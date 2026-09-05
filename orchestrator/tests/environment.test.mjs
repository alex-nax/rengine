import test from 'node:test';
import assert from 'node:assert/strict';
import { shellEnvironment } from '../server/sessions.mjs';

test('Windows sessions preserve one PATH and apply overrides case-insensitively', () => {
  const base = { Path: 'C:\\Windows\\System32;C:\\Program Files\\nodejs', SystemRoot: 'C:\\Windows',
    Electron_Run_As_Node: '1', TEMP: 'C:\\Temp' };
  const options = { inherited: base, platform: 'win32', userDirectory: 'C:\\Users\\dev' };
  const env = shellEnvironment({}, options);
  assert.deepEqual(Object.keys(env).filter(key => key.toUpperCase() === 'PATH'), ['Path']);
  assert.ok(env.Path.startsWith(`${base.Path};`));
  assert.ok(env.Path.includes('C:\\Users\\dev\\.local\\bin'));
  assert.equal(env.SystemRoot, base.SystemRoot);
  assert.equal(Object.keys(env).some(key => key.toUpperCase() === 'ELECTRON_RUN_AS_NODE'), false);
  const override = shellEnvironment({ PATH: 'D:\\Tools;C:\\Users\\DEV\\.local\\bin', temp: 'D:\\Temp' }, options);
  assert.deepEqual(Object.keys(override).filter(key => key.toUpperCase() === 'PATH'), ['PATH']);
  assert.equal(override.PATH.split(';').filter(value => value.toLowerCase().endsWith('\\.local\\bin')).length, 1);
  assert.equal(override.temp, 'D:\\Temp'); assert.equal(override.TEMP, undefined);
  assert.equal(base.Path, 'C:\\Windows\\System32;C:\\Program Files\\nodejs');
});

test('POSIX sessions keep case-sensitive environment names and explicit PATH order', () => {
  const env = shellEnvironment({ PATH: '/tools:/usr/bin', EMPTY: undefined }, {
    inherited: { PATH: '/bin', Path: 'separate variable', EMPTY: 'remove', ELECTRON_RUN_AS_NODE: '1' },
    platform: 'darwin', userDirectory: '/Users/dev',
  });
  assert.ok(env.PATH.startsWith('/tools:/usr/bin:'));
  assert.equal(env.Path, 'separate variable');
  assert.equal(env.EMPTY, undefined); assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.TERM, 'xterm-256color');
});
