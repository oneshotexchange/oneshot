import { describe, expect, it } from 'vitest';
import { concatHex, decodeEventLog, decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, stringToHex, zeroAddress, zeroHash, type Address, type Hex } from 'viem';
import { UINT256_MAX } from '../src/economics';
import { GUARDED_MARKETPLACE_ABI, guardedListingPermitHash, guardedListingPermitTypedData, guardedPolicyPermitHash, guardedPolicyPermitTypedData, type GuardedListingPermit, type GuardedMarketContext, type GuardedPolicyPermit } from '../src/guarded-market';

const address=(value:number)=>`0x${value.toString(16).padStart(40,'0')}` as Address;
const hash=(value:number)=>`0x${value.toString(16).padStart(64,'0')}` as Hex;
const context:GuardedMarketContext={chainId:31337,verifyingContract:address(1)};
const listing=():GuardedListingPermit=>({seller:address(2),collection:address(3),tokenId:4n,totalPrice:9_123_456_789_123_456_789n,nonce:0n,policyCommitment:hash(5),deadline:1_900_000_000n,deploymentSalt:hash(6)});
const policy=():GuardedPolicyPermit=>({creator:address(7),collection:address(3),commitment:hash(8),expectedCommitment:zeroHash,deadline:1_900_000_000n,deploymentSalt:hash(6)});
const domainHash=()=>keccak256(encodeAbiParameters([
  {type:'bytes32'},{type:'bytes32'},{type:'bytes32'},{type:'uint256'},{type:'address'},
],[keccak256(stringToHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')),
  keccak256(stringToHex('OneshotGuardedMarketplace')),keccak256(stringToHex('1')),31337n,context.verifyingContract]));

describe('guarded marketplace authorization binding',()=>{
  it('matches independent Solidity-style EIP-712 domain and listing struct encoding',()=>{
    const value=listing();
    const structHash=keccak256(encodeAbiParameters([
      {type:'bytes32'},{type:'address'},{type:'address'},{type:'uint256'},{type:'uint256'},
      {type:'uint256'},{type:'bytes32'},{type:'uint256'},{type:'bytes32'},
    ],[keccak256(stringToHex('ListingPermit(address seller,address collection,uint256 tokenId,uint256 totalPrice,uint256 nonce,bytes32 policyCommitment,uint256 deadline,bytes32 deploymentSalt)')),
      value.seller,value.collection,value.tokenId,value.totalPrice,value.nonce,value.policyCommitment,value.deadline,value.deploymentSalt]));
    expect(guardedListingPermitHash(context,value)).toBe(keccak256(concatHex(['0x1901',domainHash(),structHash])));
  });

  it('matches independent Solidity-style policy encoding, including expected previous commitment',()=>{
    const value=policy();
    const structHash=keccak256(encodeAbiParameters([
      {type:'bytes32'},{type:'address'},{type:'address'},{type:'bytes32'},{type:'bytes32'},{type:'uint256'},{type:'bytes32'},
    ],[keccak256(stringToHex('PolicyPermit(address creator,address collection,bytes32 commitment,bytes32 expectedCommitment,uint256 deadline,bytes32 deploymentSalt)')),
      value.creator,value.collection,value.commitment,value.expectedCommitment,value.deadline,value.deploymentSalt]));
    expect(guardedPolicyPermitHash(context,value)).toBe(keccak256(concatHex(['0x1901',domainHash(),structHash])));
  });

  it('binds every listing field, one-wei price changes and the exact marketplace deployment',()=>{
    const value=listing(),original=guardedListingPermitHash(context,value);
    const changed:Partial<GuardedListingPermit>[]=[{seller:address(20)},{collection:address(30)},{tokenId:value.tokenId+1n},
      {totalPrice:value.totalPrice+1n},{nonce:1n},{policyCommitment:hash(50)},{deadline:value.deadline+1n},{deploymentSalt:hash(60)}];
    for(const change of changed)expect(guardedListingPermitHash(context,{...value,...change})).not.toBe(original);
    expect(guardedListingPermitHash({...context,verifyingContract:address(10)},value)).not.toBe(original);
  });

  it('binds every policy field and the comparison-and-set commitment',()=>{
    const value=policy(),original=guardedPolicyPermitHash(context,value);
    const changed:Partial<GuardedPolicyPermit>[]=[{creator:address(70)},{collection:address(30)},{commitment:hash(80)},
      {expectedCommitment:hash(90)},{deadline:value.deadline+1n},{deploymentSalt:hash(60)}];
    for(const change of changed)expect(guardedPolicyPermitHash(context,{...value,...change})).not.toBe(original);
    expect(guardedPolicyPermitHash({...context,verifyingContract:address(10)},value)).not.toBe(original);
  });

  it('takes frozen snapshots while preserving the full uint256 deadline and price domain',()=>{
    const mutableContext={...context},input=listing(),data=guardedListingPermitTypedData(mutableContext,{...input,totalPrice:UINT256_MAX,nonce:UINT256_MAX,deadline:UINT256_MAX});
    mutableContext.verifyingContract=address(100);input.seller=address(200);input.totalPrice=1n;
    expect(data.domain).toEqual({name:'OneshotGuardedMarketplace',version:'1',chainId:31337,verifyingContract:address(1)});
    expect(data.message).toMatchObject({seller:address(2),totalPrice:UINT256_MAX,nonce:UINT256_MAX,deadline:UINT256_MAX});
    for(const value of [data,data.domain,data.message,data.types,data.types.ListingPermit,...data.types.ListingPermit])expect(Object.isFrozen(value)).toBe(true);
    const policyData=guardedPolicyPermitTypedData(context,{...policy(),deadline:UINT256_MAX});
    for(const value of [policyData,policyData.domain,policyData.message,policyData.types,policyData.types.PolicyPermit,...policyData.types.PolicyPermit])expect(Object.isFrozen(value)).toBe(true);
    expect(policyData.message.deadline).toBe(UINT256_MAX);
  });

  it.each([1,8453,31338,0,Number.NaN])('refuses non-local chain IDs: %s',chainId=>{
    expect(()=>guardedListingPermitTypedData({...context,chainId},listing())).toThrow('31337');
    expect(()=>guardedPolicyPermitTypedData({...context,chainId},policy())).toThrow('31337');
  });

  it('rejects zero or malformed identity addresses',()=>{
    for(const invalid of [zeroAddress,'0x1234','not-an-address',null]){
      expect(()=>guardedListingPermitTypedData({...context,verifyingContract:invalid as Address},listing())).toThrow();
      for(const key of ['seller','collection'] as const)expect(()=>guardedListingPermitTypedData(context,{...listing(),[key]:invalid} as GuardedListingPermit)).toThrow();
      for(const key of ['creator','collection'] as const)expect(()=>guardedPolicyPermitTypedData(context,{...policy(),[key]:invalid} as GuardedPolicyPermit)).toThrow();
    }
  });

  it('rejects invalid quantities, non-bigint values and malformed commitments',()=>{
    for(const invalid of [-1n,UINT256_MAX+1n,1,'1',null]){
      for(const key of ['tokenId','totalPrice','nonce','deadline'] as const)expect(()=>guardedListingPermitTypedData(context,{...listing(),[key]:invalid} as GuardedListingPermit)).toThrow();
      expect(()=>guardedPolicyPermitTypedData(context,{...policy(),deadline:invalid} as GuardedPolicyPermit)).toThrow();
    }
    for(const invalid of ['0x','0x1234',`0x${'ab'.repeat(33)}`,null]){
      for(const key of ['policyCommitment','deploymentSalt'] as const)expect(()=>guardedListingPermitTypedData(context,{...listing(),[key]:invalid} as GuardedListingPermit)).toThrow();
      for(const key of ['commitment','expectedCommitment','deploymentSalt'] as const)expect(()=>guardedPolicyPermitTypedData(context,{...policy(),[key]:invalid} as GuardedPolicyPermit)).toThrow();
    }
  });
});

describe('guarded marketplace ABI',()=>{
  it('has no unguarded list entry point, and preserves ordinary settlement calls',()=>{
    expect(GUARDED_MARKETPLACE_ABI.some(item=>item.type==='function'&&String(item.name)==='list')).toBe(false);
    for(const name of ['factory','treasury','nextListingId','listings','activeListing','pending','buy','cancel','cancelTo','claimTo'])expect(GUARDED_MARKETPLACE_ABI.some(item=>item.type==='function'&&item.name===name)).toBe(true);
  });

  it('round-trips authorized listings with exact values and opaque signature bytes',()=>{
    const value=listing(),signature=`0x${'ab'.repeat(65)}` as Hex;
    const args=[value.collection,value.tokenId,value.totalPrice,value.nonce,value.policyCommitment,value.deadline,signature] as const;
    const data=encodeFunctionData({abi:GUARDED_MARKETPLACE_ABI,functionName:'listAuthorized',args});
    expect(decodeFunctionData({abi:GUARDED_MARKETPLACE_ABI,data})).toEqual({functionName:'listAuthorized',args});
  });

  it('round-trips policy transitions and decodes their commitment-only event',()=>{
    const value=policy(),signature=`0x${'cd'.repeat(65)}` as Hex;
    const args=[value.collection,value.commitment,value.expectedCommitment,value.deadline,signature] as const;
    expect(decodeFunctionData({abi:GUARDED_MARKETPLACE_ABI,data:encodeFunctionData({abi:GUARDED_MARKETPLACE_ABI,functionName:'setPolicyCommitment',args})})).toEqual({functionName:'setPolicyCommitment',args});
    const topics=encodeEventTopics({abi:GUARDED_MARKETPLACE_ABI,eventName:'PolicyCommitted',args:{collection:value.collection,previousCommitment:value.expectedCommitment,commitment:value.commitment}});
    expect(decodeEventLog({abi:GUARDED_MARKETPLACE_ABI,data:'0x',topics:topics as [Hex,...Hex[]]})).toMatchObject({eventName:'PolicyCommitted',args:{collection:value.collection,previousCommitment:value.expectedCommitment,commitment:value.commitment}});
  });
});
