// Smooth scrolling only when the person hasn't asked their system to
// reduce motion (V2-G accessibility). Use for every scrollIntoView /
// scrollTo call: el.scrollIntoView({ behavior: scrollBehavior(), ... }).
export function prefersReducedMotion() {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function scrollBehavior() {
  return prefersReducedMotion() ? 'auto' : 'smooth';
}
