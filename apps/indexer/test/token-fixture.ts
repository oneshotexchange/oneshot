import {vi} from 'vitest';
import {decodeFunctionData,encodeAbiParameters,encodeFunctionResult,keccak256,parseAbi,zeroAddress,type Abi,type Address,type Hex} from 'viem';
import {BASE_SEPOLIA_GENESIS_HASH,BASE_SEPOLIA_POOL_MANAGER,TOKEN_MARKET_ABI,TOKEN_MARKET_FACTORY_ABI,MARKET_TOKEN_ABI,type RpcReadMethod,type RpcVerification} from '@oneshot/evm';
import {parseTokenManifest} from '../src/token-manifest';
import {VerifiedTokenSource} from '../src/token-source';
export const tokenHash=(n:number):Hex=>`0x${n.toString(16).padStart(64,'0')}`;
export const tokenAddress=(n:number):Address=>`0x${n.toString(16).padStart(40,'0')}`;
const referenceAbi=parseAbi(['function poolManager() view returns(address)','function factory() view returns(address)']);
/** Simulated RPC only; no address is asserted to be deployed on a public network. */
export function tokenFixture(options:{base?:boolean;factory?:Address;genesis?:Hex}={}){
  const factory=options.factory??tokenAddress(1),poolManager=options.base?BASE_SEPOLIA_POOL_MANAGER.toLowerCase() as Address:tokenAddress(2),oracle=tokenAddress(0x1040),quoter=tokenAddress(4),market=tokenAddress(5),token=tokenAddress(6),creator=tokenAddress(7),platform=tokenAddress(8);
  const code='0x60016000' as Hex,codeHash=keccak256(code),genesis=options.base?BASE_SEPOLIA_GENESIS_HASH:options.genesis??tokenHash(100);
  const manifest=parseTokenManifest({schemaVersion:1,deploymentVersion:'oneshot-v4-market-v1',mode:options.base?'base-sepolia':'local',chainId:options.base?84532:31337,
    genesisHash:genesis,startBlock:'1',anchorHash:genesis,factory:{address:factory,codeHash},poolManager:{address:poolManager,codeHash},oracle:{address:oracle,codeHash},quoter:{address:quoter,codeHash}});
  const state={head:3n,count:1n,registered:true,tokenMarket:market,marketChainId:BigInt(manifest.chainId),quoterFactory:factory,
    totalSupply:100000000000000000n,walletBalance:0n,codeOverrides:new Map<string,Hex>(),hashes:new Map<bigint,Hex>(),reorgDuringSupply:false};
  const block=(number:bigint)=>({number,hash:number===0n?genesis:state.hashes.get(number)??tokenHash(100+Number(number)),parentHash:number<=1n?genesis:state.hashes.get(number-1n)??tokenHash(99+Number(number)),timestamp:1700000000n+number});
  const poolId=keccak256(encodeAbiParameters([{type:'address'},{type:'address'},{type:'uint24'},{type:'int24'},{type:'address'}],[zeroAddress,token,2500,10,oracle]));
  const verification:RpcVerification={mode:manifest.mode,chainId:manifest.chainId,genesisHash:manifest.genesisHash,latestBlock:state.head,checkedAt:'2026-11-16T00:00:00Z',provider:{label:'custom',verifiedSupport:false},genesisMatched:options.base?true:null};
  const readRpc=vi.fn(async(method:RpcReadMethod,params:readonly unknown[]=[]):Promise<unknown>=>{
    if(method==='eth_blockNumber')return`0x${state.head.toString(16)}`;
    if(method==='eth_getBlockByNumber'){const row=block(BigInt(params[0] as string));return{number:`0x${row.number.toString(16)}`,hash:row.hash,parentHash:row.parentHash,timestamp:`0x${row.timestamp.toString(16)}`};}
    if(method==='eth_getCode')return state.codeOverrides.get(params[0] as string)??code;
    if(method!=='eth_call')throw new Error('Unexpected token fixture RPC method');
    const call=params[0] as {to:Address;data:Hex};const abi:Abi=call.to===factory?TOKEN_MARKET_FACTORY_ABI:call.to===market?TOKEN_MARKET_ABI:call.to===token?MARKET_TOKEN_ABI:referenceAbi;
    const decoded=decodeFunctionData({abi,data:call.data});let result:unknown;
    switch(decoded.functionName){
      case 'poolManager':result=poolManager;break;case 'oracle':result=oracle;break;case 'platformRecipient':result=platform;break;
      case 'factory':result=call.to===quoter?state.quoterFactory:factory;break;case 'marketCount':result=state.count;break;case 'markets':result=market;break;
      case 'isMarket':result=state.registered;break;case 'marketForToken':result=market;break;case 'token':result=token;break;case 'creator':result=creator;break;
      case 'deploymentChainId':result=state.marketChainId;break;case 'initialized':case 'isMarketLaunch':result=true;break;case 'market':result=state.tokenMarket;break;
      case 'decimals':result=8;break;case 'name':result='Canonical token';break;case 'symbol':result='SHOT';break;case 'INITIAL_SUPPLY':result=100000000000000000n;break;
      case 'totalSupply':result=state.totalSupply;if(state.reorgDuringSupply)state.hashes.set(state.head,tokenHash(999));break;
      case 'balanceOf':result=state.walletBalance;break;
      case 'poolKey':result={currency0:zeroAddress,currency1:token,fee:2500,tickSpacing:10,hooks:oracle};break;case 'poolId':result=poolId;break;
      case 'executionFeeBps':result=100;break;case 'liquidityAndBurn':result=true;break;case 'openingValuationNative':case 'effectiveOpeningValuationNative':result=5000000000000000000n;break;
      case 'effectiveUpperValuationNative':result=10000000000000000000n;break;case 'tickLower':result=-100;break;case 'tickUpper':result=100;break;case 'lockedLiquidity':result=123456789n;break;case 'lockedRoundingDust':result=3n;break;
      default:throw new Error('Unexpected token fixture contract read');
    }
    return encodeFunctionResult({abi,functionName:decoded.functionName,result});
  });
  return{manifest,state,source:new VerifiedTokenSource({verification,readRpc}),readRpc,verification,block,factory,poolManager,oracle,quoter,market,token,creator,platform,codeHash};
}
