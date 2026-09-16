import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
/* The other end of the wire, owned by the specs (spec 142). This spec's subject is the PRODUCER —
   an SDL/GL game packing pixels — and the workspace's transport is red-host's now; standing the
   whole door up to watch one game draw would make this spec about the door. */
import { listen } from './surface-harness.mjs';

test('real SDL/GL surface preserves packing and receives key input/release', { timeout: 20000 }, async t => {
  const surfaces = await listen();
  const { item, env } = surfaces.reserve();
  const directory = path.resolve('.cache/native');
  const child = spawn(path.join(directory, process.platform === 'win32' ? 'Release/rengine_surface_fixture.exe' : 'rengine_surface_fixture'), [], {
    env: { ...process.env, ...env, ...(process.platform === 'darwin' ? { DYLD_INSERT_LIBRARIES: path.join(directory, 'librengine_surface.dylib') } : {}) },
  });
  let logs = ''; child.stdout.on('data', bytes => { logs += bytes; }); child.stderr.on('data', bytes => { logs += bytes; });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited; await surfaces.close(); });
  const waitFor = async predicate => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      assert.ok(child.exitCode === null && child.signalCode === null, `Native producer exited: ${logs}`);
      assert.ok(Date.now() < deadline, `Native surface condition timed out: ${logs}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  await waitFor(() => item.frames.length > 0 && item.input);
  const latest = () => item.frames.at(-1);
  assert.equal(latest().width, 64); assert.equal(latest().height, 32);
  /* The pixels only: the harness hands over the decoded frame, so the 24-byte header is not in it. */
  const top = () => [...latest().pixels.subarray(64 * 31 * 4, 64 * 31 * 4 + 4)];
  assert.deepEqual(top(), [255, 0, 0, 255]);
  assert.deepEqual([...latest().pixels.subarray(0, 4)], [0, 0, 255, 255]);
  item.write({ kind: 1, values: [26, 1, 0] });
  await waitFor(() => top()[1] === 255);
  item.write({ kind: 6 });
  await waitFor(() => top()[0] === 255);
  const result = await exited;
  assert.equal(result[0], 0, logs);
  assert.doesNotMatch(logs, /Pixel-pack state changed/);
});
