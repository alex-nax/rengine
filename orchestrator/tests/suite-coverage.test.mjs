import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TESTS = path.join(ROOT, 'orchestrator/tests');

// A fixture that leaves the suite is invisible: the report stays green and says nothing about what
// is no longer being asked. It happened twice in one day — once as a list edit that read like a
// rename, once as a merge resolution that took one side of a list and dropped the other's addition.
// Neither is visible in a diff review of a long single-line script.
//
// A spec may be excluded deliberately, but the exclusion has to be written down here with its
// reason, so removing a spec from the suite is a visible edit in a reviewed file rather than a
// silent deletion inside a long single-line script.
const DELIBERATELY_UNRUN = {
  'native-agent.spec.mjs': 'needs RENGINE_NATIVE_AGENT_ROOT naming a trusted project with a real agent CLI installed',
  'sdl.spec.mjs': 'needs the separately built surface fixture in .cache/native; run by hand, see docs/evidence/gameplay-input-macos-2026-09-05.md',
};

// The same hole, one layer down: the native tests are declared in cmake.toml as CTest targets and
// run by ctest, which no npm script invoked at all until 2026-09-11 — so native_gpu_seam and
// native_gpu_device had been passing into a report nobody generated. A narrowing -R filter would
// reintroduce exactly the invisibility this file exists to prevent, so the runner must take none.
test('the native CTest targets are reachable from a script that runs all of them', async () => {
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const declared = [...(await readFile(path.join(ROOT, 'cmake.toml'), 'utf8'))
    .matchAll(/add_test\(NAME\s+(\S+)/g)].map(m => m[1]);
  assert.ok(declared.length > 0, 'cmake.toml declares CTest targets');
  const runners = Object.values(manifest.scripts).filter(s => /\bctest\b/.test(s));
  assert.ok(runners.length > 0,
    `cmake.toml declares ${declared.join(', ')} but no npm script runs ctest, so none of them is in any report`);
  for (const runner of runners)
    assert.ok(!/\s-R\b/.test(runner),
      `"${runner}" narrows ctest with -R, which hides every target it does not name`);
});

test('every desktop spec runs somewhere, or says why it does not', async () => {
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const scripts = Object.values(manifest.scripts).join(' ');
  const listed = new Set([...scripts.matchAll(/orchestrator\/tests\/(\S+\.spec\.mjs)/g)].map(m => m[1]));
  const present = (await readdir(TESTS)).filter(name => name.endsWith('.spec.mjs'));
  assert.ok(present.length > 0, 'the fixtures directory has specs in it');

  const unrun = present.filter(name => !listed.has(name) && !(name in DELIBERATELY_UNRUN));
  assert.deepEqual(unrun, [], `these specs are in the tree and no npm script runs them: ${unrun.join(', ')}`);

  // An allowlist that outlives its entries is its own kind of rot.
  const stale = Object.keys(DELIBERATELY_UNRUN).filter(name => !present.includes(name) || listed.has(name));
  assert.deepEqual(stale, [], `these exclusions no longer apply and should be deleted: ${stale.join(', ')}`);

  const absent = [...listed].filter(name => !present.includes(name));
  assert.deepEqual(absent, [], `these specs are named by a script but not in the tree: ${absent.join(', ')}`);
});

test('unit tests are matched by the pattern that runs them', async () => {
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(manifest.scripts.test, /orchestrator\/tests\/\*\.test\.mjs/,
    'the unit suite runs by glob, so a new .test.mjs file is picked up without a list edit');
  const present = (await readdir(TESTS)).filter(name => name.endsWith('.test.mjs'));
  assert.ok(present.length > 10, `the glob has files to match: ${present.length}`);
});
