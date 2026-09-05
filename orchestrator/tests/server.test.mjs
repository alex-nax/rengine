import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { startServer } from '../server/main.mjs';

test('loopback API authenticates root-bound files and rejects stale saves through HTTP', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-api-'));
  await writeFile(path.join(dir, 'hello.txt'), 'before');
  const server = await startServer({ stateDir: path.join(dir, 'state') });
  t.after(async () => { await server.close(); await rm(dir, { recursive: true, force: true }); });
  const headers = { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${server.url}/api/state`)).status, 401);
  assert.equal((await fetch(`${server.url}/api/state`, { headers: { Authorization: `Bearer ${'é'.repeat(64)}` } })).status, 401);
  assert.equal((await fetch(`${server.url}/api/state`, { headers: { ...headers, Origin: 'https://unrelated.example' } })).status, 403);
  const create = await fetch(`${server.url}/api/roots`, { method: 'POST', headers, body: JSON.stringify({ path: dir }) });
  assert.equal(create.status, 200);
  const root = await create.json();
  const file = await (await fetch(`${server.url}/api/file?rootId=${root.id}&path=hello.txt`, { headers })).json();
  const body = { rootId: root.id, path: 'hello.txt', text: 'after', version: file.version };
  assert.equal((await fetch(`${server.url}/api/save`, { method: 'POST', headers, body: JSON.stringify(body) })).status, 200);
  assert.equal((await fetch(`${server.url}/api/save`, { method: 'POST', headers, body: JSON.stringify(body) })).status, 409);
  const state = await (await fetch(`${server.url}/api/state`, { headers })).json();
  assert.equal(state.roots[0].id, root.id);
});

test('disconnecting a display socket retains the terminal and reconnect exposes its actual process', { timeout: 15000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-api-pty-'));
  const server = await startServer({ stateDir: path.join(dir, 'state') });
  t.after(async () => { await server.close(); await rm(dir, { recursive: true, force: true }); });
  const root = await server.store.addRoot(dir);
  const session = await server.sessions.terminal({ rootId: root.id, ...(process.platform === 'win32'
    ? { command: 'cmd.exe', args: [] } : { command: '/bin/bash', args: ['--noprofile', '--norc'] }) });
  const attach = async () => {
    const ws = new WebSocket(`${server.url.replace('http:', 'ws:')}/events?token=${server.token}`);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const result = new Promise(resolve => ws.on('message', bytes => { const data = JSON.parse(bytes); if (data.type === 'attached') resolve(data.session); }));
    ws.send(JSON.stringify({ type: 'attach', id: session.id }));
    const snapshot = await result;
    ws.close();
    return snapshot;
  };
  assert.equal((await attach()).pid, session.pid);
  assert.equal(server.sessions.get(session.id).state, 'running');
  assert.equal((await attach()).pid, session.pid);
});
