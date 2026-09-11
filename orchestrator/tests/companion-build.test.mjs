/* F144's first slice: the companion is pinned, and it compiles the desktop's C from one origin.
 *
 * The property worth a test is not "the app builds" — that needs an SDK, an NDK and a device, and
 * it is checked by building it. It is that the app cannot quietly stop being the same code as the
 * desktop. Decision 10 put the app in this repository for exactly one reason: the shared C modules
 * cannot be "shared with iOS later" across a pin boundary while they are churning. A copied
 * microui under apps/ would satisfy every build and defeat the whole arrangement, so that is what
 * this looks for.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const read = async p => readFile(path.join(ROOT, p), 'utf8');

test('the companion compiles the desktop C modules from their place in this repository', async () => {
  const cmake = await read('apps/companion/app/src/main/cpp/CMakeLists.txt');
  /* Two of the paths end in a CMake variable — which host and which seam backend this build carries
     is chosen by RE_COMPANION_BACKEND (charter D59). Those are resolved to every value the file
     offers, so both arms are checked rather than only the default one. */
  const backends = [...cmake.matchAll(/set\(RE_COMPANION_HOST "([^"]+)"\)/g)].map(m => m[1]);
  assert.ok(backends.length >= 2, `the build offers a host per graphics API: ${backends.join(', ')}`);
  const raw = [...cmake.matchAll(/\$\{RE_ROOT\}\/([^"\s)]+)/g)].map(m => m[1]);
  const shared = raw.flatMap(source => source.includes('${RE_COMPANION_HOST}')
    ? backends.map(host => source.replace('${RE_COMPANION_HOST}', host))
    : [source]).filter(source => !source.includes('${'));
  assert.ok(shared.length >= 4, `the native build reaches into the repository: ${shared.join(', ')}`);
  for (const source of shared) {
    assert.ok(existsSync(path.join(ROOT, source)), `${source} is where the companion expects it`);
  }
  assert.ok(shared.includes('third_party/microui/microui.c'), 'microui comes from the pinned upstream copy');
  assert.ok(shared.includes('orchestrator/native/render/draw_list.c'), 'the draw list is the desktop\'s own');

  /* The build refuses rather than falling back when the tree moves, because a native build that
     silently compiles nothing shared is the failure this whole arrangement is against. */
  assert.match(cmake, /FATAL_ERROR/, 'a missing origin is refused by name');
});

test('no C module is copied under apps/ — the app has one origin, not two', async () => {
  const walk = async dir => {
    const out = [];
    for (const entry of await readdir(path.join(ROOT, dir), { withFileTypes: true })) {
      if (entry.name === 'build' || entry.name === '.gradle' || entry.name === '.cxx') continue;
      const next = `${dir}/${entry.name}`;
      out.push(...(entry.isDirectory() ? await walk(next) : [next]));
    }
    return out;
  };
  const files = await walk('apps/companion');
  const carried = files.filter(f => /\.(c|h)$/.test(f));
  /* companion.c is the app's own entry point and belongs here; anything else with a twin in the
     desktop tree would be a fork. */
  for (const file of carried) {
    const name = path.basename(file);
    assert.equal(name, 'companion.c', `apps/ carries a C module of its own: ${file}`);
  }
});

test('the Gradle wrapper, AGP, the NDK and the SDK levels are all pinned exactly', async () => {
  const wrapper = await read('apps/companion/gradle/wrapper/gradle-wrapper.properties');
  assert.match(wrapper, /gradle-\d+\.\d+(\.\d+)?-bin\.zip/, 'the wrapper names an exact Gradle');
  assert.match(wrapper, /distributionSha256Sum=[0-9a-f]{64}/,
    'and verifies the distribution before running it, as third_party/sources.json does for an archive');

  const root = await read('apps/companion/build.gradle.kts');
  assert.match(root, /com\.android\.application"\) version "\d+\.\d+\.\d+"/, 'AGP is pinned exactly');
  assert.match(root, /kotlin\.android"\) version "\d+\.\d+\.\d+"/, 'the Kotlin plugin is pinned exactly');

  const app = await read('apps/companion/app/build.gradle.kts');
  assert.match(app, /ndkVersion = "\d+\.\d+\.\d+"/, 'the NDK is pinned exactly, not to a floating major');
  assert.match(app, /compileSdk = \d+/, 'compileSdk is stated');
  assert.match(app, /minSdk = \d+/, 'minSdk is stated');
  assert.match(app, /version = "\d+\.\d+\.\d+"/, 'the CMake the NDK uses is pinned too');
});

test('init.sh says what is missing for the companion without gating the desktop on it', async () => {
  const init = await read('init.sh');
  assert.match(init, /ndkVersion/, 'init.sh reads the NDK pin from the build rather than repeating it');
  assert.match(init, /sdkmanager/, 'and names how to install it');
  /* Deliberately a NOTE, not an ERROR: the desktop build does not need an Android toolchain, and a
     fatal check here would gate every contributor's harness on a mobile SDK. */
  assert.match(init, /NOTE: the pinned Android NDK/, 'reported, not fatal');
});
