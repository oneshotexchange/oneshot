import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { keccak256, type Address, type Hex } from 'viem';
import type { IndexedTokenMarket } from '@oneshot/evm';
import { tokenManifestId, tokenManifestJson } from '../../../indexer/src/token-manifest';
import type { TokenMarketAnalytics } from '../../../indexer/src/token-event-types';
import { tokenAddress as a, tokenFixture, tokenHash as h } from '../../../indexer/test/token-fixture';
import { createTokenAnalyticsReader } from './token-analytics';
import { oneshotApi } from './oneshot-api';
import { api } from './http';
import * as auth from './oneshot-auth';
import { encodeFollowedWallets } from '../../../web/lib/wallet-following';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const CODE_HASH = keccak256('0x60016000');

function makeMarketSnapshot(index: number): IndexedTokenMarket {
  return {
    schemaVersion: 1,
    market: a(100 + index * 2),
    token: a(101 + index * 2),
    creator: a(200 + index),
    platformRecipient: a(8),
    name: `Alpha ${index}`,
    symbol: `ALP${index}`,
    tokenDecimals: 8,
    initialSupplyRaw: '100000000000000000',
    totalSupplyRaw: '100000000000000000',
    executionFeeBps: 100,
    liquidityAndBurn: true,
    openingValuationNativeRaw: '5000000000000000000',
    effectiveOpeningValuationNativeRaw: '5000000000000000000',
    effectiveUpperValuationNativeRaw: '10000000000000000000',
    poolId: h(500 + index),
    lpFeePips: 2500,
    tickSpacing: 10,
    tickLower: -100,
    tickUpper: 100,
    lockedLiquidityRaw: '123456789',
    lockedRoundingDustRaw: '3',
    observedMarketCodeHash: CODE_HASH,
    observedTokenCodeHash: CODE_HASH,
  };
}

function makeProjection(index: number, overrides: Partial<TokenMarketAnalytics> = {}): TokenMarketAnalytics {
  const snapshot = makeMarketSnapshot(index);
  return {
    schemaVersion: 1,
    chainId: 31337,
    market: snapshot.market as Address,
    token: snapshot.token as Address,
    creator: snapshot.creator as Address,
    poolId: snapshot.poolId as Hex,
    executionFeeBps: snapshot.executionFeeBps,
    liquidityAndBurn: snapshot.liquidityAndBurn,
    tokenDecimals: 8,
    initialSupplyRaw: '100000000000000000',
    observedMarketCodeHash: snapshot.observedMarketCodeHash as Hex,
    observedTokenCodeHash: snapshot.observedTokenCodeHash as Hex,
    initialized: true,
    initialMintSeen: true,
    observedSupplyRaw: '100000000000000000',
    mintedRaw: '100000000000000000',
    burnedRaw: '0',
    holderCount: String(10 + index),
    oneshotTrades: String(5 + index),
    oneshotBuys: String(5 + index),
    oneshotSells: '0',
    oneshotGrossNativeVolumeRaw: String(1000 + index),
    oneshotExecutionFeesRaw: '30',
    poolSwaps: String(5 + index),
    poolNativeVolumeRaw: String(1000 + index),
    poolTokenVolumeRaw: '500000',
    sqrtPriceX96Raw: String(1n << 96n),
    tick: 0,
    lastSwapLiquidityRaw: '1000000',
    lastSwapFeePips: 2500,
    priceBlockNumber: '12',
    priceBlockHash: h(112),
    createdBlockNumber: String(10 + index),
    createdBlockHash: h(110 + index),
    createdTransactionHash: h(300 + index),
    createdLogIndex: 0,
    lastBlockNumber: '12',
    lastBlockHash: h(112),
    ...overrides,
  };
}

