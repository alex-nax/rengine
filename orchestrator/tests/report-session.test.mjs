import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { agentLaunch } from '../agents/config.mjs';
import { report } from '../agents/report-session.mjs';

/* The launcher decides the conversation at launch and then cannot see a /resume performed inside the
   running CLI: observed live on 2026-09-07, a pane launched as b9e2114c ran 5b8d47c2 while every
   record still said b9e2114c. The CLI is the only thing that knows, so it is asked to say so.
   See docs/specs/095-project-token.md (Identity) and docs/evidence/report-session-hook-2026-09-07.md. */
const reporter = fileURLToPath(new URL('../agents/report-session.mjs', import.meta.url));
const workerMain = fileURLToPath(new URL('../agents/mcp-worker.mjs', import.meta.url));
const LAUNCHED = 'b9e2114c-1111-4111-8111-111111111111';   // what the pane was started with
const RESUMED = '5b8d47c2-2222-4222-8222-222222222222';    // what the person resumed into, in the CLI
const ROOT_ID = '12345678-1234-1234-1234-123456789abc';
const INSTANCE = '87654321-4321-4321-4321-cba987654321';
const TOKEN = 'a'.repeat(64);

/* The payload Claude Code 2.1.263 put on this hook's stdin, recorded on this machine on 2026-09-07
   for source 'resume'; only the ids are this test's. */
const RECORDED = { session_id: RESUMED, transcript_path: `/Users/someone/.claude/projects/-tmp-project/${RESUMED}.jsonl`,
  cwd: '/tmp/project', hook_event_name: 'SessionStart', source: 'resume',
  seconds_since_last_response: 19, context_tokens: 34342, prompt_cache_likely_expired: false, estimated_cache_write_usd: 0.3434 };

async function host(t, { root = { id: ROOT_ID, name: 'project', path: '/tmp/project' } } = {}) {
  const posted = [], seen = [];
  const server = http.createServer((incoming, response) => {
    const chunks = [];
    incoming.on('data', chunk => chunks.push(chunk));
    incoming.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
      seen.push({ url: incoming.url, agent: incoming.headers['x-rengine-agent'], label: incoming.headers['x-rengine-agent-label'] });
      if (incoming.url === '/api/agent-conversation') { posted.push(body); response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"ok":true}'); return; }
      if (incoming.url === '/api/state') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ instance: INSTANCE, roots: [root], sessions: [], drafts: [], capabilities: {}, conversations: {} }));
        return;
      }
      response.writeHead(404, { 'Content-Type': 'application/json' }); response.end('{"error":"no such route"}');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { posted, seen, url: `http://127.0.0.1:${server.address().port}`, token: TOKEN, instance: INSTANCE };
}

async function pane(t, { url, token, instance }, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-report-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const contextFile = path.join(directory, 'root-context.json');
  await writeFile(contextFile, JSON.stringify({ url, token, instance, rootId: ROOT_ID }));
  const plan = await agentLaunch({ agent: 'claude', executable: '/installed/claude', contextFile, env: {}, ...options });
  return { directory, plan, env: { RENGINE_MCP_CONFIG: plan.generic, RENGINE_ORCHESTRATOR_SESSION: 'pane-1' },
    identity: async () => JSON.parse(await readFile(plan.contextFile, 'utf8')).agent };
}

