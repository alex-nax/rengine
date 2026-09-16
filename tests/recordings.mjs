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
import { askProject } from './project-client.mjs';

const text = value => (value === undefined || value === null ? '' : String(value));

export const listRecordings = (root, options = {}) =>
  askProject(['recordings', root.id, root.path, text(options.limit)]);

export const readRecording = (root, id, options = {}) =>
  askProject(['recording', root.id, root.path, text(id), text(options.artifact),
    text(options.offset), text(options.limit), text(options.maxCharacters)]);
