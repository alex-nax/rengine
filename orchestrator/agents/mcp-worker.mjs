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
  description, inputSchema, annotations: { readOnlyHint, destructiveHint: ['stop_session', 'open_script'].includes(name), openWorldHint: ['open_script', 'preview_file', 'dashboard_capture', 'launch_game'].includes(name) },
}, async values => {
  let state;
  try {
    state = await scopedState();
    const output = await action(values, state);
    return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
  } catch (error) { return { isError: true, content: [{ type: 'text', text: state ? error.message.replaceAll(state.root.path, '<root>') : error.message }] }; }
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
tool('open_script', 'Run a project-relative .sh workflow in a retained interactive terminal and open its tab in an explicit desktop. Inspect the script purpose first: execution may have effects. Arguments are literal argv; env adds UPPER_SNAKE literal variables over the shell environment (dashboard script actions list their script, args and env). Not idempotent; inspect sessions after a timeout instead of blindly retrying.', {
  path: z.string(), args: z.array(z.string()).default([]), desktopId: z.string(), env: z.record(z.string(), z.string()).optional(),
}, false, async (data, state) => { scriptCapability(state); return call('script-open', { ...data, rootId: context.rootId }); });
const dashboardCapability = state => { if (state.capabilities.dashboard !== 1) throw new Error('This retained service predates the project dashboard. Update the workspace layer first.'); };
tool('dashboard_actions', 'List the project’s declared dashboard (.rengine/project.json contract 2): groups and actions with availability (missing required files, PATH tools, or, for a game action, the referenced game’s first preflight issue) computed without running anything. Script actions are run with open_script using the listed script, args and env; log actions start from the dashboard tab and are followed with show_session/session_output; capture actions use dashboard_capture; game actions are launched with launch_game using the listed game id and args.', {}, true,
  async (_values, state) => { dashboardCapability(state); return call(`dashboard?${new URLSearchParams({ rootId: context.rootId })}`); });
tool('dashboard_capture', 'Run one declared capture action (the project’s own command, no shell, 10 s / 8 MiB) and return its manifest entry: the PNG written under the action’s into directory plus manifest.json. Executes a project executable.', { actionId: z.string() }, false,
  async ({ actionId }, state) => { dashboardCapability(state); return call('dashboard-capture', { rootId: context.rootId, actionId }); });
tool('show_session', 'Open a retained project session in a listed desktop without starting another process. Use this if a script started but its view could not attach.', { id: z.string(), desktopId: z.string() }, false,
  async (data, state) => { scriptCapability(state); ownSession(data.id, state); return call('session-view', { ...data, rootId: context.rootId }); });
tool('session_output', 'Read the bounded tail of a project session output buffer.', {
  id: z.string(), maxCharacters: z.number().int().min(1).max(32000).default(8000),
}, true, async ({ id, maxCharacters }, state) => {
  ownSession(id, state);
  const session = await call(`session?${new URLSearchParams({ id })}`);
  return { ...session, output: session.output.slice(-maxCharacters), truncated: session.output.length > maxCharacters };
});
const formatCapability = state => { if (state.capabilities.formatRegistry !== 1) throw new Error('This retained service predates the project format registry. Update the workspace layer first.'); };
const PREVIEW_BUDGET = 32000;
tool('preview_file', 'Preview a file registered in the project’s .rengine/project.json by running its declared preview command (the project’s own executable, no shell): returns the sanitized subtree at dir expanded depth levels, or read-only text. Wide levels page through offset/limit; the whole reply stays within a 32,000-character budget (depth and limit shrink, truncated/nextOffset say so). With entry, runs the entry command and returns size, SHA-256 and the text when it is UTF-8. Paths are root-relative. Never writes.', {
  path: z.string(), entry: z.string().optional(), dir: z.string().default(''), depth: z.number().int().min(1).max(8).default(1),
  offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(1000).default(200),
}, false, async ({ path, entry, dir, depth, offset, limit }, state) => {
  formatCapability(state);
  const rootPath = state.root.path, relative = value => typeof value === 'string' && value.startsWith(`${rootPath}/`) ? value.slice(rootPath.length + 1) : value;
  const result = await call('format-preview', { rootId: context.rootId, path, ...(entry !== undefined ? { entry } : {}) });
  result.command = result.command.map(relative);
  if (result.kind !== 'tree') { const { window, ...rest } = result; if (rest.text?.length > PREVIEW_BUDGET) { rest.text = rest.text.slice(0, PREVIEW_BUDGET); rest.truncated = true; } return rest; }
  let node = result.tree;
  for (const part of dir.split('/').filter(Boolean)) node = node.dirs.find(x => x.name === part) ?? (() => { throw new Error(`Directory ${dir} is not in the preview tree.`); })();
  const count = n => n.files.length + n.dirs.reduce((sum, d) => sum + count(d), 0);
  const summary = d => ({ name: d.name, dirs: d.dirs.length, files: d.files.length });
  const { tree: _tree, ...base } = result;
  let useDepth = depth, useLimit = limit, output;
  for (;;) {
    const slice = (n, level, first) => {
      const start = first ? offset : 0, files = n.files.slice(start, start + useLimit);
      return { name: n.name, files, ...(start + files.length < n.files.length ? { moreFiles: n.files.length - start - files.length } : {}),
        dirs: n.dirs.map(d => level <= useDepth ? slice(d, level + 1, false) : summary(d)) };
    };
    const tree = slice(node, 1, true), next = offset + tree.files.length, more = next < node.files.length;
    output = { ...base, dir, depth: useDepth, offset, limit: useLimit, totalFiles: count(result.tree), truncated: more || useDepth < depth || useLimit < limit, ...(more ? { nextOffset: next } : {}), tree };
    if (JSON.stringify(output).length <= PREVIEW_BUDGET || (useDepth === 1 && useLimit === 1)) break;
    if (useDepth > 1) useDepth--; else useLimit = Math.max(1, Math.floor(useLimit / 2));
  }
  return output;
});
const gameCapability = state => { if (state.capabilities.projectGame !== 1) throw new Error('This retained service predates per-project game declarations. Update the workspace layer first.'); };
const launchCapability = state => {
  gameCapability(state);
  if (state.capabilities.projectGameLaunch !== 1) throw new Error('This retained session host predates per-project game declarations and would launch its removed built-in game; game_preflight answers from the declaration. Replacing the session host requires quiescence.');
};
const gameSelector ={ gameId: z.string().optional().describe('One declared game id; omitted, the first declared game is used.') };
const gameLauncher = { ...gameSelector, args: z.array(z.string()).optional().describe('Literal argv appended to the declared record’s own args, as a dashboard game action carries.') };
tool('game_preflight', 'Check one game declared in the project’s .rengine/project.json (contract 3, games): its title, the first resolvable executable candidate, literal args and env, working directory, required files and surface prerequisites, with each problem as a named issue and ready. Runs nothing; an undeclared project reports declared false, and an unknown gameId names the declared ids.', gameSelector, true,
  async ({ gameId }, state) => { gameCapability(state); return call(`game-config?${new URLSearchParams({ rootId: context.rootId, ...(gameId ? { gameId } : {}) })}`); });
tool('launch_game', 'Launch one game declared in the project’s .rengine/project.json (its own executable with literal args and env, in its declared working directory) or reuse the running session of that same game. Games of one project can run side by side; the same game already running with different arguments is refused rather than reused, so stop it first. embedded games stream into the workspace pane; external games open their own window and retain only their PTY output. Executes a project executable; stop_session ends it.', gameLauncher, false,
  async ({ gameId, args }, state) => { launchCapability(state); return call('game', { rootId: context.rootId, ...(gameId ? { gameId } : {}), ...(args ? { args } : {}) }); });
tool('stop_session', 'Explicitly stop a retained process belonging to the bound project.', { id: z.string() }, false, async ({ id }, state) => {
  ownSession(id, state); return call('stop', { id });
});
await server.connect(new StdioServerTransport());
