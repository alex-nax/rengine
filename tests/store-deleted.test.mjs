/* F175/F172 (spec 129): the retired JS modules are gone — store.mjs and schema.mjs (F175),
 * report-session.mjs (F172) — and nothing in the shipping tree imports them. The swaps'
 * criterion — "each ported test was observed failing for the module's absence" — is the full
 * suite running green with these files deleted; this guard is what keeps the absence from
 * quietly reverting, because a new import of a deleted module fails here rather than at the
 * next consumer's runtime.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the retired modules are deleted, and nothing shipping imports them', async () => {
  for (const gone of ['orchestrator/server/store.mjs', 'orchestrator/server/schema.mjs', 'agents/report-session.mjs']) {
    await assert.rejects(() => access(path.join(ROOT, gone)), `${gone} is present again`);
  }
  /* An import reference, not a prose one: comments are allowed to say what the files were. */
  const reference = /(?:import|from|require\()\s*['"](?:\.{1,2}\/)*(?:server\/)?(?:store|schema)\.mjs['"]/;
  const offenders = [];
  /* Every tree that ships JavaScript. `orchestrator/` was the only one when this was written and
     is gone (charter D71); `tests/` is where the surviving .mjs live, and `templates/` ships one
     into a consumer's profile. A directory listed here that does not exist would scandir-throw, and
     one that is MISSING would scan nothing and report nothing — which is the failure this test is
     about, one level up. */
  for (const directory of ['tests', 'templates', 'actions', 'agents']) {
    for (const file of (await readdir(path.join(ROOT, directory), { recursive: true }))
      .filter(name => name.endsWith('.mjs') && !name.includes('node_modules'))) {
      if (['tests/store-client.mjs', 'tests/store-corpus.mjs'].includes(file)) continue;
      const text = await readFile(path.join(ROOT, directory, file), 'utf8');
      for (const [index, line] of text.split('\n').entries()) {
        if (reference.test(line) && !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*')) {
          offenders.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], 'these files import a deleted module');
});
