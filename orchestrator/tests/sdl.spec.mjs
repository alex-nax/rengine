import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { Surfaces } from '../server/surfaces.mjs';
import { inputPacket } from '../server/surface-protocol.mjs';

test('real SDL/GL surface preserves packing and receives key input/release', { timeout: 20000 }, async t => {
  const surfaces = await new Surfaces().listen();
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
  await waitFor(() => item.latest && item.input);
  assert.equal(item.width, 64); assert.equal(item.height, 32);
  const top = () => [...item.latest.subarray(24 + 64 * 31 * 4, 24 + 64 * 31 * 4 + 4)];
  assert.deepEqual(top(), [255, 0, 0, 255]);
  assert.deepEqual([...item.latest.subarray(24, 28)], [0, 0, 255, 255]);
  item.input.write(inputPacket({ kind: 1, values: [26, 1, 0] }));
  await waitFor(() => top()[1] === 255);
  item.input.write(inputPacket({ kind: 6 }));
  await waitFor(() => top()[0] === 255);
  const result = await exited;
  assert.equal(result[0], 0, logs);
  assert.doesNotMatch(logs, /Pixel-pack state changed/);
});
