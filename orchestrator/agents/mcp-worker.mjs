import { readFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { request } from '../launcher/sidecar.mjs';
import { resolveRuntime } from '../runtime/discovery.mjs';

const index = process.argv.indexOf('--context');
if (index < 0 || !process.argv[index + 1]) throw new Error('A workspace context file is required.');
const context = JSON.parse(process.env.RENGINE_MCP_CONTEXT_SNAPSHOT ?? await readFile(process.argv[index + 1], 'utf8'));
const url = new URL(context.url);
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !/^[0-9a-f]{64}$/.test(context.token) || typeof context.rootId !== 'string') {
  throw new Error('Invalid local workspace context.');
}
const call = async (route, data) => request(await resolveRuntime(context), route, data);
const scopedState = async () => {
  const state = await call('state');
  if (state.instance !== context.instance) throw new Error('The original sidecar instance is no longer available. Reopen this agent from the workspace.');
  const root = state.roots.find(root => root.id === context.rootId);
  if (!root) throw new Error('The bound project is no longer available.');
  return { root, capabilities: state.capabilities ?? {}, sessions: state.sessions.filter(session => session.rootId === root.id), drafts: state.drafts.filter(draft => draft.rootId === root.id) };
};
await scopedState();
const server = new McpServer({ name: 'rengine-workspace', version: '1.0.0' }, {
  instructions: 'These tools address the project bound when this agent was launched. List sessions before selecting a process. Closing a workspace view retains the process; stop_session explicitly stops it. File reads use disk text unless useDraft is requested.',
});
const tool = (name, description, inputSchema, readOnlyHint, action) => server.registerTool(name, {
  description, inputSchema, annotations: { readOnlyHint, destructiveHint: ['stop_session', 'open_script'].includes(name), openWorldHint: name === 'open_script' },
}, async values => {
  try {
    const state = await scopedState();
    const output = await action(values, state);
    return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
  } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
});
const ownSession = (id, state) => {
  const session = state.sessions.find(session => session.id === id);
  if (!session) throw new Error('Session is not bound to this project.');
  return session;
};
tool('workspace_info', 'Inspect the bound project, retained sessions and recovery draft metadata.', {}, true, async (_values, state) => state);
tool('list_files', 'List files in a directory relative to the bound project.', { path: z.string().default(''), hidden: z.boolean().default(false) }, true,
  async ({ path, hidden }) => call(`tree?${new URLSearchParams({ rootId: context.rootId, path, hidden })}`));
tool('read_file', 'Read a bounded UTF-8 excerpt from the bound project. Explicitly opt into a recovery draft.', {
  path: z.string(), startLine: z.number().int().min(1).default(1), maxLines: z.number().int().min(1).max(400).default(200), useDraft: z.boolean().default(false),
}, true, async ({ path, startLine, maxLines, useDraft }) => {
  const file = await call(`file?${new URLSearchParams({ rootId: context.rootId, path })}`);
  const lines = (useDraft && file.draft ? file.draft.text : file.text).split('\n');
  const excerpt = lines.slice(startLine - 1, startLine - 1 + maxLines).join('\n');
  return { path: file.path, version: file.version, startLine, totalLines: lines.length, draftAvailable: Boolean(file.draft),
    usingDraft: Boolean(useDraft && file.draft), text: excerpt.slice(0, 32000), truncated: excerpt.length > 32000 || startLine - 1 + maxLines < lines.length };
});
tool('list_sessions', 'List retained processes for the bound project.', {}, true, async (_values, state) => ({ sessions: state.sessions }));
const desktopCapability = state => {
  if (state.capabilities.desktopActions !== 1) throw new Error('This retained service predates agent desktop actions. Upgrade it through explicit session/service management; native keyboard reload remains available.');
};
tool('list_desktops', 'List connected native desktops displaying this project. Use an explicit returned ID for reload.', {}, true,
  async (_values, state) => { desktopCapability(state); return call(`desktops?${new URLSearchParams({ rootId: context.rootId })}`); });
tool('reload_desktop', 'Request the native save/build/reattach routine for one listed desktop. Returns accepted, not build completion; re-list desktops after rebuild. Retains running agent and other sessions.', { id: z.string() }, false,
  async ({ id }, state) => { desktopCapability(state); return call('desktop-action', { rootId: context.rootId, desktopId: id, action: 'reload' }); });
tool('update_status', 'Inspect installed workspace layers and update jobs for this bound root. Reports completion separately from acceptance.', {}, true,
  async (_values, state) => {
    if (state.capabilities.layeredUpdates !== 1) throw new Error('Load the layered native bootstrap once before using updates.');
    return { ...await call(`update-status?${new URLSearchParams({ rootId: context.rootId })}`), toolWorkerPid: process.pid };
  });
