import {
  IndexerError,
  type Block, type IndexerStore, type IndexerTransaction, type JournalBlock,
  type Projection, type ProjectionKind, type ProjectionValue, type RawLog, type Undo,
} from './types';

export interface QueryResult { rows: Record<string, unknown>[]; rowCount: number | null; }
export interface SqlClient {
  query(sql: string, values?: unknown[]): Promise<QueryResult>;
  release(): void;
}
export interface SqlPool { connect(): Promise<SqlClient>; end?(): Promise<void>; }

/** These tables intentionally have no dependency on the legacy b20 schema. */
export const INDEXER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS oneshot_evm_deployments (
  manifest_id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS oneshot_evm_journal (
  manifest_id text NOT NULL REFERENCES oneshot_evm_deployments(manifest_id),
  block_number numeric(78,0) NOT NULL CHECK (block_number >= 0),
  block_hash text NOT NULL,
  parent_hash text NOT NULL,
  block_timestamp numeric(78,0) NOT NULL CHECK (block_timestamp >= 0),
  undo jsonb NOT NULL,
  PRIMARY KEY (manifest_id, block_number),
  UNIQUE (manifest_id, block_hash)
);
CREATE TABLE IF NOT EXISTS oneshot_evm_logs (
  manifest_id text NOT NULL,
  block_number numeric(78,0) NOT NULL,
  log_index integer NOT NULL CHECK (log_index >= 0),
  payload jsonb NOT NULL,
  PRIMARY KEY (manifest_id, block_number, log_index),
  FOREIGN KEY (manifest_id, block_number)
    REFERENCES oneshot_evm_journal(manifest_id, block_number) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS oneshot_evm_projections (
  manifest_id text NOT NULL REFERENCES oneshot_evm_deployments(manifest_id),
  kind text NOT NULL CHECK (kind IN ('collections','items','listings','claims','activity')),
  entity_id text NOT NULL,
  value jsonb NOT NULL,
  PRIMARY KEY (manifest_id, kind, entity_id)
);`;

const kinds: readonly ProjectionKind[] = ['collections', 'items', 'listings', 'claims', 'activity'];

/** Clone strictly JSON values, refusing lossy bigint/undefined/non-finite conversions. */
function jsonClone<T>(value: T): T {
  const ancestors = new Set<object>();
  function check(item: unknown): void {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object') throw new IndexerError('PROJECTION_NOT_JSON');
    if (ancestors.has(item)) throw new IndexerError('PROJECTION_NOT_JSON');
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new IndexerError('PROJECTION_NOT_JSON');
    }
    ancestors.add(item);
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index++) check(item[index]);
    } else {
      if (Object.getOwnPropertySymbols(item).length) throw new IndexerError('PROJECTION_NOT_JSON');
      for (const entry of Object.values(item)) check(entry);
    }
    ancestors.delete(item);
  }
  check(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function projectionClone(value: ProjectionValue): ProjectionValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new IndexerError('PROJECTION_NOT_JSON');
  return jsonClone(value);
}

function copyBlock(block: Block): Block { return { ...block }; }
function copyLog(log: RawLog): RawLog { return { ...log, topics: [...log.topics] }; }
function copyUndo(undo: readonly Undo[]): Undo[] {
  return undo.map((entry) => ({ ...entry, before: entry.before === null ? null : projectionClone(entry.before) }));
}
function copyJournal(entry: JournalBlock): JournalBlock {
  return { block: copyBlock(entry.block), logs: entry.logs.map(copyLog), undo: copyUndo(entry.undo) };
}

function validateManifestId(manifestId: string): void {
  if (typeof manifestId !== 'string' || !manifestId.trim() || manifestId.includes('\0')) throw new IndexerError('INVALID_MANIFEST_ID');
}

function validateBlockAndLogs(block: Block, logs: readonly RawLog[]): void {
  if (typeof block.number !== 'bigint' || block.number < 0n || block.number.toString().length > 78 ||
      typeof block.timestamp !== 'bigint' || block.timestamp < 0n || block.timestamp.toString().length > 78) {
    throw new IndexerError('INVALID_BLOCK');
  }
  const indexes = new Set<number>();
  for (const log of logs) {
    if (log.blockNumber !== block.number || log.blockHash.toLowerCase() !== block.hash.toLowerCase()) {
      throw new IndexerError('LOG_BLOCK_MISMATCH');
    }
    if (!Number.isSafeInteger(log.logIndex) || log.logIndex < 0 || log.logIndex > 2_147_483_647 ||
        !Number.isSafeInteger(log.transactionIndex) || log.transactionIndex < 0 || indexes.has(log.logIndex)) {
      throw new IndexerError('INVALID_LOG_INDEX');
    }
    indexes.add(log.logIndex);
  }
}

interface TransactionData {
  head(): Promise<JournalBlock | null>;
  block(number: bigint): Promise<Block | null>;
  get(kind: ProjectionKind, id: string): Promise<ProjectionValue | null>;
  write(kind: ProjectionKind, id: string, value: ProjectionValue | null): Promise<void>;
  list(kind: ProjectionKind): Promise<Record<string, ProjectionValue>>;
  append(entry: JournalBlock): Promise<void>;
  removeHead(number: bigint): Promise<void>;
}

class Transaction implements IndexerTransaction {
  private readonly undo = new Map<string, Undo>();
  private active = true;
  constructor(private readonly data: TransactionData) {}

  private check(kind?: ProjectionKind): void {
    if (!this.active) throw new IndexerError('TRANSACTION_CLOSED');
    if (kind !== undefined && !kinds.includes(kind)) throw new IndexerError('INVALID_PROJECTION_KIND');
  }
  finish(): void {
    this.check();
    if (this.undo.size) throw new IndexerError('UNJOURNALED_PROJECTIONS');
    this.active = false;
  }
  abandon(): void { this.active = false; }

  async head(): Promise<Block | null> {
    this.check();
    const entry = await this.data.head();
    return entry ? copyBlock(entry.block) : null;
  }
  async block(number: bigint): Promise<Block | null> { this.check(); return this.data.block(number); }
  async get(kind: ProjectionKind, id: string): Promise<ProjectionValue | null> { this.check(kind); return this.data.get(kind, id); }
  async list(kind: ProjectionKind): Promise<Record<string, ProjectionValue>> { this.check(kind); return this.data.list(kind); }

  private async capture(kind: ProjectionKind, id: string): Promise<void> {
    this.check(kind);
    const key = JSON.stringify([kind, id]);
    if (!this.undo.has(key)) this.undo.set(key, { kind, id, before: await this.data.get(kind, id) });
  }
  async put(kind: ProjectionKind, id: string, value: ProjectionValue): Promise<void> {
    const cloned = projectionClone(value);
    await this.capture(kind, id);
    await this.data.write(kind, id, cloned);
  }
  async remove(kind: ProjectionKind, id: string): Promise<void> {
    await this.capture(kind, id);
    await this.data.write(kind, id, null);
  }

  async append(block: Block, logs: readonly RawLog[]): Promise<void> {
    this.check();
    validateBlockAndLogs(block, logs);
    const head = await this.head();
    if (head && (block.number !== head.number + 1n || block.parentHash.toLowerCase() !== head.hash.toLowerCase())) {
      throw new IndexerError('NON_CONTIGUOUS_BLOCK');
    }
    await this.data.append({ block: copyBlock(block), logs: logs.map(copyLog), undo: copyUndo([...this.undo.values()]) });
    this.undo.clear();
  }

  async rollbackHead(): Promise<void> {
    this.check();
    if (this.undo.size) throw new IndexerError('UNJOURNALED_PROJECTIONS');
    const entry = await this.data.head();
    if (!entry) return;
    for (const undo of entry.undo) await this.data.write(undo.kind, undo.id, undo.before);
    await this.data.removeHead(entry.block.number);
  }
}

type MemoryState = {
  projections: Map<ProjectionKind, Map<string, ProjectionValue>>;
  journal: Map<bigint, JournalBlock>;
};
function emptyMemoryState(): MemoryState {
  return { projections: new Map(kinds.map((kind) => [kind, new Map()])), journal: new Map() };
}
function cloneMemoryState(state: MemoryState): MemoryState {
  return {
    projections: new Map([...state.projections].map(([kind, values]) => [kind, new Map([...values].map(([id, value]) => [id, projectionClone(value)]))])),
    journal: new Map([...state.journal].map(([number, entry]) => [number, copyJournal(entry)])),
  };
}
class MemoryData implements TransactionData {
  constructor(private readonly state: MemoryState) {}
  async head(): Promise<JournalBlock | null> {
    let head: JournalBlock | null = null;
    for (const entry of this.state.journal.values()) if (!head || entry.block.number > head.block.number) head = entry;
    return head ? copyJournal(head) : null;
  }
  async block(number: bigint): Promise<Block | null> {
    const entry = this.state.journal.get(number);
    return entry ? copyBlock(entry.block) : null;
  }
  async get(kind: ProjectionKind, id: string): Promise<ProjectionValue | null> {
    const value = this.state.projections.get(kind)!.get(id);
    return value === undefined ? null : projectionClone(value);
  }
  async write(kind: ProjectionKind, id: string, value: ProjectionValue | null): Promise<void> {
    const values = this.state.projections.get(kind)!;
    if (value === null) values.delete(id); else values.set(id, projectionClone(value));
  }
  async list(kind: ProjectionKind): Promise<Record<string, ProjectionValue>> {
    return Object.fromEntries([...this.state.projections.get(kind)!].map(([id, value]) => [id, projectionClone(value)]));
  }
  async append(entry: JournalBlock): Promise<void> {
    if (this.state.journal.has(entry.block.number)) throw new IndexerError('BLOCK_ALREADY_INDEXED');
    this.state.journal.set(entry.block.number, copyJournal(entry));
  }
  async removeHead(number: bigint): Promise<void> { this.state.journal.delete(number); }
}

/** Serializes callbacks and commits a private copy only after every operation succeeds. */
export class MemoryIndexerStore implements IndexerStore {
  private state = emptyMemoryState();
  private manifestId?: string;
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();

  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(run);
    this.queue = result.catch(() => undefined);
    return result;
  }
  async initialize(manifestId: string): Promise<void> {
    return this.serialize(async () => {
      validateManifestId(manifestId);
      if (this.closed) throw new IndexerError('STORE_CLOSED');
      if (this.manifestId !== undefined && this.manifestId !== manifestId) throw new IndexerError('MANIFEST_MISMATCH');
      this.manifestId = manifestId;
    });
  }
  async transaction<T>(run: (transaction: IndexerTransaction) => Promise<T>): Promise<T> {
    return this.serialize(async () => {
      if (this.closed) throw new IndexerError('STORE_CLOSED');
      if (this.manifestId === undefined) throw new IndexerError('STORE_NOT_INITIALIZED');
      const pending = cloneMemoryState(this.state);
      const transaction = new Transaction(new MemoryData(pending));
      try {
        const result = await run(transaction);
        transaction.finish();
        this.state = pending;
        return result;
      } finally { transaction.abandon(); }
    });
  }
  async snapshot(): Promise<{ blocks: JournalBlock[]; projection: Projection }> {
    return this.serialize(async () => {
      const data = new MemoryData(this.state);
      const projection = Object.fromEntries(await Promise.all(kinds.map(async (kind) => [kind, await data.list(kind)]))) as Projection;
      const blocks = [...this.state.journal.values()].sort((left, right) => left.block.number < right.block.number ? -1 : 1).map(copyJournal);
      return { blocks, projection };
    });
  }
  async close(): Promise<void> { await this.serialize(async () => { this.closed = true; }); }
}

function decodeBlock(row: Record<string, unknown>): Block {
  return {
    number: BigInt(String(row.block_number)), hash: String(row.block_hash) as Block['hash'],
    parentHash: String(row.parent_hash) as Block['parentHash'], timestamp: BigInt(String(row.block_timestamp)),
  };
}
function decodeJson<T>(value: unknown): T {
  return jsonClone(typeof value === 'string' ? JSON.parse(value) : value) as T;
}

class PostgresData implements TransactionData {
  constructor(private readonly client: SqlClient, private readonly manifestId: string) {}
  async head(): Promise<JournalBlock | null> {
    const result = await this.client.query(`SELECT block_number::text, block_hash, parent_hash, block_timestamp::text, undo
      FROM oneshot_evm_journal WHERE manifest_id=$1 ORDER BY oneshot_evm_journal.block_number DESC LIMIT 1`, [this.manifestId]);
    const row = result.rows[0];
    return row ? { block: decodeBlock(row), logs: [], undo: decodeJson<Undo[]>(row.undo) } : null;
  }
  async block(number: bigint): Promise<Block | null> {
    const result = await this.client.query(`SELECT block_number::text, block_hash, parent_hash, block_timestamp::text
      FROM oneshot_evm_journal WHERE manifest_id=$1 AND block_number=$2::numeric`, [this.manifestId, number.toString()]);
    return result.rows[0] ? decodeBlock(result.rows[0]) : null;
  }
  async get(kind: ProjectionKind, id: string): Promise<ProjectionValue | null> {
    const result = await this.client.query('SELECT value FROM oneshot_evm_projections WHERE manifest_id=$1 AND kind=$2 AND entity_id=$3', [this.manifestId, kind, id]);
    return result.rows[0] ? decodeJson<ProjectionValue>(result.rows[0].value) : null;
  }
  async write(kind: ProjectionKind, id: string, value: ProjectionValue | null): Promise<void> {
    if (value === null) {
      await this.client.query('DELETE FROM oneshot_evm_projections WHERE manifest_id=$1 AND kind=$2 AND entity_id=$3', [this.manifestId, kind, id]);
    } else {
      await this.client.query(`INSERT INTO oneshot_evm_projections(manifest_id,kind,entity_id,value) VALUES($1,$2,$3,$4::jsonb)
        ON CONFLICT(manifest_id,kind,entity_id) DO UPDATE SET value=EXCLUDED.value`, [this.manifestId, kind, id, JSON.stringify(value)]);
    }
  }
  async list(kind: ProjectionKind): Promise<Record<string, ProjectionValue>> {
    const result = await this.client.query('SELECT entity_id, value FROM oneshot_evm_projections WHERE manifest_id=$1 AND kind=$2 ORDER BY entity_id', [this.manifestId, kind]);
    return Object.fromEntries(result.rows.map((row) => [String(row.entity_id), decodeJson<ProjectionValue>(row.value)]));
  }
  async append(entry: JournalBlock): Promise<void> {
    const { block } = entry;
    await this.client.query(`INSERT INTO oneshot_evm_journal(manifest_id,block_number,block_hash,parent_hash,block_timestamp,undo)
      VALUES($1,$2::numeric,$3,$4,$5::numeric,$6::jsonb)`, [this.manifestId, block.number.toString(), block.hash, block.parentHash, block.timestamp.toString(), JSON.stringify(entry.undo)]);
    for (const log of entry.logs) {
      const payload = { ...log, blockNumber: log.blockNumber.toString(), topics: [...log.topics] };
      await this.client.query('INSERT INTO oneshot_evm_logs(manifest_id,block_number,log_index,payload) VALUES($1,$2::numeric,$3,$4::jsonb)', [this.manifestId, block.number.toString(), log.logIndex, JSON.stringify(payload)]);
    }
  }
  async removeHead(number: bigint): Promise<void> {
    // The journal foreign key removes this block's raw logs in the same transaction.
    await this.client.query('DELETE FROM oneshot_evm_journal WHERE manifest_id=$1 AND block_number=$2::numeric', [this.manifestId, number.toString()]);
  }
}

/** A Pool is accepted structurally, so tests can inject a transactional SQL adapter. */
export class PostgresIndexerStore implements IndexerStore {
  private manifestId?: string;
  private closed = false;
  private initializing?: Promise<void>;
  constructor(private readonly pool: SqlPool) {}

  async initialize(manifestId: string): Promise<void> {
    validateManifestId(manifestId);
    if (this.closed) throw new IndexerError('STORE_CLOSED');
    if (this.initializing) await this.initializing;
    if (this.manifestId !== undefined) {
      if (this.manifestId !== manifestId) throw new IndexerError('MANIFEST_MISMATCH');
      return;
    }
    this.initializing = this.initializeDatabase(manifestId);
    try { await this.initializing; } finally { this.initializing = undefined; }
  }

  private async initializeDatabase(manifestId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.lock(client, manifestId);
      // Concurrent first deployments must also serialize CREATE TABLE itself.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('oneshot_evm_schema'), 0)");
      await client.query(INDEXER_SCHEMA_SQL);
      await client.query('INSERT INTO oneshot_evm_deployments(manifest_id) VALUES($1) ON CONFLICT DO NOTHING', [manifestId]);
      await client.query('COMMIT');
      this.manifestId = manifestId;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* Preserve the original failure. */ }
      throw error;
    } finally { client.release(); }
  }

  private async lock(client: SqlClient, manifestId: string): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('oneshot_evm_indexer'), hashtext($1))", [manifestId]);
  }

  async transaction<T>(run: (transaction: IndexerTransaction) => Promise<T>): Promise<T> {
    if (this.initializing) await this.initializing;
    if (this.closed) throw new IndexerError('STORE_CLOSED');
    if (this.manifestId === undefined) throw new IndexerError('STORE_NOT_INITIALIZED');
    const manifestId = this.manifestId;
    const client = await this.pool.connect();
    const transaction = new Transaction(new PostgresData(client, manifestId));
    try {
      await client.query('BEGIN');
      // This transaction-level lock is released on COMMIT, ROLLBACK or connection loss.
      await this.lock(client, manifestId);
      const result = await run(transaction);
      transaction.finish();
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* Preserve the original failure. */ }
      throw error;
    } finally { transaction.abandon(); client.release(); }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { await this.initializing; } finally { await this.pool.end?.(); }
  }
}
