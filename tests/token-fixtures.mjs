import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { WebSocket } from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
import { declaration } from './format-fixtures.mjs';
import { captureProducer } from './dashboard-fixtures.mjs';

/* One project that carries every gated surface at once: a game record, a local script action, a
   capture action, and a script action bound to a device that is NOT this machine — the last is what
   makes a dashboard run a device-bound action rather than an ordinary terminal (spec 095). */
export const tokenDeclaration = (extra = {}) => ({
  ...declaration(), contract: 4, project: 'token-fixture',
  devices: [{ id: 'answering-box', kind: 'ssh', title: 'Answering box', probe: ['tools/probe-ok.sh'] }],
  games: [{ id: 'fixture-game', title: 'Fixture game', executable: ['tools/game.sh'], args: ['--flat'], surface: 'external' }],
  dashboard: { title: 'Token fixture', groups: [{ id: 'work', title: 'Work', actions: [
    { id: 'deploy', title: 'Deploy to the box', kind: 'script', script: 'tools/deploy.sh', device: 'answering-box' },
    { id: 'here', title: 'Run here', kind: 'script', script: 'tools/deploy.sh' },
    { id: 'shot', title: 'Screenshot', kind: 'capture', command: [process.execPath, captureProducer, 'png'], into: '.cache/captures', format: 'png' },
    { id: 'play', title: 'Play', kind: 'game', game: 'fixture-game' },
  ] }] },
  ...extra,
});
const SCRIPTS = {
  'tools/probe-ok.sh': '#!/bin/bash\nexit 0\n',
  'tools/game.sh': '#!/bin/bash\necho FIXTURE_GAME_STARTED\ntrap \'exit 0\' TERM\nfor i in $(seq 1 600); do sleep 0.1; done\n',
  'tools/deploy.sh': '#!/bin/bash\necho DEPLOY_STARTED\nsleep "${1:-0.2}"\necho DEPLOY_DONE\n',
  /* Prints continuously, so a feed watched while it runs would carry PTY output if anything on the
     worker forwarded it. */
  'tools/chatty.sh': '#!/bin/bash\nfor i in $(seq 1 200); do echo "CHATTY_LINE_$i"; sleep 0.01; done\n',
};
export async function tokenProject(directory, name = 'project', document = tokenDeclaration()) {
  const root = path.join(directory, name);
  for (const sub of ['.rengine', 'tools']) await mkdir(path.join(root, sub), { recursive: true });
  await writeFile(path.join(root, '.rengine/project.json'), JSON.stringify(document));
  for (const [file, body] of Object.entries(SCRIPTS)) {
    await writeFile(path.join(root, file), body); await chmod(path.join(root, file), 0o755);
  }
  await writeFile(path.join(root, 'sample.pack'), Buffer.from('PACK\0{"entries":{}}', 'latin1'));
  return root;
}

export const identity = (label, pid = process.pid) => ({ agentId: randomUUID(), label, pid });
export const identityHeaders = who => who
  ? { 'X-Rengine-Agent': who.agentId, 'X-Rengine-Agent-Label': who.label, ...(who.pid ? { 'X-Rengine-Agent-Pid': String(who.pid) } : {}) }
  : {};
/* Every call in these tests goes over the wire the way the tool worker makes it, headers included,
   so the gate is exercised through the same surface an agent uses. */
export async function api(worker, route, data, who) {
  const response = await fetch(`${worker.url}/api/${route}`, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { ...identityHeaders(who), Authorization: `Bearer ${worker.token}`, 'Content-Type': 'application/json' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(15000),
  });
  return { status: response.status, body: await response.json() };
}
export async function ok(worker, route, data, who) {
  const result = await api(worker, route, data, who);
  if (result.status >= 400) throw new Error(`${route} failed ${result.status}: ${result.body.error}`);
  return result.body;
}
export async function until(check, label, attempts = 200) {
  for (let index = 0; index < attempts; index++) { const value = await check(); if (value) return value; await delay(25); }
  throw new Error(`Timed out: ${label}`);
}
/* A stand-in for the native desktop: the same /events socket the real one uses, so the token and
   recording frames stage 3 will send are exercised end to end today. */
export async function fakeDesktop(worker, rootIds, sessionIds = []) {
  const socket = new WebSocket(`${worker.url.replace('http', 'ws')}/events?token=${worker.token}`);
  const messages = [];
  socket.on('message', bytes => messages.push(JSON.parse(bytes)));
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.send(JSON.stringify({ type: 'desktop-register', rootIds, sessionIds, canReload: true, canAttach: true }));
  const registered = await until(() => messages.find(message => message.type === 'desktop-registered'), 'desktop registered');
  return { socket, messages, id: registered.id,
    send: value => socket.send(JSON.stringify(value)),
    close: () => { socket.close(); } };
}
export async function feedSocket(worker, url) {
  const socket = new WebSocket(url), frames = [];
  socket.on('message', bytes => frames.push(JSON.parse(bytes)));
  socket.on('error', () => {});
  /* Kept because a monitor is supposed to be told why its socket went away: a retired worker closes
     it with a reason that says to re-read feed_url and resume from the cursor (spec 095). */
  const closed = new Promise(resolve => socket.once('close', (code, reason) => resolve({ code, reason: String(reason) })));
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return { socket, frames, closed, close: () => socket.close() };
}
