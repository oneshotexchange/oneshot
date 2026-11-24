import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from './theme-provider';
import { GenesisAuthProvider } from './genesis-auth';
import { AirdropPage } from './airdrop-page';

vi.stubGlobal('window', {
  location: { search: '', pathname: '/airdrop' },
  sessionStorage: undefined,
  localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
});

describe('AirdropPage public customer UI and strict pre-claim disclosure', () => {
  it('hides the 7-day lock, future roadmap, and developer jargon prior to claim', () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <MemoryRouter initialEntries={['/airdrop']}>
          <GenesisAuthProvider>
            <AirdropPage />
          </GenesisAuthProvider>
        </MemoryRouter>
      </ThemeProvider>,
    );

    expect(html).toContain('Unlock your');
    expect(html).toContain('Claim tokens');
    expect(html).toContain('Top 500 Leaderboard');
    expect(html).toContain('Supply Distribution');
    expect(html).toContain('Sovereign Vault');
    expect(html).toContain('Vanguard Crate');
    expect(html).toContain('Contender Case');
    expect(html).toContain('/airdrop/mystery-sealed.webp');

    for (const forbidden of [
      '7-day',
      '7d lock',
      '14-day',
      '14 days',
      'later phase',
      'Merkle',
      'claim tree',
      '8 decimals',
      '/tokens/new',
      'Uniswap v4',
      'FDV',
      'fdv',
      '960,000',
      '960k',
      'single-sided',
      'Single-Sided',
      'one-sided',
      'One-Sided',
      'Tokenomics',
      'tokenomics',
    ]) {
      expect(html).not.toContain(forbidden);
    }
  });
});
