import { describe, expect, it } from 'vitest';
import { parseReviewedNftArguments } from './index-reviewed-nfts';
describe('reviewed NFT indexer explicit bounded arguments', () => {
  it('requires an independent manifest and defaults to eight blocks/two confirmations', () => { expect(parseReviewedNftArguments(['--manifest', 'reviewed.json'])).toMatchObject({ manifest: 'reviewed.json', maxBlocks: 8, confirmationDepth: 2 }); });
  it('accepts the explicit upper work bounds', () => { expect(parseReviewedNftArguments(['--manifest','x','--max-blocks','32','--confirmations','64'])).toMatchObject({ maxBlocks: 32, confirmationDepth: 64 }); });
  it.each([[], ['--manifest'], ['--manifest','x','--manifest','y'], ['--manifest','x','--max-blocks','33'], ['--manifest','x','--confirmations','65'], ['--manifest','x','--max-blocks','01'], ['--manifest','x','--network','zero'], ['--manifest','x','--watch']].map(args => ({ args })))('rejects ambiguous or unbounded arguments $args', ({ args }) => { expect(() => parseReviewedNftArguments(args)).toThrow(); });
});
