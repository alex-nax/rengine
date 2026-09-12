import { open, stat } from 'node:fs/promises';
import { imageDimensionsFromData } from 'image-dimensions';
import { fail } from './store-client.mjs';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const mimeTypes = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

export async function readImage(store, rootId, relative) {
  const file = await store.resolve(rootId, relative);
  if (!(await stat(file.absolute)).isFile()) fail('Image previews require a regular file.', 415);
  const handle = await open(file.absolute, 'r');
  let bytes;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_IMAGE_BYTES) fail('Image previews support regular files up to 8 MiB.', 413);
    const buffer = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    if (offset !== info.size) fail('Image changed during the read. Refresh to retry.', 409);
    bytes = buffer.subarray(0, offset);
  } finally { await handle.close(); }
  const signature = bytes.subarray(0, 4).toString('hex');
  const allowed = signature === '89504e47' || signature.startsWith('ffd8ff') || signature.startsWith('47494638')
    || (signature === '52494646' && bytes.subarray(8, 12).toString() === 'WEBP');
  if (!allowed) fail('Preview supports PNG, JPEG, GIF and WebP image data.', 415);
  const dimensions = imageDimensionsFromData(bytes);
  if (!dimensions || !mimeTypes[dimensions.type]) fail('Image header is invalid or unsupported.', 415);
  const { width, height } = dimensions;
  if (![width, height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 8192) || width * height > 16777216) {
    fail('Image preview exceeds the 8,192-pixel dimension or 16-megapixel limit.', 413);
  }
  return { bytes, mime: mimeTypes[dimensions.type], width, height };
}
