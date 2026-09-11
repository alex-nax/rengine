/* F130. The D14c verdict: one set of call sites, two graphics APIs, compared on pixels.
 *
 * vtmb-vr's F801/D14c bet that a resource-and-draw seam — buffers, textures, programs, a small
 * pipeline state, a draw — could carry Vulkan with command buffers, render passes and barriers built
 * inside the backend. Charter D52 put that bet's proof at the game, because rEngine had no renderer
 * to test it with. D53 gave rEngine one: the scene example. So this builds the example twice, once
 * against each backend, renders the same frame number with both, and compares.
 *
 * What makes the comparison mean something is that `scene.c` is byte-identical between the two
 * builds. Only the host differs — the window, the device, the read-back — which is the boundary the
 * seam always drew and never claimed to hide.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile, copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const run = promisify(execFile);

/* "N GPU allocations in total, M after the first frame (F steady frames), D draws" — the line the
 * example prints, which is F130's sixth criterion and F131's fourth. What is being gated is not a
 * number but a SHAPE: a steady frame may not allocate more than it draws. OpenGL and Metal allocate
 * nothing at all once warm; Vulkan allocates exactly one descriptor set per draw, because its pool is
 * reset at frame_begin and a set cannot outlive that (KI-086). A regression that started allocating
 * per vertex, or a second object per draw, fails here. */
function allocations(stdout) {
  const m = /(\d+) GPU allocations in total, (\d+) after the first frame \((\d+) steady frames\), (\d+) draws/.exec(stdout);
  return m && { total: +m[1], steady: +m[2], frames: +m[3], draws: +m[4] };
}

const PACK = path.resolve('packs/gpu');
const EXAMPLE = path.join(PACK, 'examples/scene');
const PYTHON = process.env.PYTHON ?? 'python3';

/* The Vulkan loader and MoltenVK's driver manifest, found the same way native-render.spec.mjs finds
   them — Homebrew puts the manifest under etc/, which is not on the loader's search path. */
function vulkanEnv() {
  if (process.platform !== 'darwin') return {};
  const env = {};
  const pick = (list, key) => { const found = list.find(p => existsSync(p)); if (found && !process.env[key]) env[key] = found; };
  pick(['/opt/homebrew/lib/libvulkan.1.dylib', '/usr/local/lib/libvulkan.1.dylib'], 'SDL_VULKAN_LIBRARY');
  pick(['/opt/homebrew/etc/vulkan/icd.d/MoltenVK_icd.json', '/usr/local/etc/vulkan/icd.d/MoltenVK_icd.json',
        '/opt/homebrew/share/vulkan/icd.d/MoltenVK_icd.json'], 'VK_ICD_FILENAMES');
  pick(['/opt/homebrew/share/vulkan/explicit_layer.d', '/usr/local/share/vulkan/explicit_layer.d'], 'VK_LAYER_PATH');
  pick(['/opt/homebrew/lib', '/usr/local/lib'], 'DYLD_LIBRARY_PATH');
  return env;
}

async function buildFor(backend, dir) {
  const where = path.join(dir, backend);
  await mkdir(where, { recursive: true });
  await writeFile(path.join(where, 'CMakeLists.txt'), `
cmake_minimum_required(VERSION 3.21)
project(scene_${backend} CXX C${backend === 'metal' ? ' OBJC' : ''})
find_package(SDL2 REQUIRED CONFIG)
set(RENGINE_GPU_SEAM_BACKEND ${backend} CACHE STRING "" FORCE)
add_subdirectory("${PACK}" pack)
add_executable(scene "${EXAMPLE}/main.c" "${EXAMPLE}/scene.c" "${EXAMPLE}/obj.c"
                     "${EXAMPLE}/${{opengl: 'host_gl.c', vulkan: 'host_vk.c', metal: 'host_metal.m'}[backend]}")
${backend === 'metal' ? `set_source_files_properties("${EXAMPLE}/host_metal.m" PROPERTIES COMPILE_OPTIONS "-fno-objc-arc")` : ''}
target_link_libraries(scene PRIVATE rengine::gpu SDL2::SDL2 m)
target_compile_features(scene PRIVATE c_std_11)
`);
  const build = path.join(where, 'build');
  await run('cmake', ['-S', where, '-B', build], { maxBuffer: 1 << 24 });
  await run('cmake', ['--build', build], { maxBuffer: 1 << 24 });
  return path.join(build, process.platform === 'win32' ? 'Debug/scene.exe' : 'scene');
}

