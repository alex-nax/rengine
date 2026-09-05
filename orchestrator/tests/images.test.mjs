import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../server/main.mjs';
import { MAX_IMAGE_BYTES } from '../server/images.mjs';
import { redImage, blueImage } from './image-fixtures.mjs';

test('image reads authenticate, retain root binding and reject unsupported or oversized data', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-image-api-'));
  const server = await startServer({ stateDir: path.join(directory, 'state') });
  t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
  const roots = [];
  for (const [name, bytes] of [['red', redImage], ['blue', blueImage]]) {
    const folder = path.join(directory, name); await mkdir(folder); await writeFile(path.join(folder, 'same.png'), bytes);
    roots.push(await server.store.addRoot(folder));
  }
  const get = (root, file, authenticated = true) => fetch(`${server.url}/api/image?${new URLSearchParams({ rootId: root.id, path: file })}`, {
    headers: authenticated ? { Authorization: `Bearer ${server.token}` } : {},
  });
  assert.equal((await get(roots[0], 'same.png', false)).status, 401);
  for (const [index, expected] of [[0, redImage], [1, blueImage]]) {
    const response = await get(roots[index], 'same.png');
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
  }
  assert.equal((await get(roots[0], '../blue/same.png')).status, 403);
  await symlink(roots[1].path, path.join(roots[0].path, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await get(roots[0], 'outside/same.png')).status, 403);
  const cases = [
    ['markup.png', Buffer.from('<svg onload="throw 1"></svg>'), 415],
    ['truncated.png', redImage.subarray(0, 12), 415],
    ['large.png', Buffer.alloc(MAX_IMAGE_BYTES + 1), 413],
  ];
  const huge = Buffer.from(redImage); huge.writeUInt32BE(8193, 16); cases.push(['wide.png', huge, 413]);
  const pixels = Buffer.from(redImage); pixels.writeUInt32BE(8192, 16); pixels.writeUInt32BE(8192, 20); cases.push(['pixels.png', pixels, 413]);
  for (const [filename, bytes, status] of cases) {
    await writeFile(path.join(roots[0].path, filename), bytes);
    const response = await get(roots[0], filename);
    assert.equal(response.status, status, filename);
    assert.ok((await response.json()).error);
  }
  assert.deepEqual(await readFile(path.join(roots[0].path, 'same.png')), redImage);
  assert.deepEqual(server.store.state.drafts, {});
});
