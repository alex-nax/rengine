/* The conversation F185's parity is judged on, and the pieces that run it (spec 129, KI-100).
 *
 * One scripted conversation — 40-odd calls covering every tool — is run against both servers, each
 * in its own workspace built from the same fixture, and the answers are compared. Two workspaces
 * because the calls have effects: a token claimed on one server is not free on the other, and a
 * task written twice is two rows.
 *
 * Two workspaces mean two sets of ids, paths, ports and timestamps, so the comparison normalises
 * exactly those and nothing else — the rules are listed in `NORMALISERS` and each one is named in
 * the evidence. Everything that carries meaning survives: field names, ordering, refusal
 * sentences, numbers, booleans, and the shape of every answer.
 *
 * Most of the conversation is refusals, deliberately. An agent meets "this workspace predates …"
 * and "you do not hold the token" far more often than a happy path, and those sentences are the
 * part of the surface a port is most likely to get subtly wrong.
 */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startServer } from './red-host-fixture.mjs';
import { startWorker } from './red-worker-fixture.mjs';
import { taskDeclaration, taskProject } from './task-fixtures.mjs';
import { identity, ok } from './token-fixtures.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const BINARY = process.env.RENGINE_RED_MCP || path.join(ROOT, 'red/target/debug/red-mcp');
export const REPO = ROOT;

/* The conversation. Order matters: read what can be read, take the token, write with it, give it
   back — and ask for the things that are refused, because the refusal is the answer worth pinning. */
export const CALLS = [
  ['workspace_info', {}],
  ['list_files', { path: '', hidden: false }],
  ['list_files', { path: '.rengine', hidden: true }],
  ['read_file', { path: 'note.txt' }],
  ['read_file', { path: 'note.txt', startLine: 2, maxLines: 1 }],
  ['read_file', { path: '../outside.txt' }],
  ['read_file', { path: 'missing.txt' }],
  ['list_sessions', {}],
  ['session_output', { id: '<session>' }],
  ['session_output', { id: '<session>', maxCharacters: 12 }],
  ['show_session', { id: '<session>', desktopId: 'none' }],
  ['list_desktops', {}],
  ['reload_desktop', { id: 'no-such-desktop' }],
  ['update_status', {}],
  ['update_workspace', { layers: ['workspace'] }],
  ['list_project_windows', {}],
  ['project_window_action', { windowId: 'nope', action: 'inspect' }],
  ['integration_inbox', {}],
  ['report_integration', { windowId: 'nope', key: 'k', kind: 'status', summary: 's' }],
  ['open_project_window', { path: 'elsewhere', agentId: 'nope' }],
  ['open_script', { path: 'say.sh', args: [], desktopId: 'none' }],
  ['dashboard_actions', {}],
  ['dashboard_capture', { actionId: 'echo' }],
  ['show_session', { id: 'nope', desktopId: 'none' }],
  ['session_output', { id: 'nope' }],
  ['preview_file', { path: 'note.txt' }],
  ['preview_file', { path: '../outside.txt' }],
  ['devices', {}],
  ['list_tasks', {}],
  ['list_agents_menu', {}],
  ['game_preflight', { gameId: 'none' }],
  ['launch_game', { gameId: 'none' }],
  ['recordings_list', {}],
  ['recording_read', { id: 'none' }],
  ['token_status', {}],
  ['token_contest', {}],
  ['token_status', {}],
  ['task_add', { row: { id: 700, key: 'F700', description: 'from the conversation' } }],
  ['task_update', { row: { key: 'F700', description: 'updated by the conversation' } }],
  ['task_decompose', { row: { id: 701, key: 'F701', description: 'a child' }, parent: 'F700' }],
  ['list_tasks', {}],
  ['feed_read', {}],
  ['feed_url', {}],
  ['spawn_agent', { agent: 'claude', taskKey: 'F700' }],
  ['stop_session', { id: 'nope' }],
  ['restart_agent', { id: 'nope' }],
  ['token_reject', { contestId: 'none' }],
  ['token_release', {}],
  ['token_status', {}],
  /* Somebody else takes the token, so the rest of the conversation is what a pane meets when it is
     NOT the holder: that is the only way the identity headers change an answer, and without it a
     server that sent none would pass every call above. */
  ['#another-agent-claims', {}],
  ['token_status', {}],
  ['task_add', { row: { id: 702, key: 'F702', description: 'while somebody else holds it' } }],
  ['token_contest', { reason: 'my turn now' }],
  ['token_status', {}],
  ['stop_session', { id: '<session>' }],
  ['not_a_tool', {}],
];

/* What differs between two workspaces and nothing else. Each rule is here because the value it
   replaces is minted per workspace, not because a difference in it would be acceptable. */
