import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { parseNftExplorerSelection } from './nft-item-discovery';
const collection=`0x${'1'.repeat(40)}`;
const parse=(query:string)=>parseNftExplorerSelection(new NextRequest(`http://localhost/api/oneshot/indexed/collections/${collection}/explore?${query}`),collection);
describe('collection explorer exact query boundaries',()=>{
  it('treats serials as exact IDs and literal name text as a full collection query',()=>{
    expect(parse('q=%2317')).toMatchObject({q:'#17',serial:'17'});expect(parse('q=17').scope).toBe(parse('q=%2317').scope);
    expect(parse('q=%20Nebula%20%25_%20')).toMatchObject({q:'Nebula %_',serial:null});expect(parse('q=Nebula').scope).toBe(parse('q=nebula').scope);
  });
  it('retains exact prices beyond Number precision and binds the normalized range into cursor scope',()=>{
    const value=parse('availability=listed&sort=price-asc&minPrice=9007199.254740993123456789&maxPrice=9007199.254740993123456789');expect(value.minPrice).toBe('9007199254740993123456789');expect(value.maxPrice).toBe(value.minPrice);
    expect(parse('availability=listed&minPrice=1.0').scope).toBe(parse('availability=listed&minPrice=1').scope);
    expect(parse('availability=listed&minPrice=1').scope).not.toBe(parse('availability=listed&minPrice=1.000000000000000001').scope);
  });
  it.each(['q=a&q=b','sort=volume','availability=hidden','availability=all&minPrice=1','availability=unlisted&sort=price-asc','availability=listed&minPrice=-1','availability=listed&minPrice=0.0000000000000000001','availability=listed&minPrice=2&maxPrice=1','owner=0x0','owner=','limit=0','limit=51','traits=bad+encoding','traits=','cursor=','unknown=1','q=bad%00name'])('rejects invalid or ambiguous query %s',query=>{expect(()=>parse(query)).toThrow();});
  it('requires canonical typed trait clauses and a bounded distinct selection',()=>{
    const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
    expect(parse(`traits=${encode([{trait_type:'Level',value:'7'}])}`).traits).toEqual([{trait_type:'Level',value:'7'}]);
    expect(parse(`traits=${encode([{trait_type:'Level',value:7}])}`).scope).not.toBe(parse(`traits=${encode([{trait_type:'Level',value:'7'}])}`).scope);
    for(const value of [[{trait_type:'A',value:'B'},{trait_type:'A',value:'B'}],[{trait_type:'Z',value:1},{trait_type:'A',value:1}],Array.from({length:11},(_,value)=>({trait_type:'A',value})),[{trait_type:'A',value:{hidden:true}}]])expect(()=>parse(`traits=${encode(value)}`)).toThrow();
  });
});
