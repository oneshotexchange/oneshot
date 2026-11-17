import {createHash} from 'node:crypto';
import {BASE_SEPOLIA_GENESIS_HASH,BASE_SEPOLIA_POOL_MANAGER,nftExecutionNetwork,type NftExecutionNetwork} from '@oneshot/evm';
import type {Address,Hex} from 'viem';
import {isAddress,isHash} from './manifest';
import {IndexerError} from './types';

type Identity<T extends NftExecutionNetwork> = T extends unknown ? Pick<T,'mode'|'chainId'> : never;
export type TokenContractIdentity={address:Address;codeHash:Hex};
export type TokenManifest={schemaVersion:1;deploymentVersion:'oneshot-v4-market-v1';genesisHash:Hex;startBlock:bigint;anchorHash:Hex;
  factory:TokenContractIdentity;poolManager:TokenContractIdentity;oracle:TokenContractIdentity;quoter:TokenContractIdentity} & Identity<NftExecutionNetwork>;
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const fail=():never=>{throw new IndexerError('TOKEN_MANIFEST_INVALID');};
export function parseTokenManifest(input:unknown):TokenManifest {
  const keys=['schemaVersion','deploymentVersion','mode','chainId','genesisHash','startBlock','anchorHash','factory','poolManager','oracle','quoter'];
  if(!object(input)||Object.keys(input).length!==keys.length||!keys.every(key=>Object.hasOwn(input,key))
    ||input.schemaVersion!==1||input.deploymentVersion!=='oneshot-v4-market-v1'||!isHash(input.genesisHash)||!isHash(input.anchorHash)
    ||typeof input.startBlock!=='string'||! /^(?:[1-9]\d{0,19})$/.test(input.startBlock))return fail();
  const network=nftExecutionNetwork(input);
  if(!network||network.mode==='base-sepolia'&&input.genesisHash.toLowerCase()!==BASE_SEPOLIA_GENESIS_HASH)return fail();
  const contract=(value:unknown):TokenContractIdentity=>{
    if(!object(value)||Object.keys(value).length!==2||!isAddress(value.address)||/^0x0{40}$/i.test(value.address)||!isHash(value.codeHash))return fail();
    return{address:value.address.toLowerCase() as Address,codeHash:value.codeHash.toLowerCase() as Hex};
  };
  const factory=contract(input.factory),poolManager=contract(input.poolManager),oracle=contract(input.oracle),quoter=contract(input.quoter);
  if(new Set([factory.address,poolManager.address,oracle.address,quoter.address]).size!==4
    ||network.mode==='base-sepolia'&&poolManager.address!==BASE_SEPOLIA_POOL_MANAGER.toLowerCase())return fail();
  const identity=network.mode==='local'?{mode:'local' as const,chainId:31337 as const}:{mode:'base-sepolia' as const,chainId:84532 as const};
  return{schemaVersion:1,deploymentVersion:'oneshot-v4-market-v1',...identity,genesisHash:input.genesisHash.toLowerCase() as Hex,
    startBlock:BigInt(input.startBlock),anchorHash:input.anchorHash.toLowerCase() as Hex,factory,poolManager,oracle,quoter};
}
export function tokenManifestJson(manifest:TokenManifest){return{...manifest,startBlock:manifest.startBlock.toString()};}
export function tokenManifestId(manifest:TokenManifest){
  const normalized=parseTokenManifest(tokenManifestJson(manifest));
  return createHash('sha256').update(JSON.stringify(tokenManifestJson(normalized))).digest('hex');
}
