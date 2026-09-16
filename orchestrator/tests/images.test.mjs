import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from './red-host-fixture.mjs';
/* The limit the route enforces (red-host's `images.rs`), named here because this spec's whole job
   is to drive a file one byte past it. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
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
  /* Each refusal in its own words, which is how a viewer tells "this is not an image" from "this is
     an image too big to draw" — and which pins that the header is READ rather than the extension
     trusted: markup named .png is refused for its signature, a PNG truncated before its size is
     refused for its header, and a PNG that claims 8,193 pixels is refused for what it claims. */
  const cases = [
    ['markup.png', Buffer.from('<svg onload="throw 1"></svg>'), 415, 'Preview supports PNG, JPEG, GIF and WebP image data.'],
    ['truncated.png', redImage.subarray(0, 12), 415, 'Image header is invalid or unsupported.'],
    ['large.png', Buffer.alloc(MAX_IMAGE_BYTES + 1), 413, 'Image previews support regular files up to 8 MiB.'],
  ];
  const huge = Buffer.from(redImage); huge.writeUInt32BE(8193, 16);
  cases.push(['wide.png', huge, 413, 'Image preview exceeds the 8,192-pixel dimension or 16-megapixel limit.']);
  const pixels = Buffer.from(redImage); pixels.writeUInt32BE(8192, 16); pixels.writeUInt32BE(8192, 20);
  cases.push(['pixels.png', pixels, 413, 'Image preview exceeds the 8,192-pixel dimension or 16-megapixel limit.']);
  for (const [filename, bytes, status, said] of cases) {
    await writeFile(path.join(roots[0].path, filename), bytes);
    const response = await get(roots[0], filename);
    assert.equal(response.status, status, filename);
    assert.equal((await response.json()).error, said, filename);
  }
  assert.deepEqual(await readFile(path.join(roots[0].path, 'same.png')), redImage);
  /* `/api/state` lists drafts, where the JS host's internal store keyed them. Both say
     'none'; the wire shape is the one a client has always seen. */
  assert.deepEqual((await server.state()).drafts, []);
});
