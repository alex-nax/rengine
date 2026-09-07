import { writeSync } from 'node:fs';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from '../launcher/sidecar.mjs';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const read = async filename => JSON.parse(await readFile(filename, 'utf8'));

/* The launcher's own plumbing, read the way the tool worker reads it: RENGINE_MCP_CONFIG names the
   per-launch mcp.json whose server is started on this launch's context file, and
   RENGINE_WORKSPACE_CONTEXT is the root file a pane inherits, which carries the host connection but
   no identity. Neither present means this CLI is not running inside a workspace pane. */
export async function bindingContext(env = process.env) {
  if (env.RENGINE_MCP_CONFIG) {
    const servers = (await read(env.RENGINE_MCP_CONFIG)).mcpServers;
    for (const server of Object.values(servers ?? {})) {
      const args = Array.isArray(server?.args) ? server.args : [];
      const at = args.indexOf('--context');
      if (at >= 0 && typeof args[at + 1] === 'string') return args[at + 1];
    }
  }
  return env.RENGINE_WORKSPACE_CONTEXT || null;
}

const connection = value => {
  const url = new URL(value.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !/^[0-9a-f]{64}$/.test(value.token ?? '')) throw new Error('Invalid local workspace connection.');
  return { url: value.url, token: value.token };
};

/* The conversation IS the identity (spec 095), so a reported id replaces the whole of it: the
   agentId, the eight characters the label goes by, and the line that resumes it. This hook is Claude
   Code's own, so the provider is claude by construction. The pid and the moment this launch started
   belong to the launcher and are not the CLI's to change. */
export function reportedIdentity(identity, conversation) {
  return { ...identity, agentId: conversation, label: `claude ${conversation.slice(0, 8)}`,
    session: { provider: 'claude', id: conversation, known: true, source: 'reported', resume: `claude --resume ${conversation}` } };
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
export async function report({ env = process.env, input } = {}) {
  const contextFile = await bindingContext(env);
  if (!contextFile) return { bound: false, rewrote: false, posted: false };
  const conversation = String(input?.session_id ?? '').toLowerCase();
  if (!UUID.test(conversation)) throw new Error(`${input?.hook_event_name ?? 'The hook'} carried no session id.`);
  const context = await read(contextFile);
  const identity = context.agent;
  const result = { bound: true, contextFile, conversation, source: input?.source ?? null, rewrote: false, posted: false };
  if (identity && typeof identity === 'object' && UUID.test(identity.agentId ?? '') && identity.agentId !== conversation) {
    result.was = identity.agentId;
    await replaceJson(contextFile, { ...context, agent: reportedIdentity(identity, conversation) });
    result.rewrote = true;
  }
  /* Posting every time, not only on a change: this is the one report that comes from the CLI itself,
     so a record the launcher could not write — a launch that continued or forked and claimed
     nothing — heals on the next session start rather than staying unknown. */
  if (env.RENGINE_ORCHESTRATOR_SESSION) {
    await request(connection(context), 'agent-conversation', { id: env.RENGINE_ORCHESTRATOR_SESSION, conversation, agent: 'claude' });
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
