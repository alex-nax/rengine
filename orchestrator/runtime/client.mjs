import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveRuntime } from './discovery.mjs';
import { request } from '../launcher/sidecar.mjs';

const args = process.argv.slice(2), action = args.shift();
let filename = process.env.RENGINE_WORKSPACE_CONTEXT, desktopId, layers = ['workspace', 'desktop', 'connector'];
for (let index = 0; index < args.length; index++) {
  const flag = args[index];
  if (!['--context', '--desktop', '--layers'].includes(flag) || !args[index + 1]) throw new Error('Usage: node orchestrator/runtime/client.mjs status|update [--context FILE] [--desktop ID] [--layers workspace,desktop,connector]');
  const value = args[++index];
  if (flag === '--context') filename = value;
  else if (flag === '--desktop') desktopId = value;
  else layers = value.split(',');
}
if (!filename || !['status', 'update'].includes(action)) throw new Error('Choose status or update and provide a bound workspace context.');
const context = JSON.parse(await readFile(filename, 'utf8'));
const runtime = await resolveRuntime(context), state = await request(runtime, 'state');
if (state.instance !== context.instance || !state.roots.some(root => root.id === context.rootId)) throw new Error('The original project/session host is no longer available.');
if (state.capabilities.layeredUpdates !== 1) throw new Error('Layered updates are not installed in this running desktop yet. Load the new native bootstrap once.');
const status = () => request(runtime, `update-status?${new URLSearchParams({ rootId: context.rootId })}`);
if (action === 'status') console.log(JSON.stringify(await status(), null, 2));
else {
  const queued = await request(runtime, 'update-workspace', { rootId: context.rootId, desktopId, layers });
  console.log(JSON.stringify(queued));
  const deadline = Date.now() + 180000;
  for (;;) {
    const job = (await status()).jobs.find(job => job.id === queued.jobId);
    if (job && ['succeeded', 'failed'].includes(job.status)) { console.log(JSON.stringify(job, null, 2)); if (job.status === 'failed') process.exitCode = 1; break; }
    if (Date.now() > deadline) throw new Error('Update observation timed out. Inspect status; the operation was not canceled.');
    await delay(250);
  }
}
