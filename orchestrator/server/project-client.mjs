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

   `environment` is for the one question that RUNS a project's own command: a preview's producer saw
   `shellEnvironment()` when this module spawned it, and must still. Every other question only reads,
   and inherits this process's own. */
export function askProject(argv, input, environment) {
  return new Promise((resolve, reject) => {
    const child = execFile(projectBinary(), argv, { maxBuffer: 32 * 1024 * 1024, ...(environment ? { env: environment } : {}) }, (error, stdout) => {
      let value;
      try { value = JSON.parse(stdout); } catch { reject(error ?? new Error(`red-project answered nothing for ${argv[0]}`)); return; }
      if (value?.error && value?.status !== undefined) { try { fail(value.error, value.status); } catch (refusal) { reject(refusal); } return; }
      resolve(value);
    });
    child.stdin.end(input ?? '');
  });
}
