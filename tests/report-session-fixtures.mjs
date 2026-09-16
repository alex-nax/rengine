/* The report-session fixture capture tool (F172, spec 129, KI-093): drives the JS
 * report-session.mjs CLI through the recorded cases against a stub host and freezes its exact
 * answers — POST bodies, context rewrites, stderr notes, exit codes — into
 * tests/report-session-fixtures.json. Like store-corpus.mjs, this is a tool
 * module, not a test: the frozen fixture is the witness; regenerating is a deliberate refresh,
 * never done by the suite.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/* Where the JS reporter WAS when this record was captured. The module is deleted and the path's
   directory has moved since (charter D71); both are true and neither matters, because this constant
   is only reached by the regenerate path — which must never run again (F172). Spelled as it was, so
   the file says what it recorded rather than what today's tree looks like. */
const REPORTER = path.join(ROOT, 'orchestrator/agents/report-session.mjs');
const OLD = '3f85774e-05bb-4791-bb9f-1c90dc37d0e6';
const NEW = 'aaaaaaaa-1111-4222-8333-444444444444';
const KIMI_ID = 'session_3f85774e-05bb-4791-bb9f-1c90dc37d0e6';

const contextFor = (url, token, agent = undefined) => ({
  url, token, instance: '87654321-4321-4321-4321-cba987654321', rootId: '12345678-1234-1234-1234-123456789abc',
  ...(agent ? { agent } : {}),
});
const claudeIdentity = { agentId: OLD, label: 'claude 3f85774e', pid: 4242, startedAt: '2026-09-12T10:00:00.000Z' };

export const CASES = [
  { name: 'claude-startup-rewrites-and-posts', argv: [],
    env: { RENGINE_ORCHESTRATOR_SESSION: 'pane-claude-1' },
    context: contextFor('URL', 'TOKEN', claudeIdentity),
    stdin: { session_id: NEW, hook_event_name: 'SessionStart', source: 'startup' } },
  { name: 'claude-same-id-posts-without-rewrite', argv: [],
    env: { RENGINE_ORCHESTRATOR_SESSION: 'pane-claude-2' },
    context: contextFor('URL', 'TOKEN', claudeIdentity),
    stdin: { session_id: OLD, hook_event_name: 'SessionStart', source: 'resume' } },
  { name: 'codex-reports-with-its-provider', argv: ['--provider', 'codex'],
    env: { RENGINE_ORCHESTRATOR_SESSION: 'pane-codex-1' },
    context: contextFor('URL', 'TOKEN', claudeIdentity),
    stdin: { session_id: NEW, hook_event_name: 'SessionStart', source: 'resume' } },
  { name: 'kimi-keeps-the-session-prefix', argv: ['--provider', 'kimi'],
    env: { RENGINE_ORCHESTRATOR_SESSION: 'pane-kimi-1' },
    context: contextFor('URL', 'TOKEN', { agentId: KIMI_ID, label: 'kimi 3f85774e', pid: 99, startedAt: '2026-09-12T10:00:00.000Z' }),
    stdin: { session_id: 'session_aaaaaaaa-1111-4222-8333-444444444444', hook_event_name: 'SessionStart', source: 'startup' } },
  { name: 'gemini-is-refused-by-name', argv: ['--provider', 'gemini'],
    env: { RENGINE_ORCHESTRATOR_SESSION: 'pane-gemini-1' },
    context: contextFor('URL', 'TOKEN'),
    stdin: { session_id: NEW, hook_event_name: 'SessionStart', source: 'startup' } },
  { name: 'opencode-is-refused-by-name', argv: ['--provider', 'opencode'],
    env: { RENGINE_ORCHESTRATOR_SESSION: 'pane-opencode-1' },
    context: contextFor('URL', 'TOKEN'),
    stdin: { session_id: NEW, hook_event_name: 'SessionStart', source: 'startup' } },
  { name: 'no-orchestrator-session-rewrites-without-post', argv: [],
    env: {},
    context: contextFor('URL', 'TOKEN', claudeIdentity),
    stdin: { session_id: NEW, hook_event_name: 'SessionStart', source: 'startup' } },
  { name: 'a-malformed-id-is-noted-never-failed', argv: [],
    env: { RENGINE_ORCHESTRATOR_SESSION: 'pane-bad-1' },
    context: contextFor('URL', 'TOKEN'),
    stdin: { session_id: 'not-a-session', hook_event_name: 'SessionStart', source: 'startup' } },
  { name: 'no-id-in-the-payload-is-noted', argv: [],
    env: { RENGINE_ORCHESTRATOR_SESSION: 'pane-bad-2' },
    context: contextFor('URL', 'TOKEN'),
    stdin: { hook_event_name: 'SessionStart', source: 'startup' } },
  { name: 'binding-through-mcp-config', argv: [], env: { RENGINE_ORCHESTRATOR_SESSION: 'pane-env-1', MCP_CONFIG: 'yes' },
    context: contextFor('URL', 'TOKEN', claudeIdentity),
    stdin: { session_id: NEW, hook_event_name: 'SessionStart', source: 'startup' } },
  { name: 'binding-through-workspace-context', argv: [], env: { RENGINE_ORCHESTRATOR_SESSION: 'pane-env-2', WORKSPACE_CONTEXT: 'yes' },
    context: contextFor('URL', 'TOKEN', claudeIdentity),
    stdin: { session_id: NEW, hook_event_name: 'SessionStart', source: 'startup' } },
  { name: 'nothing-to-report-to', argv: [], env: {}, context: null,
    stdin: { session_id: NEW, hook_event_name: 'SessionStart', source: 'startup' } },
  { name: 'an-invalid-connection-is-noted', argv: [],
    env: { RENGINE_ORCHESTRATOR_SESSION: 'pane-bad-3' },
    context: { url: 'http://example.com/', token: 'not-hex' },
    stdin: { session_id: NEW, hook_event_name: 'SessionStart', source: 'startup' } },
  { name: 'an-unknown-provider-is-noted', argv: ['--provider', 'whatever'],
    env: { RENGINE_ORCHESTRATOR_SESSION: 'pane-bad-4' },
    context: contextFor('URL', 'TOKEN'),
    stdin: { session_id: NEW, hook_event_name: 'SessionStart', source: 'startup' } },
];

