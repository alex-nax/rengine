import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { bashPath } from '../server/sessions.mjs';
import { request } from '../launcher/sidecar.mjs';
import { fail } from './protocol.mjs';
import { envRules } from '../server/dashboard-rules.mjs';

export async function openScript(host, desktops, data, state) {
  const root = state.roots.find(x => x.id === data.rootId);
  if (!root) fail('Unknown project root.', 404);
  const envProblems = envRules(data.env); if (envProblems.length) fail(`Script env: ${envProblems[0]}`);
  desktops.target(data.rootId, data.desktopId, 'attach-session');
  if (typeof data.path !== 'string' || path.isAbsolute(data.path) || !data.path.endsWith('.sh') || data.path.includes('\0')) fail('Choose a project-relative .sh script.');
  const script = await realpath(path.resolve(root.path, data.path)), relative = path.relative(root.path, script);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !(await stat(script)).isFile()) fail('Script escapes the bound project.', 403);
  const args = data.args ?? [];
  if (!Array.isArray(args) || args.length > 64 || args.some(x => typeof x !== 'string' || x.length > 4096 || x.includes('\0'))) fail('Script arguments must be a bounded string array.');
  const created = await request(host, 'terminal', { rootId: root.id, command: bashPath(), args: [script, ...args], env: data.env ?? {} });
  const session = { ...created, title: `Script · ${path.basename(script)}` };
  try { return { session, view: await desktops.attach(data.rootId, data.desktopId, session) }; }
  catch (error) { return { session, view: { status: 'not_attached', error: error.message }, detail: 'The script was started and is retained. Use show_session; do not launch it again.' }; }
}
