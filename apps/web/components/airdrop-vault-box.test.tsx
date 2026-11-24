import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AirdropVaultBox } from './airdrop-vault-box';

describe('AirdropVaultBox visual states', () => {
  it('renders sealed mystery crate before wallet check', () => {
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
    expect(html).toContain('Check your wallet to open your mystery box');
    expect(html).toContain('airdrop-vault-sealed');
    expect(html).toContain('data-tier="mystery"');
    expect(html).toContain('/airdrop/mystery-sealed.webp');
    expect(html).toContain('Mystery Vault');
    expect(html).toContain('data-progress="0"');
  });

  it('renders Sovereign Vault in locked mission state for top-tier LayerZero winners', () => {
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
    expect(html).toContain('Sovereign Vault');
    expect(html).toContain('/airdrop/tier-sovereign-locked.webp');
    expect(html).toContain('data-tier="lz_winner"');
    expect(html).toContain('data-progress="2"');
    expect(html).toContain('vault-lock-bar');
    expect(html).toContain('40,000');
    expect(html).toContain('10,000');
  });

  it('renders Vanguard Crate open and unlocked with reserved general spot number', () => {
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
    expect(html).toContain('Vanguard Crate unlocked');
    expect(html).toContain('Spot #42');
    expect(html).toContain('airdrop-vault-unlocked');
    expect(html).toContain('vault-crate-open');
    expect(html).toContain('/airdrop/tier-vanguard-open.webp');
  });

  it('renders Contender Case for the community Top 500 track', () => {
    const html = renderToStaticMarkup(
      <AirdropVaultBox
        tokenSymbol="ONE"
        tier="community"
        baseTokens={0}
        bonusTokens={0}
        projectedTop500Tokens={120_000}
        requiredCompleted={1}
        slotNumber={null}
        walletConnected={true}
        unlocked={false}
        peekTrigger={0}
      />,
    );
    expect(html).toContain('Contender Case');
    expect(html).toContain('/airdrop/tier-contender-locked.webp');
    expect(html).toContain('data-tier="community"');
  });

  it('keeps the mystery seal and hides tier and allocation numbers while checking', () => {
    const html = renderToStaticMarkup(
      <AirdropVaultBox
        tokenSymbol="ONE"
        tier="lz_winner"
        baseTokens={40_000}
        bonusTokens={10_000}
        projectedTop500Tokens={0}
        requiredCompleted={0}
        slotNumber={null}
        walletConnected={true}
        unlocked={false}
        peekTrigger={0}
        checking={true}
      />,
    );
    expect(html).toContain('airdrop-vault-checking');
    expect(html).toContain('/airdrop/mystery-sealed.webp');
    expect(html).toContain('Mystery Vault');
    expect(html).toContain('Revealing…');
    expect(html).not.toContain('Sovereign Vault');
    expect(html).not.toContain('40,000');
  });
});
