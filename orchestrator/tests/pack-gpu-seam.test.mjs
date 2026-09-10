/* F123, charter D52. The seam half of the pack, checked the way its first consumer will meet it.
 *
 * Two claims are worth evidence here and neither is provable inside rEngine's own build:
 *
 *   1. A C++ project builds the pack and uses the facade. rEngine's tree is C, so nothing here
 *      compiles a C++ translation unit — which means "the header-only C++ facade works" would
 *      otherwise be a claim resting on the fact that it parses in someone's head. This writes a real
 *      C++ consumer with its own CMake project, adds the pack, and runs the result.
 *
 *   2. The facade fixture still stands for vtmb-vr's real call sites. The fixture is hand-written
 *      from them, and a hand-written fixture rots the moment the code it mirrors moves. So this
 *      re-derives the set of methods VtMB actually calls on a gpu::Device and fails if one of them
 *      is missing from either the facade or the fixture. When vtmb-vr is not on this machine the
 *      check says so and skips, rather than passing quietly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const run = promisify(execFile);
const PACK = path.resolve('packs/gpu');
const FIXTURE = path.join(PACK, 'tests/gpu_seam_facade_test.cpp');
const VTMB = process.env.RENGINE_VTMB_DIR ?? path.join(homedir(), 'vtmb-vr');

test('a C++ project outside this repository builds the pack and uses the seam facade', { timeout: 300000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-pack-seam-'));
  try {
    /* `project(consumer CXX C)` is the shape a game has: C++ of its own, and the pack's C core
       compiled by the same build. Nothing tells CMake where a graphics library is, because the pack
       needs none — that is the property being demonstrated, not just asserted. */
    await writeFile(path.join(dir, 'CMakeLists.txt'), `
cmake_minimum_required(VERSION 3.21)
project(consumer CXX C)
add_subdirectory("${PACK}" pack)
add_executable(consumer "${FIXTURE}")
target_compile_features(consumer PRIVATE cxx_std_17)
target_link_libraries(consumer PRIVATE rengine::gpu)
`);
    const build = path.join(dir, 'build');
    await run('cmake', ['-S', dir, '-B', build], { maxBuffer: 1 << 24 });
    await run('cmake', ['--build', build], { maxBuffer: 1 << 24 });
    const binary = path.join(build, process.platform === 'win32' ? 'Debug/consumer.exe' : 'consumer');
    const { stdout } = await run(binary, [], { maxBuffer: 1 << 24 });
    assert.match(stdout, /every vtmb-vr call site compiles unchanged/);

    /* And the consumer got the seam without naming a graphics library anywhere: if the pack linked
       one, this configure would have needed to find it. */
    const cache = await readFile(path.join(build, 'CMakeCache.txt'), 'utf8');
    assert.doesNotMatch(cache, /OPENGL_gl_LIBRARY|OpenGL_FOUND:.*TRUE/,
      'the pack must not drag a graphics library into a consumer; its entry points come from the host');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the facade fixture still covers every method vtmb-vr calls on the seam', { timeout: 60000 }, async () => {
  if (!existsSync(path.join(VTMB, 'src/renderer/gpu/device.h'))) {
    console.log(`pack-gpu-seam: vtmb-vr not found at ${VTMB}; the drift check needs the real call sites`);
    return;
  }
  /* Find the identifiers actually declared as a Device, then collect the methods called on them.
     Grepping for method names alone would sweep up std::vector::clear and every other .clear() in
     the tree — the first version of this measurement did exactly that and reported 442 calls to
     `clear`. Anchoring on the declared variables is what makes the number mean something. */
  const sources = [];
  const walk = async dir => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(cpp|h)$/.test(entry.name) && !full.includes('/gpu/')) sources.push(full);
    }
  };
  await walk(path.join(VTMB, 'src'));

  const holders = new Set();
  const methods = new Set();
  const texts = await Promise.all(sources.map(file => readFile(file, 'utf8')));
  for (const text of texts) {
    for (const match of text.matchAll(/\bgpu::Device\s+(\w+)/g)) holders.add(match[1]);
    for (const match of text.matchAll(/\b(?:vtmb::renderer::)?gpu::Device\s+(\w+)/g)) holders.add(match[1]);
  }
  assert.ok(holders.size > 0, 'no gpu::Device declarations found — the extraction is broken, not the seam');
  const holderPattern = [...holders].map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  for (const text of texts) {
    for (const match of text.matchAll(new RegExp(`\\b(?:${holderPattern})\\.(\\w+)\\s*\\(`, 'g'))) {
      methods.add(match[1]);
    }
  }
  assert.ok(methods.size >= 20, `expected the whole seam to be exercised, found ${methods.size}: ${[...methods]}`);

  const facade = await readFile(path.join(PACK, 'include/rengine/gpu_seam.hpp'), 'utf8');
  const fixture = await readFile(FIXTURE, 'utf8');
  const missingFromFacade = [...methods].filter(name => !new RegExp(`\\b${name}\\s*\\(`).test(facade));
  const missingFromFixture = [...methods].filter(name => !new RegExp(`\\.${name}\\s*\\(`).test(fixture));
  assert.deepEqual(missingFromFacade, [],
    'vtmb-vr calls a method the facade does not offer, so "adopt by deleting your own copy" is false for it');
  assert.deepEqual(missingFromFixture, [],
    'vtmb-vr calls a method no fixture line covers, so the compile check no longer stands for its call sites');
  console.log(`pack-gpu-seam: ${methods.size} seam methods called across vtmb-vr, all covered`);
});
