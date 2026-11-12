import { useRef, type ReactNode, type RefObject } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';

gsap.registerPlugin(useGSAP);

const headingSelector = [
  '.page-heading > div:first-child > h1',
  '.page-heading > div:first-child > p',
  '.section-header h2',
  '.form-section-title > h2',
  '.settings-panel > h2',
].join(',');

/** A route introduction for static headings, never for data or status content. */
export function usePageMotion(scope: RefObject<HTMLElement | null>, pageKey: string) {
  useGSAP(() => {
    const root = scope.current;
    if (!root || typeof window === 'undefined') return;
    const media = gsap.matchMedia(root);

    media.add('(prefers-reduced-motion: no-preference)', () => {
      const headings = Array.from(root.querySelectorAll<HTMLElement>(headingSelector))
        .filter(node => !node.closest('[data-motion-skip], [role="status"], [role="alert"], [aria-live]'))
        .filter(node => {
          const box = node.getBoundingClientRect();
          return box.width > 0 && box.height > 0 && box.top < window.innerHeight && box.bottom > 0;
        });

      if (headings.length) gsap.fromTo(headings,
        { y: 8, opacity: .78 },
        { y: 0, opacity: 1, duration: .42, stagger: .045, ease: 'power2.out', clearProps: 'transform,opacity' },
      );
    });

    return () => media.revert();
  }, { scope, dependencies: [pageKey], revertOnUpdate: true });
}

/** Explicitly opt non-critical artwork or editorial content into a single reveal. */
export function MotionReveal({ children, className = '' }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useGSAP(() => {
    const node = ref.current;
    if (!node || typeof window === 'undefined') return;
    const media = gsap.matchMedia(node);

    media.add('(prefers-reduced-motion: no-preference)', context => {
      let observer: IntersectionObserver | undefined;
      const reveal = () => context.add(() => {
        gsap.fromTo(node,
          { y: 14, opacity: .82 },
          { y: 0, opacity: 1, duration: .65, ease: 'power2.out', clearProps: 'transform,opacity' },
        );
      });

      if ('IntersectionObserver' in window) {
        observer = new IntersectionObserver(entries => {
          if (!entries.some(entry => entry.isIntersecting)) return;
          observer?.disconnect();
          reveal();
        }, { threshold: .1, rootMargin: '0px 0px -24px 0px' });
        observer.observe(node);
      } else reveal();

      return () => observer?.disconnect();
    });

    return () => media.revert();
  }, { scope: ref });

  return <div ref={ref} className={`motion-reveal ${className}`.trim()}>{children}</div>;
}
