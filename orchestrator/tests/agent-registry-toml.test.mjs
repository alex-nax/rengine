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
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { built } from './cargo.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REGISTRY = path.join(ROOT, 'orchestrator/agents/registry.toml');
const DUMP = path.join(ROOT, 'red/target/debug/red-agents-dump');
const run = promisify(execFile);

/* F148 made this a parity proof between two parsers of one document. F173 deleted the JS one, and a
   parity proof cannot outlive the side it compares against — so what the shipped document resolves
   to is judged against the answer registry.mjs gave, recorded before its deletion, and the refusals
   are judged on their own terms. Regenerating the record would be judging the parser against
   itself. */
const RECORDED = JSON.parse(readFileSync(new URL('./agents-fixtures.json', import.meta.url), 'utf8')).resolvedRecipes;
async function build(t) {
  await built('-p', 'red-agents', '--bin', 'red-agents-dump');
  assert.ok(existsSync(DUMP), `red-agents-dump was built at ${DUMP}`);
  return () => RECORDED;
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

test('the shipped document resolves to the recipes registry.mjs resolved it to', async t => {
  const resolvedRecipes = await build(t);
  const dumped = JSON.parse((await run(DUMP, [REGISTRY])).stdout);
  assert.deepEqual(resolvedRecipes(), dumped,
    'the two sides parse the one document through the same subset and resolve the same atoms');
  /* The SET of CLIs is the claim; the dump's key order is not. It used to come out sorted only
     because serde_json's default map is a BTreeMap, and F172 turned on `preserve_order` so the hook
     payloads stay byte-identical with the JS reporter's field order — which makes every object in
     the crate, this projection included, keep document order instead. */
  assert.deepEqual(Object.keys(dumped).sort(), ['claude', 'codex', 'gemini', 'kimi', 'opencode'].sort(),
    'every shipped CLI is in the document');
});

test('an extra registry is TOML data, and redeclaration is refused by name', async t => {
  const resolvedRecipes = await build(t);
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-extra-toml-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const extra = path.join(dir, 'extra.toml');
  await writeFile(extra, EXTRA_TOML);

  process.env.RENGINE_AGENT_REGISTRY_EXTRA = extra;
  t.after(() => { delete process.env.RENGINE_AGENT_REGISTRY_EXTRA; });
  const dumped = JSON.parse((await run(DUMP, [REGISTRY, '--extra', extra])).stdout);
  const { testcli, ...shipped } = dumped;
  assert.deepEqual(shipped, resolvedRecipes(), 'the shipped recipes are untouched by an extra document');
  assert.equal(dumped.testcli?.package, '@test/testcli', 'the extra recipe resolved as data');

  const clash = path.join(dir, 'clash.toml');
  await writeFile(clash, EXTRA_TOML.replaceAll('testcli', 'claude'));
  process.env.RENGINE_AGENT_REGISTRY_EXTRA = clash;
  await assert.rejects(() => run(DUMP, [REGISTRY, '--extra', clash]),
    error => /redeclares claude/.test(error.stderr), 'a redeclaration is refused by the name it redeclares');
});

test('malformed TOML is refused with its file and line', async t => {
  const resolvedRecipes = await build(t);
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-bad-toml-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bad = path.join(dir, 'bad.toml');
  // Line 5 carries an inline table, which the subset refuses by name.
  await writeFile(bad, `[recipes.badcli]\npackage = "@test/badcli"\n\n[recipes.badcli.update]\nkind = { self = true }\n`);
  process.env.RENGINE_AGENT_REGISTRY_EXTRA = bad;
  t.after(() => { delete process.env.RENGINE_AGENT_REGISTRY_EXTRA; });
  await assert.rejects(() => run(DUMP, [REGISTRY, '--extra', bad]),
    error => /bad\.toml:5:/.test(error.stderr), 'the parser names the file and the line');
});
