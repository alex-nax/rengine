/* A client of `red-ide offered` and `red-ide auto-connect` for the specs that judge them: the
 * question as `ide-connect.mjs` will ask it, without the module in between. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { recipe } from '../agents/agents-client.mjs';
import { BINARY } from './ide-serve-client.mjs';

const run = promisify(execFile);

export async function ask(subcommand, input) {
  const child = run(BINARY, [subcommand], { maxBuffer: 1 << 24 });
  child.child.stdin.end(JSON.stringify(input));
  const { stdout } = await child;
  return JSON.parse(stdout);
}

/* The recipe's `ide` block is data the registry already resolves in Rust (F148/F173); the flags
   and the variable travel with the question, so the binary never reads the registry itself. */
export const ideOf = agent => {
  const raw = recipe(agent);
  return raw?.ide ? { flags: raw.ide.flags, envVar: Object.keys(raw.ide.env(0))[0] } : null;
};

export const rustHarness = {
  offered: (directory, locks) => ask('offered', { directory, locks }),
  connect: (agent, directory, { locks, ourPids }) => ask('auto-connect', { agent, ide: ideOf(agent), directory, locks, ourPids }),
};
