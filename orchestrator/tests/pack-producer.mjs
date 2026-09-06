// Fixture producer for the project format registry tests: a "pack" is `PACK\0` followed by a JSON
// manifest { entries: { "dir/name": "text" | { base64 } }, fail?, sleep?, bloat? }. It answers the
// same three verbs a real project executable would, with deliberate misbehaviour on request.
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const [verb, file, entry] = process.argv.slice(2);
const bytes = readFileSync(file);
if (bytes.subarray(0, 5).toString('latin1') !== 'PACK\0') { process.stderr.write(`pack: not a pack file: ${file}\n`); process.exit(3); }
const manifest = JSON.parse(bytes.subarray(5).toString('utf8'));
if (manifest.sleep) await delay(manifest.sleep);
if (manifest.fail) { process.stderr.write(`${manifest.fail}\nsecond diagnostic line\n`); process.exit(2); }
if (manifest.bloat) { process.stdout.write(Buffer.alloc(manifest.bloat, 65)); process.exit(0); }
const data = name => { const value = manifest.entries[name]; return typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value.base64, 'base64'); };
if (verb === 'tree') {
  const root = { archive: file, dir: '', name: '', dirs: [], files: [] };
  for (const name of Object.keys(manifest.entries).sort()) {
    let node = root; const parts = name.split('/');
    for (const part of parts.slice(0, -1)) {
      let next = node.dirs.find(x => x.name === part);
      if (!next) { next = { name: part, dirs: [], files: [] }; node.dirs.push(next); }
      node = next;
    }
    node.files.push({ name: parts.at(-1), path: name, size: data(name).length, offset: 42, time: 0, type: 'FIX' });
  }
  process.stdout.write(JSON.stringify(root));
} else if (verb === 'text') {
  process.stdout.write(Object.keys(manifest.entries).map(name => `${name}\t${data(name).length}`).join('\n') + '\n');
} else if (verb === 'cat') {
  if (!(entry in manifest.entries)) { process.stderr.write(`pack: no such entry: ${entry}\n`); process.exit(1); }
  process.stdout.write(data(entry));
} else { process.stderr.write(`pack: unknown verb ${verb}\n`); process.exit(2); }
