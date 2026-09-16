/* The answers registry.mjs and config.mjs gave, frozen before they were deleted (F173, spec 129).
 *
 * The same device F172 used for the hook reporter: a replacement cannot be compared against a
 * module that no longer exists, so the module's own answers are recorded while it is still here and
 * the Rust side is judged against the record afterwards. Regenerate ONLY from a checkout where
 * those modules still exist — that is, never again after the deletion commit; the file is the
 * evidence, and a regenerated one would be judging the replacement against itself.
 *
 *   node tests/agents-fixtures.mjs > tests/agents-fixtures.json
 */
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT_ID = '12345678-1234-1234-1234-123456789abc';

/* The per-launch directory carries a minted uuid and the identity a minted id and a clock; none of
   them is a decision, so they are normalised out of the record. */
export const scrub = (value, directory) => JSON.parse(JSON.stringify(value)
  .replaceAll(directory, '<home>')
  .replace(/rengine_[0-9a-f]{12}-[0-9a-f-]{36}/g, 'rengine_<root>-<mint>')
  .replace(/"startedAt":"[^"]*"/g, '"startedAt":"<stamp>"')
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
  .replace(/"label":"([a-z0-9-]+) [0-9a-f]{8}"/g, '"label":"$1 <short>"')
  /* The recording process's pid is not a decision either. */
  .replace(/"pid":\d+/g, '"pid":"<pid>"')
  .replace(/sha256:[0-9a-f]{64}/g, '<hash>'));

export const LAUNCHES = [
  { name: 'claude', agent: 'claude', executable: '/installed/claude' },
  { name: 'codex', agent: 'codex', executable: '/installed/codex' },
  { name: 'kimi', agent: 'kimi', executable: '/installed/kimi' },
  { name: 'gemini', agent: 'gemini', executable: '/installed/gemini' },
  { name: 'opencode', agent: 'opencode', executable: '/installed/opencode' },
];

/** One launch, run through whichever agentLaunch is handed in, recorded scrubbed. */
export async function recordLaunch(agentLaunch, kase, directory) {
  const context = { url: 'http://127.0.0.1:1', token: 'a'.repeat(64), instance: ROOT_ID, rootId: ROOT_ID };
  const contextFile = path.join(directory, 'root-context.json');
  await writeFile(contextFile, JSON.stringify(context));
  const plan = await agentLaunch({ agent: kase.agent, executable: kase.executable, args: [], contextFile, context,
    directory, conversation: null, resume: false, env: {}, cwd: null,
    ide: async () => ({ flags: [], env: {}, reason: 'none' }) });
  const files = {};
  for (const key of ['generic', 'contextFile', 'settings']) {
    if (!plan[key]) continue;
    files[key] = { body: scrub(JSON.parse(await readFile(plan[key], 'utf8')), directory), mode: (await stat(plan[key])).mode & 0o777 };
  }
  return {
    args: scrub(plan.args, directory), consumes: scrub(plan.consumes, directory),
    identity: scrub(plan.identity, directory), name: plan.name,
    conversation: scrub(plan.conversation ?? null, directory), custom: plan.custom ?? false, files,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const { agentLaunch, codexHookKey, codexHookTrustHash } = await import('../agents/config.mjs');
  const { agentNames, resolvedRecipes } = await import('../agents/registry.mjs');
  const command = "'/opt/red-agents' report-session --provider codex --context '/tmp/c.json'";
  const launches = {};
  for (const kase of LAUNCHES) {
    const directory = await mkdtemp(path.join(tmpdir(), 'rengine-agents-fixture-'));
    try { launches[kase.name] = await recordLaunch(agentLaunch, kase, directory); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
  console.log(JSON.stringify({
    agentNames: agentNames(),
    resolvedRecipes: resolvedRecipes(),
    hookKeys: { '0,0': codexHookKey(0, 0), '2,1': codexHookKey(2, 1) },
    trustHashes: { 'startup|resume': codexHookTrustHash(command), startup: codexHookTrustHash(command, 'startup') },
    trustCommand: command,
    launches,
  }, null, 2));
}
