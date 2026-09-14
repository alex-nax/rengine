/* The thin client of the red-project binary (F156, spec 129, KI-107).
 *
 * What a project declares about itself and what it leaves behind are one implementation now, in
 * `red/red-project/`, and this is how a JavaScript caller asks it. The same shape `store-client.mjs`
 * and `pty-client.mjs` took: the answer comes from Rust, the module a caller imports is unchanged,
 * and a refusal arrives as `{error, status}` and is thrown as the same `fail()` the module it
 * replaced threw — so a route answers the status it always answered.
 *
 * One question, one process. These are questions a person asks by opening a tab or a project, not
 * a hot path, and the answers are small.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail } from './store-client.mjs';

const project = fileURLToPath(new URL('../..', import.meta.url));

export function projectBinary(env = process.env) {
  const declared = env.RENGINE_RED_PROJECT;
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

/* `input`, when given, is written to the binary's stdin and the question takes no argument: the
   subjects that are not paths — an env object a caller proposes, a preview request — are arbitrary
   caller input, and argv has a length a caller could reach.

   The buffer is large because a TREE preview is bounded at 200,000 nodes, and a project whose paths
   are long serialises past 32 MiB — where this rejected with `maxBuffer length exceeded` instead of
   answering, which the in-process JavaScript never did. The real ceiling is the node count.

   The binary inherits THIS process's environment, which is what every question is answered against.
   A question that runs a project's own command composes the shell environment at the spawn, where
   `runCommand` composed it, so both halves of an availability check read one PATH. */
export function askProject(argv, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(projectBinary(), argv, { maxBuffer: 256 * 1024 * 1024 }, (error, stdout) => {
      let value;
      try { value = JSON.parse(stdout); } catch { reject(error ?? new Error(`red-project answered nothing for ${argv[0]}`)); return; }
      if (value?.error && value?.status !== undefined) { try { fail(value.error, value.status); } catch (refusal) { reject(refusal); } return; }
      resolve(value);
    });
    child.stdin.end(input ?? '');
  });
}
