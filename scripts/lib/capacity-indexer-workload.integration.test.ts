import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, parseAbi, zeroHash, type Address, type Hex } from 'viem';
import { manifestId } from '../../apps/indexer/src/manifest';
import { PostgresIndexerStore, type SqlPool } from '../../apps/indexer/src/store';
import type { Block, ChainSource, Manifest, RawLog } from '../../apps/indexer/src/types';
import { runCapacityIndexerWorkload } from './capacity-indexer-workload';

// Explicit opt-in; never read ambient DATABASE_URL.
const databaseUrl = process.env.ONESHOT_INDEXER_TEST_DATABASE_URL;
const hash = (): Hex => `0x${randomBytes(32).toString('hex')}`;
const address = (digit: string): Address => `0x${digit.repeat(40)}`;
const factory = address('1'), marketplace = address('2'), collection = address('3'), creator = address('4');
const factoryAbi = parseAbi(['event CollectionCreated(address indexed collection, address indexed creator, string name, string symbol)']);
const marketAbi = parseAbi(['event PolicyCommitted(address indexed collection, bytes32 indexed previousCommitment, bytes32 indexed commitment)']);

function fixture() {
  const genesis = hash(), blockHash = hash(), tipHash = hash();
  const manifest: Manifest = {
    schemaVersion: 1, deploymentVersion: 'oneshot-nft-v2', mode: 'local', chainId: 31337,
    genesisHash: genesis, startBlock: 1n, anchorHash: genesis,
    factory: { address: factory, codeHash: hash() }, marketplace: { address: marketplace, codeHash: hash() },
    listingAuthorization: { authority: creator, salt: hash() },
  };
  const blocks: Block[] = [
    { number: 0n, hash: genesis, parentHash: zeroHash, timestamp: 0n },
    { number: 1n, hash: blockHash, parentHash: genesis, timestamp: 1n },
    { number: 2n, hash: tipHash, parentHash: blockHash, timestamp: 2n },
  ];
  const logs: RawLog[] = [
    { address: factory, blockNumber: 1n, blockHash, transactionHash: hash(), transactionIndex: 0, logIndex: 0,
      topics: encodeEventTopics({ abi: factoryAbi, eventName: 'CollectionCreated', args: { collection, creator } }),
      data: encodeAbiParameters([{ type: 'string' }, { type: 'string' }], ['Capacity fixture', 'TEST']) },
    { address: marketplace, blockNumber: 2n, blockHash: tipHash, transactionHash: hash(), transactionIndex: 0, logIndex: 0,
      topics: encodeEventTopics({ abi: marketAbi, eventName: 'PolicyCommitted', args: { collection, previousCommitment: zeroHash, commitment: hash() } }), data: '0x' },
  ];
  const source: ChainSource = {
    verify: async () => undefined, height: async () => 2n,
    block: async number => blocks[Number(number)],
    logs: async (block, addresses) => logs.filter(log => log.blockNumber === block.number && addresses.includes(log.address)),
  };
  return { manifest, source, blocks };
}

async function withDatabase(run: (input: { pool: Pool; scopedInput: SqlPool; createdSchemas: string[] }) => Promise<void>) {
  if (!databaseUrl) throw new Error('Explicit capacity test database required');
  const configured = new URL(databaseUrl);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(configured.hostname)
    || configured.pathname !== '/oneshot_indexer_test') throw new Error('Dedicated local capacity test database required');
  const pool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 5000, statement_timeout: 10_000 });
  const createdSchemas: string[] = [];
  const scopedInput: SqlPool = {
    async connect() {
      const client = await pool.connect();
      return {
        async query(sql, values) {
          const result = await client.query(sql, values);
          const created = /^CREATE SCHEMA "(oneshot_capacity_[a-f0-9]{32})"$/.exec(sql);
          if (created) createdSchemas.push(created[1]);
          return result;
        },
        release() { client.release(); },
      };
    },
  };
  try { await run({ pool, scopedInput, createdSchemas }); }
  finally { await pool.end(); }
}

describe.skipIf(!databaseUrl)('real PostgreSQL capacity replay isolation', () => {
  it('replays and repeats while preserving a public deployment with the same manifest fingerprint', async () => {
    await withDatabase(async ({ pool, scopedInput, createdSchemas }) => {
      const { manifest, source, blocks } = fixture(), id = manifestId(manifest);
      const publicStore = new PostgresIndexerStore({ connect: () => pool.connect() });
      await publicStore.initialize(id);
      try {
        await publicStore.transaction(async tx => {
          await tx.put('items', 'unrelated-sentinel', { owner: 'fixture-creator', exact: '1000000000000000001' });
          await tx.append(blocks[1], []);
        });
        const before = await publicStore.transaction(async tx => ({ head: await tx.head(), items: await tx.list('items') }));
        const report = await runCapacityIndexerWorkload({ manifest, source, pool: scopedInput, batchSize: 1 });
        expect(report).toMatchObject({
          workload: 'local-indexer-replay', storage: 'postgresql-isolated-schema',
          replay: { blocks: 2, logs: 2, passes: 2 }, repeat: { processedBlocks: 0, rolledBackBlocks: 0 },
          projectionCounts: { collections: 1, items: 0, listings: 0, claims: 0, activity: 1 },
          idempotent: true, schemaCleaned: true,
        });
        expect(report.projectionFingerprint).toMatch(/^[a-f0-9]{64}$/);
        expect(JSON.stringify(report)).not.toContain('PolicyCommitted');
        expect(JSON.stringify(report)).not.toContain(creator);
        expect(await publicStore.transaction(async tx => ({ head: await tx.head(), items: await tx.list('items') }))).toEqual(before);
        expect(createdSchemas).toHaveLength(1);
        expect((await pool.query('SELECT nspname FROM pg_namespace WHERE nspname=$1', createdSchemas)).rows).toEqual([]);
        expect((await pool.query('SHOW search_path')).rows[0].search_path).not.toContain('oneshot_capacity_');
      } finally {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          for (const table of ['oneshot_evm_logs', 'oneshot_evm_journal', 'oneshot_evm_projections', 'oneshot_evm_deployments']) {
            await client.query(`DELETE FROM ${table} WHERE manifest_id=$1`, [id]);
          }
          await client.query('COMMIT');
        } finally { client.release(); await publicStore.close(); }
      }
    });
  });

  it('drops its schema and redacts raw RPC errors when a replay stops after committing a block', async () => {
    await withDatabase(async ({ pool, scopedInput, createdSchemas }) => {
      const { manifest, source } = fixture();
      const block = source.block;
      source.block = async number => {
        if (number === 2n) throw new Error('private provider URL and authorization');
        return block(number);
      };
      await expect(runCapacityIndexerWorkload({ manifest, source, pool: scopedInput, batchSize: 1 }))
        .rejects.toMatchObject({ code: 'CAPACITY_INDEXER_FAILED', message: 'CAPACITY_INDEXER_FAILED' });
      expect(createdSchemas).toHaveLength(1);
      expect((await pool.query('SELECT nspname FROM pg_namespace WHERE nspname=$1', createdSchemas)).rows).toEqual([]);
    });
  });
});
