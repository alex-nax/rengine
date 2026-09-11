import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// F139 (spec 128, D57): the Rust toolchain and the red/ cargo workspace are first-class citizens
// of the build. This file pins the slice's contract: the toolchain pin, the workspace skeletons,
// the Corrosion pin in cmake.toml, the regenerated CMakeLists, the ctest wiring, the init.sh
// check, and the zero-registry-dependency guarantee that keeps every fetch behind the two pins.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CORROSION_V061 = '1499b14e4906a2890f5cee1547c8848db261753d';

const read = (rel) => readFile(path.join(ROOT, rel), 'utf8');

test('the toolchain is pinned exactly, not to a moving channel', async () => {
  const text = await read('rust-toolchain.toml');
  const channel = text.match(/^channel\s*=\s*"([^"]+)"/m)?.[1];
  assert.ok(channel, 'rust-toolchain.toml declares a channel');
  assert.match(channel, /^\d+\.\d+\.\d+$/, `channel "${channel}" is an exact version, not stable/nightly`);
});

test('the red/ workspace holds the red-core and red-link skeleton crates', async () => {
  const workspace = await read('red/Cargo.toml');
  assert.ok(/\[workspace\]/.test(workspace), 'red/Cargo.toml is a workspace');
  for (const member of ['red-core', 'red-link']) {
    assert.ok(workspace.includes(`"${member}"`), `workspace lists ${member}`);
    const manifest = await read(`red/${member}/Cargo.toml`);
    assert.ok(manifest.includes(`name = "${member}"`), `${member}'s manifest names it`);
    await access(path.join(ROOT, 'red', member, 'src'));
  }
});

test('the skeleton crates fetch nothing: every dependency is a path dependency', async () => {
  for (const member of ['red-core', 'red-link']) {
    const manifest = await read(`red/${member}/Cargo.toml`);
    const deps = manifest.match(/^\[dependencies\]$([^[]*)/m)?.[1] ?? '';
    for (const line of deps.split('\n').filter((l) => /^\w/.test(l))) {
      assert.ok(line.includes('path'), `${member} dependency is not a path dependency: ${line}`);
    }
  }
});

test('Corrosion is pinned by commit in cmake.toml', async () => {
  const toml = await read('cmake.toml');
  assert.ok(/corrosion/i.test(toml), 'cmake.toml mentions Corrosion');
  assert.ok(
    toml.includes(`GIT_TAG ${CORROSION_V061}`),
    'cmake.toml pins Corrosion to v0.6.1 by full commit sha',
  );
});

test('the committed CMakeLists.txt was regenerated with the Rust wiring', async () => {
  const generated = await read('CMakeLists.txt');
  assert.ok(/corrosion/i.test(generated), 'generated CMakeLists.txt carries the Corrosion block');
});

test('both crates have smoke tests wired into ctest', async () => {
  const toml = await read('cmake.toml');
  for (const name of ['rust_red_core', 'rust_red_link']) {
    assert.ok(toml.includes(`add_test(NAME ${name}`), `cmake.toml declares ctest ${name}`);
  }
});

test('init.sh requires cargo and instructs the pinned toolchain, installing nothing', async () => {
  const init = await read('init.sh');
  assert.ok(/command -v cargo/.test(init), 'init.sh checks for cargo');
  assert.ok(/rustup toolchain install/.test(init), 'init.sh prints the toolchain install instruction');
});
