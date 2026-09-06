import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startServer } from '../server/main.mjs';
import { startRuntime } from '../runtime/supervisor.mjs';
import { prepareDesktop } from '../runtime/desktop.mjs';
import { nativeBridge } from './native-client.mjs';

test('MCP prepares native updates, recovers drafts and rolls back failures with one retained CLI', { timeout: 90000 }, async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-native-updates-')));
  let host, runtime, mcp, mode = 'real'; const views = [];
  try {
    const project = path.join(directory, 'project'); await mkdir(project);
    const marker = path.join(project, 'invocations.txt'), fixture = path.join(project, 'cli.cjs');
    await writeFile(path.join(project, 'document.txt'), 'Saved on disk\n');
    await writeFile(fixture, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'once\\n');
process.stdin.setRawMode(true); console.log('RETAINED_CLI_READY'); let input = '';
process.stdin.on('data', data => { input += data; console.log('CLI_' + Buffer.from(input).toString('hex')); });`);
    host = await startServer({ stateDir: path.join(directory, 'host') });
    const root = await host.store.addRoot(project);
    const session = await host.sessions.terminal({ rootId: root.id, command: process.execPath, args: [fixture] });
    const runtimeDir = path.join(directory, 'runtime');
    runtime = await startRuntime({ host, directory: runtimeDir, initial: { root: root.id, terminal: session.id }, inspectUI: true,
      onDesktop: child => child.once('spawn', () => views.push(nativeBridge(child))), buildDesktop: async dir => {
        if (mode === 'build-fails') throw new Error('Injected candidate build failure');
        if (mode === 'start-fails') return path.join(dir, 'missing-candidate');
        return prepareDesktop(dir);
      } });
    let gui = views.at(-1);
    await gui.until(s => s.tabs.some(t => t?.session === session.id && t.text?.includes('RETAINED_CLI_READY')), 'initial retained CLI');
    await gui.control('tree-entry', 'document.txt');
    let state = await gui.until(s => s.tabs.some(t => t?.type === 2 && t.text === 'Saved on disk\n'));
    const editor = state.tabs.find(t => t?.type === 2);
    await gui.click(editor.rect[0] + 12, editor.rect[1] + 8);
    await gui.command({ op: 'text', text: 'Keep my draft ' });
    await gui.until(s => s.tabs.some(t => t?.type === 2 && t.dirty));
    const contextFile = path.join(directory, 'context.json');
    await writeFile(contextFile, JSON.stringify({ url: host.url, token: host.token, instance: host.instance, rootId: root.id, runtimeDirectory: runtimeDir }), { mode: 0o600 });
    mcp = new Client({ name: 'native-layered-update', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('orchestrator/agents/mcp.mjs'), '--context', contextFile], stderr: 'pipe' });
    await mcp.connect(transport);
    const call = async (name, args = {}) => {
      const result = await mcp.callTool({ name, arguments: args }); assert.ok(!result.isError, JSON.stringify(result)); return result.structuredContent ?? JSON.parse(result.content[0].text);
    };
    const waitJob = async id => {
      for (let i = 0; i < 240; i++) { const status = await call('update_status'), job = status.jobs.find(x => x.id === id); if (['succeeded', 'failed'].includes(job?.status)) return { ...status, job }; await delay(75); }
      throw new Error('Update did not finish.');
    };
    const first = await call('update_status'), oldPid = gui.child.pid;
    assert.equal(first.desktops.length, 1); assert.equal(first.desktops[0].managed, true);
    const queued = await call('update_workspace', { layers: ['workspace', 'desktop', 'connector'], desktopId: first.desktops[0].id });
    const after = await waitJob(queued.jobId); assert.equal(after.job.status, 'succeeded', JSON.stringify(after.job));
    gui = views.at(-1); assert.notEqual(gui.child.pid, oldPid);
    assert.notEqual(after.workspace.pid, first.workspace.pid); assert.notEqual(after.toolWorkerPid, first.toolWorkerPid);
    await gui.until(s => s.tabs.some(t => t?.type === 2 && t.dirty && t.text.includes('Keep my draft')), 'draft survived prepared native replacement');
    assert.equal(await readFile(path.join(project, 'document.txt'), 'utf8'), 'Saved on disk\n');
    assert.equal(host.sessions.snapshot(session.id).pid, session.pid); assert.equal(await readFile(marker, 'utf8'), 'once\n');
    mode = 'build-fails'; const workingPid = gui.child.pid;
    const brokenBuild = await call('update_workspace', { layers: ['desktop'], desktopId: after.desktops[0].id });
    const buildFailure = await waitJob(brokenBuild.jobId);
    assert.equal(buildFailure.job.status, 'failed'); assert.match(buildFailure.job.error, /candidate build failure/);
    assert.equal(gui.child.pid, workingPid); assert.equal(gui.child.exitCode, null);
    await gui.until(s => s.connected && s.tabs.some(t => t?.dirty), 'failed build leaves old GUI usable');
    mode = 'start-fails';
    const brokenStart = await call('update_workspace', { layers: ['workspace', 'desktop', 'connector'], desktopId: buildFailure.desktops[0].id });
    const startFailure = await waitJob(brokenStart.jobId);
    assert.equal(startFailure.job.status, 'failed'); assert.equal(startFailure.job.recoveredPreviousDesktop, true, JSON.stringify(startFailure.job));
    assert.equal(startFailure.workspace.pid, after.workspace.pid); assert.equal(startFailure.connectorGeneration, after.connectorGeneration);
    gui = views.at(-1);
    await gui.until(s => s.connected && s.tabs.some(t => t?.dirty && t.text.includes('Keep my draft')), 'failed start restores previous native version');
    mode = 'build-fails';
    await gui.command({ op: 'key', key: 'R', mod: 0xc3 });
    let keyboard;
    for (let i = 0; i < 100 && !keyboard; i++) { keyboard = (await call('update_status')).jobs.find(x => x.startedAt > startFailure.job.startedAt && x.id !== startFailure.job.id); if (!keyboard) await delay(50); }
    assert.ok(keyboard, 'managed keyboard reload creates an update job');
    const keyboardFailure = await waitJob(keyboard.id);
    assert.equal(keyboardFailure.job.status, 'failed'); assert.equal(keyboardFailure.job.recoveredPreviousDesktop, true);
    gui = views.at(-1);
    await gui.until(s => s.connected && s.tabs.some(t => t?.dirty && t.text.includes('Keep my draft')), 'keyboard build failure restores previous desktop');
    const execute = promisify(execFile);
    const cli = await execute(process.execPath, ['orchestrator/runtime/client.mjs', 'update', '--context', contextFile, '--layers', 'connector'], { timeout: 15000 });
    assert.match(cli.stdout, /"status": "succeeded"/);
    const beforeCrash = await call('update_status'), retainedViewPid = gui.child.pid;
    process.kill(beforeCrash.workspace.pid, 'SIGTERM');
    let recovered;
    for (let i = 0; i < 160 && !recovered; i++) {
      const status = await call('update_status');
      if (status.workspace.recovery.state === 'recovered' && status.desktops.some(x => x.id !== beforeCrash.desktops[0].id)) recovered = status;
      else await delay(50);
    }
    assert.ok(recovered, 'native reconnects to the replacement workspace worker'); assert.equal(gui.child.pid, retainedViewPid);
    await gui.control('toolbar', 'Sessions');
    state = await gui.until(s => s.controls.some(c => c.role === 'attach' && c.key === session.id));
    await gui.control('attach', session.id);
    state = await gui.until(s => s.tabs.some(t => t?.session === session.id && t.rect[2] > 0));
    const terminal = state.tabs.find(t => t?.session === session.id);
    await gui.click(terminal.rect[0] + 20, terminal.rect[1] + 10);
    await gui.command({ op: 'text', text: 'after-update' });
    await gui.until(s => s.tabs.some(t => t?.text?.includes('CLI_61667465722d757064617465')), 'same CLI receives native input after all updates');
    await mkdir('.cache/evidence', { recursive: true });
    await gui.command({ op: 'snapshot', path: path.resolve('.cache/evidence/native-layered-update.bmp') });
    await gui.close(); assert.equal(host.sessions.snapshot(session.id).state, 'running');
    assert.equal(host.sessions.snapshot(session.id).pid, session.pid); assert.equal(await readFile(marker, 'utf8'), 'once\n');
  } finally {
    await mcp?.close(); for (const gui of views) await gui.close(); await runtime?.close(); await host?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
