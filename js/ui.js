/**
 * ui.js — presentation-layer helpers (no gameplay).
 *
 *   - Marks the document as JS-enabled so CSS can safely hide
 *     `[data-reveal]` elements (content stays visible without JS).
 *   - Reveals `[data-reveal]` elements as they scroll into view.
 *   - Keeps the footer copyright year current.
 *
 * Future plug-in: general page-level UI wiring (toasts, modals, tabs)
 * can be added here or split into their own modules under js/.
 */

/**
 * Initialize presentation helpers. Safe to call once at boot.
 */
export function initUI() {
  document.documentElement.classList.add('js');
  setFooterYear();
  initScrollReveal();
}

function setFooterYear() {
  const el = document.getElementById('year');
  if (el) el.textContent = String(new Date().getFullYear());
}

function initScrollReveal() {
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
