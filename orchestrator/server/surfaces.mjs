import net from 'node:net';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { FrameDecoder, frameHeader, inputPacket } from './surface-protocol.mjs';

export class Surfaces extends EventEmitter {
  constructor() { super(); this.items = new Map(); this.connections = new Set(); }
  async listen() {
    this.server = net.createServer(socket => this.accept(socket));
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
    return this;
  }
  reserve() {
    const token = randomBytes(32).toString('hex');
    const item = { token, viewers: new Set(), frameCount: 0, status: 'Waiting for game', frames: null, input: null };
    this.items.set(token, item);
    return { item, env: { RENGINE_SURFACE_PORT: String(this.server.address().port), RENGINE_SURFACE_TOKEN: token } };
  }
  status(item) {
    item.status = item.frames && item.input ? 'Live' : item.frames ? 'Input disconnected' : 'Video disconnected';
    const message = JSON.stringify({ type: 'surface', status: item.status, frameCount: item.frameCount });
    for (const viewer of item.viewers) if (viewer.readyState === 1) viewer.send(message);
    this.emit('status', item);
  }
  accept(socket) {
    this.connections.add(socket); socket.on('error', () => {});
    socket.once('close', () => this.connections.delete(socket));
    socket.setNoDelay(true); socket.setTimeout(3000, () => socket.destroy());
    let header = Buffer.alloc(0);
    const authenticate = bytes => {
      const newline = bytes.indexOf(10);
      const end = newline < 0 ? bytes.length : newline;
      if (header.length + end > 100) { socket.destroy(); return; }
      header = Buffer.concat([header, bytes.subarray(0, end)]);
      if (newline < 0) return;
      socket.off('data', authenticate);
      const match = /^RENGINE\/1 (FRAME|INPUT) ([0-9a-f]{64})$/.exec(header.toString('ascii'));
      const item = match && this.items.get(match[2]);
      if (!item) { socket.destroy(); return; }
      socket.setTimeout(0);
      const channel = match[1] === 'FRAME' ? 'frames' : 'input';
      if (item[channel]) { socket.destroy(); return; }
      item[channel] = socket;
      socket.once('close', () => { if (item[channel] === socket) { item[channel] = null; this.status(item); } });
      if (channel === 'frames') {
        const decoder = new FrameDecoder(frame => {
          item.frameCount++; item.width = frame.width; item.height = frame.height;
          item.latest = Buffer.concat([frameHeader(frame.width, frame.height, frame.sequence), frame.pixels]);
          for (const viewer of item.viewers) if (viewer.readyState === 1 && viewer.bufferedAmount === 0) viewer.send(item.latest);
          this.emit('frame', item);
        });
        const consume = chunk => { try { decoder.push(chunk); } catch { socket.destroy(); } };
        socket.on('data', consume);
        consume(bytes.subarray(newline + 1));
      } else {
        socket.on('data', () => socket.destroy());
        if (bytes.length > newline + 1) socket.destroy();
      }
      this.status(item);
    };
    socket.on('data', authenticate);
  }
  attach(item, viewer) {
    item.viewers.add(viewer);
    viewer.send(JSON.stringify({ type: 'surface', status: item.status, frameCount: item.frameCount }));
    if (item.latest) viewer.send(item.latest);
    viewer.on('message', (bytes, binary) => {
      try {
        if (binary) throw new Error('Expected game input JSON.');
        const message = JSON.parse(bytes);
        const packet = inputPacket(message);
        if (message.kind === 5 && message.values?.[0] === 1) {
          if (item.owner !== viewer) this.releaseInput(item);
          item.owner = viewer;
        }
        if (item.owner !== viewer) return;
        if (!item.input || item.input.destroyed) throw new Error('Game input is disconnected.');
        if (item.input.writableLength > 8192) { this.releaseInput(item); throw new Error('Game input queue is full; focus the pane again.'); }
        item.input.write(packet);
        if (message.kind === 6 || (message.kind === 5 && !message.values?.[0])) this.releaseInput(item);
      } catch (error) { viewer.send(JSON.stringify({ type: 'error', error: error.message })); }
    });
    viewer.once('close', () => { item.viewers.delete(viewer); if (item.owner === viewer) this.releaseInput(item); });
  }
  releaseInput(item) {
    if (item.input && !item.input.destroyed) item.input.write(inputPacket({ kind: 6 }));
    item.owner = null;
  }
  remove(item) {
    this.items.delete(item.token); this.releaseInput(item);
    item.frames?.destroy(); item.input?.destroy();
    for (const viewer of item.viewers) viewer.close(1000, 'Game session exited');
  }
  async close() {
    for (const item of this.items.values()) this.remove(item);
    for (const socket of this.connections) socket.destroy();
    await new Promise(resolve => this.server.close(resolve));
  }
}