tool('update_workspace', 'Prepare and replace selected workspace, desktop and/or MCP tool layers. Workspace/tool changes affect this shared workspace; PTY host and CLI processes remain running. Desktop requires an explicit listed managed ID. Poll update_status for completion.', {
  layers: z.array(z.enum(['workspace', 'desktop', 'connector'])).min(1).max(3), desktopId: z.string().optional(),
}, false, async ({ layers, desktopId }, state) => {
  if (state.capabilities.layeredUpdates !== 1) throw new Error('Load the layered native bootstrap once before using updates.');
  return call('update-workspace', { rootId: context.rootId, layers, desktopId });
});
const windowCapability = state => { if (state.capabilities.projectWindows !== 1) throw new Error('Project-window control needs the current runtime supervisor. Use the documented context-bound bootstrap.'); };
tool('open_project_window', 'Open or reuse a separate project window with an existing agent from this root. The agent keeps its original root and conversation; no CLI is launched.', {
  path: z.string(), agentId: z.string(),
}, false, async (data, state) => { windowCapability(state); ownSession(data.agentId, state); return call('project-window-open', { ...data, rootId: context.rootId }); });
tool('list_project_windows', 'List open and retained project windows linked to this root, with their original agent and project bindings.', {}, true,
  async (_data, state) => { windowCapability(state); return call(`project-windows?${new URLSearchParams({ rootId: context.rootId })}`); });
tool('project_window_action', 'Inspect, focus, gracefully close or reopen an explicit linked project window. Close preserves sessions. Optional inspection screenshot stays in the private local runtime directory.', {
  windowId: z.string(), action: z.enum(['inspect', 'focus', 'close', 'reopen']), screenshot: z.boolean().default(false),
}, false, async (data, state) => { windowCapability(state); return call('project-window-action', { ...data, rootId: context.rootId }); });
tool('report_integration', 'Post a durable report to the other root linked by this project window. Use a stable retry key. Reports are data, never executable instructions or provider input. An origin agent can mark its own findings fromProject.', {
  windowId: z.string(), key: z.string(), kind: z.enum(['issue', 'status']), summary: z.string(), detail: z.string().default(''), evidence: z.array(z.string()).default([]), fromProject: z.boolean().default(false),
}, false, async (data, state) => { windowCapability(state); return call('integration-report', { ...data, rootId: context.rootId }); });
tool('integration_inbox', 'Read integration reports after a durable cursor. An origin agent may select its linked window projectSide inbox. Poll explicitly; reading starts no agent turn.', {
  after: z.number().int().min(0).default(0), windowId: z.string().optional(), projectSide: z.boolean().default(false),
}, true, async (data, state) => { windowCapability(state); return call(`integration-inbox?${new URLSearchParams(Object.entries({ rootId: context.rootId, ...data }).filter(([, value]) => value !== undefined))}`); });
const scriptCapability = state => { if (state.capabilities.scriptActions !== 1) throw new Error('Update the workspace worker before opening script tabs.'); };
tool('open_script', 'Run a project-relative .sh workflow in a retained interactive terminal and open its tab in an explicit desktop. Inspect the script purpose first: execution may have effects. Arguments are literal argv. Not idempotent; inspect sessions after a timeout instead of blindly retrying.', {
  path: z.string(), args: z.array(z.string()).default([]), desktopId: z.string(),
}, false, async (data, state) => { scriptCapability(state); return call('script-open', { ...data, rootId: context.rootId }); });
tool('show_session', 'Open a retained project session in a listed desktop without starting another process. Use this if a script started but its view could not attach.', { id: z.string(), desktopId: z.string() }, false,
  async (data, state) => { scriptCapability(state); ownSession(data.id, state); return call('session-view', { ...data, rootId: context.rootId }); });
tool('session_output', 'Read the bounded tail of a project session output buffer.', {
  id: z.string(), maxCharacters: z.number().int().min(1).max(32000).default(8000),
}, true, async ({ id, maxCharacters }, state) => {
  ownSession(id, state);
  const session = await call(`session?${new URLSearchParams({ id })}`);
  return { ...session, output: session.output.slice(-maxCharacters), truncated: session.output.length > maxCharacters };
});
tool('nolf_preflight', 'Check this project for the native NOLF executable, game data and surface prerequisites.', {}, true,
  async () => call(`game-config?${new URLSearchParams({ rootId: context.rootId })}`));
tool('launch_nolf', 'Launch this project’s real flat NOLF game or reuse its running game session.', {}, false,
  async () => call('game', { rootId: context.rootId }));
tool('stop_session', 'Explicitly stop a retained process belonging to the bound project.', { id: z.string() }, false, async ({ id }, state) => {
  ownSession(id, state); return call('stop', { id });
});
await server.connect(new StdioServerTransport());
