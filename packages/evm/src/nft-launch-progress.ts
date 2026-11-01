/** Private creator workspace; saved associations are hints until selected and reverified. */
export type NftLaunchCandidate = { id: string; collection: string; createHash: string; createdAt: string };
export type NftCreatorProgress = {
  id: string; collection: string; createHash: string;
  phase: 'created' | 'configured' | 'opened' | 'schedule-expired' | 'orphaned' | 'pending' | 'mismatch';
  nextAction: 'configure' | 'open' | null;
  termsMatch: boolean;
  blockNumber: string; blockHash: string;
};
export type NftCreatorWorkspace = {
  draftId: string; revision: number; from: string; deploymentId: string;
  items: NftLaunchCandidate[]; nextCursor: string | null;
  pending: { reviewId: string; hash: string }[];
  selected: NftCreatorProgress | null;
};
