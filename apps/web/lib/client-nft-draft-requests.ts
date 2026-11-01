type DraftSelection = { identityScope: string | null; draft: object };

/** A response belongs to the selected account and, for edits, the exact draft version. */
export function createNftDraftRequestGate(current: () => DraftSelection) {
  let active: object | null = null;
  let activeIsCurrent: (() => boolean) | null = null;
  return {
    begin({ bindDraft = true }: { bindDraft?: boolean } = {}) {
      const captured = current();
      if (!captured.identityScope || activeIsCurrent?.()) return null;
      const key = {};
      active = key;
      const isCurrent = () => {
        const selected = current();
        return active === key && selected.identityScope === captured.identityScope
          && (!bindDraft || selected.draft === captured.draft);
      };
      activeIsCurrent = isCurrent;
      return {
        isCurrent,
        assertCurrent() { if (!isCurrent()) throw new Error('Your account, wallet or draft changed. Please try again.'); },
        finish() {
          if (active !== key) return false;
          active = null; activeIsCurrent = null;
          return true;
        },
      };
    },
    invalidate() { active = null; activeIsCurrent = null; },
  };
}
