import type { AccountWalletProfile, WalletProfileDetails } from './wallet-profile';

/** In-memory edits retain the saved version they were based on across wallet switches. */
export type WalletProfileWorkingCopy = { draft: WalletProfileDetails; baseRevision: number; conflicted: boolean };
const sameDetails = (left: WalletProfileDetails, right: WalletProfileDetails) => JSON.stringify(left) === JSON.stringify(right);

export function walletProfileEditConflict(account: AccountWalletProfile, copy: WalletProfileWorkingCopy) {
  return copy.conflicted || copy.baseRevision !== account.revision;
}
export function walletProfileHasOpenEdits(account: AccountWalletProfile, copy: WalletProfileWorkingCopy) {
  return walletProfileEditConflict(account, copy) || !sameDetails(copy.draft, account.draft);
}
export function restoreWalletProfileWorkingCopy(account: AccountWalletProfile, cached?: WalletProfileWorkingCopy): WalletProfileWorkingCopy {
  if (!cached) return { draft: { ...account.draft }, baseRevision: account.revision, conflicted: false };
  return { draft: { ...cached.draft }, baseRevision: cached.baseRevision, conflicted: walletProfileEditConflict(account, cached) };
}

/** Apply a verified API result without converting a publication-only revision into consent to replace private edits. */
export function completeWalletProfileChange(account: AccountWalletProfile, copy: WalletProfileWorkingCopy, action: 'save' | 'publish' | 'unpublish', next: AccountWalletProfile, reviewedRevision?: number): WalletProfileWorkingCopy {
  if (next.wallet !== account.wallet || next.revision !== account.revision + 1) throw new Error('The profile change could not be verified. Review the saved profile before trying again.');
  const conflict = walletProfileEditConflict(account, copy);
  if (action === 'unpublish') {
    if (next.published !== null || !sameDetails(next.draft, account.draft)) throw new Error('The profile change could not be verified. Review the saved profile before trying again.');
    return { draft: { ...copy.draft }, baseRevision: conflict ? copy.baseRevision : next.revision, conflicted: conflict };
  }
  if (conflict && (action !== 'save' || reviewedRevision !== account.revision)) throw new Error('Review the changed saved profile before replacing it with your open edits.');
  return restoreWalletProfileWorkingCopy(next);
}
