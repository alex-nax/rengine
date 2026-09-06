import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server/main.mjs';
import { nativeClient } from './native-client.mjs';

const run = promisify(execFile);
// Tolerances and budgets recorded before the run in docs/specs/068-opengl-adapter.md (decisions 5 and 6);
// spec 072 gates Metal against the same SDL reference and records Metal-versus-OpenGL as information.
const TOLERANCE = {
  workspace: ['--max-fraction', '0.001', '--max-delta', '2'],
  terminal: ['--max-fraction', '0.001', '--max-delta', '2'],
  primitives: ['--max-fraction', '0.02', '--edge-band', '2'],
};
const TERMINAL_CEILING_MS = 8, MEMORY_LIMIT_KB = 32 * 1024;
const GPU_BACKENDS = process.platform === 'darwin' ? ['opengl', 'metal'] : ['opengl'];
const TERMINAL_SCRIPT = "for i in $(seq 1 40); do printf '\\033[3%dm%03d\\033[0m row of the render scene with colour and text\\n' $((i % 7 + 1)) $i; done; printf 'RENDER_DONE\\n'\n";

async function compare(reference, candidate, name) {
  let output;
  try { ({ stdout: output } = await run('python3', ['tools/render_compare.py', reference, candidate, ...TOLERANCE[name], '--json'])); }
  catch (error) { output = error.stdout; if (!output) throw error; }
  return JSON.parse(output);
}

// Each backend gets its own server state so a later run cannot restore an earlier run's retained views.
async function capture(project, backend, dir) {
  const server = await startServer({ stateDir: path.join(dir, `state-${backend}`) });
  const root = await server.store.addRoot(project);
  // A plain shell with a fixed prompt: the login shell's asynchronous prompt segments redraw after the
  // stable-text wait and made the SDL capture disagree with the GPU captures on prompt and scrollbar pixels.
  const shell = await server.sessions.terminal({ rootId: root.id, ...(process.platform === 'win32'
    ? { command: 'cmd.exe', args: [] } : { command: '/bin/bash', args: ['--noprofile', '--norc'], env: { PS1: 'render$ ' } }) });
  const gui = await nativeClient(server, { root: root.id, terminal: shell.id, env: { RENGINE_RENDERER: backend } });
  const result = { backend, snapshots: {}, stats: {}, rss: 0 };
  try {
    const state = await gui.until(s => s.connected && s.tabs.some(t => t?.type === 1 && t.tree) && s.tabs.some(t => t?.session === shell.id && t.text), `${backend} workspace`);
    assert.equal(state.backend, backend);
    const scene = async name => {
      // Wait for the view text to stop changing so every backend captures the same terminal rows.
      let previous = null;
      for (let stable = 0; stable < 10;) {
        const current = JSON.stringify((await gui.command({ op: 'state' })).tabs.map(t => t?.text ?? null));
        stable = current === previous ? stable + 1 : 0; previous = current; await delay(50);
      }
      await gui.command({ op: 'stats', reset: true });
      for (let i = 0; i < 40; i++) { await gui.command({ op: 'state' }); await delay(16); }
      const file = path.join(dir, `${backend}-${name}.bmp`);
      assert.equal(await gui.command({ op: 'snapshot', path: file }), true);
      result.snapshots[name] = file; result.stats[name] = await gui.command({ op: 'stats' });
    };
    await scene('workspace');
    server.sessions.input(shell.id, TERMINAL_SCRIPT);
    await gui.until(s => s.tabs.some(t => t?.session === shell.id && t.text?.includes('RENDER_DONE')), `${backend} terminal output`);
    await scene('terminal');
    assert.equal(await gui.command({ op: 'scene', name: 'primitives' }), true);
    await scene('primitives');
    await gui.command({ op: 'scene', name: '' });
    result.rss = Number((await run('ps', ['-o', 'rss=', '-p', String(gui.child.pid)])).stdout.trim());
  } finally { await gui.close(); await server.close(); }
  return result;
}

test('GPU adapters match the SDL reference within the recorded tolerances and budgets', { timeout: 240000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-native-render-'));
  const project = path.join(dir, 'project'); await mkdir(project);
  await writeFile(path.join(project, 'render.txt'), 'render scene\n');
  try {
    const sdl = await capture(project, 'sdl', dir);
    const gpu = {};
    for (const backend of GPU_BACKENDS) gpu[backend] = await capture(project, backend, dir);
    await mkdir('.cache/evidence', { recursive: true });
    const report = { backends: GPU_BACKENDS, scenes: {}, memory: { sdlKb: sdl.rss, limitKb: MEMORY_LIMIT_KB } };
    for (const backend of GPU_BACKENDS) report.memory[`${backend}Kb`] = gpu[backend].rss;
    for (const name of Object.keys(TOLERANCE)) {
      await copyFile(sdl.snapshots[name], `.cache/evidence/render-${name}-sdl.bmp`);
      const scene = { sdl: sdl.stats[name], compare: {}, cross: {} };
      for (const backend of GPU_BACKENDS) {
        await copyFile(gpu[backend].snapshots[name], `.cache/evidence/render-${name}-${backend}.bmp`);
        scene[backend] = gpu[backend].stats[name];
        scene.compare[backend] = await compare(sdl.snapshots[name], gpu[backend].snapshots[name], name);
      }
      if (GPU_BACKENDS.length === 2) scene.cross['opengl-vs-metal'] = await compare(gpu.opengl.snapshots[name], gpu.metal.snapshots[name], name);
      report.scenes[name] = scene;
    }
    await writeFile('.cache/evidence/render-compare.json', JSON.stringify(report, null, 2));
    for (const backend of GPU_BACKENDS) {
      for (const name of Object.keys(TOLERANCE)) {
        const scene = report.scenes[name];
        assert.deepEqual(scene.compare[backend].failures, [], `${backend} ${name}: ${JSON.stringify(scene.compare[backend])}`);
        assert.ok(!scene[backend].overflow, `${backend} ${name}: the draw list overflowed`);
        assert.ok(scene[backend].frameMedianMs <= scene.sdl.frameMedianMs,
          `${backend} ${name}: median ${scene[backend].frameMedianMs.toFixed(3)} ms exceeds the SDL baseline ${scene.sdl.frameMedianMs.toFixed(3)} ms`);
      }
      assert.ok(report.scenes.terminal[backend].frameMedianMs <= TERMINAL_CEILING_MS, `${backend}: terminal scene median exceeds ${TERMINAL_CEILING_MS} ms`);
      assert.ok(gpu[backend].rss - sdl.rss <= MEMORY_LIMIT_KB, `${backend}: resident memory delta ${gpu[backend].rss - sdl.rss} KiB exceeds ${MEMORY_LIMIT_KB} KiB`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
