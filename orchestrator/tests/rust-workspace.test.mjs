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

/* F139 asserted that every dependency was a path dependency, because the skeletons had none and a
 * silent first fetch would have set the policy by accident. F140 brought the first real ones
 * (prost, serde_json), which that feature's own manifest comment anticipated — so the invariant
 * moves to what it was always protecting: nothing enters the tree without a pin a reader can check.
 * Cargo.lock is that pin, recording an exact version and a SHA-256 per crate, and it is committed. */
test('every registry dependency is pinned by version and checksum in a committed Cargo.lock', async () => {
  const lock = await read('red/Cargo.lock');
  const packages = [...lock.matchAll(/^\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"\n(source = "([^"]*)"\n)?(checksum = "([0-9a-f]{64})"\n)?/gm)]
    .map(([, name, version, , source, , checksum]) => ({ name, version, source, checksum }));
  assert.ok(packages.length > 2, `Cargo.lock lists the tree: ${packages.length} package(s)`);
  const local = new Set(['red-core', 'red-link', 'red-agents', 'red-store', 'red-pty']); // F139's skeletons, F148a's registry, F169's store, F176's pty
  const fetched = packages.filter((p) => !local.has(p.name));
  assert.ok(fetched.length > 0, 'there are registry dependencies to check; F140 brought the first');
  for (const { name, version, source, checksum } of fetched) {
    assert.ok(source?.startsWith('registry+'), `${name} comes from a registry, not a git or path source: ${source}`);
    assert.match(version, /^\d+\.\d+/, `${name} is pinned to an exact version`);
    assert.ok(checksum, `${name} ${version} carries a SHA-256 in the lock file`);
  }
  for (const name of local) {
    assert.ok(packages.some((p) => p.name === name && !p.source), `${name} is a path member, not fetched`);
  }
});

/* The contract's own dependency is protoc, which is not a crate and cannot ride Cargo.lock. It is a
 * prerequisite the harness gate refuses to proceed without, so a missing one is a sentence rather
 * than a build failure fifty lines deep in prost-build. */
test('init.sh refuses to pass without protoc, and says how to install it', async () => {
  const init = await read('init.sh');
  assert.match(init, /command -v protoc/, 'init.sh checks for protoc');
  assert.match(init, /brew install protobuf|protobuf-compiler/, 'and names how to install it');
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