const NORMALISERS = [
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>'],
  [/[0-9a-f]{64}/g, '<hex>'],
  [/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<time>'],
  [/127\.0\.0\.1:\d+/g, '127.0.0.1:<port>'],
];

export function normalise(value, directory) {
  const text = JSON.stringify(value);
  let out = text.split(directory).join('<workspace>');
  /* macOS hands out /var/folders/… and reports it back as /private/var/folders/…; both are this
     workspace's own directory and neither is a difference between the two servers. */
  out = out.split(directory.replace(/^\/private/, '')).join('<workspace>');
  out = out.split(`/private${directory}`).join('<workspace>');
  for (const [pattern, replacement] of NORMALISERS) out = out.replace(pattern, replacement);
  /* Epoch milliseconds, which appear as createdAt/lastSeenAt NUMBERS: replaced with a fixed one so
     the text stays JSON rather than a placeholder that would not parse. */
  out = out.replace(/\b17\d{11}\b/g, '1700000000000');
  /* The eight characters of a conversation id that name a pane in its title: a minted id, which
     the uuid rule above cannot see because only its prefix is there. */
  out = out.replace(/(claude|codex|kimi|gemini|opencode) [0-9a-f]{8}/g, '$1 <short>');
  /* Process ids: each workspace runs its own shell, and each server is its own process, so a pid
     is a fact about which copy answered rather than about what it answered. */
  out = out.replace(/"(pid|toolWorkerPid|durationMs|secondsLeft)":\d+/g, '"$1":111');
  /* …and again inside `content[0].text`, where the answer is JSON that has been stringified into a
     string, so its own quotes are escaped. */
  out = out.replace(/\\"(pid|toolWorkerPid|durationMs|secondsLeft)\\":\d+/g, '\\"$1\\":111');
  return JSON.parse(out);
}

export async function workspace(t, label) {
  const directory = await mkdtemp(path.join(tmpdir(), `red-mcp-${label}-`));
  const project = await taskProject(directory, 'project', taskDeclaration({
    dashboard: { title: 'Fixture', groups: [{ id: 'verify', title: 'Verify', actions: [
      { id: 'echo', title: 'Echo', description: 'Says hello.', kind: 'script', script: 'say.sh', args: ['hello'] },
    ] }] },
  }));
  await writeFile(path.join(project, 'say.sh'), '#!/bin/sh\necho hello\n');
  await writeFile(path.join(project, 'note.txt'), 'first line\nsecond line\nthird line\n');
  const server = await startServer({ stateDir: path.join(directory, 'state') });
  const worker = await startWorker({ url: server.url, token: server.token, instance: server.instance },
                                   { directory: path.join(directory, 'runtime') });
  const root = await server.store.addRoot(project);
  /* The descriptor `discoverRuntime` reads, written here because this fixture starts the worker
     in-process rather than through the supervisor that would normally publish it. Without it both
     servers fall back to the session host, whose /api/state does not carry the worker's
     capabilities — and every token and task call in the conversation would be refused on
     capability by both, agreeing about nothing. */
  await writeFile(path.join(directory, 'runtime/runtime.json'), JSON.stringify({
    version: 1, url: worker.url, token: worker.token, instance: server.instance, pid: process.pid,
    host: { url: server.url, token: server.token, instance: server.instance },
  }), { mode: 0o600 });
  const contextFile = path.join(directory, 'context.json');
  /* An identity, because the token tools and every gated refusal only happen for an agent: an
     anonymous caller is never gated, and a conversation without one would skip the gate entirely. */
  await writeFile(contextFile, JSON.stringify({
    url: server.url, token: server.token, instance: server.instance, rootId: root.id,
    runtimeDirectory: path.join(directory, 'runtime'),
    agent: { agentId: '3f85774e-05bb-4791-bb9f-1c90dc37d0e6', label: 'parity', pid: process.pid },
  }), { mode: 0o600 });
  /* A live session, so the tools that read one are exercised rather than only refused: the output
     tail, the ownership check and the stop at the end of the conversation. */
  const session = await server.sessions.terminal({ rootId: root.id, command: '/bin/bash',
    args: ['--noprofile', '--norc', '-c', 'printf "pane output line\\n"; sleep 30'] });
  t.after(async () => { await worker.close?.(); await server.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, contextFile, root, server, worker, session };
}

export async function converse(t, command, args, session, marker) {
  const client = new Client({ name: 'rengine-calls', version: '1.0.0' });
  const transport = new StdioClientTransport({ command, args, stderr: 'pipe' });
  let diagnostics = '';
  transport.stderr?.on('data', data => { diagnostics = (diagnostics + data).slice(-2000); });
  try { await client.connect(transport); }
  catch (error) { throw new Error(`${path.basename(command)} did not start: ${error.message} ${diagnostics}`); }
  t.after(() => client.close().catch(() => {}));
  const answers = [];
  for (const [name, args_] of CALLS) {
    if (name.startsWith('#')) { await marker(name); answers.push({ marker: name }); continue; }
    /* The one value that cannot be written into a fixture: this workspace's own session id. */
    const filled = JSON.parse(JSON.stringify(args_).split('<session>').join(session));
    const result = await client.callTool({ name, arguments: filled }).catch(error => ({ thrown: error.message }));
    answers.push(result);
  }
  return answers;
}

