import {decodeFunctionResult,encodeFunctionData,encodeFunctionResult,encodeAbiParameters,keccak256,parseAbi,zeroAddress,type Abi,type Address,type Hex} from 'viem';
import {TOKEN_MARKET_ABI,TOKEN_MARKET_FACTORY_ABI,MARKET_TOKEN_ABI,type RpcReadMethod,type RpcVerification,nftExecutionNetwork} from '@oneshot/evm';
import type {IndexedTokenMarket} from '../../../packages/evm/src/indexed-tokens';
import {isAddress,isData,isHash} from './manifest';
import {IndexerError,type Block} from './types';
import {parseTokenManifest,tokenManifestJson,type TokenManifest} from './token-manifest';
import {tokenMarketDto,validateTokenSnapshot,type TokenSnapshot} from './token-snapshot';

type TokenRpc={verification:RpcVerification;readRpc(method:RpcReadMethod,params?:readonly unknown[]):Promise<unknown>};
type Budget={active:boolean;calls:number;deadline:number};
const referenceAbi=parseAbi(['function poolManager() view returns(address)','function factory() view returns(address)']);
const fail=(code='TOKEN_RPC_DATA_INVALID'):never=>{throw new IndexerError(code);};
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const address=(value:unknown):Address=>isAddress(value)&&value.toLowerCase()!==zeroAddress?value.toLowerCase() as Address:fail();
const amount=(value:unknown,bits=256):bigint=>typeof value==='bigint'&&value>=0n&&value<2n**BigInt(bits)?value:fail();
const quantity=(value:unknown):bigint=>typeof value==='string'&&/^0x(?:0|[1-9a-f][\da-f]{0,63})$/i.test(value)?BigInt(value):fail();
const tag=(value:bigint)=>`0x${value.toString(16)}`;

