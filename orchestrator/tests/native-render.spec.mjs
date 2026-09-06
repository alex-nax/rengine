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
// Tolerances and budgets recorded before the run in docs/specs/068-opengl-adapter.md (decisions 5 and 6).
const TOLERANCE = {
  workspace: ['--max-fraction', '0.001', '--max-delta', '2'],
  terminal: ['--max-fraction', '0.001', '--max-delta', '2'],
  primitives: ['--max-fraction', '0.02', '--edge-band', '2'],
};
const TERMINAL_CEILING_MS = 8, MEMORY_LIMIT_KB = 32 * 1024;
const TERMINAL_SCRIPT = "for i in $(seq 1 40); do printf '\\033[3%dm%03d\\033[0m row of the render scene with colour and text\\n' $((i % 7 + 1)) $i; done; printf 'RENDER_DONE\\n'\n";

// Each backend gets its own server state so the second run cannot restore the first run's retained views.
async function capture(project, backend, dir) {
  const server = await startServer({ stateDir: path.join(dir, `state-${backend}`) });
  const root = await server.store.addRoot(project);
  const shell = await server.sessions.terminal({ rootId: root.id });
  const gui = await nativeClient(server, { root: root.id, terminal: shell.id, env: { RENGINE_RENDERER: backend } });
  const result = { backend, snapshots: {}, stats: {}, rss: 0 };
  try {
    const state = await gui.until(s => s.connected && s.tabs.some(t => t?.type === 1 && t.tree) && s.tabs.some(t => t?.session === shell.id && t.text), `${backend} workspace`);
    assert.equal(state.backend, backend);
    const scene = async name => {
      // Wait for the view text to stop changing so both backends capture the same terminal rows.
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

test('OpenGL adapter matches the SDL reference within the recorded tolerances and budgets', { timeout: 150000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-native-render-'));
  const project = path.join(dir, 'project'); await mkdir(project);
  await writeFile(path.join(project, 'render.txt'), 'render scene\n');
  try {
    const sdl = await capture(project, 'sdl', dir);
    const opengl = await capture(project, 'opengl', dir);
    await mkdir('.cache/evidence', { recursive: true });
    const report = { scenes: {}, memory: { sdlKb: sdl.rss, openglKb: opengl.rss, deltaKb: opengl.rss - sdl.rss, limitKb: MEMORY_LIMIT_KB } };
    for (const name of Object.keys(TOLERANCE)) {
      await copyFile(sdl.snapshots[name], `.cache/evidence/render-${name}-sdl.bmp`);
      await copyFile(opengl.snapshots[name], `.cache/evidence/render-${name}-opengl.bmp`);
      let output;
      try { ({ stdout: output } = await run('python3', ['tools/render_compare.py', sdl.snapshots[name], opengl.snapshots[name], ...TOLERANCE[name], '--json'])); }
      catch (error) { output = error.stdout; if (!output) throw error; }
      report.scenes[name] = { compare: JSON.parse(output), sdl: sdl.stats[name], opengl: opengl.stats[name] };
    }
    await writeFile('.cache/evidence/render-compare.json', JSON.stringify(report, null, 2));
    for (const name of Object.keys(TOLERANCE)) {
      assert.deepEqual(report.scenes[name].compare.failures, [], `${name}: ${JSON.stringify(report.scenes[name].compare)}`);
      assert.ok(!opengl.stats[name].overflow, `${name}: the OpenGL draw list overflowed`);
      assert.ok(opengl.stats[name].frameMedianMs <= sdl.stats[name].frameMedianMs,
        `${name}: OpenGL median ${opengl.stats[name].frameMedianMs.toFixed(3)} ms exceeds the SDL baseline ${sdl.stats[name].frameMedianMs.toFixed(3)} ms`);
    }
    assert.ok(opengl.stats.terminal.frameMedianMs <= TERMINAL_CEILING_MS, `terminal scene median ${opengl.stats.terminal.frameMedianMs} ms exceeds ${TERMINAL_CEILING_MS} ms`);
    assert.ok(opengl.rss - sdl.rss <= MEMORY_LIMIT_KB, `resident memory delta ${opengl.rss - sdl.rss} KiB exceeds ${MEMORY_LIMIT_KB} KiB`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
