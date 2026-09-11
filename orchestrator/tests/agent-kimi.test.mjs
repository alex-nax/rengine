import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { agentLaunch, describeSession } from '../agents/config.mjs';

/* Kimi Code is a named CLI like the other four (docs/specs/127-kimi-agent-integration.md). Its
   channels are its own: the workspace MCP reaches it through the project-level .kimi-code/mcp.json
   — the only per-project channel kimi publishes — and its session is named by its own --session
   flags, never minted by rEngine, because kimi has no start-with-id flag. */
const ROOT_ID = '12345678-1234-1234-1234-123456789abc';
const INSTANCE = '87654321-4321-4321-4321-cba987654321';
const TOKEN = 'a'.repeat(64);
/* The shape kimi reports on its SessionStart hook, prefix included; the documentation also shows
   ULID-shaped ids. */
const SESSION = 'session_3f85774e-05bb-4791-bb9f-1c90dc37d0e6';
const ULID = '01HZYJ8K3M4N5P6Q7R8S9T0V1W';

async function project(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-kimi-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'project');
  await mkdir(path.join(root, '.git'), { recursive: true });
  const contextFile = path.join(directory, 'context.json');
  await writeFile(contextFile, JSON.stringify({ url: 'http://127.0.0.1:1/', token: TOKEN, instance: INSTANCE, rootId: ROOT_ID }));
  return { directory, root, contextFile };
}

test('a kimi launch wires the workspace MCP into the project it runs in, and nowhere else', async t => {
  const { root, contextFile } = await project(t);
  const nested = path.join(root, 'nested', 'deeper');
  await mkdir(nested, { recursive: true });
  const args = ['literal $(stay literal)', 'two words'];

  const plan = await agentLaunch({ agent: 'kimi', executable: '/installed/kimi', args, contextFile, env: {}, cwd: nested });
  assert.equal(plan.custom, undefined, 'kimi is named, so it is no longer told to configure itself');
  assert.deepEqual(plan.args, args, 'kimi needs no flag to consume its configuration, so the pane’s own args pass through untouched');
  const file = path.join(root, '.kimi-code', 'mcp.json');
  assert.equal(plan.kimi, file, 'the project file lands at the repository root, not the pane’s subdirectory');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const written = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(written.mcpServers[plan.name], { command: process.execPath, args: [fileURLToPath(new URL('../agents/mcp.mjs', import.meta.url)), '--context', plan.contextFile] },
    'the one entry rEngine owns starts the facade on this launch’s own context');
  assert.equal(Object.keys(written.mcpServers).length, 1, 'and rEngine owns nothing else in the file');
  assert.equal(plan.env.RENGINE_MCP_CONFIG, plan.generic, 'and the pane’s environment still names its own per-launch configuration');

  /* The same project may already use kimi with its own servers: those are the person's, and only
     rEngine's namespace is rEngine's to replace. */
  await writeFile(file, '{// the person’s own\n"mcpServers":{"previous":{"command":"existing"},"rengine_876543218765":{"command":"stale"}}}\n');
  const second = await agentLaunch({ agent: 'kimi', executable: '/installed/kimi', args, contextFile, env: {}, cwd: nested });
  const merged = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(merged.mcpServers.previous, { command: 'existing' }, 'a foreign entry is preserved');
  assert.equal(merged.mcpServers.rengine_876543218765, undefined, 'a stale rEngine key is reclaimed');
  assert.equal(merged.mcpServers[second.name].args.at(-1), second.contextFile, 'and the current key names this launch');

  await writeFile(file, '{damaged');
  await assert.rejects(agentLaunch({ agent: 'kimi', executable: '/installed/kimi', contextFile, env: {}, cwd: nested }), /Kimi MCP configuration/);
  assert.equal(await readFile(file, 'utf8'), '{damaged', 'an unreadable file is refused with the file left untouched');
});

