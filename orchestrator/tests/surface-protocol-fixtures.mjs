/* The answers `server/surface-protocol.mjs` gave, frozen before it was deleted (spec 142).
 *
 * The same device F173 used for the agent registry and F172 for the hook reporter: a parity proof
 * cannot outlive the side it compares against, so the module's own answers are recorded while it is
 * still here and the Rust side is judged against the record afterwards.
 *
 * **Regenerate ONLY from a checkout where `surface-protocol.mjs` still exists** — that is, never
 * again after the deletion commit. The file is the evidence, and a regenerated one would be judging
 * the replacement against itself.
 *
 *   node orchestrator/tests/surface-protocol-fixtures.mjs > orchestrator/tests/surface-protocol-fixtures.json
 */
import { readFileSync } from 'node:fs';

/* The digest both sides compute: FNV-1a over the pixels. Its only job is to notice that two
   implementations produced different bytes, so a corpus can ask for a megabyte without carrying
   one. */
export function digest(bytes) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return hash.toString(16).padStart(16, '0');
}

export const UUID = 'a'.repeat(64);

/* Built without the module under record, so the corpus itself does not depend on the thing being
   replaced: a header is 24 little-endian bytes and this writes them. */
const MAGIC = 0x31464752;
function header(width, height, sequence) {
  const bytes = Buffer.alloc(24);
  [MAGIC, width, height, sequence, width * height * 4, 0].forEach((value, index) => bytes.writeUInt32LE(value, index * 4));
  return bytes;
}

export const CASES = [
  /* Frames that are frames. The byte-at-a-time split is the case a streaming decoder exists for,
     and two frames in one chunk is where a decoder that resets wrongly loses the second. */
  ['one small frame, whole', { case: 'frame', width: 2, height: 1, sequence: 7, pixels: 8 }],
  ['one small frame, a byte at a time', { case: 'frame', width: 2, height: 1, sequence: 7, pixels: 8, split: 1 }],
  ['one small frame, split across the header', { case: 'frame', width: 4, height: 2, sequence: 3, pixels: 32, split: 13 }],
  ['a frame at the format\'s largest dimensions', { case: 'frame', width: 1920, height: 1080, sequence: 1, pixels: 1920 * 1080 * 4, split: 65536 }],
  ['a one-pixel frame', { case: 'frame', width: 1, height: 1, sequence: 0, pixels: 4 }],
  ['a header with no pixels yet is no frame at all', { case: 'frame', width: 2, height: 1, sequence: 1, pixels: 0 }],
  ['nothing at all', { case: 'frame', chunks: [] }],

  /* Every bound in the header, each on its own, because each is a refusal the JS makes.

     The dimension cases come in PAIRS, and the second of each pair is the one that counts. An
     override writes the field and leaves the byte count saying what the ORIGINAL dimensions gave,
     so `bytes != width * height * 4` refuses it first and the dimension bound is never reached:
     dropping the width bound entirely left this suite green until these were added. The second of
     each pair builds the header from the bad dimension, so its byte count AGREES and only the bound
     can refuse it. That is the control masking the thing under test. */
  ['a header whose magic is wrong', { case: 'frame', width: 2, height: 1, pixels: 8, header: { 0: 0 } }],
  ['a width past the format', { case: 'frame', width: 2, height: 1, pixels: 8, header: { 1: 50000 } }],
  ['a width of zero', { case: 'frame', width: 2, height: 1, pixels: 8, header: { 1: 0 } }],
  ['a height of zero', { case: 'frame', width: 2, height: 1, pixels: 8, header: { 2: 0 } }],
  ['a height past the format', { case: 'frame', width: 2, height: 1, pixels: 8, header: { 2: 2000 } }],
  ['a byte count that is not the dimensions', { case: 'frame', width: 2, height: 1, pixels: 8, header: { 4: 4 } }],
  ['a byte count that would allocate four gigabytes', { case: 'frame', width: 2, height: 1, pixels: 8, header: { 4: 0xffffffff } }],
  ['a flag this format does not have', { case: 'frame', width: 2, height: 1, pixels: 8, header: { 5: 1 } }],
  ['a refusal mid-stream, after a good frame', { case: 'frame',
    chunks: [header(1, 1, 1).toString('hex') + '00000000', header(1, 1, 2).toString('hex').replace(/^.{8}/, '00000000')] }],
  ['a width one past the format, its byte count agreeing', { case: 'frame', width: 1921, height: 1, sequence: 1, pixels: 0 }],
  ['a height one past the format, its byte count agreeing', { case: 'frame', width: 1, height: 1081, sequence: 1, pixels: 0 }],
  ['a width of zero, its byte count agreeing', { case: 'frame', width: 0, height: 1, sequence: 1, pixels: 0 }],
  ['a height of zero, its byte count agreeing', { case: 'frame', width: 1, height: 0, sequence: 1, pixels: 0 }],
  ['the largest width the format admits', { case: 'frame', width: 1920, height: 1, sequence: 1, pixels: 1920 * 4 }],
  ['the largest height the format admits', { case: 'frame', width: 1, height: 1080, sequence: 1, pixels: 1080 * 4 }],

  /* Input: one case per kind, the edges of each range, and the ways a caller gets it wrong. */
  ['a key down', { case: 'input', kind: 1, values: [26, 1, 0] }],
  ['a key with its trailing values omitted', { case: 'input', kind: 1, values: [26] }],
  ['a key at the top of its range', { case: 'input', kind: 1, values: [511, 1, 1] }],
  ['a key past the top of its range', { case: 'input', kind: 1, values: [512, 1, 1] }],
  ['a key with a bad value in a LATER slot', { case: 'input', kind: 1, values: [4, 7] }],
  ['a motion event at both extremes', { case: 'input', kind: 2, values: [-32768, 32767, -32768, 32767] }],
  ['a motion event past an extreme', { case: 'input', kind: 2, values: [-32769, 0, 0, 0] }],
  ['a button', { case: 'input', kind: 3, values: [5, 1, 0, 0] }],
  ['a button this format does not have', { case: 'input', kind: 3, values: [50, 1, 0, 0] }],
  ['a button numbered zero', { case: 'input', kind: 3, values: [0, 1, 0, 0] }],
  ['a wheel', { case: 'input', kind: 4, values: [-1000, 1000] }],
  ['focus gained', { case: 'input', kind: 5, values: [1] }],
  ['focus lost', { case: 'input', kind: 5, values: [0] }],
  ['a release, which carries nothing', { case: 'input', kind: 6, values: [] }],
  ['a release handed a value anyway', { case: 'input', kind: 6, values: [1] }],
  ['a kind this format does not have', { case: 'input', kind: 99, values: [] }],
  ['kind zero', { case: 'input', kind: 0, values: [] }],
  ['a negative kind', { case: 'input', kind: -1, values: [] }],
  ['more values than the kind admits', { case: 'input', kind: 5, values: [0, 0] }],
  ['a value that is not a whole number', { case: 'input', kind: 2, values: [1.5, 0, 0, 0] }],

  /* The greeting, which is the one line a producer sends before anything else. */
  ['a frame producer', { case: 'greeting', line: `RENGINE/1 FRAME ${UUID}` }],
  ['an input producer', { case: 'greeting', line: `RENGINE/1 INPUT ${UUID}` }],
  ['a channel this door does not serve', { case: 'greeting', line: `RENGINE/1 VIDEO ${UUID}` }],
  ['a version this door does not speak', { case: 'greeting', line: `RENGINE/2 FRAME ${UUID}` }],
  ['a token a character short', { case: 'greeting', line: `RENGINE/1 FRAME ${'a'.repeat(63)}` }],
  ['a token in capitals', { case: 'greeting', line: `RENGINE/1 FRAME ${'A'.repeat(64)}` }],
  ['a token that is not hex', { case: 'greeting', line: `RENGINE/1 FRAME ${'g'.repeat(64)}` }],
  ['an empty line', { case: 'greeting', line: '' }],
];

