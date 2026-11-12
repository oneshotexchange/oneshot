import { useRef, useState } from 'react';
import { useGSAP } from '@gsap/react';
import { gsap } from 'gsap';
import { ArrowUpRight, RotateCcw, FilePenLine } from 'lucide-react';
import { ButtonLink } from './ui';

gsap.registerPlugin(useGSAP);

function HeroStage() {
  const host = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const replay = useRef<() => void>(() => {});
  const [motionAllowed, setMotionAllowed] = useState(false);
  useGSAP(() => {
    const element = host.current;
    const artwork = image.current;
    if (!element || !artwork) return;
    const media = gsap.matchMedia();
    media.add('(prefers-reduced-motion: reduce)', () => { setMotionAllowed(false); });
    media.add('(prefers-reduced-motion: no-preference)', () => {
      setMotionAllowed(true);
      let inView = false, started = false;
      // Move the camera very slightly over the finished artwork. Its materials,
      // lighting and geometry are never replaced with a simplified model.
      const camera = gsap.timeline({ paused: true })
        .set(artwork, { willChange: 'transform' }, 0)
        .fromTo(artwork, { scale: 1.025 }, { scale: 1, duration: 3.2, ease: 'power2.out', clearProps: 'transform,willChange' }, 0);
      const start = () => {
        if (!artwork.complete || !artwork.naturalWidth) return;
        started = true;
        camera.restart();
        if (!inView || document.hidden) camera.pause();
      };
      const visibility = () => {
        if (!inView || document.hidden) camera.pause();
        else if (!started) start();
        else if (camera.progress() < 1) camera.resume();
      };
      replay.current = start;
      const observer = new IntersectionObserver(entries => {
        inView = entries[0].isIntersecting;
        visibility();
      }, { threshold: .1 });
      observer.observe(element);
      artwork.addEventListener('load', visibility);
      document.addEventListener('visibilitychange', visibility);
      return () => {
        replay.current = () => {};
        observer.disconnect();
        artwork.removeEventListener('load', visibility);
        document.removeEventListener('visibilitychange', visibility);
      };
    }, element);
    return () => media.revert();
  }, { scope: host });

  return <figure className="hero-studio" aria-label="The oneshot emblem in satin gold, ivory and onyx, resting on a dark stone plinth">
    <div className="hero-studio-surface" ref={host}>
      <img ref={image} className="hero-studio-poster" src="/brand/oneshot-studio-detail.webp" srcSet="/brand/oneshot-studio-768.webp 768w, /brand/oneshot-studio-detail.webp 1536w" sizes="(max-width: 760px) 100vw, (max-width: 1000px) 75vw, 55vw" width="1536" height="1024" alt="" fetchPriority="high" />
    </div>
    <figcaption><span>The oneshot studio</span>{motionAllowed && <button type="button" onClick={() => replay.current()} aria-label="Replay artwork motion"><RotateCcw size={12} />Replay</button>}</figcaption>
  </figure>;
}

export function LaunchHero() {
  const scope = useRef<HTMLElement>(null);
  useGSAP(() => {
    const media = gsap.matchMedia();
    media.add('(prefers-reduced-motion: no-preference)', () => {
      const timeline = gsap.timeline({ defaults: { ease: 'power3.out' } });
      timeline.from('.launch-hero-line > span', { yPercent: 65, opacity: .45, duration: .95, stagger: .1 })
        .from('.launch-hero-description', { y: 12, opacity: .5, duration: .7 }, .25)
        .from('.launch-hero-actions', { y: 10, opacity: .6, duration: .65 }, .4);
    }, scope);
    return () => media.revert();
  }, { scope });
  return <section className="launch-hero" ref={scope} aria-labelledby="home-title">
    <div className="launch-hero-copy">
      <div className="launch-hero-intro"><span className="launch-hero-rule" />Create with oneshot</div>
      <h1 id="home-title"><span className="launch-hero-line"><span>Tokens for your </span></span><span className="launch-hero-line"><span>community. </span></span><em className="launch-hero-line"><span>Collections for your art.</span></em></h1>
      <p className="launch-hero-description">Save a draft, add your artwork or token details, and review the terms before anything goes onchain.</p>
      <div className="launch-hero-actions"><ButtonLink href="/tokens/new">Create a token <ArrowUpRight size={16} /></ButtonLink><ButtonLink href="/nfts/new" variant="secondary">Create a collection <ArrowUpRight size={16} /></ButtonLink></div>
      <p className="launch-hero-note"><FilePenLine size={13} />No wallet needed to start a draft.</p>
    </div>
    <HeroStage />
  </section>;
}
