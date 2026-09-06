import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server/main.mjs';
import { nativeClient } from './native-client.mjs';

test('native terminals deliver negotiated mouse clicks and wheel scrolling to fullscreen applications', { timeout: 45000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-terminal-mouse-'));
  let server, gui;
  try {
    const eventsFile = path.join(directory, 'events.jsonl'), rawFile = path.join(directory, 'input.raw'), fixture = path.join(directory, 'mouse.cjs');
    await writeFile(eventsFile, '');
    await writeFile(rawFile, '');
    await writeFile(fixture, `const fs = require('node:fs');
process.stdin.setRawMode(true);
let buffer = '', expanded = false, scroll = 0, mode = 1003;
const draw = () => process.stdout.write('\\x1b[2J\\x1b[HMouse application\\r\\n\\r\\n  ITEM ' + (expanded ? 'expanded' : 'closed') + '\\r\\nSCROLL ' + scroll + '\\r\\nMODE ' + mode + '\\r\\n');
process.stdout.write('\\x1b[?1049h\\x1b[?1000h\\x1b[?1002h\\x1b[?1003h\\x1b[?1006h'); draw();
process.stdin.on('data', data => {
  fs.appendFileSync(${JSON.stringify(rawFile)}, data);
  const command = data.toString();
  if (/^[0123]$/.test(command)) {
    mode = [0, 1000, 1002, 1003][Number(command)];
    process.stdout.write('\\x1b[?1000l\\x1b[?1002l\\x1b[?1003l' + (mode ? '\\x1b[?' + mode + 'h' : '')); draw(); return;
  }
  if (command === 'x' || command === 's') { process.stdout.write('\\x1b[?1006' + (command === 's' ? 'h' : 'l')); return; }
  if (command === 'Q') { process.stdout.write('\\x1b[6n'); return; }
  if (command === 'p') { process.stdout.write('\\x1b[?1049l' + Array.from({length: 80}, (_, i) => 'HISTORY_' + i + '\\r\\n').join('')); draw(); return; }
  if (command === 'R' && process.env.RENGINE_MOUSE_REPLAY) {
    const recording = JSON.parse(fs.readFileSync(process.env.RENGINE_MOUSE_REPLAY, 'utf8'));
    process.stdout.write('\\x1bc' + recording.output + '\\x1b[1;1HCLAUDE_REPLAY_READY'); return;
  }
  buffer = (buffer + data.toString()).slice(-4096);
  const mouse = /\\x1b\\[<(\\d+);(\\d+);(\\d+)([Mm])/g;
  let match, end = 0;
  while ((match = mouse.exec(buffer))) {
    const [code, col, row] = match.slice(1, 4).map(Number), down = match[4] === 'M';
    fs.appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify({ code, col, row, down }) + '\\n');
    if (down && code === 0 && row === 3 && col >= 3 && col <= 22) { expanded = !expanded; draw(); }
    if (down && (code === 64 || code === 65)) { scroll += code === 64 ? 1 : -1; draw(); }
    end = mouse.lastIndex;
  }
  buffer = buffer.slice(end);
});`);
    server = await startServer({ stateDir: path.join(directory, 'state') });
    const root = await server.store.addRoot(directory);
    const session = await server.sessions.terminal({ rootId: root.id, command: process.execPath, args: [fixture] });
    gui = await nativeClient(server, { root: root.id, terminal: session.id });
    let state = await gui.until(s => s.tabs.some(t => t?.session === session.id && t.text?.includes('ITEM closed')));
    let tabIndex = state.tabs.findIndex(t => t?.session === session.id);
    const point = (s, col, row) => {
      const r = s.tabs[tabIndex].rect, [cw, lh] = s.tabs[tabIndex].cellSize;
      return [r[0] + (col - 0.5) * cw, r[1] + (row - 0.5) * lh];
    };
    await gui.click(...point(state, 5, 3));
    await gui.until(s => s.tabs[tabIndex].text.includes('ITEM expanded'), 'click reaches the fullscreen item');
    await gui.command({ op: 'wheel', preciseY: 0.5, flipped: true });
    await gui.command({ op: 'wheel', preciseY: 0.5, flipped: true });
    await gui.until(s => s.tabs[tabIndex].text.includes('SCROLL 1'), 'fractional wheel reaches application history');
    await gui.command({ op: 'wheel', preciseY: -1, flipped: true });
    await gui.until(s => s.tabs[tabIndex].text.includes('SCROLL 0'), 'system wheel sign is preserved');
    const events = (await readFile(eventsFile, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.ok(events.some(e => e.code === 0 && e.col === 5 && e.row === 3 && e.down));
    assert.ok(events.some(e => e.code === 0 && !e.down));
    const received = async () => (await readFile(eventsFile, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    const move = async (col, row) => {
      state = await gui.command({ op: 'state' }); const [x, y] = point(state, col, row);
      await gui.command({ op: 'motion', x, y }); await delay(80); return { x, y };
    };
    const mode = async value => {
      await gui.command({ op: 'text', text: String(value) });
      await gui.until(s => s.tabs[tabIndex].mouseMode === value, 'negotiated mouse mode');
    };
    await mode(1);
    let count = (await received()).length;
    await move(10, 6); assert.equal((await received()).length, count, 'click-only mode does not report hover');
    await mode(2); count = (await received()).length;
    const held = await move(12, 6); assert.equal((await received()).length, count, 'drag mode does not report unheld motion');
    await gui.command({ op: 'button', ...held, down: true }); await move(15, 8);
    assert.ok((await received()).some(e => e.code === 32 && e.col === 15 && e.row === 8));
    await gui.command({ op: 'motion', x: -30, y: -30 });
    await gui.command({ op: 'button', x: -30, y: -30, down: false }); await delay(80);
    assert.deepEqual((await received()).at(-1), { code: 0, col: 1, row: 1, down: false }, 'held release clamps to its original terminal');
    await mode(3);
    const focus = await move(9, 7);
    await gui.command({ op: 'button', ...focus, down: true });
    await gui.command({ op: 'focus', focused: false }); await delay(80);
    assert.equal((await received()).at(-1).down, false, 'focus loss releases the held button');
    await gui.command({ op: 'focus', focused: true });
    await gui.command({ op: 'button', ...focus, down: false });
    await gui.command({ op: 'button', ...focus, button: 3, down: true, mod: 0xc3 });
    await gui.command({ op: 'button', ...focus, button: 3, down: false, mod: 0xc3 }); await delay(80);
    assert.ok((await received()).some(e => e.code === 22 && e.down), 'right click carries Ctrl+Shift');
    await gui.command({ op: 'motion', ...focus, mod: 0 });
    await gui.command({ op: 'wheel', preciseX: 1 }); await delay(80);
    assert.ok((await received()).some(e => e.code === 67 && e.down), 'horizontal wheel reaches the application');
    await gui.click(focus.x, focus.y); await mode(1);
    await gui.command({ op: 'text', text: 'x' }); await delay(80);
    const beforeLegacy = (await readFile(rawFile)).length;
    await gui.click(...point(await gui.command({ op: 'state' }), 5, 3));
    const legacy = (await readFile(rawFile)).subarray(beforeLegacy);
    assert.ok(legacy.includes(Buffer.from([27, 91, 77, 32, 37, 35])), 'legacy X10 coordinates use the negotiated encoding');
    assert.ok(legacy.includes(Buffer.from([27, 91, 77, 35, 37, 35])), 'legacy release is balanced');
    await gui.command({ op: 'text', text: 's' }); await mode(3);
    await gui.command({ op: 'resize', width: 1050, height: 480 }); await delay(150);
    await gui.command({ op: 'resize', width: 1280, height: 800 }); await delay(150);
    state = await gui.command({ op: 'state' });
    await gui.click(...point(state, 5, 3));
    await gui.until(s => s.tabs[tabIndex].text.includes('ITEM closed'), 'click coordinates survive resize');
    await gui.command({ op: 'text', text: 'p' });
    await gui.until(s => s.tabs[tabIndex].historyLines > 0 && s.tabs[tabIndex].text.includes('ITEM closed'), 'primary screen with history and mouse mode');
    await gui.command({ op: 'wheel', preciseY: 1 });
    await gui.until(s => s.tabs[tabIndex].text.includes('SCROLL 1') && s.tabs[tabIndex].scrollOffset === 0, 'primary-screen application owns unmodified wheel');
    await gui.command({ op: 'wheel', preciseY: 4, mod: 3 });
    await gui.until(s => s.tabs[tabIndex].scrollOffset > 0, 'Shift+wheel browses primary history locally');
    count = (await received()).length;
    state = await gui.command({ op: 'state' });
    const [hx, hy] = point(state, 5, 3);
    await gui.command({ op: 'motion', x: hx, y: hy, mod: 0 }); await gui.click(hx, hy);
    assert.equal((await received()).length, count, 'clicks on old history do not activate live application items');
    await gui.key('End', 3);
    await mode(0); count = (await received()).length;
    await gui.command({ op: 'wheel', preciseY: 2 });
    await gui.until(s => s.tabs[tabIndex].scrollOffset > 0, 'disabled mouse mode returns wheel to native history');
    assert.equal((await received()).length, count);
    await gui.key('End', 3); await mode(3);
    await gui.control('toolbar', 'Shell');
    state = await gui.until(s => s.tabs.filter(t => t?.type === 3).length === 2);
    const otherIndex = state.tabs.findIndex(t => t?.type === 3 && t.session !== session.id);
    await gui.control('tab', '', tabIndex); state = await gui.command({ op: 'state' });
    const tab = state.tabs[tabIndex];
    await gui.command({ op: 'button', x: tab.header[0] + 20, y: tab.header[1] + 12, down: true });
    await gui.command({ op: 'motion', x: 100, y: 420 });
    await gui.command({ op: 'button', x: 100, y: 420, down: false });
    await gui.until(s => s.tabs[tabIndex].rect[0] < 100 && s.tabs[tabIndex].rect[2] > 0, 'mouse application moved to left pane');
    await gui.control('tab', '', otherIndex); state = await gui.command({ op: 'state' });
    await gui.click(state.tabs[otherIndex].rect[0] + 15, state.tabs[otherIndex].rect[1] + 15);
    await move(5, 3); await gui.command({ op: 'wheel', preciseY: 1 });
    state = await gui.until(s => s.tabs[tabIndex].text.includes('SCROLL 2'), 'hovered application scrolls after pane movement');
    assert.equal(state.focus, otherIndex);
    await gui.command({ op: 'text', text: "printf 'MOUSE_FOCUS_%s\\n' RETAINED" }); await gui.key('Return');
    await gui.until(s => s.tabs[otherIndex].text.includes('MOUSE_FOCUS_RETAINED'), 'hover does not retarget keyboard input');
    const closePoint = await move(9, 7);
    await gui.command({ op: 'button', ...closePoint, button: 3, down: true }); await delay(80);
    await gui.close(); await delay(80);
    assert.deepEqual((await received()).at(-1), {code: 2, col: 9, row: 7, down: false}, 'GUI detach sends the final held release');
    gui = await nativeClient(server, { root: root.id, terminal: session.id });
    state = await gui.until(s => s.tabs.some(t => t?.session === session.id && t.mouseMode === 3 && t.rect[2] > 0));
    tabIndex = state.tabs.findIndex(t => t?.session === session.id);
    await gui.click(...point(state, 5, 3));
    await gui.until(s => s.tabs[tabIndex].text.includes('ITEM expanded'), 'mouse negotiation reconstructed from retained PTY');
    assert.equal(server.sessions.snapshot(session.id).pid, session.pid);
    await mkdir('.cache/evidence', { recursive: true });
    await gui.command({ op: 'snapshot', path: path.resolve('.cache/evidence/native-terminal-mouse.bmp') });
    if (process.env.RENGINE_MOUSE_REPLAY) {
      await mode(0);
      await gui.command({ op: 'text', text: 'R' });
      state = await gui.until(s => s.tabs[tabIndex].mouseMode === 3 && s.tabs[tabIndex].text.includes('CLAUDE_REPLAY_READY'), 'actual Claude mode negotiation and rendered stream');
      await gui.close(); await delay(80);
      const beforeAttach = (await readFile(rawFile)).length;
      gui = await nativeClient(server, {root: root.id, terminal: session.id});
      state = await gui.until(s => s.tabs.some(t => t?.session === session.id && t.mouseMode === 3 && t.text?.includes('CLAUDE_REPLAY_READY')), 'recorded Claude reattached');
      tabIndex = state.tabs.findIndex(t => t?.session === session.id);
      assert.equal((await readFile(rawFile)).length, beforeAttach, 'historical terminal queries are not answered again on reattachment');
      await gui.command({ op: 'snapshot', path: path.resolve('.cache/evidence/native-claude-mouse-replay.bmp') });
      count = (await received()).length;
      await gui.click(...point(state, 5, 3)); await gui.command({ op: 'wheel', preciseY: 1 }); await delay(120);
      const actual = (await received()).slice(count);
      assert.ok(actual.some(e => e.code === 0 && e.col === 5 && e.row === 3 && e.down), JSON.stringify(actual));
      assert.ok(actual.some(e => e.code === 64 && e.down));
      const beforeQuery = (await readFile(rawFile)).length;
      await gui.command({op: 'text', text: 'Q'}); await delay(100);
      assert.match((await readFile(rawFile)).subarray(beforeQuery).toString(), /\x1b\[\d+;\d+R/, 'live cursor queries still receive replies');
      console.log('Actual recorded Claude output enables native SGR click and wheel reporting.');
    }
  } finally { await gui?.close(); await server?.close(); await rm(directory, { recursive: true, force: true }); }
});
