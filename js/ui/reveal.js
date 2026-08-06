/**
 * ui/reveal.js — scroll-reveal animation helper (no gameplay).
 *
 * Adds the `js` marker class so CSS can safely hide `[data-reveal]`
 * elements only when JavaScript is enabled, then reveals them as they
 * scroll into view using IntersectionObserver.
 *
 * Future plug-in: page-level UI behaviors (panels, toasts, tabs) should
 * live in their own modules alongside this one.
 */

/**
 * Initialize scroll-reveal for every `[data-reveal]` element.
 * Content stays visible when JS is unavailable or unsupported.
 */
export function initScrollReveal() {
  document.documentElement.classList.add('js');

  const targets = document.querySelectorAll('[data-reveal]');

  // Fallback: if IntersectionObserver is unavailable, show everything.
  if (!('IntersectionObserver' in window) || targets.length === 0) {
    targets.forEach((el) => el.classList.add('is-visible'));
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.12 }
  );

  targets.forEach((el) => observer.observe(el));
}
