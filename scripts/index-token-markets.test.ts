import {describe,expect,it} from 'vitest';
import {parseTokenSnapshotArguments} from './index-token-markets';
describe('explicit one-pass token snapshot flags',()=>{
  it('requires a manifest and bounds the complete factory scan',()=>{
    expect(parseTokenSnapshotArguments(['--manifest','token.json'])).toEqual({manifest:'token.json',envFile:undefined,maximumMarkets:10});
    expect(parseTokenSnapshotArguments(['--manifest','token.json','--max-markets','25'])).toMatchObject({maximumMarkets:25});
    for(const args of [[],['--manifest','x','--max-markets','26'],['--manifest','x','--max-markets','0'],['--manifest','x','--watch'],['--manifest','x','--manifest','y']])expect(()=>parseTokenSnapshotArguments(args)).toThrow('CLI_ARGUMENTS_INVALID');
  });
});
