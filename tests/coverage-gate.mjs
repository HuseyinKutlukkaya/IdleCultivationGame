/**
 * coverage-gate.mjs — enforces a minimum line-coverage baseline for the
 * node:test suite (dev-only gate; never ships to GitHub Pages).
 *
 * Usage: node tests/coverage-gate.mjs [minLinePercent]   (default 93)
 *
 * Runs the full suite with Node's built-in coverage and fails (exit 1) when
 * the total line coverage drops below the baseline — so untested code shows
 * up as a red build instead of being found by accident later. The baseline is
 * a committed project rule (see AGENTS.md, "Feature Gate"); it rises as the
 * suite improves but never silently falls.
 *
 * Note: the gate measures the whole repo (js/ + tests/), which keeps the
 * metric simple and stable — a trend guard, not a per-module audit.
 */
import { spawnSync } from 'node:child_process';

const MIN_LINE = Number(process.argv[2] ?? 93);

const result = spawnSync(
  process.execPath,
  [
    '--experimental-test-coverage',
    '--test',
    '--test-reporter=./tests/reporters/compact.mjs',
    'tests/**/*.test.mjs',
  ],
  { encoding: 'utf8' }
);

// Forward the suite output so failures below are debuggable in context.
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);

// The compact reporter prints a summary row like:  all files | 96.66 | ...
const match = (result.stdout + result.stderr).match(/all files\s*\|\s*([\d.]+)/);
if (!match) {
  console.error('coverage-gate: could not find the "all files" coverage summary.');
  process.exit(2);
}

const line = Number(match[1]);
console.log(`\ncoverage-gate: total line coverage ${line}% (baseline ${MIN_LINE}%)`);

if (line < MIN_LINE) {
  console.error(
    `coverage-gate: FAIL — line coverage dropped below ${MIN_LINE}%. ` +
      'New code must ship with its tests.'
  );
  process.exit(1);
}

console.log('coverage-gate: PASS');
