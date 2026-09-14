/* The contract ceiling, read from the document that declares it.
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
