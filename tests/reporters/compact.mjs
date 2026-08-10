/**
 * tests/reporters/compact.mjs — compact reporter for the node:test runner
 * (dev-only tooling; never ships to GitHub Pages).
 *
 * Purpose: keep agent/human context small. A successful suite prints ~4 lines
 * instead of one line per test; failures print their full details; when
 * coverage is enabled the aggregate "all files" row is printed in the same
 * format the coverage gate parses.
 *
 * This is a stream-style reporter (async generator over test-run events),
 * which is the form node accepts from a `--test-reporter=<path>` module on
 * all supported Node versions. Test counts come from the final `test:summary`
 * event (the authoritative aggregate — skipped tests surface as `test:pass`,
 * so per-event counting would be wrong); failure details come from
 * `test:fail` events.
 *
 * Usage:
 *   node --test --test-reporter=./tests/reporters/compact.mjs <test-glob>
 *   (the project uses the glob form documented in tests/README.md)
 *
 * The pure formatting helpers (formatDuration, formatCounts, formatSummary,
 * formatFailures, formatCoverage) are exported so the suite can unit-test the
 * output contract without a browser.
 */

/** Hint printed when the run fails, so full detail is one command away. */
export const FULL_DETAILS_HINT =
  'Full details: node --test --test-reporter=spec <test-glob>';

/** Format a millisecond duration compactly, e.g. "320ms" or "1.50s". */
export function formatDuration(ms) {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
}

/** Build the one-line status line from run counters. */
export function formatCounts({ tests, passed, failed, skipped, todo }) {
  return (
    `${tests} tests · ${passed} passed · ${failed} failed · ` +
    `${skipped} skipped · ${todo} todo`
  );
}

/**
 * Format the list of failures. Each entry prints its name followed by the
 * error stack (indented) so diagnosis has the file:line it needs.
 */
export function formatFailures(failures) {
  const lines = ['FAILURES'];
  failures.forEach((failure, index) => {
    lines.push('');
    lines.push(`${index + 1}) ${failure.name}`);
    const detail =
      failure.error?.stack ?? failure.error?.message ?? String(failure.error);
    for (const line of String(detail).split('\n')) lines.push(`   ${line}`);
  });
  return lines;
}

/**
 * Build the full report: a PASS/FAIL status line, the counts line, the
 * duration, and (on failure) the failure details plus a full-report hint.
 *
 * `aborted` flags a run that ended without a `test:summary` event (interrupt,
 * crash, truncated stream). Such a run must never look green: it reports FAIL
 * with an explanation line even though the counters are all zero.
 */
export function formatSummary(state, durationMs, { aborted = false } = {}) {
  const status =
    aborted || state.failed > 0 || (state.cancelled ?? 0) > 0 ? 'FAIL' : 'PASS';
  const lines = [status, formatCounts(state), `duration: ${formatDuration(durationMs)}`];
  if (aborted) {
    lines.push('');
    lines.push(
      'Suite ended without a test:summary event (aborted or crashed?) — treated as FAIL.'
    );
  } else if (state.failed > 0) {
    lines.push('');
    lines.push(...formatFailures(state.failures));
    lines.push('');
    lines.push(FULL_DETAILS_HINT);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Aggregate coverage into the same "all files" row the coverage gate parses
 * ("all files | line | branch | function |"). Returns an empty string when no
 * coverage data was collected.
 *
 * Contract observed on Node 24: a single `test:coverage` event arrives with an
 * already-aggregated `summary.totals` for the whole run (all files, all child
 * processes). The last event's totals are used, so the format survives
 * multiple events without double counting.
 */
export function formatCoverage(coverageEvents) {
  if (coverageEvents.length === 0) return '';
  const totals =
    coverageEvents[coverageEvents.length - 1]?.summary?.totals ?? {};
  const pct = (covered, total) => (total > 0 ? (covered / total) * 100 : 0);
  const line = pct(totals.coveredLineCount, totals.totalLineCount).toFixed(2);
  const branch = pct(totals.coveredBranchCount, totals.totalBranchCount).toFixed(2);
  const fn = pct(totals.coveredFunctionCount, totals.totalFunctionCount).toFixed(2);
  return `all files | ${line} | ${branch} | ${fn} |\n`;
}

/**
 * The stream-style reporter consumed by node:test. Collects fail/coverage
 * events, reads the authoritative counts from the final summary, then yields
 * one compact report. Kept intentionally thin — all formatting lives in the
 * pure helpers above so it is unit-testable.
 */
export default async function* compactReporter(source) {
  const failures = [];
  const coverage = [];
  let summary = null;

  for await (const event of source) {
    switch (event.type) {
      case 'test:fail': {
        const data = event.data ?? {};
        failures.push({ name: data.name ?? 'unknown', error: data.details?.error });
        break;
      }
      case 'test:coverage':
        coverage.push(event.data);
        break;
      case 'test:summary':
        summary = event.data;
        break;
      default:
        break;
    }
  }

  const counts = summary?.counts ?? {};
  const state = {
    tests: counts.tests ?? 0,
    passed: counts.passed ?? 0,
    failed: counts.failed ?? 0,
    skipped: counts.skipped ?? 0,
    todo: counts.todo ?? 0,
    cancelled: counts.cancelled ?? 0,
    failures,
  };
  yield formatSummary(state, summary?.duration_ms ?? 0, { aborted: summary === null });
  const coverageRow = formatCoverage(coverage);
  if (coverageRow) yield coverageRow;
}
