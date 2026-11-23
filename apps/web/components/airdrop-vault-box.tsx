import { useEffect, useState } from 'react';
import { Check, Lock, RotateCcw, Sparkles, Unlock } from 'lucide-react';
import type { AirdropTier } from '../lib/airdrop-schema';

export type VaultVisualStage = 'sealed' | 'peek_open' | 'relocked' | 'charging' | 'unlocked';

type VaultProps = {
  tokenSymbol: string;
  tier: AirdropTier | null;
  baseTokens: number;
  bonusTokens: number;
  projectedTop500Tokens: number;
  requiredCompleted: number; // 0..4
  slotNumber: number | null;
  walletConnected: boolean;
  unlocked: boolean;
  peekTrigger: number;
};

const MISSION_SEALS = [
  { key: 'follow', label: 'Follow X' },
  { key: 'repost', label: 'Like & Repost' },
  { key: 'post', label: 'Post on X' },
  { key: 'create', label: 'Meme Token' },
] as const;

export function AirdropVaultBox({
  tokenSymbol,
  tier,
  baseTokens,
  bonusTokens,
  projectedTop500Tokens,
  requiredCompleted,
  slotNumber,
  walletConnected,
  unlocked,
  peekTrigger,
}: VaultProps) {
  const [peeking, setPeeking] = useState(false);
  const [localPeek, setLocalPeek] = useState(0);

  useEffect(() => {
    if ((peekTrigger <= 0 && localPeek <= 0) || unlocked) return;
    setPeeking(true);
    const timer = window.setTimeout(() => setPeeking(false), 3400);
    return () => window.clearTimeout(timer);
  }, [peekTrigger, localPeek, unlocked]);

  const stage: VaultVisualStage = unlocked
    ? 'unlocked'
    : peeking
      ? 'peek_open'
      : requiredCompleted > 0
        ? 'charging'
        : walletConnected
          ? 'relocked'
          : 'sealed';

  const lidOpen = stage === 'peek_open' || stage === 'unlocked';
  const totalShown = baseTokens + bonusTokens + projectedTop500Tokens;

  const tierTitle =
    tier === 'lz_winner'
      ? 'LayerZero winner (100%)'
      : tier === 'lz_user_5tx'
        ? 'LayerZero user · 5+ txs (50%)'
        : tier === 'community'
          ? 'Top 500 leaderboard'
          : 'Check wallet to reveal';

  const statusText =
    stage === 'unlocked'
      ? slotNumber
        ? `Box unlocked · Spot #${slotNumber.toLocaleString()}`
        : 'Box unlocked · Ranked in Top 500'
      : stage === 'peek_open'
        ? 'Opening your box…'
        : stage === 'charging'
          ? `${requiredCompleted} of 4 missions complete`
          : stage === 'relocked'
            ? 'Locked · Finish 4 missions to unlock'
            : 'Check your wallet to preview your box';

  const chargeWidth = requiredCompleted <= 0 ? 0 : Math.min(104, Math.round((requiredCompleted / 4) * 104));

  return (
    <div className={`airdrop-vault airdrop-vault-${stage}`} data-testid="airdrop-vault-box">
      <div className="airdrop-vault-header">
        <span className="airdrop-vault-status">
          {unlocked ? <Unlock size={14} /> : <Lock size={14} />}
          {statusText}
        </span>
        {!unlocked && walletConnected && (
          <button
            type="button"
            className="airdrop-replay-btn"
            onClick={() => setLocalPeek(n => n + 1)}
          >
            <RotateCcw size={13} /> Peek box
          </button>
        )}
      </div>

      <div className="airdrop-vault-stage" aria-live="polite">
        <div className={`vault-glow ${lidOpen ? 'vault-glow-on' : ''}`} aria-hidden="true" />
        <div className={`vault-orb ${lidOpen ? 'vault-orb-up' : ''}`}>
          <Sparkles size={15} />
          <strong>{totalShown > 0 ? totalShown.toLocaleString() : tier === 'community' ? 'Top 500' : '?'}</strong>
          <span>{totalShown > 0 ? tokenSymbol : tier === 'community' ? '100M pool' : tokenSymbol}</span>
        </div>

        <svg
          className={`vault-svg ${lidOpen ? 'vault-svg-open' : ''}`}
          viewBox="0 0 260 220"
          role="img"
          aria-label={`Token airdrop box: ${statusText}`}
        >
          <defs>
            <linearGradient id="vaultBodyGrad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="var(--surface-raised)" />
              <stop offset="100%" stopColor="var(--surface)" />
            </linearGradient>
            <linearGradient id="vaultCoreGrad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.9" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.35" />
            </linearGradient>
          </defs>

          <ellipse cx="130" cy="198" rx="78" ry="12" fill="currentColor" opacity="0.16" />

          <g className="vault-chest">
            <rect
              x="54"
              y="96"
              width="152"
              height="92"
              rx="14"
              fill="url(#vaultBodyGrad)"
              stroke="var(--line)"
              strokeWidth="2.5"
            />
            <rect
              x="66"
              y="108"
              width="128"
              height="68"
              rx="9"
              fill="none"
              stroke="var(--accent)"
              strokeOpacity={unlocked ? 0.8 : 0.25}
              strokeWidth="1.5"
            />
            <rect x="78" y="138" width="104" height="8" rx="4" fill="var(--line)" opacity="0.45" />
            <rect
              x="78"
              y="138"
              width={chargeWidth}
              height="8"
              rx="4"
              fill="url(#vaultCoreGrad)"
              className="vault-charge-bar"
            />
            <rect
              x="116"
              y="90"
              width="28"
              height="24"
              rx="6"
              fill={unlocked ? 'var(--accent)' : 'var(--surface-raised)'}
              stroke="var(--line)"
              strokeWidth="2"
            />
            <circle cx="130" cy="102" r="4" fill={unlocked ? 'var(--accent-ink)' : 'var(--accent)'} />
          </g>

          <g className="vault-lid">
            <path
              d="M48 96 L58 58 Q62 46 74 46 L186 46 Q198 46 202 58 L212 96 Z"
              fill="url(#vaultBodyGrad)"
              stroke="var(--accent)"
              strokeOpacity={lidOpen ? 0.9 : 0.45}
              strokeWidth="2.5"
            />
            <path d="M74 62 H186" stroke="var(--line)" strokeWidth="2" strokeLinecap="round" />
            <circle cx="130" cy="74" r="9" fill="none" stroke="var(--accent)" strokeWidth="2" />
          </g>
        </svg>
      </div>

      <div className="airdrop-vault-seals">
        {MISSION_SEALS.map((seal, index) => {
          const active = index < requiredCompleted || unlocked;
          return (
            <div key={seal.key} className={`vault-seal ${active ? 'vault-seal-lit' : ''}`}>
              <span>{active ? <Check size={12} /> : index + 1}</span>
              <small>{seal.label}</small>
            </div>
          );
        })}
      </div>

      <div className="airdrop-vault-summary">
        <div>
          <span>Tier</span>
          <strong>{tierTitle}</strong>
        </div>
        <div>
          <span>LayerZero + Bonus</span>
          <strong>
            {baseTokens.toLocaleString()} + {bonusTokens.toLocaleString()} {tokenSymbol}
          </strong>
        </div>
        <div>
          <span>Top 500 Projected</span>
          <strong>
            {projectedTop500Tokens > 0 ? `+${projectedTop500Tokens.toLocaleString()} ${tokenSymbol}` : 'Compete by rank'}
          </strong>
        </div>
      </div>
    </div>
  );
}
