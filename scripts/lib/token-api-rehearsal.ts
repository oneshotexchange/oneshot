import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createPublicClient, createWalletClient, http, type Address, type Hex } from 'viem';
import { anvil } from 'viem/chains';
import { createTokenExecutionService } from '../../apps/api/lib/server/token-execution';
import { createTokenExecutionRepository } from '../../apps/api/lib/server/token-execution-store';
import type { OneshotSession } from '../../apps/api/lib/server/oneshot-auth';
import { tokenManifestId, type TokenManifest } from '../../apps/indexer/src/token-manifest';
import type { TokenTransactionIntent } from '@oneshot/evm';

/** Owned ephemeral Anvil only. Uses its unlocked fixture accounts; never accepts a key or remote RPC. */
export async function runLocalTokenApiRehearsal(input:{rpcUrl:string;manifest:TokenManifest;market:Address;trader:Address;platform:Address;creator:Address}){
  const endpoint=new URL(input.rpcUrl);
  assert(endpoint.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)&&!endpoint.username&&!endpoint.password&&!endpoint.search&&!endpoint.hash);
  assert.equal(input.manifest.mode,'local');assert.equal(input.manifest.chainId,31337);
  const client=createPublicClient({chain:anvil,transport:http(input.rpcUrl,{retryCount:0})});assert.equal(await client.getChainId(),31337);
  const wallet=createWalletClient({chain:anvil,transport:http(input.rpcUrl,{retryCount:0})});
  const accounts=(await wallet.getAddresses()).map(value=>value.toLowerCase());for(const selected of [input.trader,input.platform,input.creator])assert(accounts.includes(selected.toLowerCase() as Address));
  const directory=path.resolve('.local/qa');await mkdir(directory,{recursive:true});const dataDirectory=await mkdtemp(path.join(directory,'token-api-rehearsal-'));
  const previous={nodeEnv:process.env.NODE_ENV,dataDir:process.env.ONESHOT_DATA_DIR};process.env.NODE_ENV='test';process.env.ONESHOT_DATA_DIR=dataDirectory;
  const repository=createTokenExecutionRepository({database:()=>null});let clock=Number((await client.getBlock()).timestamp)*1000+1;
  const service=createTokenExecutionService({environment:()=>({ONESHOT_NETWORK:'local',ONESHOT_RPC_URL:input.rpcUrl,ONESHOT_LOCAL_TOKEN_EXECUTION_ENABLED:'true',ONESHOT_TOKEN_INDEXER_MANIFEST_PATH:'fixture'}),
    loadManifest:async()=>input.manifest,now:()=>clock,repository});
  const deploymentId=tokenManifestId(input.manifest),transactions:Array<{action:string;hash:Hex;blockNumber:string}>=[];
  const identity=(from:Address):OneshotSession=>({provider:'privy',userId:`local-rehearsal:${from.toLowerCase()}`,sessionId:'fixture-only',linkedAddresses:[from.toLowerCase() as Address],expiresAt:Math.floor(clock/1000)+3600});
  const common=(from:Address)=>({from:from.toLowerCase() as Address,testEthAcknowledged:true as const,expectedChainId:31337 as const,expectedDeploymentId:deploymentId});
  async function execute(intent:TokenTransactionIntent){
    clock=Number((await client.getBlock()).timestamp)*1000+1;const session=identity(intent.from);
    const review=await service.review(intent,session);assert.equal(review.chainId,31337);assert.equal(review.from,intent.from);assert.equal(review.deploymentId,deploymentId);
    const validated=await service.validate(review.id,review.reviewHash,session);assert.deepEqual(validated,review);
    const hash=await wallet.sendTransaction({account:intent.from,to:review.to,data:review.data,value:BigInt(review.value),gas:BigInt(review.simulation.gasEstimate)*12n/10n});
    const receipt=await client.waitForTransactionReceipt({hash});assert.equal(receipt.status,'success');clock=Number((await client.getBlock()).timestamp)*1000+1;
    const recovered=await service.receipt(review.id,hash,session);assert.equal(recovered.status,'confirmed');assert.equal(recovered.hash,hash);
    const reopened=createTokenExecutionService({environment:()=>({ONESHOT_NETWORK:'local',ONESHOT_RPC_URL:input.rpcUrl,ONESHOT_LOCAL_TOKEN_EXECUTION_ENABLED:'true',ONESHOT_TOKEN_INDEXER_MANIFEST_PATH:'fixture'}),
      loadManifest:async()=>input.manifest,now:()=>clock,repository:createTokenExecutionRepository({database:()=>null})});
    assert.equal((await reopened.recover(review.id,session)).transactionHash,hash);
    transactions.push({action:intent.action,hash,blockNumber:receipt.blockNumber.toString()});return review;
  }
  try{
    const status=await service.status();assert(status.enabled&&status.network?.chainId===31337&&status.deploymentId===deploymentId);
    const buy=await execute({...common(input.trader),action:'buy',market:input.market,amount:'0.01',slippageBps:100});
    assert.equal(buy.value,'10000000000000000');assert.equal(buy.summary.fullInputRequired,'true');
    await execute({...common(input.trader),action:'approve',market:input.market,amount:'1'});
    await execute({...common(input.trader),action:'sell',market:input.market,amount:'1',slippageBps:100});
    await execute({...common(input.platform),action:'claim',market:input.market,recipient:input.platform});
    const launch=await execute({...common(input.creator),action:'launch',draft:{pricingNetwork:'base-sepolia',name:'API rehearsal',symbol:'APITEST',openingValuation:'100',executionFeeBps:150,feeMode:'creator'}});
    assert.equal(launch.value,'0');assert.equal(launch.summary.initialNativePrincipalRaw,'0');
    return{scope:'ephemeral-local-api-wallet-calls' as const,status:'passed' as const,transactions,dataDirectory,
      assertions:['Real hash-selected factory, oracle, quoter, market and token reads','Wallet-linked exact-input buy review and pre-sign simulation','Separate limited sell approval and native-output sale','Creator/platform pull-payment review','Factory-aligned token-only launch review','Canonical receipt matching and durable review recovery']};
  }finally{
    if(previous.nodeEnv===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous.nodeEnv;
    if(previous.dataDir===undefined)delete process.env.ONESHOT_DATA_DIR;else process.env.ONESHOT_DATA_DIR=previous.dataDir;
  }
}