test('the same call sites render the same frame on every backend', { timeout: 1200000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-backends-'));
  try {
    const gl = await buildFor('opengl', dir);
    const glFrame = path.join(dir, 'opengl.bmp');
    try {
      await run(gl, ['--snapshot', glFrame, '--frames', '60'], { maxBuffer: 1 << 24 });
    } catch (error) {
      const text = `${error.stdout ?? ''}${error.stderr ?? ''}`;
      if (/SDL video unavailable|no GL context|no window/.test(text)) {
        console.log(`pack-gpu-backends: ${text.trim().split('\n')[0]}; skipping`);
        return;
      }
      throw error;
    }

    /* Each remaining backend is judged against the OpenGL frame, which charter D51 already named as
       the reference. A backend this machine cannot run is said aloud and skipped; an absence is never
       turned into green, and a run where nothing could be compared fails rather than passing empty. */
    let compared = 0;
    for (const backend of ['vulkan', 'metal']) {
      if (backend === 'metal' && process.platform !== 'darwin') continue;
      const binary = await buildFor(backend, dir);
      const frame = path.join(dir, `${backend}.bmp`);
      const env = { ...process.env, ...vulkanEnv(), RENGINE_SCENE_VALIDATION: '1' };
      let produced;
      try {
        produced = await run(binary, ['--snapshot', frame, '--frames', '60'], { env, maxBuffer: 1 << 24 });
      } catch (error) {
        const text = `${error.stdout ?? ''}${error.stderr ?? ''}`;
        if (/no Vulkan loader|no Metal device|no device|SDL video unavailable/.test(text)) {
          console.log(`pack-gpu-backends: ${backend} unavailable (${text.trim().split('\n')[0]}); skipped`);
          continue;
        }
        throw error;
      }

      /* Every validation message is a failure: a frame that renders correctly by luck on one driver
         is not evidence about any other. */
      const messages = `${produced.stderr}`.split('\n').filter(line => line.startsWith('validation:'));
      assert.deepEqual(messages, [], `${backend} drew legally: ${messages.slice(0, 3).join(' | ')}`);

      /* The same tolerance this repository already applies to its own backends: pixels may differ
         where two rasterisers break a tie at a shared edge, and nowhere else. No --max-fraction,
         because the tool exits 1 on a limit it was given and an exit status thrown as an exception
         would hide the numbers behind "Command failed" — this spec reads the report and judges. */
      const output = await run(PYTHON, ['tools/render_compare.py', glFrame, frame,
                                        '--edge-band', '2', '--json'], { maxBuffer: 1 << 24 });
      const report = JSON.parse(output.stdout);
      assert.equal(report.outside_edge_band, 0,
        `every difference between ${backend} and OpenGL is at an edge: ${JSON.stringify(report)}`);
      assert.ok(report.fraction < 0.01, `and there are few of them: ${report.differing} pixels`);
      console.log(`pack-gpu-backends: ${backend} differs from OpenGL in ${report.differing} of ` +
                  `${report.pixels} pixels, all within the edge band`);
      const counted = allocations(`${produced.stdout}`);
      assert.ok(counted, `${backend} reported its allocation counters`);
      const perFrame = counted.steady / counted.frames, drawsPerFrame = counted.draws / (counted.frames + 1);
      assert.ok(counted.steady <= counted.draws - drawsPerFrame,
        `${backend} allocates no more than once per draw in a steady frame: ${counted.steady} over ` +
        `${counted.frames} frames against ${counted.draws} draws`);
      console.log(`pack-gpu-backends: ${backend} allocated ${counted.total} objects in total, ` +
                  `${perFrame.toFixed(1)} per steady frame against ${drawsPerFrame.toFixed(0)} draws`);
      await mkdir('.cache/evidence', { recursive: true });
      await copyFile(frame, `.cache/evidence/scene-${backend}.bmp`);
      compared++;
    }
    assert.ok(compared > 0, 'at least one other backend was compared; otherwise this proved nothing');
    await mkdir('.cache/evidence', { recursive: true });
    await copyFile(glFrame, '.cache/evidence/scene-opengl.bmp');

    /* scene.c is what both builds compiled. If a backend needed its own copy, the claim that the
       call sites do not change would be empty — so this asserts the thing the comparison rests on. */
    /* Comments are stripped first. The previous version matched the prose — a comment explaining
       why vtmb-vr makes fourteen glDepthFunc calls tripped an assertion about CODE, which is the
       assertion measuring the wrong text rather than the code being wrong. */
    const scene = (await readFile(path.join(EXAMPLE, 'scene.c'), 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
    const apiCalls = [...scene.matchAll(/\b((?:gl|vk|Vk|SDL_)[A-Za-z_]\w*)\s*\(/g)].map(m => m[1]);
    assert.deepEqual(apiCalls, [],
      `scene.c calls no graphics API directly, which is what "no call-site difference" has to mean: ${apiCalls}`);
    assert.ok(!/#include\s*[<"](?:GL|vulkan|SDL|Metal)/.test(scene),
      'and it includes no graphics header either');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
