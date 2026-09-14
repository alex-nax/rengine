/* The thin client of red-project's recording reader (F156c, spec 129, KI-107).
 *
 * What left this file is every line that walked the filesystem: the manifests, the artifact
 * composition, the paging and the log budget are `red/red-project/src/recordings.rs` now. What
 * stayed is this module's API, unchanged — `listRecordings`, `readRecording`, `RECORDINGS` and the
 * bounds — because its callers are two hosts and two suites, and a port that renamed anything would
 * be a port that touched all four.
 *
 * The same shape `store-client.mjs` and `pty-client.mjs` took: the answer comes from one
 * implementation, and the module a JavaScript caller imports is the way to ask for it. A refusal
 * arrives as `{error, status}` and is thrown as the same `fail()` the reader used to throw, so a
 * route answers the status it always answered.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail } from './store-client.mjs';

export const RECORDINGS = '.cache/recordings';
export const LIST_LIMIT = 200, LOG_CHARACTERS = 8000, LOG_MAX = 32000, PAGE = 200, PAGE_MAX = 1000;

const project = fileURLToPath(new URL('../..', import.meta.url));
function binary() {
  const declared = process.env.RENGINE_RED_PROJECT;
  if (declared) {
    if (existsSync(declared)) return declared;
    throw new Error(`RENGINE_RED_PROJECT names ${declared}, which does not exist.`);
  }
  for (const profile of ['release', 'debug']) {
    const candidate = path.join(project, 'red/target', profile, 'red-project');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('The red-project binary is required (run: cargo build -p red-project, or set RENGINE_RED_PROJECT).');
}

/* One question, one process. A recording list is opened by a person clicking a tab, so the cost of
   starting a process is paid where a person is already waiting — and the answer is small. */
function ask(argv) {
  return new Promise((resolve, reject) => {
    execFile(binary(), argv, { maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      let value;
      try { value = JSON.parse(stdout); } catch { reject(error ?? new Error(`red-project answered nothing for ${argv[0]}`)); return; }
      if (value?.error) { try { fail(value.error, value.status ?? 400); } catch (refusal) { reject(refusal); } return; }
      resolve(value);
    });
  });
}

const text = value => (value === undefined || value === null ? '' : String(value));

export const listRecordings = (root, options = {}) =>
  ask(['recordings', root.id, root.path, text(options.limit)]);

export const readRecording = (root, id, options = {}) =>
  ask(['recording', root.id, root.path, text(id), text(options.artifact),
    text(options.offset), text(options.limit), text(options.maxCharacters)]);
