/* The workspace launcher, as a spec reaches it (F159, spec 145).
 *
 * `npm start` is a binary now: `orchestrator/launch.mjs` and the four modules under it —
 * `launcher/{headless,replace,restart-supervisor}.mjs` and `build.mjs` — are `red-launch`. The
 * suites that drove them drive it, which is why this file exists at all: one place that knows where
 * the binary is, so a spec asserting about a replacement is not also asserting about a path.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveBinary } from './service-client.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The binary under test: the environment names one, then this checkout's debug or release build. */
export const LAUNCH = () => serveBinary('RENGINE_RED_LAUNCH', 'red-launch');

/** One run, with stdout, stderr and the exit code — a refusal is an answer here, not a throw. */
export async function launch(args, options = {}) {
  try {
    const { stdout, stderr } = await promisify(execFile)(LAUNCH(), args, { cwd: ROOT, maxBuffer: 16 * 1024 * 1024, ...options });
    return { code: 0, stdout, stderr };
  } catch (error) {
    if (error.code === undefined && error.stdout === undefined) throw error;
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? error.message };
  }
}

/** Replace the session host of a state directory, and answer what the report said. */
export const replaceHost = (stateDir, extra = []) => launch(['replace-host', '--state', stateDir, ...extra]);
