import { brandColors, markPaths, wordmarkPaths } from '../lib/brand.mjs';

/** Decorative inside an already labelled home link. The wordmark is outlined. */
export function OneshotLogo({ className = '', compact = false }: { className?: string; compact?: boolean }) {
  return <svg className={`oneshot-logo ${className}`} viewBox={compact ? '0 0 128 128' : '0 0 582 128'} fill="none" aria-hidden="true" focusable="false">
    <path d={markPaths.silhouette} fill={brandColors.gold} />
    <path d={markPaths.onyx} fill={brandColors.onyx} />
    <path d={markPaths.one} fill={brandColors.ivory} />
    {!compact && <g transform="translate(155 22)" fill="currentColor" fillRule="evenodd">{wordmarkPaths.map(letter => <path key={letter.x} transform={`translate(${letter.x} 0)`} d={letter.d} />)}</g>}
  </svg>;
}

export function BrandArtwork() {
  return <figure className="brand-artwork" aria-label="The oneshot folded emblem, sculpted in gold, ivory and onyx">
    <img src="/brand/oneshot-studio.webp" width="1536" height="1024" fetchPriority="high" alt="" />
    <figcaption><span>oneshot</span><span>Tokens &amp; NFT collections</span></figcaption>
  </figure>;
}
