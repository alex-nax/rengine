import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameDecoder, frameHeader, inputPacket } from '../server/surface-protocol.mjs';

test('frame receiver handles fragmented packets and rejects oversized or inconsistent allocation requests', () => {
  const frames = [];
  const decoder = new FrameDecoder(frame => frames.push(frame));
  const header = frameHeader(2, 1, 7);
  const pixels = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255]);
  const packet = Buffer.concat([header, pixels, frameHeader(1, 1, 8), pixels.subarray(0, 4)]);
  for (const byte of packet) decoder.push(Buffer.from([byte]));
  assert.equal(frames.length, 2);
  assert.equal(frames[0].sequence, 7);
  assert.deepEqual(frames[0].pixels, pixels);
  assert.equal(frames[1].pixels.length, 4);
  for (const mutate of [buffer => buffer.writeUInt32LE(0, 0), buffer => buffer.writeUInt32LE(50000, 4),
    buffer => buffer.writeUInt32LE(0, 8), buffer => buffer.writeUInt32LE(0xffffffff, 16), buffer => buffer.writeUInt32LE(1, 20)]) {
    const invalid = frameHeader(2, 1, 1); mutate(invalid);
    assert.throws(() => new FrameDecoder(() => assert.fail('invalid frame emitted')).push(invalid));
  }
});

test('input packets validate supported controls before native delivery', () => {
  const packet = inputPacket({ kind: 1, values: [26, 1, 0] });
  assert.equal(packet.length, 32);
  assert.equal(packet.readInt32LE(4), 26);
  for (const event of [{ kind: 99 }, { kind: 1, values: [99999, 1] }, { kind: 1, values: [4, 7] },
    { kind: 2, values: [NaN, 2, 0, 0] }, { kind: 3, values: [50, 1, 0, 0] }]) assert.throws(() => inputPacket(event));
});
