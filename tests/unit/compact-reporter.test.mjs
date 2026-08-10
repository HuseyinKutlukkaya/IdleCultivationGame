/**
 * tests/unit/compact-reporter.test.mjs — contract tests for the compact
 * node:test reporter (tests/reporters/compact.mjs).
 *
 * Covers:
 *   - the pure formatting helpers (duration, counts, summary, failures, coverage)
 *   - the stream reporter's event handling, driven by synthetic events
 *   - two real spawned runs: a passing fixture prints a compact PASS, a
 *     failing fixture prints FAIL plus the failing test's name, and exits 1
 *
 * Run: the full suite as documented in tests/README.md (`node --test` with
 * the glob form); or just this file: node --test tests/unit/compact-reporter.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  formatDuration,
  formatCounts,
  formatSummary,
  formatFailures,
  formatCoverage,
  FULL_DETAILS_HINT,
} from '../reporters/compact.mjs';
import compactReporter from '../reporters/compact.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Run node --test with the compact reporter on a fixture file.
 *
 * Node's test runner sets NODE_TEST_CONTEXT on its own child processes; a
 * nested `node --test` spawn then skips running files ("recursively within a
 * test file"). The env marker is cleared here so the fixture actually runs.
 */
function runFixture(fixtureName) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(
    process.execPath,
    [
      '--test',
      '--test-reporter=./tests/reporters/compact.mjs',
      `tests/fixtures/${fixtureName}`,
    ],
    { cwd: REPO_ROOT, encoding: 'utf8', env },
  );
}

/** Drive the stream reporter with synthetic events and collect its output. */
async function collectReport(events) {
  const source = (async function* () {
    for (const event of events) yield event;
  })();
  const chunks = [];
  for await (const chunk of compactReporter(source)) chunks.push(String(chunk));
  return chunks.join('');
}

// --- pure formatters --------------------------------------------------------

test('formatDuration renders compact durations', () => {
  assert.equal(formatDuration(320), '320ms');
  assert.equal(formatDuration(1500), '1.50s');
  assert.equal(formatDuration(0), '0ms');
});

test('formatCounts renders a one-line status row', () => {
  const line = formatCounts({ tests: 252, passed: 250, failed: 2, skipped: 0, todo: 0 });
  assert.match(line, /252 tests/);
  assert.match(line, /250 passed/);
  assert.match(line, /2 failed/);
});

test('formatSummary prints PASS and no failures when green', () => {
  const state = { tests: 2, passed: 2, failed: 0, skipped: 0, todo: 0, failures: [] };
  const out = formatSummary(state, 320);
  assert.match(out, /^PASS\n/);
  assert.match(out, /2 passed/);
  assert.match(out, /duration: 320ms/);
  assert.doesNotMatch(out, /FAILURES/);
});

test('formatSummary prints FAIL plus failure details and a full-report hint', () => {
  const state = {
    tests: 2,
    passed: 1,
    failed: 1,
    skipped: 0,
    todo: 0,
    failures: [{ name: 'caps Qi', error: new Error('expected 1000, received 1200') }],
  };
  const out = formatSummary(state, 410);
  assert.match(out, /^FAIL\n/);
  assert.match(out, /1 failed/);
  assert.match(out, /caps Qi/);
  assert.match(out, /expected 1000, received 1200/);
  assert.ok(out.includes(FULL_DETAILS_HINT));
});

test('formatSummary prints FAIL when the run was aborted without a summary', () => {
  const state = { tests: 0, passed: 0, failed: 0, skipped: 0, todo: 0, failures: [] };
  const out = formatSummary(state, 0, { aborted: true });
  assert.match(out, /^FAIL\n/);
  assert.match(out, /0 passed/);
  assert.match(out, /aborted or crashed/);
  assert.doesNotMatch(out, /FAILURES/);
});

test('formatFailures indents each stack line under the failure header', () => {
  const lines = formatFailures([{ name: 'fails hard', error: new Error('boom\n  at x') }]);
  const joined = lines.join('\n');
  assert.match(joined, /^FAILURES\n/);
  assert.match(joined, /1\) fails hard/);
  // V8 stacks carry "Error:" as the first line and indent frames by 4 spaces.
  assert.match(joined, /   Error: boom\n     at x/);
});

