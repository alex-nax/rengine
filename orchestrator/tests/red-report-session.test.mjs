/* F172 (F149b, spec 129, KI-093): `red-agents report-session` emits byte-identical results to
 * the JS reporter it replaces — POST bodies, context rewrites, stderr notes, exit codes — on
 * the fixture the JS CLI itself recorded (orchestrator/tests/report-session-fixtures.json,
 * captured pre-deletion by report-session-fixtures.mjs). Fourteen cases: the three reporting
 * providers, the two refusals, the binding orders, the gating and the malformed edges.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CASES, stubHost } from './report-session-fixtures.mjs';
import { built } from './cargo.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = path.join(ROOT, 'red/target/debug/red-agents');
const FIXTURES = path.join(ROOT, 'orchestrator/tests/report-session-fixtures.json');
const run = promisify(execFile);

async function runRust(kase, stub) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-report-rust-'));
  try {
    let contextFile = null;
    const env = { PATH: process.env.PATH, HOME: tmpdir(), ...kase.env };
    delete env.MCP_CONFIG;
    delete env.WORKSPACE_CONTEXT;
    if (kase.context) {
      contextFile = path.join(directory, 'context.json');
      const context = {
        ...kase.context,
        url: kase.context.url === 'URL' ? stub.url : kase.context.url,
        token: kase.context.token === 'TOKEN' ? stub.token : kase.context.token,
      };
      await writeFile(contextFile, JSON.stringify(context, null, 2));
      if (kase.env.MCP_CONFIG) {
        const mcpConfig = path.join(directory, 'mcp.json');
        await writeFile(mcpConfig, JSON.stringify({ mcpServers: { rengine_test: { command: 'node', args: ['mcp.mjs', '--context', contextFile] } } }));
        env.RENGINE_MCP_CONFIG = mcpConfig;
      }
      if (kase.env.WORKSPACE_CONTEXT) env.RENGINE_WORKSPACE_CONTEXT = contextFile;
    }
    const argv = ['report-session', ...kase.argv, ...(contextFile && !kase.env.MCP_CONFIG && !kase.env.WORKSPACE_CONTEXT ? ['--context', contextFile] : [])];
    const child = spawn(BIN, argv, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.end(JSON.stringify(kase.stdin));
    const exitCode = await new Promise(resolve => child.once('exit', resolve));
    const contextAfter = contextFile ? JSON.parse(await readFile(contextFile, 'utf8')) : null;
    return { exitCode, stderr, stdout, contextAfter, posts: stub.drain() };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('red-agents report-session matches the frozen JS answers on all fourteen cases', async t => {
  await built('-p', 'red-agents');
  assert.ok(existsSync(BIN), `red-agents was built at ${BIN}`);
  const fixtures = JSON.parse(await readFile(FIXTURES, 'utf8'));
  const stub = await stubHost();
  t.after(() => stub.close());
  for (const kase of CASES) {
    const expected = fixtures[kase.name];
    const actual = await runRust(kase, stub);
    if (expected.contextAfter && kase.context.url === 'URL') expected.contextAfter.url = stub.url;
    assert.equal(actual.exitCode, expected.exitCode, `${kase.name}: exit code`);
    assert.equal(actual.stderr, expected.stderr, `${kase.name}: stderr`);
    assert.equal(actual.stdout, expected.stdout, `${kase.name}: stdout`);
    assert.deepEqual(actual.posts, expected.posts, `${kase.name}: the POST the host recorded`);
    assert.deepEqual(actual.contextAfter, expected.contextAfter, `${kase.name}: the context file afterwards`);
  }
});