test('a claude launch carries a settings file whose SessionStart hook runs the reporter', async t => {
  const workspace = await host(t);
  const { plan } = await pane(t, workspace, { conversation: LAUNCHED });

  assert.deepEqual(plan.args.slice(0, 4), ['--mcp-config', plan.generic, '--settings', plan.settings],
    'the CLI is given the per-launch settings beside the per-launch MCP configuration');
  assert.equal(path.dirname(plan.settings), plan.directory, 'written in this launch’s own directory, never over the person’s settings file');
  assert.equal((await stat(plan.settings)).mode & 0o777, 0o600);

  const settings = JSON.parse(await readFile(plan.settings, 'utf8'));
  assert.deepEqual(Object.keys(settings.hooks), ['SessionStart'], 'and it adds one hook: the one that says what this CLI is running');
  const command = settings.hooks.SessionStart[0].hooks[0].command;
  assert.equal(settings.hooks.SessionStart[0].hooks[0].type, 'command');
  assert.ok(command.includes(reporter), `the hook runs report-session.mjs by absolute path (${command})`);
  assert.ok(command.startsWith(process.execPath) || command.includes(`'${process.execPath}'`), 'under the node the launcher itself is running');
  assert.ok(command.includes(`--context ${plan.contextFile}`) || command.includes(`--context '${plan.contextFile}'`),
    'and is told this launch’s context on its own command line, so a session started by hand is bound too');
  await stat(reporter);
});

/* `bind.mjs` prints a line a person runs in their own shell, which inherits none of the launcher's
   environment. The context on the hook's command line is what makes that session report itself. */
test('a session started from the line bind prints reports itself with no environment at all', async t => {
  const workspace = await host(t);
  const { plan, identity } = await pane(t, workspace, { conversation: LAUNCHED });
  const settings = JSON.parse(await readFile(plan.settings, 'utf8'));
  const argv = settings.hooks.SessionStart[0].hooks[0].command.split(' ').slice(2).map(value => value.replace(/^'|'$/g, ''));

  const result = await report({ env: {}, argv, input: RECORDED });
  assert.equal(result.bound, true, 'the hook finds the launch it was written for without RENGINE_MCP_CONFIG');
  assert.equal(result.rewrote, true);
  assert.equal(result.posted, false, 'and reports to no pane, because a bound session is not one');
  assert.deepEqual(workspace.posted, []);
  assert.equal((await identity()).agentId, RESUMED, 'the identity the tool worker reads still follows the CLI');
});

test('the CLI’s own report replaces the conversation: the host is told and the context follows', async t => {
  const workspace = await host(t);
  const { plan, env, identity } = await pane(t, workspace, { conversation: LAUNCHED });
  const before = await identity();
  assert.equal(before.agentId, LAUNCHED, 'the launch recorded the conversation the workspace minted');

  const result = await report({ env, input: RECORDED });
  assert.deepEqual(result, { bound: true, contextFile: plan.contextFile, conversation: RESUMED, source: 'resume',
    rewrote: true, posted: true, was: LAUNCHED });
  assert.deepEqual(workspace.posted, [{ id: 'pane-1', conversation: RESUMED, agent: 'claude' }],
    'the host is told over the same route the launcher reports on, so the pane record follows the CLI');

  const after = await identity();
  assert.equal(after.agentId, RESUMED, 'the conversation IS the identity, so the agentId is the one the CLI is in');
  assert.equal(after.label, `claude ${RESUMED.slice(0, 8)}`, 'and the eight characters it goes by are that conversation’s');
  assert.deepEqual(after.session, { provider: 'claude', id: RESUMED, known: true, source: 'reported',
    resume: `claude --resume ${RESUMED}` }, 'the session says the CLI reported it, and the line that resumes it is that one');
  assert.equal(after.pid, before.pid, 'the pid is the launcher’s and is not the CLI’s to change');
  assert.equal(after.startedAt, before.startedAt);
  assert.equal(JSON.parse(await readFile(plan.contextFile, 'utf8')).rootId, ROOT_ID, 'and the binding the file carries is untouched');

  workspace.posted.length = 0;
  const again = await report({ env, input: { ...RECORDED, source: 'compact' } });
  assert.equal(again.rewrote, false, 'a report that changes nothing rewrites nothing');
  assert.equal(again.posted, true, 'but still reports, so a record the launcher could not write heals on the next session start');
});

