import test from 'node:test';
import assert from 'node:assert/strict';
import pty from 'node-pty';

test('installed PTY starts an interactive operating-system process', { timeout: 10000 }, async () => {
  const win = process.platform === 'win32';
  const child = pty.spawn(win ? 'cmd.exe' : '/bin/bash', win ? ['/c', 'echo rengine-pty-ready'] : ['-c', 'printf rengine-pty-ready'], {
    name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env,
  });
  let output = '';
  child.onData(data => { output += data; });
  const result = await new Promise(resolve => child.onExit(resolve));
  assert.equal(result.exitCode, 0);
  assert.match(output, /rengine-pty-ready/);
});
