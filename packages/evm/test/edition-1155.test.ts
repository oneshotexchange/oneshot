import { describe, expect, it } from 'vitest';
import { keccak256, type Address } from 'viem';
import {
  buildEdition1155AllowlistTree,
  EDITION_1155_ABI,
  EDITION_1155_ALLOWLIST_DOMAIN,
  EDITION_1155_FACTORY_ABI,
  edition1155AllowlistLeaf,
} from '../src/edition-1155';

const col = '0x1111111111111111111111111111111111111111' as Address;
const w1 = '0x2222222222222222222222222222222222222222' as Address;
const w2Mixed = '0xAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCd';
const w2 = w2Mixed.toLowerCase() as Address;

function verifySortedProof(leaf: string, proof: readonly string[], root: string): boolean {
  let computed = leaf;
  for (const element of proof) {
    const [a, b] = computed.toLowerCase() < element.toLowerCase() ? [computed, element] : [element, computed];
    computed = keccak256(`0x${a.slice(2)}${b.slice(2)}`);
  }
  return computed === root;
}

describe('ERC-1155 multi-edition ABI and allowlist builder', () => {
  it('binds allowlist leaves separately per chain, collection and editionId', () => {
    expect(EDITION_1155_ALLOWLIST_DOMAIN).toMatch(/^0x[\da-f]{64}$/);
    expect(EDITION_1155_FACTORY_ABI.some(item => item.type === 'function' && item.name === 'createCollection')).toBe(true);
    expect(EDITION_1155_ABI.some(item => item.type === 'function' && item.name === 'createEdition')).toBe(true);

    const e1 = edition1155AllowlistLeaf(84532, col, 1n, w1);
    const e2 = edition1155AllowlistLeaf(84532, col, 2n, w1);
    const otherChain = edition1155AllowlistLeaf(33001, col, 1n, w1);
    expect(e1).not.toBe(e2);
    expect(e1).not.toBe(otherChain);
  });

  it('builds deterministic Merkle trees and valid commutative proofs', () => {
    const empty = buildEdition1155AllowlistTree([], 84532, col, 1n);
    expect(empty.addresses).toEqual([]);
    expect(empty.root).toBe(`0x${'0'.repeat(64)}`);

    const tree = buildEdition1155AllowlistTree([w2Mixed, w1, w1], 84532, col, 1n);
    expect(tree.addresses).toEqual([w1, w2]);
    expect(verifySortedProof(edition1155AllowlistLeaf(84532, col, 1n, w1), tree.proofs[w1]!, tree.root)).toBe(true);
    expect(verifySortedProof(edition1155AllowlistLeaf(84532, col, 1n, w2), tree.proofs[w2]!, tree.root)).toBe(true);
    expect(verifySortedProof(edition1155AllowlistLeaf(84532, col, 2n, w1), tree.proofs[w1]!, tree.root)).toBe(false);
  });

  it('rejects invalid chain, editionId, or zero addresses', () => {
    expect(() => edition1155AllowlistLeaf(0, col, 1n, w1)).toThrow();
    expect(() => edition1155AllowlistLeaf(84532, col, 0n, w1)).toThrow();
    expect(() => buildEdition1155AllowlistTree(['0x0000000000000000000000000000000000000000'], 84532, col, 1n)).toThrow();
  });
});
