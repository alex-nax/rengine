/* A surface listener the SPECS own, for the ones that drive a real producer (spec 142).
 *
 * The workspace's transport is `red-host`'s now. A spec whose subject is the PRODUCER — an SDL/GL
 * game packing pixels, a cooperative fixture greeting on its own — needs something to connect to,
 * and standing up the whole door to watch one game draw would make those specs about the door.
 *
 * So this is the other end of the wire and nothing more: it accepts the greeting, keeps one FRAME
 * and one INPUT socket, decodes frames and lets a spec write input. It is deliberately NOT the
 * door's implementation — the door's is judged against the recorded JavaScript
 * (`surface-protocol-parity.test.mjs`), and a harness that shared code with it could not be used to
 * check it.
 */
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';

const MAGIC = 0x31464752;

export function frameHeader(width, height, sequence) {
  const header = Buffer.alloc(24);
  [MAGIC, width, height, sequence, width * height * 4, 0].forEach((value, index) => header.writeUInt32LE(value, index * 4));
  return header;
}

/* The ranges the format admits, so a spec writing input writes something a game would accept. */
const RANGES = {
  1: [[0, 511], [0, 1], [0, 1]],
  2: [[-32768, 32767], [-32768, 32767], [-32768, 32767], [-32768, 32767]],
  3: [[1, 5], [0, 1], [-32768, 32767], [-32768, 32767]],
  4: [[-1000, 1000], [-1000, 1000]], 5: [[0, 1]], 6: [],
};

export function inputPacket({ kind, values = [] }) {
  const rule = RANGES[kind];
  if (!rule || values.length > rule.length) throw new Error('Unsupported game input.');
  const numbers = rule.map((_, index) => values[index] ?? 0);
  if (numbers.some((value, index) => !Number.isInteger(value) || value < rule[index][0] || value > rule[index][1])) {
    throw new Error('Game input is out of range.');
  }
  const packet = Buffer.alloc(32);
  [kind, ...numbers].forEach((value, index) => packet.writeInt32LE(value, index * 4));
  return packet;
}

/** One reserved surface: `frames` as they arrive, and `write` to send the game input. */
class Item extends EventEmitter {
  constructor(token) { super(); this.token = token; this.frames = []; this.input = null; }
  write(event) {
    if (!this.input) throw new Error('Game input is disconnected.');
    this.input.write(inputPacket(event));
  }
  /** Wait for at least `count` frames, or throw once `timeout` has passed. */
  async waitForFrames(count, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (this.frames.length < count) {
      if (Date.now() > deadline) throw new Error(`only ${this.frames.length} of ${count} frames arrived`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return this.frames;
  }
}

export async function listen() {
  const items = new Map();
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    let header = Buffer.alloc(0);
    const greet = bytes => {
      const newline = bytes.indexOf(10);
      header = Buffer.concat([header, bytes.subarray(0, newline < 0 ? bytes.length : newline)]);
      if (newline < 0) return;
      socket.off('data', greet);
      const match = /^RENGINE\/1 (FRAME|INPUT) ([0-9a-f]{64})$/.exec(header.toString('ascii'));
      const item = match && items.get(match[2]);
      if (!item) { socket.destroy(); return; }
      if (match[1] === 'INPUT') { item.input = socket; item.emit('input'); return; }
      /* Frames: header, then exactly the bytes it declared. */
      let pending = bytes.subarray(newline + 1);
      let metadata = null;
      const consume = chunk => {
        pending = Buffer.concat([pending, chunk]);
        for (;;) {
          if (!metadata) {
            if (pending.length < 24) return;
            const read = index => pending.readUInt32LE(index * 4);
            if (read(0) !== MAGIC) { socket.destroy(); return; }
            metadata = { width: read(1), height: read(2), sequence: read(3), bytes: read(4) };
            pending = pending.subarray(24);
          }
          if (pending.length < metadata.bytes) return;
          item.frames.push({ ...metadata, pixels: pending.subarray(0, metadata.bytes) });
          item.emit('frame', item.frames.at(-1));
          pending = pending.subarray(metadata.bytes);
          metadata = null;
        }
      };
      socket.on('data', consume);
      consume(Buffer.alloc(0));
    };
    socket.on('data', greet);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    reserve() {
      const token = randomBytes(32).toString('hex');
      const item = new Item(token);
      items.set(token, item);
      return { item, env: { RENGINE_SURFACE_PORT: String(server.address().port), RENGINE_SURFACE_TOKEN: token } };
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