/** Hash-selected contract snapshots. No signer, receipts, inferred pricing or event aggregation. */
export class VerifiedTokenSource {
  constructor(private readonly rpc:TokenRpc){}
  async height(){return quantity(await this.rpc.readRpc('eth_blockNumber'));}
  async block(number:bigint):Promise<Block>{return this.readBlock(number);}
  private async read(method:RpcReadMethod,params:readonly unknown[],budget?:Budget){
    if(budget&&(!budget.active||Date.now()>=budget.deadline||++budget.calls>900))return fail('TOKEN_SOURCE_LIMIT');
    return this.rpc.readRpc(method,params);
  }
  private async readBlock(number:bigint,budget?:Budget):Promise<Block>{
    if(number<0n||number>=2n**256n)return fail();
    const row=await this.read('eth_getBlockByNumber',[tag(number),false],budget);
    if(!object(row)||quantity(row.number)!==number||!isHash(row.hash)||!isHash(row.parentHash))return fail();
    return{number,hash:row.hash.toLowerCase() as Hex,parentHash:row.parentHash.toLowerCase() as Hex,timestamp:quantity(row.timestamp)};
  }
  private async bounded<T>(run:(budget:Budget)=>Promise<T>):Promise<T>{
    const budget:Budget={active:true,calls:0,deadline:Date.now()+30_000};let timer:ReturnType<typeof setTimeout>|undefined;
    const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{budget.active=false;reject(new IndexerError('TOKEN_SOURCE_LIMIT'));},30_000);});
    try{return await Promise.race([run(budget),timeout]);}finally{budget.active=false;if(timer)clearTimeout(timer);}
  }
  private async code(at:Block,selected:Address,budget:Budget):Promise<Hex>{
    const code=await this.read('eth_getCode',[selected,{blockHash:at.hash,requireCanonical:true}],budget);
    if(!isData(code)||code==='0x'||code.length>131_074)return fail('TOKEN_CONTRACT_CODE_MISMATCH');
    return keccak256(code);
  }
  private async call(at:Block,to:Address,abi:Abi,functionName:string,args:readonly unknown[],budget:Budget):Promise<unknown>{
    const data=await this.read('eth_call',[{to,data:encodeFunctionData({abi,functionName,args})},{blockHash:at.hash,requireCanonical:true}],budget);
    if(!isData(data))return fail();
    try{
      const result=decodeFunctionResult({abi,functionName,data});
      if(encodeFunctionResult({abi,functionName,result}).toLowerCase()!==data.toLowerCase())return fail();
      return result;
    }catch{return fail();}
  }
  private async canonical(at:Block,budget:Budget){
    const observed=await this.readBlock(at.number,budget);
    if(observed.hash!==at.hash||observed.parentHash!==at.parentHash||observed.timestamp!==at.timestamp)return fail('TOKEN_CHAIN_MOVED');
  }
  private async core(input:TokenManifest,at:Block,budget:Budget){
    const manifest=parseTokenManifest(tokenManifestJson(input)),seen=this.rpc.verification;
    if(!nftExecutionNetwork(manifest)||seen.mode!==manifest.mode||seen.chainId!==manifest.chainId||seen.genesisHash.toLowerCase()!==manifest.genesisHash)return fail('TOKEN_CHAIN_IDENTITY_MISMATCH');
    if(at.number<manifest.startBlock||(await this.readBlock(0n,budget)).hash!==manifest.genesisHash)return fail('TOKEN_CHAIN_IDENTITY_MISMATCH');
    if((await this.readBlock(manifest.startBlock-1n,budget)).hash!==manifest.anchorHash)return fail('TOKEN_DEPLOYMENT_ANCHOR_CHANGED');
    await this.canonical(at,budget);
    for(const contract of [manifest.factory,manifest.poolManager,manifest.oracle,manifest.quoter])if(await this.code(at,contract.address,budget)!==contract.codeHash)return fail('TOKEN_CONTRACT_CODE_MISMATCH');
    const read=(to:Address,name:string)=>this.call(at,to,referenceAbi,name,[],budget);
    const manager=address(await this.call(at,manifest.factory.address,TOKEN_MARKET_FACTORY_ABI,'poolManager',[],budget));
    const oracle=address(await this.call(at,manifest.factory.address,TOKEN_MARKET_FACTORY_ABI,'oracle',[],budget));
    const platformRecipient=address(await this.call(at,manifest.factory.address,TOKEN_MARKET_FACTORY_ABI,'platformRecipient',[],budget));
    if(manager!==manifest.poolManager.address||oracle!==manifest.oracle.address||address(await read(oracle,'poolManager'))!==manager
      ||address(await read(manifest.quoter.address,'factory'))!==manifest.factory.address||address(await read(manifest.quoter.address,'poolManager'))!==manager)return fail('TOKEN_PROTOCOL_REFERENCE_MISMATCH');
    if((BigInt(oracle)&((1n<<14n)-1n))!==((1n<<12n)|(1n<<6n)))return fail('TOKEN_ORACLE_FLAGS_MISMATCH');
    return{manifest,platformRecipient};
  }
  /** Suitable for execution adapters: exact core code/references at one canonical checkpoint. */
  async verify(manifest:TokenManifest,at?:Block){return this.bounded(async budget=>{
    const block=at??await this.readBlock(quantity(await this.read('eth_blockNumber',[],budget)),budget);
    const core=await this.core(manifest,block,budget);await this.canonical(block,budget);return{block,platformRecipient:core.platformRecipient};
  });}
  private async market(manifest:TokenManifest,selected:Address,at:Block,platform:Address,budget:Budget):Promise<IndexedTokenMarket>{
    if(await this.call(at,manifest.factory.address,TOKEN_MARKET_FACTORY_ABI,'isMarket',[selected],budget)!==true)return fail('TOKEN_MARKET_UNREGISTERED');
    const read=(name:string)=>this.call(at,selected,TOKEN_MARKET_ABI,name,[],budget);
    const token=address(await read('token'));
    if(token===selected||address(await this.call(at,manifest.factory.address,TOKEN_MARKET_FACTORY_ABI,'marketForToken',[token],budget))!==selected
      ||address(await read('factory'))!==manifest.factory.address||address(await read('poolManager'))!==manifest.poolManager.address
      ||address(await read('oracle'))!==manifest.oracle.address||address(await read('platformRecipient'))!==platform
      ||await read('deploymentChainId')!==BigInt(manifest.chainId)||await read('initialized')!==true||await read('isMarketLaunch')!==true)return fail('TOKEN_MARKET_REFERENCE_MISMATCH');
    const tokenRead=(name:string)=>this.call(at,token,MARKET_TOKEN_ABI,name,[],budget);
    if(address(await tokenRead('market'))!==selected||await tokenRead('decimals')!==8)return fail('TOKEN_MARKET_REFERENCE_MISMATCH');
    const key=await read('poolKey') as Record<string,unknown>;
    if(!object(key)||key.currency0!==zeroAddress||address(key.currency1)!==token||key.fee!==2500||key.tickSpacing!==10||address(key.hooks)!==manifest.oracle.address)return fail('TOKEN_POOL_REFERENCE_MISMATCH');
    const poolId=await read('poolId');
    const expected=keccak256(encodeAbiParameters([{type:'address'},{type:'address'},{type:'uint24'},{type:'int24'},{type:'address'}],[zeroAddress,token,2500,10,manifest.oracle.address]));
    if(poolId!==expected)return fail('TOKEN_POOL_REFERENCE_MISMATCH');
    return tokenMarketDto({schemaVersion:1,market:selected,token,creator:address(await read('creator')),platformRecipient:platform,
      name:await tokenRead('name'),symbol:await tokenRead('symbol'),tokenDecimals:8,initialSupplyRaw:amount(await tokenRead('INITIAL_SUPPLY')).toString(),totalSupplyRaw:amount(await tokenRead('totalSupply')).toString(),
      executionFeeBps:await read('executionFeeBps'),liquidityAndBurn:await read('liquidityAndBurn'),openingValuationNativeRaw:amount(await read('openingValuationNative')).toString(),
      effectiveOpeningValuationNativeRaw:amount(await read('effectiveOpeningValuationNative')).toString(),effectiveUpperValuationNativeRaw:amount(await read('effectiveUpperValuationNative')).toString(),
      poolId,lpFeePips:2500,tickSpacing:10,tickLower:await read('tickLower'),tickUpper:await read('tickUpper'),lockedLiquidityRaw:amount(await read('lockedLiquidity'),128).toString(),
      lockedRoundingDustRaw:amount(await read('lockedRoundingDust')).toString(),observedMarketCodeHash:await this.code(at,selected,budget),observedTokenCodeHash:await this.code(at,token,budget)});
  }
  /** Registry and runtime checks reusable by quote/review services; no wallet calls are generated. */
  async verifyMarket(manifest:TokenManifest,selected:Address,at:Block){return this.bounded(async budget=>{
    const core=await this.core(manifest,at,budget),market=await this.market(core.manifest,address(selected),at,core.platformRecipient,budget);
    await this.canonical(at,budget);return market;
  });}
  /** Indexing only: a market may be created before the separate quoter deployment.
   * Full core identity is independently proved at the target. Historical factory,
   * manager, oracle, registry, market and token are proved at their exact hash.
   * Execution and current public reads must continue to use verifyMarket. */
  async verifyHistoricalMarket(manifest:TokenManifest,selected:Address,at:Block,verifiedTarget:Block){return this.bounded(async budget=>{
    if(at.number<manifest.startBlock||at.number>verifiedTarget.number)return fail('TOKEN_CHAIN_IDENTITY_MISMATCH');
    const core=await this.core(manifest,verifiedTarget,budget);await this.canonical(at,budget);
    for(const contract of [core.manifest.factory,core.manifest.poolManager,core.manifest.oracle])if(await this.code(at,contract.address,budget)!==contract.codeHash)return fail('TOKEN_CONTRACT_CODE_MISMATCH');
    const market=await this.market(core.manifest,address(selected),at,core.platformRecipient,budget);
    await this.canonical(at,budget);await this.canonical(verifiedTarget,budget);return market;
  });}
  /** Bounded public-chain wallet proof. No signer, native balance or valuation is inferred. */
  async verifyWalletBalances(manifest:TokenManifest,selected:readonly Address[],wallet:Address,at:Block){return this.bounded(async budget=>{
    if(!Array.isArray(selected)||selected.length<1||selected.length>5||new Set(selected.map(value=>address(value))).size!==selected.length)return fail('TOKEN_SOURCE_LIMIT');
    const owner=address(wallet),core=await this.core(manifest,at,budget),holdings:{market:IndexedTokenMarket;balanceRaw:string}[]=[];
    for(const candidate of selected){
      const market=await this.market(core.manifest,address(candidate),at,core.platformRecipient,budget);
      const balance=amount(await this.call(at,market.token as Address,MARKET_TOKEN_ABI,'balanceOf',[owner],budget));
      if(balance>BigInt(market.totalSupplyRaw))return fail('TOKEN_WALLET_BALANCE_INVALID');
      holdings.push({market,balanceRaw:balance.toString()});
    }
    await this.canonical(at,budget);return holdings;
  });}
  /** A complete bounded snapshot. Exceeding the limit preserves the previous checkpoint. */
  async snapshot(manifest:TokenManifest,maximumMarkets=10):Promise<TokenSnapshot>{return this.bounded(async budget=>{
    if(!Number.isSafeInteger(maximumMarkets)||maximumMarkets<1||maximumMarkets>25)return fail('TOKEN_SOURCE_LIMIT');
    const block=await this.readBlock(quantity(await this.read('eth_blockNumber',[],budget)),budget),core=await this.core(manifest,block,budget);
    const count=amount(await this.call(block,manifest.factory.address,TOKEN_MARKET_FACTORY_ABI,'marketCount',[],budget));
    if(count>BigInt(maximumMarkets))return fail('TOKEN_SOURCE_LIMIT');
    const markets:IndexedTokenMarket[]=[];
    for(let index=0n;index<count;index++)markets.push(await this.market(core.manifest,address(await this.call(block,manifest.factory.address,TOKEN_MARKET_FACTORY_ABI,'markets',[index],budget)),block,core.platformRecipient,budget));
    await this.canonical(block,budget);return validateTokenSnapshot({block,markets});
  });}
}
