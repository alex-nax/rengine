/* F123. A pack nobody has built from outside is a claim rather than a pack, so this is the claim's
 * evidence: a project that has never heard of rEngine's build adds the pack as a subdirectory, links
 * it, includes its one public header and calls into it.
 *
 * It also checks the two properties that make it a pack rather than a directory — that a consumer
 * gets the library and NOT the desktop, and that the implementation is not reachable through the
 * public include path. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const run = promisify(execFile);
const PACK = path.resolve('packs/gpu');

test('a project outside this repository builds the gpu pack and links it', { timeout: 300000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-pack-gpu-'));
  try {
    await writeFile(path.join(dir, 'CMakeLists.txt'), `
cmake_minimum_required(VERSION 3.21)
project(consumer C)
add_subdirectory("${PACK}" pack)
add_executable(consumer main.c)
target_link_libraries(consumer PRIVATE rengine::gpu)
`);
    /* Uses the pack the way a host would: the public header, and a call that needs no device. */
    await writeFile(path.join(dir, 'main.c'), `
#include <rengine/gpu_device.h>
int main(void) {
  /* No loader is needed to prove the seam links: a null device has no memory types. */
  return re_gpu_memory_type(0, 0, 0) == UINT32_MAX ? 0 : 1;
}
`);
    const build = path.join(dir, 'build');
    await run('cmake', ['-S', dir, '-B', build], { maxBuffer: 1 << 24 });
    await run('cmake', ['--build', build], { maxBuffer: 1 << 24 });

    /* The consumer's own binary runs, which means the pack linked and its header was usable. */
    const exe = path.join(build, process.platform === 'win32' ? 'Debug/consumer.exe' : 'consumer');
    await run(exe, [], { maxBuffer: 1 << 20 });

    /* A consumer gets the library and nothing else: no desktop, no tests, no terminal. A pack that
       drags a whole application into someone's build is not a pack.

       Asked of the build system's own target list rather than of CMakeCache.txt — the cache holds
       paths and variables that mention target names for other reasons, so it answers this question
       wrongly and always passes. */
    const { stdout: help } = await run('cmake', ['--build', build, '--target', 'help'], { maxBuffer: 1 << 24 });
    const targets = help.split('\n').filter(line => line.startsWith('... ')).map(line => line.slice(4).trim());
    assert.deepEqual(targets.filter(t => t.startsWith('rengine')), ['rengine_gpu'],
      `the consumer configured the pack's library and no other rEngine target: ${targets.join(', ')}`);

    /* The public surface is these three headers and nothing else: the device layer, the seam's C
       core, and the seam's header-only C++ facade. src/ is private and must not be on the include
       path. Named rather than counted, so adding a fourth is a deliberate edit here — an accidental
       one (an internal header moved to include/ to fix a build) fails instead of widening the
       surface a consumer then depends on. */
    const published = await readdir(path.join(PACK, 'include', 'rengine'));
    assert.deepEqual(published, ['gpu_device.h', 'gpu_seam.h', 'gpu_seam.hpp'],
      `the pack publishes its two layers' headers and no more: ${published}`);
    /* A separate project, so this cannot depend on an incremental build noticing a rewrite. */
    const probe = path.join(dir, 'probe');
    await mkdir(probe, { recursive: true });
    await writeFile(path.join(probe, 'CMakeLists.txt'), `
cmake_minimum_required(VERSION 3.21)
project(probe C)
add_subdirectory("${PACK}" pack)
add_executable(probe main.c)
target_link_libraries(probe PRIVATE rengine::gpu)
`);
    await writeFile(path.join(probe, 'main.c'), `
#include <gpu_device.c>
int main(void) { return 0; }
`);
    const probeBuild = path.join(probe, 'build');
    await run('cmake', ['-S', probe, '-B', probeBuild], { maxBuffer: 1 << 24 });
    await assert.rejects(run('cmake', ['--build', probeBuild], { maxBuffer: 1 << 24 }),
      'the implementation is not reachable through the public include path');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