test('kimi’s own flags name the session, and nothing is invented for a launch that names none', async t => {
  const { root, contextFile } = await project(t);
  const launch = (args, extra = {}) => agentLaunch({ agent: 'kimi', executable: '/installed/kimi', args, contextFile, env: {}, cwd: root, ...extra });

  for (const flag of ['--session', '-S', '--resume', '-r']) {
    const named = await launch([flag, SESSION]);
    assert.equal(named.identity.agentId, SESSION, `${flag} names the session, and that session is the identity`);
    assert.deepEqual(named.identity.session, { provider: 'kimi', id: SESSION, known: true, source: 'flag', resume: `kimi --session ${SESSION}` });
    assert.equal(named.identity.label, `kimi ${SESSION.slice(8, 16)}`, 'the eight characters it goes by skip the session_ prefix');
    assert.deepEqual(named.args.slice(-2), [flag, SESSION], `${flag} is passed through unchanged, with nothing injected beside it`);
    assert.equal(named.conversation, SESSION, 'and the plan reports it, so the session record can keep it');
  }
  assert.equal((await launch([`--session=${SESSION}`])).identity.agentId, SESSION, 'in either spelling');
  assert.equal((await launch(['--session', ULID])).identity.agentId, ULID, 'and in the ULID shape the documentation shows');

  for (const args of [['-c'], ['--continue'], ['--session']]) {
    const opaque = await launch(args);
    assert.equal(opaque.identity.session.known, false, `${args[0]} names a conversation only the CLI knows`);
    assert.equal(opaque.conversation, null, 'so the record is actively cleared rather than left claiming one');
    assert.match(describeSession(opaque.identity), /unknown/);
  }
  const fresh = await launch([]);
  assert.equal(fresh.identity.session, undefined, 'a bare launch names its own conversation inside the CLI; rEngine invents nothing');
  assert.equal(fresh.conversation, null);

  /* The picker and restart_agent both arrive as a recorded conversation plus resume: kimi is put
     back with its own spelling. It can never be told which conversation to START. */
  const resumed = await launch([], { conversation: SESSION, resume: true });
  assert.deepEqual(resumed.args.slice(-2), ['--session', SESSION]);
  assert.equal(resumed.conversation, SESSION);
  const unclaimable = await launch([], { conversation: SESSION });
  assert.deepEqual(unclaimable.args, [], 'a conversation that cannot be told to the CLI is not claimed either');
  assert.equal(unclaimable.conversation, null);
  await assert.rejects(launch([], { conversation: 'not-a-session', resume: true }), /session/i, 'an identifier in no shape kimi resumes by is refused');
});

/* .kimi-code/mcp.json is shared per project and last-writer-wins, so two kimi panes on one root
   would both be started on the newest launch's context if the facade trusted its argv. The pane's
   own environment always names its own launch — so the environment wins (spec 127 decision 5). */
test('the MCP facade resolves its context from the pane environment before the shared file’s argv', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-kimi-facade-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = http.createServer((incoming, response) => {
    if (incoming.url === '/api/state') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ instance: INSTANCE, roots: [{ id: ROOT_ID, name: 'project', path: '/tmp/project' }], sessions: [], drafts: [], capabilities: {}, conversations: {} }));
      return;
    }
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end('{"error":"no such route"}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));

  const facade = fileURLToPath(new URL('../agents/mcp.mjs', import.meta.url));
  const paneA = path.join(directory, 'pane-a-context.json');
  await writeFile(paneA, JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, token: TOKEN, instance: INSTANCE, rootId: ROOT_ID }));
  const genericA = path.join(directory, 'pane-a-mcp.json');
  await writeFile(genericA, JSON.stringify({ mcpServers: { rengine_123456781234: { type: 'stdio', command: process.execPath, args: [facade, '--context', paneA] } } }));
  /* What the shared project file says after a second pane launched: pane B's context, which is
     unreachable here. If the facade trusts argv over the environment it starts on pane B's. */
  const paneB = path.join(directory, 'pane-b-context.json');
  await writeFile(paneB, JSON.stringify({ url: 'http://127.0.0.1:1/', token: TOKEN, instance: INSTANCE, rootId: ROOT_ID }));

  const client = new Client({ name: 'rengine-kimi-facade-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [facade, '--context', paneB], stderr: 'pipe',
    env: { ...process.env, RENGINE_MCP_CONFIG: genericA } }));
  t.after(() => client.close());
  const info = await client.callTool({ name: 'workspace_info', arguments: {} });
  assert.equal(info.isError, undefined, info.content?.[0]?.text);
  assert.equal(info.structuredContent.root.id, ROOT_ID,
    'the pane’s own environment named the context: pane A’s host answers even though the shared file’s argv pointed at pane B, which is unreachable');
});
