import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Segment fixtures shaped exactly as the desktop's recorder writes them (spec 081): a manifest, a
// JSONL keyframe index, one JPEG per kept frame and a JSONL log slice, all on one clock.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);
const iso = ms => new Date(ms).toISOString();

export function manifest(id, { frames = 3, lines = 2, kind = 'ring', start = Date.UTC(2026, 8, 6, 20, 45, 12, 340), fps = 10, ...rest } = {}) {
  const step = Math.round(1000 / fps), duration = frames ? (frames - 1) * step : 0;
  return {
    version: 1, id, kind, rootId: 'fixture-root', sessionId: 'fixture-session', game: 'fixture-game',
    title: 'Fixture game · fixture', createdAt: iso(start + duration + 40),
    startedAt: iso(start), endedAt: iso(start + duration), durationMs: duration,
    clock: { unit: 'ms', field: 'atMs', origin: 'startedAt', note: 'atMs, sequence and wall are on one clock.' },
    video: { codec: 'jpeg', width: 640, height: 360, fps, quality: 70, frames, bytes: frames * JPEG.length,
      directory: 'keyframes', index: 'keyframes.jsonl' },
    log: { file: 'log.jsonl', lines, bytes: lines * 64 },
    audio: { present: false, provider: 'capture-mcp', reason: 'The game audio never passes through the workspace (KI-044).', issue: 'KI-044' },
    ring: { seconds: 120, bytes: 67108864, fps, width: 640, quality: 70, requestedSeconds: 120, truncated: false, droppedFrames: 0 },
    bytes: frames * JPEG.length + lines * 64, ...rest,
  };
}

export async function segment(root, id, options = {}) {
  const directory = path.join(root, '.cache/recordings', id);
  await mkdir(path.join(directory, 'keyframes'), { recursive: true });
  const document = options.manifest ?? manifest(id, options);
  const frames = document.video?.frames ?? 0, lines = document.log?.lines ?? 0;
  const start = Date.parse(document.startedAt), step = Math.round(1000 / (document.video?.fps ?? 10));
  const index = [];
  for (let i = 0; i < frames; i++) {
    const file = `keyframes/${String(i + 1).padStart(6, '0')}.jpg`;
    await writeFile(path.join(directory, file), JPEG);
    index.push({ file, atMs: i * step, wall: iso(start + i * step), sequence: 41233 + i, bytes: JPEG.length });
  }
  await writeFile(path.join(directory, 'keyframes.jsonl'), index.map(entry => JSON.stringify(entry)).join('\n') + (index.length ? '\n' : ''));
  const log = Array.from({ length: lines }, (_, i) => JSON.stringify({ atMs: i * 37, wall: iso(start + i * 37), text: `fixture log line ${i}` }));
  await writeFile(path.join(directory, 'log.jsonl'), log.join('\n') + (log.length ? '\n' : ''));
  if (options.malformed) await writeFile(path.join(directory, 'manifest.json'), '{ not json');
  else if (!options.incomplete) await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(document, null, 2));
  return { directory, manifest: document, index };
}
