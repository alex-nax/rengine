/* The thin client of `red_project::dashboard` and `red_project::capture` (F155/F156, spec 129).
 *
 * Which actions may be pressed, and what a capture does, are one implementation now. What stayed
 * here is the shape a caller hands to a terminal: a script or a log action becomes a PTY payload,
 * and that is the session host's business rather than the project reader's.
 */
import path from 'node:path';
import { probeCacheFor, declarationOf, workspaceListings } from './devices.mjs';
import { fail, resolveInRoot } from './store-client.mjs';
import { askProject } from './project-client.mjs';
import { bashPath, shellEnvironment } from './sessions-client.mjs';
import { stat } from 'node:fs/promises';

/* `preflight` is still taken and still ignored: the reader on the other side runs the game preflight
   itself, from the same declaration, which is what made a second copy of those checks unnecessary. */
export async function dashboardActions(root, preflight, options = {}) {
  return (await workspaceListings(root, options)).dashboard;
}
export async function dashboardAction(root, actionId, preflight) {
  const board = await dashboardActions(root, preflight);
  if (!board.declared || board.error) fail(board.error ?? 'This project does not declare a dashboard in .rengine/project.json.', 415);
  const action = board.groups.flatMap(group => group.actions).find(x => x.id === actionId);
  if (!action) fail('Unknown dashboard action.', 404);
  if (!action.available) fail(`Action ${action.id} is unavailable: ${action.missing.map(m => `${m.type} ${m.name}`).join(', ')}.`, 409);
  return action;
}
export async function dashboardRunPayload(root, action) {
  if (action.kind === 'capture') fail('Capture actions run through dashboard-capture.', 400);
  if (action.kind === 'game') fail('Game actions run through the project game route.', 400);
  if (action.kind === 'script') {
    const script = await resolveInRoot(root, action.script);
    if (!(await stat(script.absolute)).isFile()) fail('Dashboard script is not a file.', 415);
    return { rootId: root.id, command: bashPath(), args: [script.absolute, ...(action.args ?? [])], env: action.env ?? {}, title: `Script · ${path.posix.basename(script.relative)}` };
  }
  return { rootId: root.id, command: action.command[0], args: action.command.slice(1), env: {}, title: `Log · ${action.title}` };
}
/* The one project question that WRITES. It carries the shell environment because the capture runs
   the project's own command and its producer saw one when this module spawned it; it carries this
   root's probe cache because the availability it checks first is the board's, and the board probes
   every device an action is bound to. */
export async function dashboardCapture(root, actionId, preflight) {
  return askProject(['dashboard-capture', root.id, root.path, actionId ?? '', probeCacheFor(root), declarationOf(root)], undefined, shellEnvironment());
}