test('outside a workspace pane the hook reports nothing and never fails the CLI', async t => {
  const workspace = await host(t);
  await pane(t, workspace, { conversation: LAUNCHED });
  assert.deepEqual(await report({ env: {}, input: RECORDED }), { bound: false, rewrote: false, posted: false });
  assert.deepEqual(workspace.posted, [], 'a CLI that is not in a workspace pane has nothing to report to');

  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('RENGINE_')));
  for (const [payload, complains] of [[JSON.stringify(RECORDED), false], ['{}', false], ['not json at all', true]]) {
    const child = spawn(process.execPath, [reporter], { env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', errors = '';
    child.stdout.on('data', data => { out += data; });
    child.stderr.on('data', data => { errors += data; });
    child.stdin.end(payload);
    const code = await new Promise(resolve => child.on('exit', resolve));
    assert.equal(code, 0, `the hook exits 0 for ${payload.slice(0, 20)}, so it can never fail the CLI it runs inside`);
    assert.equal(out, '', 'and writes nothing to stdout, which a SessionStart hook would add to the CLI’s context');
    assert.equal(errors !== '', complains, `trouble goes to stderr and nowhere else (${payload.slice(0, 20)})`);
  }
});

test('a launch that continued or forked becomes known once the CLI reports', async t => {
  const workspace = await host(t);
  const { plan, env, identity } = await pane(t, workspace, { conversation: LAUNCHED, args: ['-c'] });
  assert.equal(plan.conversation, null, 'a -c launch claims nothing: the CLI names that conversation itself');
  const before = await identity();
  assert.equal(before.session.known, false, 'so the identity is rEngine’s own and says it does not know the conversation');
  assert.notEqual(before.agentId, RESUMED);

  await report({ env, input: { ...RECORDED, source: 'startup' } });
  const after = await identity();
  assert.equal(after.agentId, RESUMED, 'and the id the CLI minted for itself becomes the identity as soon as it reports it');
  assert.equal(after.session.known, true, 'known, because the CLI said so rather than rEngine guessing');
  assert.deepEqual(workspace.posted, [{ id: 'pane-1', conversation: RESUMED, agent: 'claude' }],
    'so the pane the launcher had to leave empty can be restarted into its conversation');
});

test('a kimi SessionStart hook reports the session the CLI is running, with its own resume line', async t => {
  /* kimi's hook lives in the person's own config.toml and is installed by the guided bootstrap
     action (spec 127 decision 6); what lands there is this reporter with --provider kimi. */
  const workspace = await host(t);
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-report-kimi-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const contextFile = path.join(directory, 'root-context.json');
  await writeFile(contextFile, JSON.stringify({ url: workspace.url, token: TOKEN, instance: INSTANCE, rootId: ROOT_ID }));
  const plan = await agentLaunch({ agent: 'kimi', executable: '/installed/kimi', contextFile, env: {}, cwd: directory });
  const env = { RENGINE_MCP_CONFIG: plan.generic, RENGINE_ORCHESTRATOR_SESSION: 'pane-kimi-1' };
  const KIMI_SESSION = 'session_5b8d47c2-2222-4222-8222-222222222222';
  /* The payload shape kimi's SessionStart documents: the base fields every hook gets. */
  const payload = { session_id: KIMI_SESSION, session_title: 'a kimi pane', client_type: 'kimi_code_cli', cwd: '/tmp/project',
    hook_event_name: 'SessionStart', source: 'startup', model: 'kimi-for-coding', profile: 'default' };

  const result = await report({ env, argv: ['--provider', 'kimi'], input: payload });
  assert.equal(result.bound, true);
  assert.equal(result.rewrote, true);
  assert.equal(result.posted, true);
  assert.deepEqual(workspace.posted, [{ id: 'pane-kimi-1', conversation: KIMI_SESSION, agent: 'kimi' }],
    'the host is told over the same route claude’s hook uses, under kimi’s own name');

  const identity = JSON.parse(await readFile(plan.contextFile, 'utf8')).agent;
  assert.equal(identity.agentId, KIMI_SESSION, 'the conversation IS the identity, prefix included');
  assert.equal(identity.label, `kimi ${KIMI_SESSION.slice(8, 16)}`, 'labelled by the eight characters after the session_ prefix');
  assert.deepEqual(identity.session, { provider: 'kimi', id: KIMI_SESSION, known: true, source: 'reported',
    resume: `kimi --session ${KIMI_SESSION}` }, 'and the line that resumes it is kimi’s own spelling');

  await assert.rejects(report({ env, argv: ['--provider', 'kimi'], input: { ...payload, session_id: 'not a session' } }), /session id/i,
    'a payload in no shape kimi resumes by is refused (and the wrapper still exits 0, so the CLI is never failed)');
  assert.equal(workspace.posted.length, 1, 'and nothing more was reported');
});

