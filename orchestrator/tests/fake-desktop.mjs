#!/usr/bin/env node
/* A desktop window, as far as the supervisor is concerned (F159, spec 144).
 *
 * The real one is a native binary with a renderer in it. What the supervisor actually requires of a
 * window is much smaller, and it is exactly this: register itself through the workspace so the
 * launcher that opened it can tell it arrived, answer the control channel on stdin, exit 75 when it
 * is told to reload, and exit 0 when it is told to close.
 *
 * It also answers the OTHER protocol on the same stream — positive ids, which is what a test driving
 * a window sends — so the automation relay has something real on the far end of it.
 *
 * Its environment is the contract `desktop-launch-corpus.json` froze, and it reads it rather than
 * being told: `RENGINE_WORKSPACE_URL` and `_TOKEN` to reach the workspace, `RENGINE_DESKTOP_OWNER`
 * and `_VIEW` to say which window it is, `RENGINE_INITIAL_ROOT` for the project it is bound to.
 */
import { WebSocket } from 'ws';
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

const url = process.env.RENGINE_WORKSPACE_URL ?? '';
const token = process.env.RENGINE_WORKSPACE_TOKEN ?? '';
const owner = process.env.RENGINE_DESKTOP_OWNER ?? '';
const view = process.env.RENGINE_DESKTOP_VIEW ?? '';
const root = process.env.RENGINE_INITIAL_ROOT ?? '';
const say = value => process.stdout.write(`${JSON.stringify(value)}\n`);

/* A diagnostic on the way up, because a window that printed one must not break anything that reads
   this stream — which is the rule the control channel and the relay both keep. */
process.stderr.write('fake-desktop: starting\n');

const socket = new WebSocket(`${url.replace('http', 'ws')}/events?token=${token}`);
socket.on('error', error => { process.stderr.write(`fake-desktop: ${error.message}\n`); });
socket.on('open', () => {
  socket.send(JSON.stringify({ type: 'desktop-register', rootIds: root ? [root] : [], sessionIds: [],
    canReload: true, canAttach: true, owner, view }));
});
socket.on('message', bytes => {
  let frame; try { frame = JSON.parse(bytes); } catch { return; }
  if (frame.type === 'desktop-registered') { process.stderr.write(`fake-desktop: registered ${frame.id}\n`); return; }
  if (frame.type !== 'desktop-action') return;
  socket.send(JSON.stringify({ type: 'desktop-action-result', requestId: frame.requestId, accepted: true }));
  if (frame.action === 'reload') {
    /* 75: "I saved and let go", which is the whole handshake a layered update rests on. */
    setTimeout(() => process.exit(75), 50);
  }
});

createInterface({ input: process.stdin }).on('line', async line => {
  let asked; try { asked = JSON.parse(line); } catch { return; }
  const { id, op } = asked;
  if (op === 'control-state') return say({ id, result: { panes: 1, focus: 'terminal', state: { tree: 'large' } } });
  if (op === 'control-focus') return say({ id, result: true });
  if (op === 'control-snapshot') { await writeFile(asked.path, 'BM'); return say({ id, result: true }); }
  if (op === 'control-close') { say({ id, result: true }); setTimeout(() => process.exit(0), 50); return; }
  /* The automation protocol, numbered upward: a test driving this window through the relay. */
  if (op === 'state') return say({ id, result: { controls: [{ role: 'tab', key: 'terminal', rect: [0, 0, 10, 10] }] } });
  /* The person pressed the desktop's own update key: it saves, lets go, and exits 75 with nobody
     having asked it to. The supervisor is expected to notice and bring the window back. */
  if (op === 'detach') { say({ id, result: true }); setTimeout(() => process.exit(75), 50); return; }
  if (op === 'quit') { say({ id, result: true }); setTimeout(() => process.exit(0), 50); return; }
  say({ id, result: null });
});
