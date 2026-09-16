/* Should this pane's CLI be told to connect to the editor it is running inside? (spec 102, F103,
 * spec 133)
 *
 * The decision is `red_ide::discovery` now — the rule the CLI was MEASURED to apply (folders
 * against cwd, a live pid) plus this workspace's own editor named by port, judged against every
 * sentence this module used to answer with (`tests/ide-connect-corpus.json`). It
 * stays the caller's probe: `agents-client.mjs` resolves it before asking `red-agents` for a plan
 * (owner, 2026-09-13), and only the decision inside it crossed to Rust.
 */
import { ask } from './ide.mjs';
import { recipe, resolvedRecipes } from './agents-client.mjs';

/** The editors published for a directory: `red-ide offered`, with the lock directory defaulted by the binary. */
export const offeredEditors = (directory, { locks } = {}) => ask('offered', { directory, locks });

/* Which CLIs accept being told to connect on startup, and what says it: the recipe's `ide` block.
   A CLI whose recipe names none launches exactly as it does today, with nothing added to its
   command line. */
export const ideConnectFlag = agent => recipe(agent)?.ide?.flags ?? null;

/* The decision, its environment, and the sentence explaining it. The recipe's `ide` block travels
   with the question — its flags and the variable that names a port — so the binary never reads
   the registry itself; `ourPids` is this pane's ancestor chain, which is how its own editor is
   told apart from a machine-mate's. */
export const autoConnect = (agent, directory, options = {}) =>
  ask('auto-connect', { agent, ide: resolvedRecipes()[agent]?.ide ?? null, directory, locks: options.locks, ourPids: options.ourPids ?? [] });
