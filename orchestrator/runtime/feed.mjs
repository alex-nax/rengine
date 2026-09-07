import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

export const FEED_LIMIT = 1000;
const TYPES = new Set(['token.claimed', 'token.contested', 'token.rejected', 'token.released', 'token.revoked',
  'game.started', 'game.ended', 'device-action.started', 'device-action.ended',
  'capture.started', 'capture.committed', 'workspace.updated']);

export async function writeAtomically(filename, value) {
  const temporary = `${filename}.${process.pid}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value), { mode: 0o600 }); await rename(temporary, filename); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
}

/* One retained ring per project root, beside that root's ledger. Frames are lifecycle only: this
   file never sees a PTY byte, because the only producer that reads the host's stream discards
   everything that is not a session transition (spec 095, decision 7). */
export class Feed {
  constructor(directory, rootId, limit = FEED_LIMIT) {
    this.directory = directory; this.rootId = rootId; this.limit = limit;
    this.file = path.join(directory, 'feed.json');
    this.frames = []; this.sequence = 0; this.listeners = new Set(); this.writing = Promise.resolve();
  }
  static async open(directory, rootId, limit = FEED_LIMIT) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const feed = new Feed(directory, rootId, limit);
    await feed.load();
    return feed;
  }
  async load() {
    let value;
    try { value = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!value || value.version !== 1 || !Array.isArray(value.frames)) return;
    this.frames = value.frames.filter(frame => TYPES.has(frame?.type) && Number.isSafeInteger(frame.sequence)).slice(-this.limit);
    this.sequence = this.frames.length ? this.frames[this.frames.length - 1].sequence : 0;
  }
  /* Sequence continues from the persisted tail, so a replaced worker never rewinds a monitor's
     cursor and never repeats a number a monitor has already seen. */
  emit(type, by, fields = {}) {
    if (!TYPES.has(type)) throw new Error(`Unknown feed frame type ${type}.`);
    const frame = { sequence: ++this.sequence, at: new Date().toISOString(), rootId: this.rootId, type, by, ...fields };
    this.frames.push(frame);
    if (this.frames.length > this.limit) this.frames.splice(0, this.frames.length - this.limit);
    this.persisting = this.writing = this.writing.then(() => writeAtomically(this.file, { version: 1, rootId: this.rootId, frames: this.frames })).catch(() => {});
    for (const listener of this.listeners) { try { listener(frame); } catch { /* one bad monitor never stops the others */ } }
    return frame;
  }
  after(cursor = 0, limit = this.limit) {
    const frames = this.frames.filter(frame => frame.sequence > cursor).slice(0, Math.max(0, limit));
    return { cursor: this.sequence, retainedFrom: this.frames[0]?.sequence ?? this.sequence, frames };
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  drained() { return this.writing; }
}