describe('canonical token analytics public boundary', () => {
  it('routes a safely disabled journal context before account authentication', async () => {
    vi.stubEnv('ONESHOT_TOKEN_ANALYTICS_READS_ENABLED', 'false');
    const session = vi.spyOn(auth, 'requireOneshotSession').mockRejectedValue(new Error('No auth expected'));
    const response = await oneshotApi(new NextRequest(`http://localhost/api/oneshot/token-analytics/markets/${a(5)}`), {});
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ context: { kind: 'canonical-event-journal', available: false, enabled: false, source: null, checkpoint: null }, market: null, analytics: null });
    expect(session).not.toHaveBeenCalled();

    const listResponse = await oneshotApi(new NextRequest('http://localhost/api/oneshot/token-analytics/markets?sort=volume'), {});
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toMatchObject({ context: { available: false, enabled: false }, sort: 'volume', items: [], nextCursor: null });

    const feedResponse = await oneshotApi(new NextRequest('http://localhost/api/oneshot/token-analytics/trades?kind=oneshot-trade'), {});
    expect(feedResponse.status).toBe(200);
    expect(await feedResponse.json()).toMatchObject({ context: { available: false, enabled: false }, kind: 'oneshot-trade', wallet: null, items: [], nextCursor: null });
  });

  it('rejects malformed page inputs and unsupported methods before any database or provider work', async () => {
    const pool = vi.fn(() => { throw new Error('Unexpected database'); });
    const source = vi.fn(async () => { throw new Error('Unexpected provider'); });
    const reader = createTokenAnalyticsReader({ env: () => ({ ONESHOT_TOKEN_ANALYTICS_READS_ENABLED: 'true' }), pool, source });
    for (const suffix of ['/trades?limit=01', '/holders?limit=51', '/holders?kind=all', '/trades?kind=all&kind=pool-swap', '/trades?cursor=invalid', '?limit=1']) {
      const response = await api(request => reader(request))(new NextRequest(`http://localhost/api/oneshot/token-analytics/markets/${a(5)}${suffix}`), {});
      expect(response.status).toBe(400);
    }
    for (const listQuery of ['?sort=invalid', '?limit=0', '?limit=51', '?cursor=invalid', `?q=${'x'.repeat(101)}`]) {
      const response = await api(request => reader(request))(new NextRequest(`http://localhost/api/oneshot/token-analytics/markets${listQuery}`), {});
      expect(response.status).toBe(400);
    }
    for (const feedQuery of [
      `?wallet=${a(1)}&wallets=${encodeFollowedWallets([a(1)])}`,
      `?wallet=${a(1)}&kind=pool-swap`,
      `?wallet=${a(1)}&kind=all`,
      '?kind=bad',
      '?limit=0',
      '?limit=51',
      '?cursor=invalid',
    ]) {
      const response = await api(request => reader(request))(new NextRequest(`http://localhost/api/oneshot/token-analytics/trades${feedQuery}`), {});
      expect(response.status).toBe(400);
    }
    const response = await api(request => reader(request))(new NextRequest(`http://localhost/api/oneshot/token-analytics/markets/${a(5)}`, { method: 'POST' }), {});
    expect(response.status).toBe(405);
    expect(pool).not.toHaveBeenCalled();
    expect(source).not.toHaveBeenCalled();
  });

  it('lists, sorts by volume/trades/holders/newest, searches and paginates event-journal markets', async () => {
    const fixture = tokenFixture();
    const manifest = fixture.manifest;
    const head = fixture.block(12n);
    const snapshots = [makeMarketSnapshot(1), makeMarketSnapshot(2), makeMarketSnapshot(3)];
    const projections = [
      makeProjection(1, { createdBlockNumber: '11', poolNativeVolumeRaw: '500', oneshotTrades: '20', oneshotBuys: '20', holderCount: '3' }),
      makeProjection(2, { createdBlockNumber: '12', poolNativeVolumeRaw: '5000', oneshotTrades: '2', oneshotBuys: '2', holderCount: '15' }),
      makeProjection(3, { createdBlockNumber: '10', poolNativeVolumeRaw: '1500', oneshotTrades: '99', oneshotBuys: '99', holderCount: '50' }),
    ];
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('oneshot_evm_token_event_deployments')) return { rows: [{ manifest: tokenManifestJson(manifest) }] };
        if (sql.includes('oneshot_evm_token_event_journal')) {
          return { rows: [{ block_number: head.number.toString(), block_hash: head.hash, parent_hash: head.parentHash, block_timestamp: head.timestamp.toString() }] };
        }
        if (sql.includes("kind='markets'")) {
          return { rows: projections.map(item => ({ entity_id: item.market, value: item })) };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const reader = createTokenAnalyticsReader({
      env: () => ({
        ONESHOT_TOKEN_ANALYTICS_READS_ENABLED: 'true',
        ONESHOT_NETWORK: 'local',
        DATABASE_URL: 'postgres://localhost/test',
        ONESHOT_TOKEN_INDEXER_MANIFEST_PATH: 'manifest.json',
      }),
      loadManifest: async () => manifest,
      pool: () => ({ connect: async () => client as never } as never),
      source: async () => ({
        verify: async () => ({}),
        verifyMarket: async (_m, market) => snapshots.find(item => item.market === market.toLowerCase())!,
        height: async () => 15n,
        block: async () => head,
      }),
    });

    const callList = async (qs: string) => {
      const response = await api(req => reader(req))(new NextRequest(`http://localhost/api/oneshot/token-analytics/markets${qs}`), {});
      expect(response.status).toBe(200);
      return response.json();
    };

    const byVolume = await callList('?sort=volume&limit=2');
    expect(byVolume.context.deploymentId).toBe(tokenManifestId(manifest));
    expect(byVolume.items.map((item: { market: { market: string } }) => item.market.market)).toEqual([projections[1]!.market, projections[2]!.market]);
    expect(byVolume.nextCursor).toBeTruthy();

    const page2 = await callList(`?sort=volume&limit=2&cursor=${encodeURIComponent(byVolume.nextCursor)}`);
    expect(page2.items.map((item: { market: { market: string } }) => item.market.market)).toEqual([projections[0]!.market]);
    expect(page2.nextCursor).toBeNull();

    const byTrades = await callList('?sort=trades');
    expect(byTrades.items.map((item: { analytics: { oneshotTrades: string } }) => item.analytics.oneshotTrades)).toEqual(['99', '20', '2']);

    const byHolders = await callList('?sort=holders');
    expect(byHolders.items.map((item: { analytics: { holderCount: string } }) => item.analytics.holderCount)).toEqual(['50', '15', '3']);

    const bySearch = await callList('?q=Alpha%203');
    expect(bySearch.items).toHaveLength(1);
    expect(bySearch.items[0].market.symbol).toBe('ALP3');
  });

  it('serves global, wallet-filtered and followed-wallets token trade feeds with bound cursors and stale rejection', async () => {
    const fixture = tokenFixture();
    const manifest = fixture.manifest;
    let head = fixture.block(12n);
    const projections = [
      makeProjection(1, { createdBlockNumber: '11', oneshotTrades: '1', oneshotBuys: '1' }),
      makeProjection(2, { createdBlockNumber: '10', oneshotTrades: '1', oneshotBuys: '1' }),
      makeProjection(3, { createdBlockNumber: '10', oneshotTrades: '1', oneshotBuys: '1' }),
    ];
    const marketsById = new Map(projections.map(item => [item.market, item]));
    const block12 = fixture.block(12n);
    const block11 = fixture.block(11n);
    const block10 = fixture.block(10n);
    const events = [
      {
        entity_id: `${h(701)}:5`,
        block_number: '12',
        block_hash: block12.hash,
        block_timestamp: block12.timestamp.toString(),
        value: {
          schemaVersion: 1,
          chainId: manifest.chainId,
          kind: 'oneshot-trade',
          source: projections[0]!.market,
          market: projections[0]!.market,
          token: projections[0]!.token,
          blockNumber: '12',
          blockHash: block12.hash,
          timestamp: block12.timestamp.toString(),
          transactionHash: h(701),
          transactionIndex: 0,
          logIndex: 5,
          trader: a(501),
          recipient: a(502),
          buy: true,
          tokensRaw: '500000000',
          grossNativeRaw: '1000',
          netNativeRaw: '990',
          executionFeeRaw: '10',
        },
      },
      {
        entity_id: `${h(702)}:3`,
        block_number: '12',
        block_hash: block12.hash,
        block_timestamp: block12.timestamp.toString(),
        value: {
          schemaVersion: 1,
          chainId: manifest.chainId,
          kind: 'pool-swap',
          source: manifest.poolManager.address,
          market: projections[1]!.market,
          poolId: projections[1]!.poolId,
          poolSender: a(600),
          trader: null,
          recipient: null,
          blockNumber: '12',
          blockHash: block12.hash,
          timestamp: block12.timestamp.toString(),
          transactionHash: h(702),
          transactionIndex: 0,
          logIndex: 3,
          amount0Raw: '-1000',
          amount1Raw: '500',
          sqrtPriceX96Raw: String(1n << 96n),
          liquidityRaw: '1000000',
          tick: 0,
          feePips: 2500,
        },
      },
      {
        entity_id: `${h(703)}:2`,
        block_number: '11',
        block_hash: block11.hash,
        block_timestamp: block11.timestamp.toString(),
        value: {
          schemaVersion: 1,
          chainId: manifest.chainId,
          kind: 'oneshot-trade',
          source: projections[1]!.market,
          market: projections[1]!.market,
          token: projections[1]!.token,
          blockNumber: '11',
          blockHash: block11.hash,
          timestamp: block11.timestamp.toString(),
          transactionHash: h(703),
          transactionIndex: 0,
          logIndex: 2,
          trader: a(503),
          recipient: a(501),
          buy: false,
          tokensRaw: '300000000',
          grossNativeRaw: '2000',
          netNativeRaw: '1980',
          executionFeeRaw: '20',
        },
      },
      {
        entity_id: `${h(704)}:1`,
        block_number: '10',
        block_hash: block10.hash,
        block_timestamp: block10.timestamp.toString(),
        value: {
          schemaVersion: 1,
          chainId: manifest.chainId,
          kind: 'oneshot-trade',
          source: projections[2]!.market,
          market: projections[2]!.market,
          token: projections[2]!.token,
          blockNumber: '10',
          blockHash: block10.hash,
          timestamp: block10.timestamp.toString(),
          transactionHash: h(704),
          transactionIndex: 0,
          logIndex: 1,
          trader: a(504),
          recipient: a(505),
          buy: true,
          tokensRaw: '400000000',
          grossNativeRaw: '3000',
          netNativeRaw: '2970',
          executionFeeRaw: '30',
        },
      },
    ];

    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql.includes("p.kind='events'")) {
          const kinds = values![1] as string[];
          const afterBlock = values![2] as string | null;
          const afterLog = values![3] as string | null;
          const actors = Array.isArray(values![4]) ? (values![4] as string[]) : null;
          const limit = (actors ? values![5] : values![4]) as number;
          const filtered = events.filter(row => {
            if (!kinds.includes(row.value.kind)) return false;
            if (actors) {
              if (row.value.kind !== 'oneshot-trade') return false;
              if (!actors.includes(row.value.trader!) && !actors.includes(row.value.recipient!)) return false;
            }
            if (afterBlock !== null && afterLog !== null) {
              const rowPos = BigInt(row.block_number);
              const afterPos = BigInt(afterBlock);
              if (rowPos > afterPos || (rowPos === afterPos && row.value.logIndex >= Number(afterLog))) return false;
            }
            return true;
          });
          return {
            rows: filtered.slice(0, limit).map(row => ({
              entity_id: row.entity_id,
              value: row.value,
              block_number: row.block_number,
              block_hash: row.block_hash,
              block_timestamp: row.block_timestamp,
              market_value: marketsById.get(row.value.market),
            })),
          };
        }
        if (sql.includes('oneshot_evm_token_event_deployments')) return { rows: [{ manifest: tokenManifestJson(manifest) }] };
        if (sql.includes('oneshot_evm_token_event_journal')) {
          return { rows: [{ block_number: head.number.toString(), block_hash: head.hash, parent_hash: head.parentHash, block_timestamp: head.timestamp.toString() }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };

    const reader = createTokenAnalyticsReader({
      env: () => ({
        ONESHOT_TOKEN_ANALYTICS_READS_ENABLED: 'true',
        ONESHOT_NETWORK: 'local',
        DATABASE_URL: 'postgres://localhost/test',
        ONESHOT_TOKEN_INDEXER_MANIFEST_PATH: 'manifest.json',
      }),
      loadManifest: async () => manifest,
      pool: () => ({ connect: async () => client as never } as never),
      source: async () => ({
        verify: async () => ({}),
        verifyMarket: async (_m, market) => makeMarketSnapshot(projections.findIndex(item => item.market === market) + 1),
        height: async () => 15n,
        block: async () => head,
      }),
    });

    const callFeed = async (qs: string) => api(req => reader(req))(new NextRequest(`http://localhost/api/oneshot/token-analytics/trades${qs}`), {});

    const allPage1 = await callFeed('?kind=all&limit=2');
    expect(allPage1.status).toBe(200);
    const allBody1 = await allPage1.json();
    expect(allBody1.items.map((item: { id: string }) => item.id)).toEqual([events[0]!.entity_id, events[1]!.entity_id]);
    expect(allBody1.nextCursor).toBeTruthy();

    const allPage2 = await callFeed(`?kind=all&limit=2&cursor=${encodeURIComponent(allBody1.nextCursor)}`);
    expect(allPage2.status).toBe(200);
    const allBody2 = await allPage2.json();
    expect(allBody2.items.map((item: { id: string }) => item.id)).toEqual([events[2]!.entity_id, events[3]!.entity_id]);
    expect(allBody2.nextCursor).toBeNull();

    // Cursor bound to filter scope
    const mismatched = await callFeed(`?kind=oneshot-trade&limit=2&cursor=${encodeURIComponent(allBody1.nextCursor)}`);
    expect(mismatched.status).toBe(400);

    // Single wallet matches trader or recipient
    const singleWallet = await callFeed(`?wallet=${a(501)}`);
    expect(singleWallet.status).toBe(200);
    const walletBody = await singleWallet.json();
    expect(walletBody.wallet).toBe(a(501));
    expect(walletBody.items.map((item: { id: string }) => item.id)).toEqual([events[0]!.entity_id, events[2]!.entity_id]);

    // Multi-wallet followed feed
    const followed = await callFeed(`?wallets=${encodeFollowedWallets([a(502), a(504)])}`);
    expect(followed.status).toBe(200);
    const followedBody = await followed.json();
    expect(followedBody.items.map((item: { id: string }) => item.id)).toEqual([events[0]!.entity_id, events[3]!.entity_id]);

    // Stale checkpoint returns 409
    head = fixture.block(13n);
    const staleResp = await callFeed(`?kind=all&limit=2&cursor=${encodeURIComponent(allBody1.nextCursor)}`);
    expect(staleResp.status).toBe(409);
  });
});
