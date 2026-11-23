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
    ]) {
      expect(html).not.toContain(forbidden);
    }
  });
});
