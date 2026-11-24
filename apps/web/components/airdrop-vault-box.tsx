import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import gsap from 'gsap';
import { Check, Lock, RotateCcw, Sparkles, Unlock } from 'lucide-react';
import type { AirdropTier } from '../lib/airdrop-schema';

export type VaultVisualStage =
  | 'sealed'
  | 'checking'
  | 'charging_open'
  | 'peek_open'
  | 'relocking'
  | 'relocked'
  | 'charging'
  | 'unlocked';

export type AirdropBoxTierVisual = {
  tier: AirdropTier;
  name: string;
  badge: string;
  qualification: string;
  shareLabel: string;
  accent: string;
  glowRgb: string;
  lockedImage: string;
  openImage: string;
};

export const AIRDROP_BOX_MYSTERY_IMAGE = '/airdrop/mystery-sealed.webp';

export const AIRDROP_BOX_TIERS: readonly AirdropBoxTierVisual[] = [
  {
    tier: 'lz_winner',
    name: 'Sovereign Vault',
    badge: '100% Share',
    qualification: 'LayerZero Airdrop Winner',
    shareLabel: 'Full base allocation + up to 50% post engagement boost + Top 500 leaderboard',
    accent: '#E8BA5A',
    glowRgb: '232, 186, 90',
    lockedImage: '/airdrop/tier-sovereign-locked.webp',
    openImage: '/airdrop/tier-sovereign-open.webp',
  },
  {
    tier: 'lz_user_5tx',
    name: 'Vanguard Crate',
    badge: '50% Share',
    qualification: 'LayerZero User · 5+ Txs',
    shareLabel: 'Half base allocation + up to 50% post engagement boost + Top 500 leaderboard',
    accent: '#4BC0FF',
    glowRgb: '75, 192, 255',
    lockedImage: '/airdrop/tier-vanguard-locked.webp',
    openImage: '/airdrop/tier-vanguard-open.webp',
  },
  {
    tier: 'community',
    name: 'Contender Case',
    badge: 'Top 500 Track',
    qualification: 'Open Community Track',
    shareLabel: 'Compete on the 100,000,000 token leaderboard by finishing missions & inviting friends',
    accent: '#57E6C1',
    glowRgb: '87, 230, 193',
    lockedImage: '/airdrop/tier-contender-locked.webp',
    openImage: '/airdrop/tier-contender-open.webp',
  },
] as const;

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
  checking?: boolean;
};

type RevealPhase = 'idle' | 'charging_open' | 'peek_open' | 'relocking';

const MISSION_SEALS = [
  { key: 'follow', label: 'Follow X' },
  { key: 'repost', label: 'Like & Repost' },
  { key: 'post', label: 'Post on X' },
  { key: 'create', label: 'Meme Token' },
] as const;

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  alpha: number;
  life: number;
  maxLife: number;
  burst: boolean;
};

