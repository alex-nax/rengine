import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fail } from './store-client.mjs';

/* The committed-segment store the desktop's recorder writes (spec 081). Reading is a pure
   filesystem walk over a project root, so the replaceable workspace worker serves it from its own
   checkout and the capability arrives with a layered update. */
export const RECORDINGS = '.cache/recordings';
export const LIST_LIMIT = 200, LOG_CHARACTERS = 8000, LOG_MAX = 32000, PAGE = 200, PAGE_MAX = 1000;
const MAX_INDEX_BYTES = 16 * 1024 * 1024;
const ID = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/;

const bounded = (value, fallback, low, high) => {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) fail(`Expected a number, not ${JSON.stringify(value)}.`);
  return Math.max(low, Math.min(Math.trunc(number), high));
};
const checkId = id => {
  if (typeof id !== 'string' || !ID.test(id)) fail('A recording id is one directory name minted by the recorder.', 400);
  return id;
};
const at = (root, relative) => path.join(root.path, ...RECORDINGS.split('/'), ...relative.split('/').filter(Boolean));
async function present(root, relative) {
  try { const info = await stat(at(root, relative)); return info.isFile() || info.isDirectory(); }
  catch { return false; }
}
async function readManifest(root, id) {
  let text;
  try { text = await readFile(at(root, `${id}/manifest.json`), 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    if (!(await present(root, id))) return { missing: true };
    return { error: `Recording ${id} has no manifest.json; the commit did not complete.` };
  }
  let value;
  try { value = JSON.parse(text); } catch { return { error: `Recording ${id} has a manifest.json that is not valid JSON.` }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: `Recording ${id} has a manifest.json that is not an object.` };
  if (value.version !== 1) return { error: `Recording ${id} has manifest version ${value.version}; this workspace reads version 1.` };
  return { manifest: value };
}
async function entryOf(root, id, manifest) {
  const base = `${RECORDINGS}/${id}`;
  const index = manifest.video?.index ?? 'keyframes.jsonl', file = manifest.log?.file ?? 'log.jsonl';
  const [frames, listed, log] = await Promise.all([present(root, `${id}/keyframes`), present(root, `${id}/${index}`), present(root, `${id}/${file}`)]);
  return {
    id, kind: manifest.kind ?? 'ring', game: manifest.game ?? '', sessionId: manifest.sessionId ?? '',
    title: manifest.title ?? '', startedAt: manifest.startedAt ?? '', endedAt: manifest.endedAt ?? '',
    durationMs: manifest.durationMs ?? 0, bytes: manifest.bytes ?? 0, path: base,
    artifacts: {
      keyframes: { count: manifest.video?.frames ?? 0, fps: manifest.video?.fps ?? 0,
        width: manifest.video?.width ?? 0, height: manifest.video?.height ?? 0,
        present: frames && listed, directory: `${base}/keyframes`, index: `${base}/${index}` },
      log: { lines: manifest.log?.lines ?? 0, present: log, file: `${base}/${file}` },
      /* Absent audio is declared by the recorder, never inferred here: a reader is told what is
         missing and which tool provides it (spec 081 decision 4). */
      audio: manifest.audio ?? { present: false, reason: 'This manifest predates the audio slot.' },
    },
  };
}
async function jsonl(root, id, file, limitBytes = MAX_INDEX_BYTES) {
  let text;
  try { text = await readFile(at(root, `${id}/${file}`), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return []; throw error; }
  if (text.length > limitBytes) fail(`Recording ${id} has a ${file} above the ${limitBytes}-byte read limit.`, 413);
  return text.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}

export async function listRecordings(root, options = {}) {
  const limit = bounded(options.limit, LIST_LIMIT, 1, LIST_LIMIT);
  let names = [];
  try {
    names = (await readdir(at(root, ''), { withFileTypes: true })).filter(item => item.isDirectory() && ID.test(item.name)).map(item => item.name);
  } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
  names.sort().reverse();   /* the id is a sortable UTC stamp, so this is newest first */
  const shown = names.slice(0, limit);
  const recordings = await Promise.all(shown.map(async id => {
    const read = await readManifest(root, id);
    if (read.manifest) return entryOf(root, id, read.manifest);
    return { id, path: `${RECORDINGS}/${id}`, error: read.error ?? `Recording ${id} is no longer in this project.` };
  }));
  return { rootId: root.id, path: RECORDINGS, truncated: names.length > shown.length, recordings };
}

export async function readRecording(root, id, options = {}) {
  checkId(id);
  const read = await readManifest(root, id);
  if (read.missing) fail(`Unknown recording ${id} in this project.`, 404);
  if (read.error) fail(read.error, 409);
  const manifest = read.manifest, base = `${RECORDINGS}/${id}`;
  const artifact = options.artifact ?? 'all';
  if (!['all', 'manifest', 'log', 'keyframes'].includes(artifact)) fail('artifact must be all, manifest, log or keyframes.');
  const result = { rootId: root.id, id, path: base, manifest, artifacts: (await entryOf(root, id, manifest)).artifacts };
  if (artifact === 'all' || artifact === 'keyframes') {
    const offset = bounded(options.offset, 0, 0, 1000000), limit = bounded(options.limit, PAGE, 1, PAGE_MAX);
    const entries = await jsonl(root, id, manifest.video?.index ?? 'keyframes.jsonl');
    const page = entries.slice(offset, offset + limit);
    result.keyframes = page.map(entry => ({ path: `${base}/${entry.file}`, atMs: entry.atMs, wall: entry.wall, sequence: entry.sequence, bytes: entry.bytes }));
    result.totalKeyframes = entries.length;
    if (offset + page.length < entries.length) result.nextOffset = offset + page.length;
  }
  if (artifact === 'all' || artifact === 'log') {
    const budget = bounded(options.maxCharacters, LOG_CHARACTERS, 1, LOG_MAX);
    const entries = await jsonl(root, id, manifest.log?.file ?? 'log.jsonl');
    const kept = []; let used = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
      used += (entries[i].text ?? '').length + 1;
      if (used > budget && kept.length) break;
      kept.unshift(entries[i]);
      if (used > budget) break;
    }
    result.log = { lines: kept, truncated: kept.length < entries.length, total: entries.length };
  }
  return result;
}
