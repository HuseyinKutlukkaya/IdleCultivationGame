/**
 * utils/paths.js — portable project-root path resolution.
 *
 * The ESM/browser equivalent of .NET's AppDomain.CurrentDomain.BaseDirectory
 * (or Application.StartupPath): a dynamic base location derived from the
 * current module's own import.meta.url — never a hardcoded, machine-specific
 * path. The project root resolves correctly in the browser (the served
 * origin) and in the Node test runner (the file:// URL of the repo), so data
 * reads, content imports, exports and fixtures can all anchor to it
 * portably.
 *
 * Use resolveFromRoot() wherever code needs "the project directory" as a
 * default base (config, content, fixtures, future file import/export).
 *
 * Pure infrastructure — no DOM access, no storage I/O, no gameplay logic,
 * framework-free and GitHub Pages compatible.
 */

/** The project root URL, derived from this module's location (js/utils/ → root). */
const ROOT = new URL('../..', import.meta.url);

/**
 * @returns {URL} the project root directory (always ends with '/').
 */
export function projectRoot() {
  return new URL(ROOT.href);
}

/**
 * Resolve one or more relative path segments against the project root.
 *
 * @param {...string} segments — relative path segments, e.g. 'data',
 *        'game-config.json'.
 * @returns {URL} the fully-resolved URL anchored at the project root.
 */
export function resolveFromRoot(...segments) {
  return new URL(segments.join('/'), ROOT);
}
