import electron from 'electron';
import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readdir, symlink, writeFile, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { startServer } from '../server/main.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
if (process.platform !== 'darwin') throw new Error('This NOLF gameplay probe currently qualifies the macOS adapter only.');
if (!process.env.RENGINE_NOLF_ROOT) throw new Error('Set RENGINE_NOLF_ROOT to an actual built NOLF checkout with local game data.');
const source = path.resolve(process.env.RENGINE_NOLF_ROOT);
const directory = await mkdtemp(path.resolve('.cache/gameplay-direct-'));
for (const sub of ['build', 'nolf/Custom', 'assets']) await mkdir(path.join(directory, sub), { recursive: true });
await copyFile(path.join(source, 'build/relith-nolf'), path.join(directory, 'build/relith-nolf'), constants.COPYFILE_FICLONE);
for (const sub of ['nolf', 'nolf/Custom', 'assets']) {
  for (const entry of await readdir(path.join(source, sub), { withFileTypes: true })) {
    if (entry.isFile() && /\.rez$/i.test(entry.name)) await symlink(path.join(source, sub, entry.name), path.join(directory, sub, entry.name));
  }
}
const server = await startServer({ stateDir: path.join(directory, 'state') });
await server.store.addRoot(directory);
const child = spawn(electron, ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', path.resolve('orchestrator/desktop/main.cjs')], {
  env: { ...process.env, RENGINE_UI_URL: `${server.url}/#${server.token}`, RENGINE_DESKTOP_STATE: path.join(directory, 'electron') }, stdio: ['ignore', 'pipe', 'pipe'],
});
const exited = once(child, 'exit');
let desktopLogs = ''; child.stderr.on('data', bytes => { desktopLogs += bytes; }); child.stdout.on('data', bytes => { desktopLogs += bytes; });
let socket, session;
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = Number((await readFile(path.join(directory, 'electron/DevToolsActivePort'), 'utf8')).split('\n')[0]); break; } catch { await sleep(100); }
  }
  if (!port) throw new Error(`No desktop inspection port: ${desktopLogs}`);
  let target;
  for (let i = 0; i < 50; i++) {
    target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === 'page' && item.url.startsWith(server.url));
    if (target) break; await sleep(100);
  }
  socket = new WebSocket(target.webSocketDebuggerUrl); await once(socket, 'open');
  const pending = new Map(); let sequence = 0;
  socket.on('message', bytes => { const message = JSON.parse(bytes); const task = pending.get(message.id); if (!task) return;
    pending.delete(message.id); clearTimeout(task.timer); message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result); });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 10000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
  const click = async text => { const point = await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(text)}); if (!b) throw Error('Missing button'); const r = b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...point });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, ...point }); };
  const key = async (value, down) => { const code = value.length === 1 ? `Key${value.toUpperCase()}` : value;
    await cdp('Input.dispatchKeyEvent', { type: down ? 'keyDown' : 'keyUp', key: value, code,
      windowsVirtualKeyCode: value.length === 1 ? value.toUpperCase().charCodeAt(0) : ({ Enter: 13, Escape: 27, F6: 117, F9: 120 })[value] ?? 0 }); };
  const shot = async name => { const result = await cdp('Page.captureScreenshot', { format: 'png' }); const filename = path.join(directory, `${name}.png`);
    await writeFile(filename, Buffer.from(result.data, 'base64')); console.log(JSON.stringify({ screenshot: filename })); };
  await cdp('Page.bringToFront'); await sleep(400); await click('Launch NOLF');
  session = server.sessions.list().find(item => item.type === 'game');
  console.log(JSON.stringify({ directory, desktopPid: child.pid, pid: session.pid, id: session.id }));
  for await (const line of createInterface({ input: process.stdin })) {
    try {
      const command = JSON.parse(line); if (command.quit) break;
      if (command.keys || command.key || command.hold) await evaluate(`document.querySelector('canvas').focus()`);
      for (const value of command.keys ?? (command.key ? [command.key] : [])) { await key(value, true); await key(value, false); await sleep(300); }
      if (command.hold) { await key(command.hold, true); await sleep(Math.min(command.ms ?? 500, 5000)); await key(command.hold, false); }
      if (command.click) await click(command.click);
      if (command.move) await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: command.move[0], y: command.move[1] });
      if (command.shot) { if (!/^[a-z0-9_-]+$/i.test(command.shot)) throw new Error('Screenshot names use letters, digits, underscores or hyphens.'); await shot(command.shot); }
      if (command.log) console.log(server.sessions.snapshot(session.id, true).output.slice(-command.log));
      console.log(JSON.stringify({ frames: server.games.items.get(session.id)?.frameCount, state: server.sessions.get(session.id).state,
        captured: await evaluate('Boolean(document.pointerLockElement)'), sequence: await evaluate("document.querySelector('canvas')?.dataset.sequence") }));
    } catch (error) { console.log(JSON.stringify({ error: error.message })); }
  }
} finally {
  if (session) await writeFile(path.join(directory, 'game.log'), server.sessions.snapshot(session.id, true).output);
  await writeFile(path.join(directory, 'desktop.log'), desktopLogs);
  socket?.terminate(); await server.close(); child.kill('SIGTERM');
  await Promise.race([exited, sleep(2000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await exited; child.stdout.destroy(); child.stderr.destroy(); process.stdin.pause(); process.stdin.unref?.();
  console.log(JSON.stringify({ closed: true, directory }));
}