test('formatCoverage emits the all-files row the coverage gate parses', () => {
  const events = [
    {
      summary: {
        totals: {
          coveredLineCount: 160,
          totalLineCount: 200,
          coveredBranchCount: 10,
          totalBranchCount: 20,
          coveredFunctionCount: 6,
          totalFunctionCount: 10,
        },
      },
    },
  ];
  assert.equal(formatCoverage(events), 'all files | 80.00 | 50.00 | 60.00 |\n');
});

test('formatCoverage returns an empty string without coverage data', () => {
  assert.equal(formatCoverage([]), '');
});

// --- stream reporter (synthetic events) --------------------------------------

test('a stream of passing events yields a compact PASS summary', async () => {
  const out = await collectReport([
    {
      type: 'test:summary',
      data: { counts: { tests: 2, passed: 2, failed: 0, skipped: 0, todo: 0 }, duration_ms: 120 },
    },
  ]);
  assert.match(out, /^PASS\n/);
  assert.match(out, /2 tests · 2 passed · 0 failed/);
  assert.doesNotMatch(out, /FAILURES/);
});

test('a stream with a failing event yields FAIL, the test name, and the hint', async () => {
  const out = await collectReport([
    { type: 'test:fail', data: { name: 'caps Qi', details: { error: new Error('expected 1000, received 1200') } } },
    {
      type: 'test:summary',
      data: { counts: { tests: 2, passed: 1, failed: 1, skipped: 0, todo: 0 }, duration_ms: 200 },
    },
  ]);
  assert.match(out, /^FAIL\n/);
  assert.match(out, /2 tests/);
  assert.match(out, /1 failed/);
  assert.match(out, /caps Qi/);
  assert.match(out, /expected 1000, received 1200/);
  assert.ok(out.includes(FULL_DETAILS_HINT));
});

test('a stream that ends without a summary event reports FAIL, not a false green', async () => {
  // An interrupted/crashed run never delivers test:summary; the reporter must
  // not print PASS with zero counters.
  const out = await collectReport([
    { type: 'test:fail', data: { name: 'dies mid-run', details: { error: new Error('boom') } } },
  ]);
  assert.match(out, /^FAIL\n/);
  assert.match(out, /aborted or crashed/);
  assert.doesNotMatch(out, /^PASS/);
});

test('coverage events yield the all-files aggregate row', async () => {
  const out = await collectReport([
    {
      type: 'test:coverage',
      data: {
        summary: {
          totals: {
            coveredLineCount: 160,
            totalLineCount: 200,
            coveredBranchCount: 10,
            totalBranchCount: 20,
            coveredFunctionCount: 6,
            totalFunctionCount: 10,
          },
        },
      },
    },
    {
      type: 'test:summary',
      data: { counts: { tests: 1, passed: 1, failed: 0, skipped: 0, todo: 0 }, duration_ms: 10 },
    },
  ]);
  assert.match(out, /all files \| 80\.00 \| 50\.00 \| 60\.00 \|\n/);
});

// --- real spawned runs --------------------------------------------------------

test('a passing fixture produces a compact PASS and exits 0', () => {
  const result = runFixture('reporter-pass.mjs');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^PASS\n/);
  assert.match(result.stdout, /2 passed/);
  assert.match(result.stdout, /0 failed/);
  assert.doesNotMatch(result.stdout, /FAILURES/);
  // Compactness guard: no per-test lines, no giant table.
  assert.ok(result.stdout.length < 500, `output too verbose (${result.stdout.length} chars)`);
});

test('a failing fixture produces FAIL with the test name and exits 1', () => {
  const result = runFixture('reporter-fail.mjs');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^FAIL\n/);
  assert.match(result.stdout, /1 tests/);
  assert.match(result.stdout, /1 failed/);
  assert.match(result.stdout, /failing fixture test \(expected\)/);
  assert.match(result.stdout, /Full details:/);
});
