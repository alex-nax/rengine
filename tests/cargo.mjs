/* Building a Rust binary from inside a spec, without the specs building over each other.
 *
 * Every spec that drives a Rust binary builds it first, so `node --test <one file>` works on a
 * fresh checkout. Run as a suite, those builds become the problem they were meant to solve: cargo
 * UPLIFTS a binary by removing the destination and hardlinking the new one, and two builds of the
 * same package with different `--bin` selections re-link on every alternation — so a spec spawning
 * `red-agent-env` while another spec's cargo is inside that window gets ENOENT for a file that
 * exists before and after. `docs/evidence/suite-prebuild-2026-09-13.md` records the first form of
 * this, where `existsSync` was the victim.
 *
 * So `npm test` builds every binary once in `pretest` and says so with RENGINE_SUITE_PREBUILT, and
 * a spec builds only when nobody has built for it.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const RED = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../red');

export async function built(...selection) {
  if (process.env.RENGINE_SUITE_PREBUILT === '1') return;
  await run('cargo', ['build', ...selection], { cwd: RED, maxBuffer: 1 << 24 });
}
