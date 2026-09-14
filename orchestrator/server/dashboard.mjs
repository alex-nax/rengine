import { stat, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { runCommand } from './formats.mjs';
import { present, workspaceListings } from './devices.mjs';
import { fail, hash, resolveInRoot } from './store-client.mjs';
import { bashPath } from './sessions-client.mjs';

export const CAPTURE_TIMEOUT_MS = 10000;
export const CAPTURE_MAX_BYTES = 8 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/* Which actions may be pressed is `red_project::dashboard`'s (F155), asked through the same run
   that answers the Devices tab so the two share one probe cache. `preflight` is still taken and
   still ignored: the reader on the other side runs the game preflight itself, from the same
   declaration, which is what made a second copy of those checks unnecessary in the first place. */
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
export async function dashboardCapture(root, actionId, preflight) {
  const action = await dashboardAction(root, actionId, preflight);
  if (action.kind !== 'capture') fail(`Action ${action.id} is not a capture action.`, 400);
  const target = path.resolve(root.path, action.into), relative = path.relative(root.path, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('Capture directory is outside the selected project root.', 403);
  await mkdir(target, { recursive: true });
  const into = await resolveInRoot(root, action.into);
  if (!(await stat(into.absolute)).isDirectory()) fail('Capture target is not a directory.', 415);
  const run = await runCommand(root, { command: action.command, timeoutMs: CAPTURE_TIMEOUT_MS, maxBytes: CAPTURE_MAX_BYTES }, {});
  if (!run.stdout.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) fail('Capture output is not a PNG (signature mismatch); nothing was written.', 502);
  const time = new Date().toISOString(); let file = `${time.replaceAll(':', '-')}.png`;
  for (let n = 2; await present(root, `${into.relative}/${file}`); n++) file = `${time.replaceAll(':', '-')}-${n}.png`;
  const entry = { file, time, size: run.stdout.length, sha256: hash(run.stdout), action: action.id };
  const manifestPath = path.join(into.absolute, 'manifest.json');
  let manifest = [];
  try { const parsed = JSON.parse(await readFile(manifestPath, 'utf8')); if (Array.isArray(parsed)) manifest = parsed; } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  const temp = path.join(into.absolute, `.rengine-capture-${randomUUID()}`);
  try {
    await writeFile(temp, run.stdout, { mode: 0o644 }); await rename(temp, path.join(into.absolute, file));
    await writeFile(temp, JSON.stringify([...manifest, entry], null, 2), { mode: 0o644 }); await rename(temp, manifestPath);
  } finally { await rm(temp, { force: true }); }
  return { ...entry, path: `${into.relative}/${file}`, manifest: `${into.relative}/manifest.json` };
}
