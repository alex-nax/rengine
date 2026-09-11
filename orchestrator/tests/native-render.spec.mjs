import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, copyFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server/main.mjs';
import { nativeClient } from './native-client.mjs';

const run = promisify(execFile);
// Tolerances and budgets recorded before the run in docs/specs/068-opengl-adapter.md (decisions 5 and 6);
// specs 072 and 073 gate Metal and Vulkan against the same SDL reference and record GPU-versus-GPU as information.
// The current-UI scenes gained anti-aliased rounded controls with the design update (spec 076), so
// they carry the edge-band rule the owner set for the primitives scene instead of a channel limit:
// the differing fraction stays tight and nothing may differ outside a 2px band of a shape's edge.
const TOLERANCE = {
  workspace: ['--max-fraction', '0.001', '--edge-band', '2'],
  terminal: ['--max-fraction', '0.001', '--edge-band', '2'],
  primitives: ['--max-fraction', '0.02', '--edge-band', '2'],
};
// Frame time is gated on an absolute ceiling per scene, which is what a 60Hz workspace needs; the
// SDL comparison stays in the report as information. Spec 068 decision 6 as amended on 2026-09-06
// (spec 076): the adapters now anti-alias shapes the reference draws hard-edged, so the old
// at-or-below-the-reference rule no longer compares like with like.
const SCENE_CEILING_MS = 8, MEMORY_LIMIT_KB = 32 * 1024;
const WIN = process.platform === 'win32';
// Spec 068 decision 6 as amended on 2026-09-06 (spec 073 status): Vulkan on Windows carries the NVIDIA driver's
// process baseline, so its resident-memory ceiling is 64 MiB there; every other backend keeps 32 MiB.
const memoryLimitKb = backend => (WIN && backend === 'vulkan' ? 64 * 1024 : MEMORY_LIMIT_KB);
const PYTHON = WIN ? 'python' : 'python3'; // Windows ships no python3 alias
const BINARY = process.env.RENGINE_NATIVE_BINARY ?? path.resolve('.cache/desktop/bin', WIN ? 'Release/rengine.exe' : 'rengine');
const GPU_BACKENDS = process.platform === 'darwin' ? ['opengl', 'metal', 'vulkan'] : ['opengl', 'vulkan'];
const TERMINAL_SCRIPT = WIN
  ? "1..40 | % { ('{0}[3{1}m{2:D3}{0}[0m row of the render scene with colour and text' -f [char]27, ($_ % 7 + 1), $_) }; 'RENDER_DONE'\r\n"
  : "for i in $(seq 1 40); do printf '\\033[3%dm%03d\\033[0m row of the render scene with colour and text\\n' $((i % 7 + 1)) $i; done; printf 'RENDER_DONE\\n'\n";
// A plain shell with a fixed prompt: the login shell's asynchronous prompt segments redraw after the
// stable-text wait and made the SDL capture disagree with the GPU captures on prompt and scrollbar pixels.
const SHELL = WIN ? { command: 'powershell.exe', args: ['-NoLogo', '-NoProfile'] } : { command: '/bin/bash', args: ['--noprofile', '--norc'], env: { PS1: 'render$ ' } };

// SDL honours SDL_VULKAN_LIBRARY; on macOS the Homebrew loader (with MoltenVK) lives outside the default search path.
function vulkanEnv() {
  if (process.platform !== 'darwin') return {};
  const env = {};
  const loader = ['/opt/homebrew/lib/libvulkan.1.dylib', '/usr/local/lib/libvulkan.1.dylib'].find(p => existsSync(p));
  if (loader && !process.env.SDL_VULKAN_LIBRARY) env.SDL_VULKAN_LIBRARY = loader;
  const layers = ['/opt/homebrew/share/vulkan/explicit_layer.d', '/usr/local/share/vulkan/explicit_layer.d'].find(p => existsSync(p));
  if (layers && !process.env.VK_LAYER_PATH) env.VK_LAYER_PATH = layers;
  // Homebrew's layer manifest names its library by bare filename, which dyld only finds with a library path.
  const layerLib = ['/opt/homebrew/lib', '/usr/local/lib'].find(p => existsSync(path.join(p, 'libVkLayer_khronos_validation.dylib')));
  if (layerLib && !process.env.DYLD_LIBRARY_PATH) env.DYLD_LIBRARY_PATH = layerLib;
  // And the loader finds a driver through an ICD manifest. Homebrew installs MoltenVK's under etc/,
  // which is not on the loader's default search path — so the loader loads, reports no physical
  // device, and the failure reads like "no Vulkan on this machine" when the driver is right there.
  // This one variable is the whole difference between the backend being unrunnable here and running.
  const icd = ['/opt/homebrew/etc/vulkan/icd.d/MoltenVK_icd.json', '/usr/local/etc/vulkan/icd.d/MoltenVK_icd.json',
               '/opt/homebrew/share/vulkan/icd.d/MoltenVK_icd.json', '/usr/local/share/vulkan/icd.d/MoltenVK_icd.json']
    .find(p => existsSync(p));
  if (icd && !process.env.VK_ICD_FILENAMES && !process.env.VK_DRIVER_FILES) env.VK_ICD_FILENAMES = icd;
  return env;
}
// Spec 073 decision 11: probe once, record 'unavailable' with the reason instead of failing on machines without a loader or layer.
async function probe(backend, extraEnv, dir) {
  const file = path.join(dir, `probe-${backend}.bmp`);
  try {
    await run(BINARY, ['--renderer', backend, '--smoke-test', '--snapshot', file], { env: { ...process.env, ...extraEnv, RENGINE_RENDERER: '' } });
    return null;
  } catch (error) { return (error.stderr || error.message || 'failed').toString().trim().split('\n').pop(); }
}

