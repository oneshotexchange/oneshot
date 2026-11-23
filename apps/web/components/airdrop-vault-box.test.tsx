import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AirdropVaultBox } from './airdrop-vault-box';

describe('AirdropVaultBox visual states', () => {
  it('renders sealed state with zero progress fill before wallet check', () => {
    const html = renderToStaticMarkup(
      <AirdropVaultBox
        tokenSymbol="ONE"
        tier={null}
        baseTokens={0}
        bonusTokens={0}
        projectedTop500Tokens={0}
        requiredCompleted={0}
        slotNumber={null}
        walletConnected={false}
        unlocked={false}
        peekTrigger={0}
      />,
    );
    expect(html).toContain('Check your wallet to preview your box');
    expect(html).toContain('airdrop-vault-sealed');
    expect(html).toContain('class="vault-charge-bar"');
    expect(html).toContain('width="0"');
  });

  it('renders charging state with lit seals and allocation breakdown', () => {
    const html = renderToStaticMarkup(
      <AirdropVaultBox
        tokenSymbol="ONE"
        tier="lz_winner"
        baseTokens={40_000}
        bonusTokens={10_000}
        projectedTop500Tokens={250_000}
        requiredCompleted={2}
        slotNumber={null}
        walletConnected={true}
        unlocked={false}
        peekTrigger={0}
      />,
    );
    expect(html).toContain('2 of 4 missions complete');
    expect(html).toContain('LayerZero winner (100%)');
    expect(html).toContain('40,000 + 10,000 ONE');
  });

  it('renders unlocked state with reserved general spot number', () => {
    const html = renderToStaticMarkup(
      <AirdropVaultBox
        tokenSymbol="ONE"
        tier="lz_user_5tx"
        baseTokens={20_000}
        bonusTokens={5_000}
        projectedTop500Tokens={0}
        requiredCompleted={4}
        slotNumber={42}
        walletConnected={true}
        unlocked={true}
        peekTrigger={0}
      />,
    );
    expect(html).toContain('Box unlocked · Spot #42');
    expect(html).toContain('airdrop-vault-unlocked');
    expect(html).toContain('vault-svg-open');
  });
});
