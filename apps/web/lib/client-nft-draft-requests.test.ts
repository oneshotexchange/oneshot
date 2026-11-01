import { describe, expect, it } from 'vitest';
import { createNftDraftRequestGate } from './client-nft-draft-requests';

describe('account draft request ownership', () => {
  it('rejects duplicate submissions until the active request finishes', () => {
    const selection = { identityScope: 'alice:wallet-a', draft: {} };
    const gate = createNftDraftRequestGate(() => selection);
    const upload = gate.begin()!;
    expect(gate.begin()).toBeNull();
    expect(upload.isCurrent()).toBe(true);
    expect(upload.finish()).toBe(true);
    expect(gate.begin()).not.toBeNull();
  });

  it('does not apply an upload or preparation response to another draft or edited version', () => {
    let selection = { identityScope: 'alice:wallet-a', draft: { id: 'draft-a', name: 'First' } };
    const gate = createNftDraftRequestGate(() => selection);
    const preparation = gate.begin()!;
    selection = { ...selection, draft: { ...selection.draft, name: 'Edited' } };
    expect(preparation.isCurrent()).toBe(false);
    expect(() => preparation.assertCurrent()).toThrow('draft changed');
    const current = gate.begin()!;
    expect(preparation.finish()).toBe(false);
    expect(current.isCurrent()).toBe(true);
    selection = { ...selection, draft: { id: 'draft-b', name: 'Other collection' } };
    expect(current.isCurrent()).toBe(false);
  });

  it('does not let an old account or wallet request clear a new operation', () => {
    let selection = { identityScope: 'alice:wallet-a', draft: {} };
    const gate = createNftDraftRequestGate(() => selection);
    const first = gate.begin()!;
    selection = { ...selection, identityScope: 'alice:wallet-b' };
    const second = gate.begin()!;
    expect(first.isCurrent()).toBe(false);
    expect(first.finish()).toBe(false);
    expect(gate.begin()).toBeNull();
    expect(second.finish()).toBe(true);
    selection = { ...selection, identityScope: 'bob:wallet-b' };
    expect(second.isCurrent()).toBe(false);
  });

  it('allows account-list responses across draft navigation but rejects them after sign-out', () => {
    let selection: { identityScope: string | null; draft: object } = { identityScope: 'alice', draft: {} };
    const gate = createNftDraftRequestGate(() => selection);
    const list = gate.begin({ bindDraft: false })!;
    selection = { ...selection, draft: {} };
    expect(list.isCurrent()).toBe(true);
    selection = { ...selection, identityScope: null };
    expect(list.isCurrent()).toBe(false);
    expect(gate.begin()).toBeNull();
    gate.invalidate();
    expect(list.finish()).toBe(false);
  });
});