async function resident(pid) {
  const { stdout } = WIN
    ? await run('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).WorkingSet64 / 1024`])
    : await run('ps', ['-o', 'rss=', '-p', String(pid)]);
  return Number(stdout.trim());
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function compare(reference, candidate, name) {
  let output;
  try { ({ stdout: output } = await run(PYTHON, ['tools/render_compare.py', reference, candidate, ...TOLERANCE[name], '--json'])); }
  catch (error) { output = error.stdout; if (!output) throw error; }
  return JSON.parse(output);
}

// Each backend gets its own server state so a later run cannot restore an earlier run's retained views.
async function capture(project, backend, dir, extraEnv = {}, tag = backend) {
  const server = await startServer({ stateDir: path.join(dir, `state-${tag}`) });
  const root = await server.store.addRoot(project);
  const shell = await server.sessions.terminal({ rootId: root.id, ...SHELL });
  const gui = await nativeClient(server, { root: root.id, terminal: shell.id, env: { RENGINE_RENDERER: backend, ...extraEnv } });
  const result = { backend, snapshots: {}, stats: {}, rss: 0, samples: [] };
  try {
    const state = await gui.until(s => s.connected && s.tabs.some(t => t?.type === 1 && t.tree) && s.tabs.some(t => t?.session === shell.id && t.text), `${tag} workspace`);
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
      const file = path.join(dir, `${tag}-${name}.bmp`);
      assert.equal(await gui.command({ op: 'snapshot', path: file }), true);
      result.snapshots[name] = file; result.stats[name] = await gui.command({ op: 'stats' });
      result.samples.push(await resident(gui.child.pid)); // one sample per scene: a single reading swings by more than the budget
    };
    await scene('workspace');
    server.sessions.input(shell.id, TERMINAL_SCRIPT);
    await gui.until(s => s.tabs.some(t => t?.session === shell.id && t.text?.includes('RENDER_DONE')), `${tag} terminal output`);
    await scene('terminal');
    assert.equal(await gui.command({ op: 'scene', name: 'primitives' }), true);
    await scene('primitives');
    await gui.command({ op: 'scene', name: '' });
    result.samples.push(await resident(gui.child.pid));
    result.rss = median(result.samples);
  } finally { await gui.close(); await server.close(); }
  return result;
}

test('GPU adapters match the SDL reference within the recorded tolerances and budgets', { timeout: 420000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-native-render-'));
  const project = path.join(dir, 'project'); await mkdir(project);
  await writeFile(path.join(project, 'render.txt'), 'render scene\n');
  try {
    const envFor = backend => (backend === 'vulkan' ? vulkanEnv() : {});
    const unavailable = {};
    const backends = [];
    for (const backend of GPU_BACKENDS) {
      const reason = backend === 'vulkan' ? await probe(backend, envFor(backend), dir) : null;
      if (reason) unavailable[backend] = reason; else backends.push(backend);
    }
    for (const [backend, reason] of Object.entries(unavailable)) console.log(`render spec: ${backend} unavailable on this machine (${reason})`);
    const sdl = await capture(project, 'sdl', dir);
    const gpu = {};
    for (const backend of backends) gpu[backend] = await capture(project, backend, dir, envFor(backend));
    // Spec 073 decision 9: one validation-layer run of the Vulkan backend; every message is a failure.
    const validation = {};
    if (backends.includes('vulkan')) {
      const log = path.join(dir, 'vulkan-validation.log');
      const reason = await probe('vulkan', { ...vulkanEnv(), RENGINE_VULKAN_VALIDATION: '1', RENGINE_VULKAN_VALIDATION_LOG: log }, dir);
      if (reason) validation.vulkan = { unavailable: reason };
      else {
        await capture(project, 'vulkan', dir, { ...vulkanEnv(), RENGINE_VULKAN_VALIDATION: '1', RENGINE_VULKAN_VALIDATION_LOG: log }, 'vulkan-validation');
        const text = existsSync(log) ? await readFile(log, 'utf8') : '';
        const messages = text.split('\n').filter(Boolean);
        validation.vulkan = { messages: messages.length, first: messages.slice(0, 5) };
      }
    }
    await mkdir('.cache/evidence', { recursive: true });
    const report = { platform: process.platform, backends, unavailable, validation, scenes: {}, memory: { sdlKb: sdl.rss, limitKb: MEMORY_LIMIT_KB } };
    report.memory.sdlSamples = sdl.samples;
    for (const backend of backends) { report.memory[`${backend}Kb`] = gpu[backend].rss; report.memory[`${backend}LimitKb`] = memoryLimitKb(backend); report.memory[`${backend}Samples`] = gpu[backend].samples; }
    for (const name of Object.keys(TOLERANCE)) {
      await copyFile(sdl.snapshots[name], `.cache/evidence/render-${name}-sdl.bmp`);
      const scene = { sdl: sdl.stats[name], compare: {}, cross: {} };
      for (const backend of backends) {
        await copyFile(gpu[backend].snapshots[name], `.cache/evidence/render-${name}-${backend}.bmp`);
        scene[backend] = gpu[backend].stats[name];
        scene.compare[backend] = await compare(sdl.snapshots[name], gpu[backend].snapshots[name], name);
        scene.compare[backend].versusReference = Number((scene[backend].frameMedianMs / sdl.stats[name].frameMedianMs).toFixed(3));
      }
      for (let i = 0; i < backends.length; i++) for (let j = i + 1; j < backends.length; j++)
        scene.cross[`${backends[i]}-vs-${backends[j]}`] = await compare(gpu[backends[i]].snapshots[name], gpu[backends[j]].snapshots[name], name);
      report.scenes[name] = scene;
    }
    /* And against the COMMITTED reference frames, which are the oracle that survives SDL_Renderer
       retiring as a shipping path (charter D49/D54, spec 124). The live comparison above is only as
       independent as SDL is: once every backend renders through one seam, a seam defect moves pixels
       in all of them at once and cross-comparison sees nothing. A recorded frame cannot drift along
       with the code it judges, which is the whole point of keeping one. */
    report.reference = {};
    for (const name of Object.keys(TOLERANCE)) {
      const recorded = path.join('orchestrator/tests/references', `render-${name}.png`);
      if (!existsSync(recorded)) continue;
      report.reference[name] = {};
      for (const backend of [...backends, 'sdl']) {
        const shot = backend === 'sdl' ? sdl.snapshots[name] : gpu[backend].snapshots[name];
        report.reference[name][backend] = await compare(recorded, shot, name);
      }
    }
    await writeFile('.cache/evidence/render-compare.json', JSON.stringify(report, null, 2));
    for (const name of Object.keys(report.reference)) {
      for (const [backend, result] of Object.entries(report.reference[name])) {
        assert.deepEqual(result.failures, [],
          `${backend} ${name} still matches the recorded frame: ${JSON.stringify(result)}`);
      }
    }
    for (const backend of backends) {
      for (const name of Object.keys(TOLERANCE)) {
        const scene = report.scenes[name];
        assert.deepEqual(scene.compare[backend].failures, [], `${backend} ${name}: ${JSON.stringify(scene.compare[backend])}`);
        assert.ok(!scene[backend].overflow, `${backend} ${name}: the draw list overflowed`);
        assert.ok(scene[backend].frameMedianMs <= SCENE_CEILING_MS,
          `${backend} ${name}: median ${scene[backend].frameMedianMs.toFixed(3)} ms exceeds the ${SCENE_CEILING_MS} ms ceiling`);
      }
      assert.ok(gpu[backend].rss - sdl.rss <= memoryLimitKb(backend), `${backend}: resident memory delta ${gpu[backend].rss - sdl.rss} KiB exceeds ${memoryLimitKb(backend)} KiB`);
    }
    if (validation.vulkan && !validation.vulkan.unavailable) assert.equal(validation.vulkan.messages, 0, `vulkan validation: ${JSON.stringify(validation.vulkan.first)}`);
    if (validation.vulkan?.unavailable) console.log(`render spec: vulkan validation unavailable on this machine (${validation.vulkan.unavailable})`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
