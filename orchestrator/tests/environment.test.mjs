import test from 'node:test';
import assert from 'node:assert/strict';
import { shellEnvironment, AGENT_PROCESS_IDENTITY } from '../server/sessions-client.mjs';

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

// The workspace sets TERM/COLORTERM to declare a colour-capable surface. A NO_COLOR inherited from
// whatever happened to launch the workspace silently contradicts that declaration for the whole
// life of the session host. See docs/specs/096-agent-session-resume.md.
test('the surface owns its colour declaration, so an inherited NO_COLOR never reaches a pane', () => {
  const options = { inherited: { PATH: '/bin', NO_COLOR: '1' }, platform: 'darwin', userDirectory: '/Users/dev' };
  const env = shellEnvironment({}, options);
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.COLORTERM, 'truecolor');
  assert.equal(env.NO_COLOR, undefined, 'an inherited NO_COLOR contradicts the TERM and COLORTERM this function sets');
  assert.equal(shellEnvironment({ NO_COLOR: '1' }, options).NO_COLOR, '1', 'an explicit caller may still suppress colour');
  const win = shellEnvironment({}, { inherited: { Path: 'C:\\Windows', No_Color: '1' }, platform: 'win32', userDirectory: 'C:\\Users\\dev' });
  assert.equal(Object.keys(win).some(name => name.toUpperCase() === 'NO_COLOR'), false, 'and the drop is case-insensitive on Windows');
});

// A host started from inside a Claude Code pane carries that pane's process identity, and a pane
// inheriting CLAUDE_CODE_CHILD_SESSION is a child session: the CLI saves no transcript, so the
// conversation rEngine minted for it cannot be resumed. See docs/specs/096-agent-session-resume.md
// decision 9 and known-issues KI-113.
test('a pane is nobody\'s child session, so an inherited agent identity never reaches it', () => {
  const inherited = { PATH: '/bin', CLAUDECODE: '1', CLAUDE_PID: '92680', CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ID: '287bba3a', CLAUDE_CODE_SESSION_ATTENDED: '1',
    CLAUDE_CODE_BRIDGE_SESSION_ID: 'session_01', CLAUDE_CODE_EXECPATH: '/v/2.1.260', CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/s',
    CLAUDE_CODE_MESSAGING_TOKEN: 't', CLAUDE_DIFF_TOOL: 'cursor', CLAUDE_EFFORT: 'xhigh' };
  const options = { inherited, platform: 'darwin', userDirectory: '/Users/dev' };
  const env = shellEnvironment({}, options);
  for (const name of AGENT_PROCESS_IDENTITY) assert.equal(env[name], undefined, `${name} names the session that started the host`);
  assert.equal(env.CLAUDE_DIFF_TOOL, 'cursor', 'a preference is not an identity');
  assert.equal(env.CLAUDE_EFFORT, 'xhigh');
  const minted = shellEnvironment({ CLAUDE_CODE_SESSION_ID: 'minted' }, options);
  assert.equal(minted.CLAUDE_CODE_SESSION_ID, 'minted', 'an explicit override still wins');
  assert.equal(minted.CLAUDE_CODE_CHILD_SESSION, undefined);
  const win = shellEnvironment({}, { inherited: { Path: 'C:\\Windows', claude_code_child_session: '1' }, platform: 'win32', userDirectory: 'C:\\Users\\dev' });
  assert.equal(Object.keys(win).some(name => name.toUpperCase() === 'CLAUDE_CODE_CHILD_SESSION'), false, 'and the drop is case-insensitive on Windows');
});
