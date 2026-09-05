const MAGIC = 0x31464752;
export function frameHeader(width, height, sequence) {
  const header = Buffer.alloc(24);
  [MAGIC, width, height, sequence, width * height * 4, 0].forEach((value, index) => header.writeUInt32LE(value, index * 4));
  return header;
}

export class FrameDecoder {
  constructor(emit) { this.emit = emit; this.target = Buffer.alloc(24); this.offset = 0; this.metadata = null; }
  push(chunk) {
    while (chunk.length) {
      const count = Math.min(chunk.length, this.target.length - this.offset);
      chunk.copy(this.target, this.offset, 0, count); this.offset += count; chunk = chunk.subarray(count);
      if (this.offset !== this.target.length) continue;
      if (!this.metadata) {
        const [magic, width, height, sequence, bytes, flags] = Array.from({ length: 6 }, (_, index) => this.target.readUInt32LE(index * 4));
        if (magic !== MAGIC || width < 1 || width > 1920 || height < 1 || height > 1080 || bytes !== width * height * 4 || flags !== 0) throw new Error('Invalid game frame header.');
        this.metadata = { width, height, sequence };
        this.target = Buffer.allocUnsafe(bytes);
      } else {
        this.emit({ ...this.metadata, pixels: this.target });
        this.metadata = null; this.target = Buffer.alloc(24);
      }
      this.offset = 0;
    }
  }
}

export function inputPacket({ kind, values = [] }) {
  const ranges = {
    1: [[0, 511], [0, 1], [0, 1]],
    2: [[-32768, 32767], [-32768, 32767], [-32768, 32767], [-32768, 32767]],
    3: [[1, 5], [0, 1], [-32768, 32767], [-32768, 32767]],
    4: [[-1000, 1000], [-1000, 1000]], 5: [[0, 1]], 6: [],
  };
  const rule = ranges[kind];
  if (!Number.isInteger(kind) || !rule || !Array.isArray(values) || values.length > rule.length) throw new Error('Unsupported game input.');
  const numbers = rule.map((range, index) => values[index] ?? 0);
  if (numbers.some((value, index) => !Number.isInteger(value) || value < rule[index][0] || value > rule[index][1])) throw new Error('Game input is out of range.');
  const packet = Buffer.alloc(32);
  [kind, ...numbers].forEach((value, index) => packet.writeInt32LE(value, index * 4));
  return packet;
}
