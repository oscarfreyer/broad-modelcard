// Reduced motion for scripted scrolling: CSS covers transitions and
// animations, but `scrollTo` and `scrollIntoView` with `behavior: 'smooth'`
// ignore the media query unless the script checks it.

/** True when the reader asked the system for reduced motion. */
export function prefersReducedMotion() {
  return typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

/** The `behavior` for a scripted scroll: 'auto' (a jump) under reduced motion, else 'smooth'. */
export function scrollBehavior() {
  return prefersReducedMotion() ? 'auto' : 'smooth';
}
