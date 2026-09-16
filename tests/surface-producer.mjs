// Fixture cooperative game (spec 078): a process whose own code speaks the surface protocol, so the
// suite proves `surface: "cooperative"` without any consumer binary. It reads the two variables,
// greets RENGINE/1 FRAME and RENGINE/1 INPUT itself and streams frames through the server's own
// encoder; nothing is injected into it, which is the whole point of the value.
// --frames N sends N frames and exits; the default streams until it is stopped.
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
/* Its OWN encoder, not the workspace's: `surface: "cooperative"` means a game whose own code speaks
   the protocol, so a fixture that imported rEngine's encoder would be proving less than the value
   claims. Twenty-four little-endian bytes (spec 142). */
const MAGIC = 0x31464752;
const frameHeader = (width, height, sequence) => {
  const header = Buffer.alloc(24);
  [MAGIC, width, height, sequence, width * height * 4, 0].forEach((value, index) => header.writeUInt32LE(value, index * 4));
  return header;
};

const argv = process.argv.slice(2);
const option = (name, fallback) => { const at = argv.indexOf(name); return at < 0 ? fallback : Number(argv[at + 1]); };
const port = Number(process.env.RENGINE_SURFACE_PORT), token = process.env.RENGINE_SURFACE_TOKEN ?? '';
const width = option('--width', 8), height = option('--height', 4), count = option('--frames', 0);

/* The line every launch assertion reads: argv, the declared env, the working directory, the surface
   variables, and every injection variable this process was actually handed. On macOS dyld purges
   DYLD_* before a protected interpreter sees them, so this is corroboration; the load-bearing
   regression asserts on the environment rEngine composes. */
const injected = Object.keys(process.env).filter(key => /^(?:DYLD_|LD_)/.test(key)).sort();
process.stdout.write(`COOPERATIVE_STARTED args=${argv.join(' ')} flavour=${process.env.FIXTURE_FLAVOUR ?? 'unset'}`
  + ` cwd=${process.cwd()} port=${process.env.RENGINE_SURFACE_PORT ?? 'unset'} token=${token.length}`
  + ` inject=${injected.length ? injected.join(',') : 'none'}\n`);
if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[0-9a-f]{64}$/.test(token)) {
  process.stderr.write('cooperative: no usable RENGINE_SURFACE_PORT/RENGINE_SURFACE_TOKEN\n');
  process.exit(2);
}

const greet = channel => new Promise((resolve, reject) => {
  const socket = net.connect(port, '127.0.0.1', () => { socket.write(`RENGINE/1 ${channel} ${token}\n`); resolve(socket); });
  socket.setNoDelay(true);
  socket.once('error', reject);
});
const frames = await greet('FRAME'), input = await greet('INPUT');
let running = true;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { running = false; });
frames.once('close', () => { running = false; });
input.on('data', bytes => {
  for (let at = 0; at + 32 <= bytes.length; at += 32) process.stdout.write(`COOPERATIVE_INPUT ${bytes.readInt32LE(at)}\n`);
});

const pixels = Buffer.alloc(width * height * 4);
let sequence = 0;
while (running && (count === 0 || sequence < count)) {
  const shade = 40 + ((sequence * 37) % 200);
  for (let at = 0; at < pixels.length; at += 4) pixels.set([shade, 0x20, 0xc0, 0xff], at);
  /* Bottom row first, the orientation a glReadPixels-shaped producer sends. */
  frames.write(Buffer.concat([frameHeader(width, height, ++sequence), pixels]));
  process.stdout.write(`COOPERATIVE_FRAME ${sequence}\n`);
  await delay(50);
}
await new Promise(resolve => frames.end(resolve));
input.destroy();
