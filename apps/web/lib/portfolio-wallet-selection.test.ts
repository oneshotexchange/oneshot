import { describe, expect, it } from 'vitest';
import { portfolioWalletSelection } from './portfolio-wallet-selection';

const connected = `0x${'1'.repeat(40)}`, inspected = `0x${'ab'.repeat(20)}`;
describe('shared public portfolio wallet selection', () => {
  it('uses the connected wallet only when no explicit public wallet was selected', () => {
    expect(portfolioWalletSelection('', connected)).toEqual({ wallet: connected, selected: null, error: null });
    expect(portfolioWalletSelection('', null)).toEqual({ wallet: null, selected: null, error: null });
    expect(portfolioWalletSelection(`?wallet=${inspected}`, connected)).toEqual({ wallet: inspected, selected: inspected, error: null });
  });
  it('normalizes a checksum selection without changing its identity when the connected signing wallet changes', () => {
    const search = `?wallet=${inspected.toUpperCase().replace('0X', '0x')}`;
    expect(portfolioWalletSelection(search, connected).wallet).toBe(inspected);
    expect(portfolioWalletSelection(search, null).wallet).toBe(inspected);
  });
  it.each(['?wallet=', '?wallet=bad', `?wallet=0x${'0'.repeat(40)}`, `?wallet=${inspected}&wallet=${connected}`])('does not display a different connected wallet after invalid URL selection %s', search => {
    expect(portfolioWalletSelection(search, connected)).toMatchObject({ wallet: null, selected: null, error: expect.stringContaining('Enter one') });
  });
});
