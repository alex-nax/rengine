import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server/main.mjs';
import { nativeClient } from './native-client.mjs';

test('animated PTY output and a stream burst keep both native terminals interactive', { timeout: 45000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-terminal-recovery-'));
  let server, gui, proxy, offline = false; const peers = new Set();
  try {
    const fixture = path.join(directory, 'animated.cjs');
    await writeFile(fixture, `let frame = 0, received = '';
if (process.env.RENGINE_TERMINAL_REPLAY) process.stdout.write(require('node:fs').readFileSync(process.env.RENGINE_TERMINAL_REPLAY));
process.stdin.setRawMode(true);
process.stdin.on('data', data => { received += data.toString(); process.stdout.write('\\r\\nINPUT_RECEIVED_' + received + '\\r\\n'); });
process.stdout.write('READY_FOR_INPUT\\r\\n');
setInterval(() => { if (frame++ < 150) process.stdout.write('\\x1b[?2026h\\x1b[2K\\r⠋ Working ' + frame + ' \\x1b[32m✓\\x1b[0m\\x1b[?2026l'); }, 10);
`);
    server = await startServer({ stateDir: path.join(directory, 'state') });
    proxy = net.createServer(front => {
      if (offline) { front.destroy(); return; }
      const back = net.connect({ host: '127.0.0.1', port: Number(new URL(server.url).port) });
      peers.add(front); peers.add(back);
      front.on('error', () => back.destroy()); back.on('error', () => front.destroy());
      front.on('close', () => { peers.delete(front); back.destroy(); });
      back.on('close', () => { peers.delete(back); front.destroy(); });
      front.pipe(back); back.pipe(front);
    });
    await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve); });
    const root = await server.store.addRoot(directory);
    const first = await server.sessions.terminal({ rootId: root.id, command: process.execPath, args: [fixture] });
    const second = await server.sessions.terminal({ rootId: root.id });
    gui = await nativeClient({ ...server, url: `http://127.0.0.1:${proxy.address().port}` }, { root: root.id, terminal: second.id, agent: first.id });
    await gui.until(s => s.connected && s.tabs.some(t => t?.session === first.id && t.text?.includes('Working')));
    await delay(1800);
    for (let i = 0; i < 8000; i++) server.sessions.emit('event', { type: 'output', id: first.id, sequence: 1, data: '\x1b[?2026h\r⠋ burst\x1b[?2026l' });
    await delay(800);
    let state = await gui.command({ op: 'state' });
    assert.equal(state.connected, true, `The shared stream died after the burst: ${state.status}`);
    const select = async id => {
      state = await gui.command({ op: 'state' });
      await gui.control('tab', '', state.tabs.findIndex(t => t?.session === id));
      state = await gui.until(s => s.tabs.some(t => t?.session === id && t.rect[2] > 0));
      const tab = state.tabs.find(t => t?.session === id);
      await gui.click(tab.rect[0] + 15, tab.rect[1] + 10);
    };
    await select(first.id);
    await gui.command({ op: 'text', text: 'AGENT' });
    await gui.until(s => s.tabs.some(t => t?.session === first.id && t.text?.includes('INPUT_RECEIVED_AGENT')), 'agent input after animation');
    await select(second.id);
    await gui.command({ op: 'text', text: "printf 'SECOND_%s\\n' ALIVE" }); await gui.key('Return');
    await gui.until(s => s.tabs.some(t => t?.session === second.id && t.text?.includes('SECOND_ALIVE')), 'shell input after agent burst');
    await select(first.id);
    offline = true; for (const peer of peers) peer.destroy();
    await gui.until(s => !s.connected, 'native connection-loss notice');
    await gui.command({ op: 'text', text: 'NO_REPLAY' });
    await delay(700); offline = false;
    await gui.until(s => s.connected && s.tabs.some(t => t?.session === first.id && t.attached && t.text?.includes('INPUT_RECEIVED_AGENT')), 'same agent reattached after transport outage');
    await gui.command({ op: 'text', text: 'ALIVE' });
    await gui.until(s => s.tabs.some(t => t?.session === first.id && t.text?.includes('INPUT_RECEIVED_AGENTALIVE')), 'fresh agent input after reconnection');
    assert.doesNotMatch(server.sessions.snapshot(first.id, true).output, /NO_REPLAY/);
    await mkdir('.cache/evidence', { recursive: true });
    await gui.command({ op: 'snapshot', path: path.resolve('.cache/evidence/native-terminal-recovery.bmp') });
    await select(second.id);
    await gui.command({ op: 'text', text: "printf 'SECOND_%s\\n' RECOVERED" }); await gui.key('Return');
    await gui.until(s => s.tabs.some(t => t?.session === second.id && t.text?.includes('SECOND_RECOVERED')), 'shell input after reconnection');
    assert.equal(server.sessions.snapshot(first.id).pid, first.pid);
    assert.equal(server.sessions.snapshot(second.id).pid, second.pid);
    assert.equal(server.sessions.list().length, 2);
  } finally {
    offline = false; await gui?.close();
    for (const peer of peers) peer.destroy();
    if (proxy) await new Promise(resolve => proxy.close(resolve));
    await server?.close(); await rm(directory, { recursive: true, force: true });
  }
});
