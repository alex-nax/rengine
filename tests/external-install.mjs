/* The external installer, as a spec runs it (spec 146).
 *
 * It was `installExternalProject` from a module; it is `red-project install-external`. One place
 * knows that, so a spec asserting about a profile is not also asserting about how the installer is
 * started — and so the switch was one edit rather than two.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const projectBinary = () => process.env.RENGINE_RED_PROJECT || path.join(ROOT, 'red/target/debug/red-project');

export async function installExternalProject(options) {
  const args = ['install-external'];
  for (const [flag, key] of [['--project', 'project'], ['--profile', 'profile'], ['--launcher', 'launcher'], ['--state', 'state'], ['--title', 'title']]) {
    if (options[key] !== undefined) args.push(flag, options[key]);
  }
  if (options.minimal) args.push('--minimal');
  if (options.dryRun) args.push('--dry-run');
  /* `red-project` answers a refusal as `{error}` on STDOUT with a non-zero exit — the convention
     every one of its subcommands follows — and reserves stderr for the argument layer. */
  try {
    const { stdout } = await run(projectBinary(), args, { maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (failure) {
    let said = (failure.stderr ?? '').trim();
    try { said = JSON.parse(failure.stdout ?? '').error ?? said; } catch { /* not JSON: stderr it is */ }
    throw new Error(said || failure.message);
  }
}