export function stream(kase, frameHeader) {
  if (kase.chunks) return kase.chunks.map(hex => Buffer.from(hex, 'hex'));
  /* Written into a preallocated buffer rather than built through an Array: the largest frame the
     format admits is 8 MB, and Array.from over it dominated this spec's runtime. */
  const filler = Buffer.allocUnsafe(kase.pixels ?? 0);
  for (let at = 0; at < filler.length; at++) filler[at] = at % 251;
  const bytes = Buffer.concat([frameHeader(kase.width ?? 0, kase.height ?? 0, kase.sequence ?? 0), filler]);
  for (const [index, value] of Object.entries(kase.header ?? {})) bytes.writeUInt32LE(value, Number(index) * 4);
  const split = kase.split ?? Math.max(bytes.length, 1);
  const chunks = [];
  for (let at = 0; at < bytes.length; at += split) chunks.push(bytes.subarray(at, at + split));
  return chunks.length ? chunks : [Buffer.alloc(0)];
}

/** One case, answered by the module under record, in the shape `red-surface` answers in. */
export function record(kase, { FrameDecoder, frameHeader, inputPacket }) {
  try {
    if (kase.case === 'frame') {
      const frames = [];
      const decoder = new FrameDecoder(frame => frames.push(frame));
      for (const chunk of stream(kase, frameHeader)) decoder.push(chunk);
      return { frames: frames.map(frame => ({ width: frame.width, height: frame.height, sequence: frame.sequence,
        bytes: frame.pixels.length, digest: digest(frame.pixels) })) };
    }
    if (kase.case === 'input') return { packet: inputPacket({ kind: kase.kind, values: kase.values }).toString('hex') };
    if (kase.case === 'greeting') {
      const match = /^RENGINE\/1 (FRAME|INPUT) ([0-9a-f]{64})$/.exec(kase.line ?? '');
      if (!match) return { refused: 'not a greeting' };
      return { channel: match[1] === 'FRAME' ? 'frames' : 'input', token: match[2] };
    }
    return { refused: `unknown case ${kase.case}` };
  } catch (error) { return { refused: error.message }; }
}

export const RECORDED = (() => {
  try { return JSON.parse(readFileSync(new URL('./surface-protocol-fixtures.json', import.meta.url), 'utf8')); }
  catch { return null; }
})();

if (process.argv[1] && process.argv[1].endsWith('surface-protocol-fixtures.mjs')) {
  const module = await import('../server/surface-protocol.mjs');
  const answers = {};
  for (const [title, kase] of CASES) answers[title] = record(kase, module);
  process.stdout.write(`${JSON.stringify(answers, null, 2)}\n`);
}
