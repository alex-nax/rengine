import { readFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { request } from '../launcher/sidecar.mjs';

const index = process.argv.indexOf('--context');
if (index < 0 || !process.argv[index + 1]) throw new Error('A workspace context file is required.');
const context = JSON.parse(await readFile(process.argv[index + 1], 'utf8'));
const url = new URL(context.url);
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !/^[0-9a-f]{64}$/.test(context.token) || typeof context.rootId !== 'string') {
  throw new Error('Invalid local workspace context.');
}
const scopedState = async () => {
  const state = await request(context, 'state');
  if (state.instance !== context.instance) throw new Error('The original sidecar instance is no longer available. Reopen this agent from the workspace.');
  const root = state.roots.find(root => root.id === context.rootId);
  if (!root) throw new Error('The bound project is no longer available.');
  return { root, sessions: state.sessions.filter(session => session.rootId === root.id), drafts: state.drafts.filter(draft => draft.rootId === root.id) };
};
await scopedState();
const server = new McpServer({ name: 'rengine-workspace', version: '1.0.0' }, {
  instructions: 'These tools address the project bound when this agent was launched. List sessions before selecting a process. Closing a workspace view retains the process; stop_session explicitly stops it. File reads use disk text unless useDraft is requested.',
});
const tool = (name, description, inputSchema, readOnlyHint, action) => server.registerTool(name, {
  description, inputSchema, annotations: { readOnlyHint, destructiveHint: name === 'stop_session', openWorldHint: false },
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
  async ({ path, hidden }) => request(context, `tree?${new URLSearchParams({ rootId: context.rootId, path, hidden })}`));
tool('read_file', 'Read a bounded UTF-8 excerpt from the bound project. Explicitly opt into a recovery draft.', {
  path: z.string(), startLine: z.number().int().min(1).default(1), maxLines: z.number().int().min(1).max(400).default(200), useDraft: z.boolean().default(false),
}, true, async ({ path, startLine, maxLines, useDraft }) => {
  const file = await request(context, `file?${new URLSearchParams({ rootId: context.rootId, path })}`);
  const lines = (useDraft && file.draft ? file.draft.text : file.text).split('\n');
  const excerpt = lines.slice(startLine - 1, startLine - 1 + maxLines).join('\n');
  return { path: file.path, version: file.version, startLine, totalLines: lines.length, draftAvailable: Boolean(file.draft),
    usingDraft: Boolean(useDraft && file.draft), text: excerpt.slice(0, 32000), truncated: excerpt.length > 32000 || startLine - 1 + maxLines < lines.length };
});
tool('list_sessions', 'List retained processes for the bound project.', {}, true, async (_values, state) => ({ sessions: state.sessions }));
tool('session_output', 'Read the bounded tail of a project session output buffer.', {
  id: z.string(), maxCharacters: z.number().int().min(1).max(32000).default(8000),
}, true, async ({ id, maxCharacters }, state) => {
  ownSession(id, state);
  const session = await request(context, `session?${new URLSearchParams({ id })}`);
  return { ...session, output: session.output.slice(-maxCharacters), truncated: session.output.length > maxCharacters };
});
tool('nolf_preflight', 'Check this project for the native NOLF executable, game data and surface prerequisites.', {}, true,
  async () => request(context, `game-config?${new URLSearchParams({ rootId: context.rootId })}`));
tool('launch_nolf', 'Launch this project’s real flat NOLF game or reuse its running game session.', {}, false,
  async () => request(context, 'game', { rootId: context.rootId }));
tool('stop_session', 'Explicitly stop a retained process belonging to the bound project.', { id: z.string() }, false, async ({ id }, state) => {
  ownSession(id, state); return request(context, 'stop', { id });
});
await server.connect(new StdioServerTransport());
