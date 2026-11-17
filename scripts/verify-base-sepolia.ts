/** Bounded public-chain reads only. No signer, deployment, key or database access. */
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BASE_SEPOLIA_CHAIN_ID, BASE_SEPOLIA_GENESIS_HASH, createVerifiedRpc, networkConfig, RpcError } from '@oneshot/evm';

const quantity=(value:unknown):value is string=>typeof value==='string' && /^0x(?:0|[1-9a-f][\da-f]{0,63})$/i.test(value);
const hash=(value:unknown):value is string=>typeof value==='string' && /^0x[\da-f]{64}$/i.test(value);
function checkpoint(input:unknown) {
  if (!input || typeof input!=='object' || Array.isArray(input)) throw new RpcError('RPC_RESPONSE_INVALID');
  const value=input as Record<string,unknown>;
  if (!quantity(value.number) || !hash(value.hash) || !hash(value.parentHash) || !quantity(value.timestamp)) throw new RpcError('RPC_RESPONSE_INVALID');
  return {number:BigInt(value.number).toString(),hash:value.hash.toLowerCase(),parentHash:value.parentHash.toLowerCase(),timestamp:BigInt(value.timestamp).toString()};
}

export async function verifyBaseSepoliaReadOnly(env:Record<string,string|undefined>, options:{fetch?:typeof globalThis.fetch}={}) {
  if (env.ONESHOT_NETWORK!=='base-sepolia') throw new RpcError('CONFIG_INVALID');
  let config:ReturnType<typeof networkConfig>;
  try {config=networkConfig(env);} catch {throw new RpcError('CONFIG_INVALID');}
  const controller=new AbortController(),transport=options.fetch??globalThis.fetch;
  let requests=0,timer:ReturnType<typeof setTimeout>|undefined;
  const boundedFetch:typeof globalThis.fetch=async(input,init)=>{
    if (controller.signal.aborted) throw new RpcError('RPC_TIMEOUT');
    if (++requests>24) throw new RpcError('RPC_PARAMS_INVALID');
    return transport(input,{...init,signal:init?.signal?AbortSignal.any([init.signal,controller.signal]):controller.signal});
  };
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new RpcError('RPC_TIMEOUT'));},30_000);});
  const operation=(async()=>{
    const rpc=await createVerifiedRpc(config,{fetch:boundedFetch,timeoutMs:4000,provider:env.ONESHOT_RPC_URL?'custom':'official'});
    if (rpc.verification.chainId!==BASE_SEPOLIA_CHAIN_ID || rpc.verification.genesisHash!==BASE_SEPOLIA_GENESIS_HASH) throw new RpcError('CONFIG_INVALID');
    const checkpoints={} as Record<'latest'|'safe'|'finalized',ReturnType<typeof checkpoint>>;
    for (const tag of ['latest','safe','finalized'] as const) checkpoints[tag]=checkpoint(await rpc.readRpc('eth_getBlockByNumber',[tag,false]));
    if (BigInt(checkpoints.finalized.number)>BigInt(checkpoints.safe.number) || BigInt(checkpoints.safe.number)>BigInt(checkpoints.latest.number)) throw new RpcError('RPC_RESPONSE_INVALID');
    for (const value of Object.values(checkpoints)) {
      const current=checkpoint(await rpc.readRpc('eth_getBlockByNumber',[`0x${BigInt(value.number).toString(16)}`,false]));
      if (current.number!==value.number || current.hash!==value.hash || current.parentHash!==value.parentHash || current.timestamp!==value.timestamp) throw new RpcError('RPC_RESPONSE_INVALID');
    }
    return {status:'passed' as const,readOnly:true,executionEnabled:false,chainId:BASE_SEPOLIA_CHAIN_ID,genesisHash:BASE_SEPOLIA_GENESIS_HASH,
      nativeSymbol:'ETH',nativeDecimals:18,identity:'passed',checkpoints,requests,
      scope:'Chain identity and canonical latest/safe/finalized checkpoint reads only.',
      untested:['NFT deployment','contract code identity','EIP-1898 calls','EIP-234 logs','receipts','gas estimation','transaction execution','AMM integration']};
  })();
  try {return await Promise.race([deadline,operation]);}
  catch(error){throw error instanceof RpcError?error:new RpcError('RPC_UNAVAILABLE');}
  finally {if(timer)clearTimeout(timer);controller.abort();}
}

async function main(args:string[]) {
  const failed=(code:string)=>{console.error(JSON.stringify({status:'failed',code,readOnly:true,executionEnabled:false}));process.exitCode=1;};
  if (args.length===1 && args[0]==='--help') {console.log('Usage: npm run verify:base-sepolia [-- --env-file PATH]\nRequires ONESHOT_NETWORK=base-sepolia. At most24 HTTP requests/30 seconds. Verifies only chain identity and latest/safe/finalized block reads. Use verify:rpc-capabilities with an explicit contract plan for NFT/AMM read requirements. Never signs, deploys or broadcasts.');return;}
  if (args.length!==0 && !(args.length===2 && args[0]==='--env-file' && args[1] && !args[1].startsWith('--'))) {failed('INVALID_ARGUMENTS');return;}
  if (args.length) {try {loadEnvFile(resolve(args[1]));}catch {failed('ENV_FILE_UNAVAILABLE');return;}}
  try {console.log(JSON.stringify(await verifyBaseSepoliaReadOnly(process.env),null,2));}
  catch(error){failed(error instanceof RpcError?error.code:'RPC_UNAVAILABLE');}
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void main(process.argv.slice(2));
