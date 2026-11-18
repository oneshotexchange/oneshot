export class NftCatalogBackfillError extends Error {
  constructor(readonly code: 'INVALID_CATALOG_ARGUMENTS' | 'INVALID_CATALOG_RESULT') { super(code); }
}
export type NftCatalogBackfillOptions = { manifestHash: string; envFile?: string; output?: string };
export const NFT_CATALOG_BACKFILL_HELP = 'Usage: npm run nft:catalog:backfill -- --manifest-hash SHA256 [--env-file PATH] [--output .local/qa/REPORT.json]\nRebuild one immutable NFT search catalog from stored, hash-verified metadata. No URL downloads, chain transactions or draft publication. Existing local reports are preserved.';

export function parseNftCatalogBackfillArguments(args: string[]): NftCatalogBackfillOptions | { help: true } {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!['--manifest-hash', '--env-file', '--output'].includes(flag) || !value || value.startsWith('--') || flags.has(flag)
      || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) throw new NftCatalogBackfillError('INVALID_CATALOG_ARGUMENTS');
    flags.set(flag, value);
  }
  const manifestHash = flags.get('--manifest-hash');
  if (!manifestHash || !/^[a-f0-9]{64}$/.test(manifestHash)) throw new NftCatalogBackfillError('INVALID_CATALOG_ARGUMENTS');
  return { manifestHash, ...(flags.has('--env-file') ? { envFile: flags.get('--env-file')! } : {}), ...(flags.has('--output') ? { output: flags.get('--output')! } : {}) };
}

type Catalog = { manifestHash: string; items: { serial: number; metadataJson: string }[] };
type Dependencies = { rebuild(manifestHash: string, options: { signal: AbortSignal }): Promise<Catalog> };
export type NftCatalogBackfillReport = {
  schemaVersion: 1; scope: 'stored-nft-metadata-catalog'; manifestHash: string; status: 'verified' | 'failed';
  itemCount: number; metadataBytes: number; checkedAt: string; code: string | null;
};
const knownErrors = new Set(['NFT_CATALOG_INVALID', 'NFT_CATALOG_TIMEOUT', 'NFT_CATALOG_CHANGED', 'CONTENT_INTEGRITY', 'DATABASE_REQUIRED']);
async function interrupted<T>(signal:AbortSignal,run:()=>Promise<T>):Promise<T>{
  signal.throwIfAborted();
  let onAbort:()=>void=()=>{};
  const stopped=new Promise<never>((_resolve,reject)=>{onAbort=()=>reject(signal.reason);signal.addEventListener('abort',onAbort,{once:true});});
  try{return await Promise.race([Promise.resolve().then(()=>{signal.throwIfAborted();return run();}),stopped]);}
  finally{signal.removeEventListener('abort',onAbort);}
}

/** Only the verified derived catalog is written; reports contain no raw metadata, owners or provider details. */
export async function runNftCatalogBackfill(options: NftCatalogBackfillOptions, deps: Dependencies, signal = AbortSignal.timeout(60_000)): Promise<NftCatalogBackfillReport> {
  const base = { schemaVersion: 1 as const, scope: 'stored-nft-metadata-catalog' as const, manifestHash: options.manifestHash, checkedAt: new Date().toISOString() };
  try {
    if (!/^[a-f0-9]{64}$/.test(options.manifestHash)) throw new NftCatalogBackfillError('INVALID_CATALOG_ARGUMENTS');
    signal.throwIfAborted();
    const catalog = await interrupted(signal,()=>deps.rebuild(options.manifestHash, { signal }));
    if (!catalog || catalog.manifestHash !== options.manifestHash || !Array.isArray(catalog.items) || catalog.items.length < 1 || catalog.items.length > 1000
      || catalog.items.some((item, index) => !item || item.serial !== index + 1 || typeof item.metadataJson !== 'string' || Buffer.byteLength(item.metadataJson) > 256 * 1024)) throw new NftCatalogBackfillError('INVALID_CATALOG_RESULT');
    const metadataBytes = catalog.items.reduce((sum, item) => sum + Buffer.byteLength(item.metadataJson), 0);
    if (metadataBytes > 20 * 1024 * 1024) throw new NftCatalogBackfillError('INVALID_CATALOG_RESULT');
    return { ...base, status: 'verified', itemCount: catalog.items.length, metadataBytes, code: null };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && knownErrors.has(error.code)
      ? error.code : error instanceof NftCatalogBackfillError ? error.code : signal.aborted ? 'CATALOG_BACKFILL_TIMEOUT' : 'CATALOG_BACKFILL_FAILED';
    return { ...base, status: 'failed', itemCount: 0, metadataBytes: 0, code };
  }
}
