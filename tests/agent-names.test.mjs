/* F217, spec 141: an agent CLI's name may not appear in shared code, and the build says so.
 *
 * The rule existed as prose and did not hold. `docs/lessons-learned.md` records what that cost:
 * spec 140 said "one adapter per CLI", and the file that put three CLIs in one was written in the
 * same session by the agent that had written the spec. The product name has had a build-failing
 * guard for a year (`design.py check`); an agent name had nothing, which is the whole difference.
 *
 * This spec is the guard's own evidence, and the shape is `product-name.test.mjs`'s: the real tree
 * must be clean, and the check must go red for its own reason on a decoy written OUTSIDE the tree,
 * because other agents are working inside it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = ['tools/agent_names.py', 'check'];

test('no shared source names an agent CLI, and the guard is reachable from the gates', async () => {
  const clean = await run('python3', GUARD, { cwd: ROOT });
  assert.match(clean.stdout, /No agent name appears in shared code/, clean.stdout);

  /* And it runs with the other gates rather than on request, which is what keeps it honest. */
  const init = await readFile(path.join(ROOT, 'init.sh'), 'utf8');
  assert.match(init, /python3 tools\/agent_names\.py check/, 'init.sh runs the guard');
});

test('the guard goes red for its own reason, and says which name and where', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-agent-name-decoy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const decoy = path.join(directory, 'decoy.rs');

  /* The exact shape F210 shipped: one file with a function per agent. `\b` does NOT catch
     `kimi_flags` — `_` is a word character — and the guard passed this the first time it was tried,
     which is why the case is pinned here. */
  await writeFile(decoy, [
    '/* A comment naming kimi is prose: a file has to be able to say why it is shaped this way. */',
    'fn kimi_flags() {}',
    'fn claude_flags() {}',
    'const HOME: &str = "https://codex.example/path";  // a name after a URL is still a name',
    '#[cfg(test)]',
    'pub(crate) mod tests {',
    '    const FIXTURE: &str = "gemini";  // a fixture naming one deliberately is the point of it',
    '}',
    ''].join('\n'));

  const refused = await run('python3', [...GUARD, decoy], { cwd: ROOT }).catch(error => error);
  assert.equal(refused.code, 1, `the guard failed the build: ${refused.stdout}`);
  const lines = refused.stdout.split('\n').filter(line => line.includes(': ['));
  assert.equal(lines.length, 3, `the two functions and the URL, not the comment or the fixture: ${refused.stdout}`);
  assert.match(lines[0], /decoy\.rs:2: \[kimi\] fn kimi_flags/, 'by name and by location');
  assert.match(lines[1], /decoy\.rs:3: \[claude\]/);
  assert.match(lines[2], /decoy\.rs:4: \[codex\]/, 'a name after `//` inside a string is not hidden');
  /* `pub(crate) mod tests` is a test module like any other. Missing the visibility modifier made
     deliberate fixtures fire, which pushes the next person toward an exception for TEST code — the
     one kind this list must never collect. */
  assert.ok(!refused.stdout.includes('[gemini]'), `a fixture inside pub(crate) mod tests is not a finding: ${refused.stdout}`);

  /* A word boundary is the wrong tool TWICE over. `\b` does not break at `_`, so `\bkimi\b` misses
     `kimi_flags`; widening it to "not a letter or digit" then misses `codexModels`, because
     JavaScript spells the same violation in camelCase. Both spellings were live findings when the
     boundary was fixed the second time (F220). */
  const camel = path.join(directory, 'camel.mjs');
  await writeFile(camel, [
    "export const codexModels = help => ask('codexModels', help);",
    'export const claudeSettings = x => x;',
    'const codexish = 1;  // a different word, and not a finding',
    ''].join('\n'));
  const spelled = await run('python3', [...GUARD, camel], { cwd: ROOT }).catch(error => error);
  const found = spelled.stdout.split('\n').filter(line => line.includes(': ['));
  assert.equal(found.length, 2, `camelCase counts, and a longer word does not: ${spelled.stdout}`);
  assert.match(found[0], /camel\.mjs:1: \[codex\]/);
  assert.match(found[1], /camel\.mjs:2: \[claude\]/);
  /* It names the antipattern and points at the record, rather than only reporting a match. */
  assert.match(refused.stdout, /docs\/lessons-learned\.md/);
  assert.match(refused.stdout, /one file that knows every agent/);
  assert.match(refused.stdout, /add it to EXCEPTIONS in tools\/agent_names\.py/,
    'and says how to declare one that genuinely belongs');
});

test('the roster is the registry’s, so a CLI added as data is guarded the day it is added', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-agent-name-roster-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const decoy = path.join(directory, 'decoy.mjs');
  await writeFile(decoy, 'export const WHO = "opencode";\n');
  const refused = await run('python3', [...GUARD, decoy], { cwd: ROOT }).catch(error => error);
  assert.equal(refused.code, 1, 'every declared CLI is guarded, not a list kept in the checker');
  assert.match(refused.stdout, /\[opencode\]/);
});
