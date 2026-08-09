/**
 * tests/unit/path-portability.test.mjs — repo hygiene guard.
 *
 * Enforces the AGENTS.md "Portable Paths (Hard Rule)": no machine-specific
 * absolute path may ever appear in committed code, data, or tests. Anything
 * before the repo folder name in a path is machine-specific and forbidden.
 *
 * Scope: every source file under js/, data/, css/, tests/ plus index.html.
 * Markdown docs are excluded on purpose — AGENTS.md and the agent rule files
 * document the forbidden patterns themselves. This file is excluded too,
 * because it necessarily quotes the markers it detects.
 *
 * Patterns are constructed from fragments so this file never contains a raw
 * forbidden string (e.g. a literal "C:\" or "/Users/").
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

// Directory roots scanned (relative to the repo root) and extra root files.
const SCAN_DIRS = ['js', 'data', 'css', 'tests'];
const SCAN_FILES = ['index.html'];
const SCAN_EXTENSIONS = new Set(['.js', '.mjs', '.json', '.html', '.css']);
const SELF = 'path-portability.test.mjs';

// --- markers ---------------------------------------------------------------
// Each marker is built from fragments so the guard file itself stays clean.
// The drive-letter marker requires the letter NOT to be preceded by a letter,
// which keeps https://json-schema.org/... URLs from being flagged.
const MARKERS = [
  {
    name: 'drive letter (e.g. C:)',
    make: () => new RegExp('[^A-Za-z][A-Za-z]:[\\\\/]'),
  },
  {
    name: 'user home (e.g. /Users/, /home/, C:\\Users\\)',
    make: () => new RegExp('[\\\\/]Users[\\\\/]|[\\\\/]home[\\\\/]'),
  },
  {
    name: 'OS app-data / temp dir (e.g. AppData, \\Temp\\)',
    make: () => new RegExp('(App' + 'Data)|[\\\\/]Temp[\\\\/]'),
  },
  {
    name: 'repo folder used as an absolute path location',
    make: () => new RegExp('(?:^|[\\\\/])Idle' + 'Cultivation' + 'Game[\\\\/]'),
  },
];

function buildMarkers() {
  return MARKERS.map((m) => ({ name: m.name, re: m.make() }));
}

// --- scanning --------------------------------------------------------------

/** Recursively collect files with a scanned extension. */
function collectFilesRecursive(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFilesRecursive(full, out);
    } else if (
      entry.isFile() &&
      entry.name !== SELF &&
      SCAN_EXTENSIONS.has(extname(entry.name))
    ) {
      out.push(full);
    }
  }
}

/** Return [{ file, line, name, text }] for every marker hit in `files`. */
function findViolations(files, markers) {
  const violations = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((text, index) => {
      for (const { name, re } of markers) {
        if (re.test(text)) {
          violations.push({ file, line: index + 1, name, text: text.trim() });
        }
      }
    });
  }
  return violations;
}

function scannedFiles() {
  const files = [];
  for (const dir of SCAN_DIRS) collectFilesRecursive(join(REPO_ROOT, dir), files);
  for (const file of SCAN_FILES) {
    const full = join(REPO_ROOT, file);
    if (SCAN_EXTENSIONS.has(extname(full))) files.push(full);
  }
  return files;
}

// --- tests -----------------------------------------------------------------
test('every scanned source file is free of machine-specific paths', () => {
  const violations = findViolations(scannedFiles(), buildMarkers());
  const report = violations
    .map((v) => `  ${v.file}:${v.line} [${v.name}] ${v.text}`)
    .join('\n');
  assert.deepEqual(
    violations,
    [],
    `Machine-specific paths found (breaks portability):\n${report || '(none)'}`,
  );
});

test('the scanner actually detects machine paths (positive control)', () => {
  const markers = buildMarkers();
  const badLines = [
    'const p = "C:\\Users\\me\\AppData\\Local\\Temp\\x.mjs";',
    "import x from '../../../../../../Projects/IdleCultivationGame/js/core/x.js';",
    'const p = "/Users/me/game/save.json";',
  ];
  for (const line of badLines) {
    const hits = markers.filter((m) => m.re.test(line));
    assert.ok(hits.length > 0, `expected a marker to hit: ${line}`);
  }
  // Sanity: https URLs and relative imports must NOT be flagged.
  const goodLines = [
    '"$schema": "https://json-schema.org/draft/2020-12/schema",',
    "import { x } from './x.js';",
    "import { y } from '../../js/core/y.js';",
    "const url = new URL('../../data/game-config.json', import.meta.url);",
  ];
  for (const line of goodLines) {
    const hits = markers.filter((m) => m.re.test(line));
    assert.deepEqual(hits, [], `expected no marker to hit: ${line}`);
  }
});