/* Run one CLI (argv-ordered: reporter args, then --context FILE unless the case omits it) with a
   hermetic environment and the stub host recording. Returns the full expectation. */
export async function runCase(command, kase, stub) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-report-case-'));
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
    const argv = [...command, ...kase.argv, ...(contextFile && !kase.env.MCP_CONFIG && !kase.env.WORKSPACE_CONTEXT ? ['--context', contextFile] : [])];
    const child = spawn(argv[0], argv.slice(1), { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.end(JSON.stringify(kase.stdin));
    const exitCode = await new Promise(resolve => child.once('exit', resolve));
    const contextAfter = contextFile ? JSON.parse(await readFile(contextFile, 'utf8')) : null;
    return { name: kase.name, exitCode, stderr, stdout, contextAfter, posts: stub.drain() };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function stubHost() {
  const token = 'f'.repeat(64);
  let recorded = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      recorded.push({ path: request.url, authorization: request.headers.authorization ?? null, body });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, token,
    drain: () => { const out = recorded; recorded = []; return out; },
    close: () => new Promise(resolve => server.close(resolve)) };
}

/* The capture itself, run as a tool: node tests/report-session-fixtures.mjs */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stub = await stubHost();
  const out = {};
  for (const kase of CASES) out[kase.name] = await runCase(['node', REPORTER], kase, stub);
  await stub.close();
  const file = path.join(ROOT, 'tests/report-session-fixtures.json');
  await writeFile(file, JSON.stringify(out, null, 2) + '\n');
  console.log(`captured ${CASES.length} cases into ${path.relative(ROOT, file)}`);
}
