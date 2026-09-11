import { writeSync } from 'node:fs';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from '../launcher/sidecar.mjs';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const read = async filename => JSON.parse(await readFile(filename, 'utf8'));

/* Where this launch's context is, in the order that finds it. The per-launch settings file names it
   on this hook's own command line, so a session started by hand from the line bind.mjs prints --
   which inherits none of the launcher's environment -- is bound as well as a pane is. Otherwise the
   launcher's own plumbing, read the way the tool worker reads it: RENGINE_MCP_CONFIG names the
   per-launch mcp.json whose server is started on that same file, and RENGINE_WORKSPACE_CONTEXT is
   the root file a pane inherits, which carries the host connection but no identity. None of the
   three means this CLI is not running under rEngine at all, and there is nothing to report to.
   envFirst reverses the order for the MCP facade: kimi's mcp.json is shared per project and
   last-writer-wins, so the argv it passes can name another pane's launch while the pane's own
   environment always names its own (spec 127 decision 5). */
export async function bindingContext(env = process.env, argv = process.argv.slice(2), { envFirst = false } = {}) {
  const fromArgv = () => {
    const named = argv.indexOf('--context');
    return named >= 0 && argv[named + 1] ? argv[named + 1] : null;
  };
  const fromEnv = async () => {
    if (env.RENGINE_MCP_CONFIG) {
      const servers = (await read(env.RENGINE_MCP_CONFIG)).mcpServers;
      for (const server of Object.values(servers ?? {})) {
        const args = Array.isArray(server?.args) ? server.args : [];
        const at = args.indexOf('--context');
        if (at >= 0 && typeof args[at + 1] === 'string') return args[at + 1];
      }
    }
    return env.RENGINE_WORKSPACE_CONTEXT || null;
  };
  const [first, second] = envFirst ? [fromEnv, fromArgv] : [fromArgv, fromEnv];
  return await first() ?? await second();
}

const connection = value => {
  const url = new URL(value.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !/^[0-9a-f]{64}$/.test(value.token ?? '')) throw new Error('Invalid local workspace connection.');
  return { url: value.url, token: value.token };
};

/* The conversation IS the identity (spec 095), so a reported id replaces the whole of it: the
   agentId, the eight characters the label goes by, and the line that resumes it. Which CLI the
   report speaks for comes from --provider: claude's hook is wired per launch, kimi's by the guided
   bootstrap action (spec 127), and each resumes in its own spelling. The pid and the moment this
   launch started belong to the launcher and are not the CLI's to change. */
const PROVIDERS = {
  claude: { pattern: UUID, short: id => id.slice(0, 8), resume: id => `claude --resume ${id}`, normalize: id => id.toLowerCase() },
  kimi: {
    pattern: /^(?:session_)?(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9A-HJKMNP-TV-Z]{26})$/i,
    short: id => id.replace(/^session_/i, '').slice(0, 8), resume: id => `kimi --session ${id}`, normalize: id => id,
  },
};
export function reportedIdentity(identity, conversation, provider = 'claude') {
  const kind = PROVIDERS[provider];
  return { ...identity, agentId: conversation, label: `${provider} ${kind.short(conversation)}`,
    session: { provider, id: conversation, known: true, source: 'reported', resume: kind.resume(conversation) } };
}

async function replaceJson(filename, value) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 }); await rename(temporary, filename); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
}

/* What the CLI says it is running now. The launcher decides the conversation at launch and cannot
   see a /resume performed inside the running CLI, so the record follows this report rather than the
   launch: the host is told over the same route launch.mjs reports on, and the per-launch context is
   rewritten so the tool worker's identity header and workspace_info follow it too. */
export async function report({ env = process.env, argv = process.argv.slice(2), input } = {}) {
  const contextFile = await bindingContext(env, argv);
  if (!contextFile) return { bound: false, rewrote: false, posted: false };
  const at = argv.indexOf('--provider');
  const provider = at >= 0 ? argv[at + 1] : 'claude';
  const kind = PROVIDERS[provider];
  if (!kind) throw new Error(`Unknown agent provider: ${provider}`);
  const conversation = kind.normalize(String(input?.session_id ?? ''));
  if (!kind.pattern.test(conversation)) throw new Error(`${input?.hook_event_name ?? 'The hook'} carried no session id.`);
  const context = await read(contextFile);
  const identity = context.agent;
  const result = { bound: true, contextFile, conversation, source: input?.source ?? null, rewrote: false, posted: false };
  if (identity && typeof identity === 'object' && kind.pattern.test(identity.agentId ?? '') && identity.agentId !== conversation) {
    result.was = identity.agentId;
    await replaceJson(contextFile, { ...context, agent: reportedIdentity(identity, conversation, provider) });
    result.rewrote = true;
  }
  /* Posting every time, not only on a change: this is the one report that comes from the CLI itself,
     so a record the launcher could not write — a launch that continued or forked and claimed
     nothing — heals on the next session start rather than staying unknown. */
  if (env.RENGINE_ORCHESTRATOR_SESSION) {
    await request(connection(context), 'agent-conversation', { id: env.RENGINE_ORCHESTRATOR_SESSION, conversation, agent: provider });
    result.posted = true;
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  /* A hook must never fail the CLI it runs inside, and a SessionStart hook's stdout is added to that
     CLI's context — so everything this has to say goes to stderr, written synchronously, and the
     exit status is always 0. The explicit exit also releases the keep-alive socket the report leaves
     behind, instead of holding the CLI's startup for it. */
  const note = message => { try { writeSync(2, `${message}\n`); } catch { /* the pane is gone */ } };
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const result = await report({ input: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') });
    if (result.rewrote) note(`rEngine: this pane is conversation ${result.conversation.slice(0, 8)} (was ${result.was.slice(0, 8)}).`);
  } catch (error) { note(`rEngine could not report this conversation: ${error.message}`); }
  process.exit(0);
}
