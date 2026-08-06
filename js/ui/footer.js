/**
 * ui/footer.js — footer chrome helpers (no gameplay).
 *
 * Keeps the copyright year in the footer current.
 */

/**
 * Set the footer copyright year to the current year.
 */
export function initFooter() {
  const el = document.getElementById('year');
  if (el) el.textContent = String(new Date().getFullYear());
}
