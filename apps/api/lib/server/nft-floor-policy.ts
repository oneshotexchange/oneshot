import { randomBytes } from 'node:crypto';
import { keccak256, stringToHex, zeroHash, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseAssetAmount, applyProtectedFloor, guardedListingPermitTypedData, guardedPolicyPermitTypedData, type GuardedListingPermit, type GuardedPolicyPermit } from '@oneshot/evm';
import { putIfAbsent, getRecord } from './store';
import { stableJson } from './media';
import { ApiError } from './errors';

const namespace='oneshot_floor_policies';
const address=/^0x[\da-f]{40}$/i, hash=/^0x[\da-f]{64}$/i;
export type PrivateFloorPolicy={schemaVersion:1;deploymentId:string;collection:Address;creator:Address;enabled:boolean;floorRaw:string;salt:Hex;commitment:Hex;createdAt:string;ownerUserId:string};
export type FloorContext={deploymentId:string;collection:Address;creator:Address};
const fail=(code:string,message:string):never=>{throw new ApiError(409,code,message);};
function key(context:FloorContext,commitment:Hex){return `${context.deploymentId}:${context.collection.toLowerCase()}:${commitment.toLowerCase()}`;}
function commitmentFor(value:Omit<PrivateFloorPolicy,'commitment'|'createdAt'|'ownerUserId'>):Hex{
  return keccak256(stringToHex(stableJson({domain:'ONESHOT_PRIVATE_FLOOR_V1',...value})));
}

/** Policy data and eligibility stay server-side. Only a salted commitment enters calldata. */
export function createNftFloorPolicyService(environment:()=>Record<string,string|undefined>=()=>process.env){
  function eligible(creator:Address){
    const values=(environment().ONESHOT_FLOOR_CREATORS||'').split(/[\s,]+/).filter(Boolean);
    if(values.length>10_000||values.some(value=>!address.test(value)||/^0x0{40}$/i.test(value)))throw new ApiError(503,'FLOOR_CONFIG_INVALID','Configure a valid private creator eligibility list.');
    return values.some(value=>value.toLowerCase()===creator.toLowerCase());
  }
  async function resolve(context:FloorContext,commitment:Hex){
    if(commitment===zeroHash)return {enabled:false,floorRaw:'0',commitment} as const;
    const value=await getRecord<PrivateFloorPolicy>(namespace,key(context,commitment));
    if(!value||value.schemaVersion!==1||value.deploymentId!==context.deploymentId||value.collection!==context.collection||value.creator!==context.creator
      ||typeof value.enabled!=='boolean'||!/^(0|[1-9]\d{0,77})$/.test(value.floorRaw)||!hash.test(value.salt)||value.commitment!==commitment)fail('FLOOR_POLICY_UNAVAILABLE','The current marketplace policy is unavailable. Refresh before listing.');
    const stored=value!;
    const expected=commitmentFor({schemaVersion:1,deploymentId:stored.deploymentId,collection:stored.collection,creator:stored.creator,enabled:stored.enabled,floorRaw:stored.floorRaw,salt:stored.salt});
    let floor:bigint;try{floor=BigInt(stored.floorRaw);applyProtectedFloor(0n,floor);}catch{return fail('FLOOR_POLICY_UNAVAILABLE','The marketplace policy failed its amount check.');}
    if(expected!==stored.commitment||stored.enabled&&floor<=0n||!stored.enabled&&floor!==0n)fail('FLOOR_POLICY_UNAVAILABLE','The marketplace policy failed its integrity check.');
    return stored;
  }
  async function stage(context:FloorContext,enabled:boolean,price:string,existingCommitment?:Hex){
    if(enabled&&!eligible(context.creator))throw new ApiError(404,'NOT_FOUND','Settings not available.');
    let floor:bigint;try{floor=enabled?parseAssetAmount(price,18):0n;}catch{return fail('INVALID_FLOOR','Enter an exact native ETH minimum with at most 18 decimals.');}
    if(enabled&&floor<=0n)fail('INVALID_FLOOR','Choose a positive protected minimum.');
    if(existingCommitment){
      const existing=await resolve(context,existingCommitment);
      if(existing.enabled!==enabled||existing.floorRaw!==floor.toString())fail('REVIEW_CHANGED','The proposed listing settings changed. Prepare a fresh review.');
      return existing;
    }
    const body={schemaVersion:1 as const,deploymentId:context.deploymentId,collection:context.collection,creator:context.creator,enabled,floorRaw:floor.toString(),salt:`0x${randomBytes(32).toString('hex')}` as Hex};
    const commitment=commitmentFor(body),ownerUserId=`${context.deploymentId}:${context.collection}`;
    const record:PrivateFloorPolicy={...body,commitment,createdAt:new Date().toISOString(),ownerUserId};
    // Historical commitments remain available for canonical reorg recovery.
    // A lifetime quota would eventually prevent the creator from disabling the mode.
    // Creator-only, rate-limited reviews write immutable history for reorg recovery.
    await putIfAbsent(namespace,key(context,commitment),record);
    return await resolve(context,commitment);
  }
  function signer(expected:Address){
    const secret=environment().ONESHOT_LISTING_AUTHORITY_PRIVATE_KEY;
    try{
      if(!secret||!/^0x[\da-f]{64}$/i.test(secret))throw new Error();
      const account=privateKeyToAccount(secret as Hex);
      if(account.address.toLowerCase()!==expected.toLowerCase())throw new Error();
      return account;
    }catch{throw new ApiError(503,'LISTING_AUTHORITY_UNAVAILABLE','The guarded marketplace listing authority is not configured.');}
  }
  async function signListing(market:Address,authority:Address,message:GuardedListingPermit){
    try{return await signer(authority).signTypedData(guardedListingPermitTypedData({chainId:31337,verifyingContract:market},message));}
    catch(error){if(error instanceof ApiError)throw error;throw new ApiError(503,'LISTING_AUTHORITY_UNAVAILABLE','The listing authorization could not be prepared.');}
  }
  async function signPolicy(market:Address,authority:Address,message:GuardedPolicyPermit){
    try{return await signer(authority).signTypedData(guardedPolicyPermitTypedData({chainId:31337,verifyingContract:market},message));}
    catch(error){if(error instanceof ApiError)throw error;throw new ApiError(503,'LISTING_AUTHORITY_UNAVAILABLE','The settings authorization could not be prepared.');}
  }
  function assertAuthority(authority:Address){signer(authority);}
  return{eligible,resolve,stage,signListing,signPolicy,assertAuthority};
}
