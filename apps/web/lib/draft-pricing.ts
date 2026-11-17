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
