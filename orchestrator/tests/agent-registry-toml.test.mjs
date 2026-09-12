/* F148a (spec 129, KI-092): the agent recipe registry is ONE TOML document. The remaining JS
 * (registry.mjs, until F149) and the red-agents crate parse the same file through the same
 * bounded subset, so the resolved recipes are identical for every CLI — proven here against a
 * JSON dump from the Rust side, the same harness shape red-contract established (F140).
 *
 * The EXTRA file moved from JSON to TOML in this slice (the contract change KI-092 records);
 * the end-to-end "added as data" proofs live in agent-registry.test.mjs on the TOML form.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REGISTRY = path.join(ROOT, 'orchestrator/agents/registry.toml');
const DUMP = path.join(ROOT, 'red/target/debug/red-agents-dump');
const run = promisify(execFile);

async function build(t) {
  await run('cargo', ['build', '-p', 'red-agents', '--bin', 'red-agents-dump'], { cwd: path.join(ROOT, 'red') });
  assert.ok(existsSync(DUMP), `red-agents-dump was built at ${DUMP}`);
  return (await import('../agents/registry.mjs')).resolvedRecipes;
}

const EXTRA_TOML = `[recipes.testcli]
package = "@test/testcli"

[recipes.testcli.update]
kind = "self"
command = "upgrade"

[recipes.testcli.model]
flag = "--model"

[recipes.testcli.models]
kind = "none"

[recipes.testcli.mcp]
kind = "flag"
`;

test('JS and Rust resolve identical recipes for every CLI', async t => {
  const resolvedRecipes = await build(t);
  const dumped = JSON.parse((await run(DUMP, [REGISTRY])).stdout);
  assert.deepEqual(resolvedRecipes(), dumped,
    'the two sides parse the one document through the same subset and resolve the same atoms');
  assert.deepEqual(Object.keys(dumped), ['claude', 'codex', 'gemini', 'kimi', 'opencode'].sort(),
    'every shipped CLI is in the document');
});

test('an extra registry is TOML data on both sides, and redeclaration is refused on both', async t => {
  const resolvedRecipes = await build(t);
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-extra-toml-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const extra = path.join(dir, 'extra.toml');
  await writeFile(extra, EXTRA_TOML);

  process.env.RENGINE_AGENT_REGISTRY_EXTRA = extra;
  t.after(() => { delete process.env.RENGINE_AGENT_REGISTRY_EXTRA; });
  const dumped = JSON.parse((await run(DUMP, [REGISTRY, '--extra', extra])).stdout);
  assert.deepEqual(resolvedRecipes(), dumped, 'shipped plus extra, identical on both sides');
  assert.equal(dumped.testcli?.package, '@test/testcli', 'the extra recipe resolved as data');

  const clash = path.join(dir, 'clash.toml');
  await writeFile(clash, EXTRA_TOML.replaceAll('testcli', 'claude'));
  process.env.RENGINE_AGENT_REGISTRY_EXTRA = clash;
  assert.throws(() => resolvedRecipes(), /redeclares claude/, 'JS refuses the redeclaration');
  await assert.rejects(() => run(DUMP, [REGISTRY, '--extra', clash]),
    error => /redeclares claude/.test(error.stderr), 'Rust refuses it in the same words');
});

test('malformed TOML is refused with its line number by both parsers', async t => {
  const resolvedRecipes = await build(t);
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-bad-toml-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bad = path.join(dir, 'bad.toml');
  // Line 5 carries an inline table, which the subset refuses by name.
  await writeFile(bad, `[recipes.badcli]\npackage = "@test/badcli"\n\n[recipes.badcli.update]\nkind = { self = true }\n`);
  process.env.RENGINE_AGENT_REGISTRY_EXTRA = bad;
  t.after(() => { delete process.env.RENGINE_AGENT_REGISTRY_EXTRA; });
  assert.throws(() => resolvedRecipes(), /bad\.toml:5:/, 'the JS parser names the file and line');
  await assert.rejects(() => run(DUMP, [REGISTRY, '--extra', bad]),
    error => /bad\.toml:5:/.test(error.stderr), 'the Rust parser names the same file and line');
});
