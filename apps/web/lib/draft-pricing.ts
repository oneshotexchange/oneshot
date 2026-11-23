import type { LocalCollectionDraft } from './client-oneshot-api';
import { collectionWorkingTerms } from './collection-working-copy';
import { tokenDraftSchema, type TokenDraft } from './token-drafts';

/** Retargeting is an explicit new editable copy. Native-currency amounts are never converted or reused. */
export function collectionCopyForBase(draft: LocalCollectionDraft): LocalCollectionDraft {
  return { ...collectionWorkingTerms(draft), id: '', savedAt: '', pricingNetwork: 'base-sepolia', price: '', allowlistPrice: '' };
}
export function tokenCopyForBase(draft: TokenDraft): TokenDraft {
  return tokenDraftSchema.parse({ ...draft, pricingNetwork: 'base-sepolia', openingValuation: '' });
}

export function collectionCopyForZero(
  draft: LocalCollectionDraft,
  target: 'zero-testnet' | 'zero-mainnet' = 'zero-testnet',
): LocalCollectionDraft {
  return { ...collectionWorkingTerms(draft), id: '', savedAt: '', pricingNetwork: target, price: '', allowlistPrice: '' };
}
export function tokenCopyForZero(
  draft: TokenDraft,
  target: 'zero-testnet' | 'zero-mainnet' = 'zero-testnet',
): TokenDraft {
  return tokenDraftSchema.parse({ ...draft, pricingNetwork: target, openingValuation: '' });
}
