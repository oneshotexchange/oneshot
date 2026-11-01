import { describe,it,expect } from 'vitest';
import { Account } from '@aptos-labs/ts-sdk';
import { parseSignedMessage,verifyEd25519Proof } from './auth';
import { canonicalPublicUrl,isPublicIpv4 } from './public-fetch';
import { allowlistTree,draftSchema } from './drafts';
import { createHash } from 'node:crypto';
import { stableJson } from './media';
import { normalizeAddress } from './config';
import { boundedBody } from './http';

describe('wallet session proof',()=>{
  const account=Account.generate();
  const message='APTOS\nchainId: 2\nmessage: Sign in to B20 at https://b20.example\nnonce: 123';
  it('verifies the actual key and exact signed message',()=>{
    const signature=account.sign(new TextEncoder().encode(message)).toString();
    expect(verifyEd25519Proof(account.publicKey.toString(),signature,message,account.publicKey.authKey().toString())).toBe(true);
    expect(verifyEd25519Proof(account.publicKey.toString(),signature,message+'tampered',account.publicKey.authKey().toString())).toBe(false);
    expect(verifyEd25519Proof(account.publicKey.toString(),signature,message,Account.generate().publicKey.authKey().toString())).toBe(false);
  });
  it('rejects duplicate fields and a mainnet challenge',()=>{
    expect(parseSignedMessage(message).nonce).toBe('123');
    expect(()=>parseSignedMessage(message+'\nnonce: 456')).toThrow();
    expect(()=>parseSignedMessage(message.replace('chainId: 2','chainId: 1'))).toThrow();
  });
});
describe('metadata import boundaries',()=>{
  it('validates Unicode text against Move UTF-8 byte limits before preparing assets',()=>{
    const input={name:'é'.repeat(50),description:'é'.repeat(1024),maxSupply:1};
    expect(draftSchema.safeParse(input).success).toBe(true);
    expect(draftSchema.safeParse({...input,name:'é'.repeat(51)}).success).toBe(false);
    expect(draftSchema.safeParse({...input,description:'é'.repeat(1025)}).success).toBe(false);
  });
  it('rejects private, loopback, metadata and shared IP ranges',()=>{
    for(const ip of ['127.0.0.1','10.1.2.3','172.16.4.5','192.168.0.1','169.254.169.254','100.64.0.1','0.0.0.0','224.0.0.1'])expect(isPublicIpv4(ip)).toBe(false);
    expect(isPublicIpv4('1.1.1.1')).toBe(true);
    expect(()=>canonicalPublicUrl('http://127.0.0.1')).toThrow();
    expect(()=>canonicalPublicUrl('https://user:secret@example.com')).toThrow();
    expect(()=>canonicalPublicUrl('https://example.com:8443')).toThrow();
  });
  it('uses deterministic nested metadata snapshots',()=>{
    expect(stableJson({z:2,a:{d:4,b:3}})).toBe(stableJson({a:{b:3,d:4},z:2}));
  });
  it('caps streamed requests even without Content-Length',async()=>{
    const request=new Request('https://example.com',{method:'POST',body:'oversized'});
    await expect(boundedBody(request,3)).rejects.toThrow('size limit');
  });
});
describe('allowlist proofs match Move bytes',()=>{
  it('binds proofs to collection and wallet, with sorted parent hashes',()=>{
    const wallets=['0x1','0x2','0x3'];const collection='0xc';
    const tree=allowlistTree(collection,wallets,'0x2');
    const h=(b:Buffer)=>createHash('sha3-256').update(b).digest();
    let leaf=h(Buffer.concat([Buffer.from('B20_ALLOWLIST_V1'),Buffer.from(normalizeAddress(collection).slice(2),'hex'),Buffer.from(normalizeAddress('0x2').slice(2),'hex')]));
    for(const sibling of tree.proof)leaf=h(Buffer.concat([leaf,Buffer.from(sibling.slice(2),'hex')].sort(Buffer.compare)));
    expect(`0x${leaf.toString('hex')}`).toBe(tree.root);
    expect(allowlistTree('0xd',wallets).root).not.toBe(tree.root);
    expect(()=>allowlistTree(collection,wallets,'0x4')).toThrow('not on');
  });
});
