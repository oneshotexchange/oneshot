import { access } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { localReportPath, writeCapacityReport } from './lib/capacity';
import { NFT_CATALOG_BACKFILL_HELP, parseNftCatalogBackfillArguments, runNftCatalogBackfill } from './lib/nft-catalog-backfill';

const root = fileURLToPath(new URL('../', import.meta.url));
let usedStorage=false;
try {
  const options = parseNftCatalogBackfillArguments(process.argv.slice(2));
  if ('help' in options) { console.log(NFT_CATALOG_BACKFILL_HELP); process.exit(0); }
  if (options.output) {
    const output = localReportPath(root, options.output);
    try { await access(output); throw new Error('REPORT_ALREADY_EXISTS'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('REPORT_NOT_AVAILABLE'); }
  }
  if (options.envFile) loadEnvFile(path.resolve(options.envFile));
  const { rebuildNftMetadataCatalog } = await import('../apps/api/lib/server/nft-metadata-catalog');
  usedStorage=true;
  const report = await runNftCatalogBackfill(options, { rebuild: rebuildNftMetadataCatalog });
  if (options.output) await writeCapacityReport(root, options.output, report);
  console.log(JSON.stringify(report));
  if (report.status !== 'verified') process.exitCode = 1;
} catch {
  console.error('NFT catalog backfill could not finish. Check the arguments, explicit environment file, storage access and unused local report path.');
  process.exitCode = 1;
} finally {
  if(usedStorage){
    const { database } = await import('../apps/api/lib/server/store');
    const pool=database();
    if(pool){
      let timer:ReturnType<typeof setTimeout>|undefined;
      const closed=await Promise.race([pool.end().then(()=>true,()=>false),new Promise<false>(resolve=>{timer=setTimeout(()=>resolve(false),1000);})]);
      if(timer)clearTimeout(timer);
      if(!closed){console.error('NFT catalog storage cleanup timed out; inspect the catalog before retrying.');process.exit(1);}
    }
  }
}
