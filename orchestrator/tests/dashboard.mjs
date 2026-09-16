/* The thin client of `red_project::dashboard` and `red_project::capture` (F155/F156, spec 129).
 *
 * Which actions may be pressed, and what a capture does, are one implementation now. What stayed
 * here is the shape a caller hands to a terminal: a script or a log action becomes a PTY payload,
 * and that is the session host's business rather than the project reader's.
 */
import { probeCacheFor, declarationOf, workspaceListings } from './devices.mjs';
import { fail } from './store-client.mjs';
import { askProject } from './project-client.mjs';
import { bashPath } from '../server/sessions-client.mjs';

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
/* What a script or a log action becomes for the session host. The action is passed in because the
   caller already has it — a game action never reaches here, it goes to the project game route — and
   the bash is this machine's, which is the session host's business and not a rule. */
export async function dashboardRunPayload(root, action) {
  return askProject(['dashboard-run', root.id, root.path, action?.id ?? '', bashPath(), probeCacheFor(root), declarationOf(root)]);
}
/* The one project question that WRITES. It carries this root's probe cache because the availability
   it checks first is the board's, and the board probes every device an action is bound to. The
   shell environment is composed where the command is spawned (`red_project::command`), so the board
   judges a `tools` entry against the same PATH the run will use. */
export async function dashboardCapture(root, actionId, preflight) {
  return askProject(['dashboard-capture', root.id, root.path, actionId ?? '', probeCacheFor(root), declarationOf(root)]);
}