test('a codex SessionStart hook reports the session the CLI is running, with its own resume line', async t => {
  /* codex's documented hooks carry SessionStart on startup and resume; the launch injects the hook
     through the same -c channel as its MCP wiring (F113 criterion 6), running this reporter with
     --provider codex. */
  const workspace = await host(t);
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-report-codex-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const contextFile = path.join(directory, 'root-context.json');
  await writeFile(contextFile, JSON.stringify({ url: workspace.url, token: TOKEN, instance: INSTANCE, rootId: ROOT_ID }));
  const plan = await agentLaunch({ agent: 'codex', executable: '/installed/codex', contextFile, env: {} });
  const env = { RENGINE_MCP_CONFIG: plan.generic, RENGINE_ORCHESTRATOR_SESSION: 'pane-codex-1' };
  const payload = { session_id: RESUMED, transcript_path: `/Users/someone/.codex/sessions/2026/09/11/${RESUMED}.jsonl`,
    cwd: '/tmp/project', hook_event_name: 'SessionStart', source: 'resume' };

  const result = await report({ env, argv: ['--provider', 'codex'], input: payload });
  assert.equal(result.bound, true);
  assert.equal(result.rewrote, true);
  assert.equal(result.posted, true);
  assert.deepEqual(workspace.posted, [{ id: 'pane-codex-1', conversation: RESUMED, agent: 'codex' }],
    'the host is told over the same route, under codex’s own name');

  const identity = JSON.parse(await readFile(plan.contextFile, 'utf8')).agent;
  assert.equal(identity.agentId, RESUMED);
  assert.equal(identity.label, `codex ${RESUMED.slice(0, 8)}`);
  assert.deepEqual(identity.session, { provider: 'codex', id: RESUMED, known: true, source: 'reported',
    resume: `codex resume ${RESUMED}` }, 'and the line that resumes it is codex’s own spelling');
});

test('the tool worker’s next call carries the conversation the CLI reported', async t => {
  const workspace = await host(t);
  const { plan, env } = await pane(t, workspace, { conversation: LAUNCHED });
  const snapshot = JSON.parse(await readFile(plan.contextFile, 'utf8'));

  const client = new Client({ name: 'rengine-report-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [workerMain, '--context', plan.contextFile], stderr: 'pipe',
    env: { ...process.env, RENGINE_MCP_CONTEXT_SNAPSHOT: JSON.stringify(snapshot) } }));
  t.after(() => client.close());
  const info = async () => {
    const result = await client.callTool({ name: 'workspace_info', arguments: {} });
    assert.equal(result.isError, undefined, result.content?.[0]?.text);
    return result.structuredContent;
  };

  assert.equal((await info()).agent.agentId, LAUNCHED, 'before the report, the worker is the conversation the launch named');
  await report({ env, input: RECORDED });

  const after = await info();
  assert.equal(after.agent.agentId, RESUMED, 'the identity is re-read per call, so workspace_info follows the CLI without a restart');
  assert.equal(after.agent.label, `claude ${RESUMED.slice(0, 8)}`);
  assert.equal(after.root.id, ROOT_ID, 'while the binding stays the snapshot’s: the file can rename this agent, never retarget its root');
  const identified = workspace.seen.filter(entry => entry.agent);
  assert.equal(identified.at(0).agent, LAUNCHED, 'and the ledger sees the same change on the wire');
  assert.equal(identified.at(-1).agent, RESUMED);
  assert.equal(identified.at(-1).label, `claude ${RESUMED.slice(0, 8)}`);
});
