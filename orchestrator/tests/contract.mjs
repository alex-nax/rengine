/* The contract ceiling, read from the document that declares it, and the two facts about a format
 * that specs used to import from the shipping module.
 *
 * `formats.mjs` used to export a hand-written copy of this list, which was a third one: the schema
 * enumerates the contracts, `red-project` holds a constant checked against the schema, and that copy
 * existed only so seven specs could say "one above the ceiling". It went with the declaration reader
 * (F156b, cleaned up 2026-09-14); this reads the enum instead, so a contract added to the document
 * moves every spec that asks about the ceiling without anyone remembering to.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const schema = JSON.parse(await readFile(path.join(ROOT, 'contracts/project-v1.schema.json'), 'utf8'));

export const CONTRACTS = schema.properties.contract.enum;

/** The cap `red_project::preview::MAX_RAW_WINDOW` states. A copy that drifted would turn the spec
    asserting the cap RED, which is why a copy is safe here and the glob below says more. */
export const MAX_RAW_WINDOW = 64 * 1024;

/* Which format a file's name is matched to is `red_project::preview::match_format` now. This is a
   reader's copy for specs that ask what a SHIPPED declaration matches — `contracts.test.mjs` — and
   it is pinned to the real one only by `preview-parity.test.mjs`, which judges the Rust against the
   recorded answers. The rule itself is tested there and in red-project's own unit tests; do not add
   rule cases here, where a drifted copy would agree with itself. */
const globToRegExp = glob => {
  const source = glob.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\[!/g, '[^');
  try { return new RegExp(`^${source}$`, 'i'); } catch { return new RegExp(`^${glob.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'); }
};
export const matchFormat = (formats, name) => {
  const base = path.posix.basename(name);
  return formats.find(format => format.match.some(glob => globToRegExp(glob).test(base))) ?? null;
};