type Shockwave = {
  x: number;
  y: number;
  radius: number;
  maxRadius: number;
  alpha: number;
};

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function getAirdropBoxTierVisual(tier: AirdropTier | null): AirdropBoxTierVisual | null {
  if (!tier) return null;
  return AIRDROP_BOX_TIERS.find(entry => entry.tier === tier) ?? null;
}

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
  checking = false,
}: VaultProps) {
  const [revealPhase, setRevealPhase] = useState<RevealPhase>('idle');
  const [localPeek, setLocalPeek] = useState(0);
  const totalShown = baseTokens + bonusTokens + projectedTop500Tokens;
  const [animatedCount, setAnimatedCount] = useState(totalShown);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const tiltRef = useRef<HTMLDivElement | null>(null);
  const flashRef = useRef<HTMLDivElement | null>(null);
  const hudRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const burstQueueRef = useRef(0);
  const quickRotateX = useRef<((val: number) => gsap.core.Tween) | null>(null);
  const quickRotateY = useRef<((val: number) => gsap.core.Tween) | null>(null);

  const activeVisual = getAirdropBoxTierVisual(tier);
  const accent = activeVisual?.accent ?? '#C2CBD6';
  const glowRgb = activeVisual?.glowRgb ?? '194, 203, 214';
  const glowRef = useRef(glowRgb);
  glowRef.current = glowRgb;

  // Preload all 7 crisp WebP studio crate renders on mount so state swaps are instant
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.Image !== 'function') return;
    const urls = [
      AIRDROP_BOX_MYSTERY_IMAGE,
      ...AIRDROP_BOX_TIERS.flatMap(entry => [entry.lockedImage, entry.openImage]),
    ];
    for (const src of urls) {
      const img = new window.Image();
      img.decoding = 'async';
      img.src = src;
    }
  }, []);

  useEffect(() => {
    setAnimatedCount(totalShown);
  }, [totalShown]);

  // Set up GSAP smooth 3D pointer tilt tweens
  useEffect(() => {
    if (typeof window === 'undefined' || prefersReducedMotion() || !tiltRef.current) return;
    const ctx = gsap.context(() => {
      if (!tiltRef.current) return;
      quickRotateX.current = gsap.quickTo(tiltRef.current, 'rotationX', { duration: 0.35, ease: 'power2.out' });
      quickRotateY.current = gsap.quickTo(tiltRef.current, 'rotationY', { duration: 0.35, ease: 'power2.out' });
    }, tiltRef);
    return () => {
      quickRotateX.current = null;
      quickRotateY.current = null;
      ctx.revert();
    };
  }, []);

  // Choreography timeline when checking finishes (peekTrigger) or user clicks Replay opening
  useEffect(() => {
    const triggerCount = peekTrigger + localPeek;
    if (triggerCount <= 0 || unlocked || !walletConnected) {
      setRevealPhase('idle');
      return;
    }

    if (prefersReducedMotion()) {
      setRevealPhase('peek_open');
      setAnimatedCount(totalShown);
      const t = window.setTimeout(() => setRevealPhase('idle'), 2400);
      return () => window.clearTimeout(t);
    }

    const counter = { value: 0 };
    const ctx = gsap.context(() => {
      setRevealPhase('charging_open');
      const tl = gsap.timeline({
        onComplete: () => {
          setRevealPhase('idle');
        },
      });

      if (tiltRef.current) {
        tl.to(tiltRef.current, { y: 4, scale: 0.96, duration: 0.14, ease: 'power2.in' })
          .to(tiltRef.current, { x: -5, rotationZ: -1.4, duration: 0.06, ease: 'sine.inOut' })
          .to(tiltRef.current, { x: 5, rotationZ: 1.4, duration: 0.06, ease: 'sine.inOut' })
          .to(tiltRef.current, { x: -4, rotationZ: -1.0, duration: 0.06, ease: 'sine.inOut' })
          .to(tiltRef.current, { x: 4, rotationZ: 1.0, duration: 0.06, ease: 'sine.inOut' })
          .to(tiltRef.current, { x: 0, y: 0, rotationZ: 0, duration: 0.08 });
      } else {
        tl.to({}, { duration: 0.46 });
      }

      tl.call(() => {
        setRevealPhase('peek_open');
        burstQueueRef.current += 1;
      });

      if (flashRef.current) {
        tl.fromTo(
          flashRef.current,
          { opacity: 0.95, scale: 0.55 },
          { opacity: 0, scale: 1.85, duration: 0.72, ease: 'power3.out' },
          '<',
        );
      }

      if (tiltRef.current) {
        tl.fromTo(
          tiltRef.current,
          { scale: 0.92, y: 8 },
          { scale: 1.03, y: -4, duration: 0.44, ease: 'back.out(1.9)' },
          '<',
        ).to(tiltRef.current, { scale: 1, y: 0, duration: 0.35, ease: 'power2.out' });
      }

      if (hudRef.current) {
        tl.fromTo(
          hudRef.current,
          { opacity: 0, y: 20, scale: 0.88 },
          { opacity: 1, y: 0, scale: 1, duration: 0.48, ease: 'back.out(1.6)' },
          '<+0.06',
        );
      }

      if (totalShown > 0) {
        tl.to(
          counter,
          {
            value: totalShown,
            duration: 0.85,
            ease: 'power2.out',
            onUpdate: () => setAnimatedCount(Math.round(counter.value)),
          },
          '<',
        );
      }

      // Hold the opened allocation showcase briefly, then lock the chest back down
      tl.to({}, { duration: 1.95 })
        .call(() => {
          setRevealPhase('relocking');
        });

      if (hudRef.current) {
        tl.to(hudRef.current, { opacity: 0, y: 14, scale: 0.92, duration: 0.28, ease: 'power2.in' });
      }
      if (tiltRef.current) {
        tl.to(tiltRef.current, { scale: 0.95, y: 5, duration: 0.18, ease: 'power2.in' }, '<+0.12').to(
          tiltRef.current,
          { scale: 1, y: 0, duration: 0.28, ease: 'bounce.out' },
        );
      } else {
        tl.to({}, { duration: 0.46 });
      }
    }, stageRef);

    return () => {
      ctx.revert();
    };
  }, [peekTrigger, localPeek, unlocked, walletConnected, totalShown]);

  // 60fps Canvas 2D ambient embers & reveal shockwave particle burst
  useEffect(() => {
    if (typeof window === 'undefined' || prefersReducedMotion()) return;
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let width = stage.clientWidth || 320;
    let height = stage.clientHeight || 272;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const resize = () => {
      width = stage.clientWidth || 320;
      height = stage.clientHeight || 272;
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();

    const particles: Particle[] = [];
    const shockwaves: Shockwave[] = [];

    const spawnAmbient = () => {
      particles.push({
        x: width * (0.2 + Math.random() * 0.6),
        y: height * (0.35 + Math.random() * 0.5),
        vx: (Math.random() - 0.5) * 0.35,
        vy: -(0.35 + Math.random() * 0.65),
        size: 1 + Math.random() * 1.8,
        alpha: 0.25 + Math.random() * 0.45,
        life: 0,
        maxLife: 70 + Math.random() * 70,
        burst: false,
      });
    };

    const spawnBurst = () => {
      const originX = width * 0.5;
      const originY = height * 0.52;
      shockwaves.push({
        x: originX,
        y: originY,
        radius: 14,
        maxRadius: Math.min(width, height) * 0.48,
        alpha: 0.85,
      });
      for (let i = 0; i < 55; i++) {
        const angle = -Math.PI * 0.92 + Math.random() * Math.PI * 0.84;
        const speed = 1.8 + Math.random() * 4.8;
        particles.push({
          x: originX + (Math.random() - 0.5) * 28,
          y: originY + (Math.random() - 0.5) * 14,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - 0.8,
          size: 1.3 + Math.random() * 2.5,
          alpha: 0.95,
          life: 0,
          maxLife: 40 + Math.random() * 34,
          burst: true,
        });
      }
    };

    for (let i = 0; i < 16; i++) spawnAmbient();

    let rafId = 0;
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(resize);
      observer.observe(stage);
    } else {
      window.addEventListener('resize', resize);
    }

    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) {
        rafId = window.requestAnimationFrame(tick);
        return;
      }

      if (burstQueueRef.current > 0) {
        burstQueueRef.current = 0;
        spawnBurst();
      }

      ctx.clearRect(0, 0, width, height);
      ctx.globalCompositeOperation = 'lighter';
      const rgb = glowRef.current;

      if (particles.length < 24 && Math.random() < 0.28) {
        spawnAmbient();
      }

      for (let i = shockwaves.length - 1; i >= 0; i--) {
        const wave = shockwaves[i]!;
        wave.radius += (wave.maxRadius - wave.radius) * 0.11 + 1.5;
        wave.alpha *= 0.91;
        if (wave.alpha < 0.03 || wave.radius >= wave.maxRadius) {
          shockwaves.splice(i, 1);
          continue;
        }
        ctx.beginPath();
        ctx.arc(wave.x, wave.y, wave.radius, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${rgb}, ${wave.alpha.toFixed(3)})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i]!;
        p.life += 1;
        p.x += p.vx;
        p.y += p.vy;
        if (p.burst) {
          p.vy += 0.055; // subtle gravity arc
          p.vx *= 0.985;
        }
        if (p.life >= p.maxLife) {
          particles.splice(i, 1);
          continue;
        }
        const progress = p.life / p.maxLife;
        const opacity = p.burst ? p.alpha * (1 - progress) : p.alpha * Math.sin(progress * Math.PI);
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${rgb}, ${Math.max(0, opacity).toFixed(3)})`;
        ctx.fill();
      }

      ctx.globalCompositeOperation = 'source-over';
      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);

    return () => {
      window.cancelAnimationFrame(rafId);
      observer?.disconnect();
      window.removeEventListener('resize', resize);
    };
  }, []);

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!quickRotateX.current || !quickRotateY.current || !stageRef.current) return;
    const rect = stageRef.current.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const normX = (event.clientX - rect.left) / rect.width - 0.5;
    const normY = (event.clientY - rect.top) / rect.height - 0.5;
    quickRotateY.current(normX * 12);
    quickRotateX.current(-normY * 10);
  }

  function handlePointerLeave() {
    quickRotateX.current?.(0);
    quickRotateY.current?.(0);
  }

  const stage: VaultVisualStage = unlocked
    ? 'unlocked'
    : checking
      ? 'checking'
      : revealPhase !== 'idle'
        ? revealPhase
        : requiredCompleted > 0
          ? 'charging'
          : walletConnected
            ? 'relocked'
            : 'sealed';

  const chestOpen = stage === 'peek_open' || stage === 'unlocked';
  const revealedLocked =
    walletConnected &&
    !unlocked &&
    stage !== 'checking' &&
    stage !== 'charging_open' &&
    stage !== 'peek_open';

  const crateImage =
    !walletConnected || !activeVisual || stage === 'checking' || stage === 'charging_open'
      ? AIRDROP_BOX_MYSTERY_IMAGE
      : chestOpen
        ? activeVisual.openImage
        : activeVisual.lockedImage;

  const crateAlt =
    !walletConnected || !activeVisual
      ? 'Sealed mystery airdrop vault'
      : chestOpen
        ? `${activeVisual.name} open with allocation revealed`
        : `${activeVisual.name} locked`;

  const tierTitle = activeVisual ? `${activeVisual.name} · ${activeVisual.badge}` : 'Mystery Vault';

  const statusText =
    stage === 'unlocked'
      ? slotNumber
        ? `${activeVisual?.name || 'Box'} unlocked · Spot #${slotNumber.toLocaleString()}`
        : `${activeVisual?.name || 'Box'} unlocked · Top 500 ranked`
      : stage === 'checking'
        ? 'Inspecting wallet allocation…'
        : stage === 'charging_open'
          ? 'Breaking mystery seal…'
          : stage === 'peek_open'
            ? 'Allocation revealed — securing box…'
            : stage === 'relocking'
              ? 'Locking allocation inside vault…'
              : stage === 'charging'
                ? `${activeVisual?.name || 'Box'} locked · ${requiredCompleted} of 4 missions complete`
                : stage === 'relocked'
                  ? `${activeVisual?.name || 'Box'} locked · Finish 4 missions to unlock`
                  : 'Check your wallet to open your mystery box';

  const revealedDisplayValue =
    totalShown > 0
      ? `${animatedCount.toLocaleString()} ${tokenSymbol}`
      : tier === 'community'
        ? 'Top 500 Eligible'
        : 'Mystery';

  const lockedDisplayValue =
    totalShown > 0
      ? `${totalShown.toLocaleString()} ${tokenSymbol}`
      : tier === 'community'
        ? '100M Leaderboard Track'
        : '—';

  const chargePct = Math.min(100, Math.round((Math.max(0, requiredCompleted) / 4) * 100));

  return (
    <div
      className={`airdrop-vault airdrop-vault-${stage}`}
      data-testid="airdrop-vault-box"
      data-tier={tier || 'mystery'}
      data-stage={stage}
      style={
        {
          '--vault-accent': accent,
          '--vault-glow': glowRgb,
        } as CSSProperties
      }
    >
      <div className="airdrop-vault-header">
        <span className="airdrop-vault-status">
          {unlocked || chestOpen ? <Unlock size={14} /> : <Lock size={14} />}
          {statusText}
        </span>
        <div className="airdrop-vault-header-actions">
          <span className="airdrop-tier-pill">{tierTitle}</span>
          {!unlocked && walletConnected && (
            <button
              type="button"
              className="airdrop-replay-btn"
              onClick={() => setLocalPeek(n => n + 1)}
            >
              <RotateCcw size={12} /> Replay opening
            </button>
          )}
        </div>
      </div>

      <div
        ref={stageRef}
        className="airdrop-vault-stage"
        aria-live="polite"
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
      >
        <div className="vault-stage-backdrop" aria-hidden="true" />
        <div className={`vault-glow ${chestOpen || stage === 'charging_open' ? 'vault-glow-on' : ''}`} aria-hidden="true" />
        <div ref={flashRef} className="vault-reveal-flash" aria-hidden="true" />
        <canvas ref={canvasRef} className="vault-particle-canvas" aria-hidden="true" />

        <div ref={tiltRef} className="vault-crate-tilt">
          <img
            src={crateImage}
            alt={crateAlt}
            width={640}
            height={640}
            className={`vault-crate-image ${
              stage === 'checking' || stage === 'charging_open' ? 'vault-crate-anticipate' : ''
            } ${chestOpen ? 'vault-crate-open' : ''}`}
          />
        </div>

        {(stage === 'peek_open' || stage === 'unlocked') && (
          <div ref={hudRef} className="vault-reveal-hud" role="status">
            <span className="vault-hud-kicker">
              <Sparkles size={12} /> {activeVisual?.name || 'Allocation'}
            </span>
            <strong>{revealedDisplayValue}</strong>
            <small>{stage === 'unlocked' ? 'Unlocked & reserved' : 'Revealed · Relocking for missions'}</small>
          </div>
        )}

        {revealedLocked && (
          <div className="vault-lock-bar">
            <Lock size={13} />
            <span>
              <strong>{lockedDisplayValue}</strong> secured inside · Complete 4 missions to unlock
            </span>
          </div>
        )}
      </div>

      <div className="vault-charge-track" role="progressbar" aria-valuenow={requiredCompleted} aria-valuemin={0} aria-valuemax={4}>
        <div className="vault-charge-fill" data-progress={requiredCompleted} style={{ width: `${chargePct}%` }} />
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
          <span>Box Tier</span>
          <strong>{activeVisual ? activeVisual.name : 'Unchecked Mystery'}</strong>
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
