import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureRuntime, resolveRuntime } from './discovery.mjs';
import { request } from '../launcher/sidecar.mjs';

const args = process.argv.slice(2), action = args.shift(), options = {};
const usage = 'Usage: node orchestrator/runtime/client.mjs bootstrap|status|update|open|windows|window|report|inbox|script|show-session --context FILE [--project DIR --agent ID] [--window ID --action inspect|focus|close|reopen --screenshot] [--report FILE] [--script FILE --desktop ID] [--session ID] [--after N --project-side] [--desktop ID --layers workspace,desktop,connector]';
for (let index = 0; index < args.length; index++) {
  const flag = args[index];
  if (['--screenshot', '--project-side'].includes(flag)) options[flag.slice(2)] = true;
  else if (['--context', '--desktop', '--layers', '--project', '--agent', '--window', '--action', '--report', '--after', '--script', '--session'].includes(flag) && args[index + 1]) options[flag.slice(2)] = args[++index];
  else throw new Error(usage);
}
const filename = options.context ?? process.env.RENGINE_WORKSPACE_CONTEXT;
if (!filename || !['bootstrap', 'status', 'update', 'open', 'windows', 'window', 'report', 'inbox', 'script', 'show-session'].includes(action)) throw new Error(usage);
const context = JSON.parse(await readFile(filename, 'utf8'));
const original = await request(context, 'state');
if (original.instance !== context.instance || !original.roots.some(root => root.id === context.rootId)) throw new Error('The original project/session host is no longer available.');
if (action === 'bootstrap') {
  const runtime = await ensureRuntime(context, { directory: context.runtimeDirectory });
  console.log(JSON.stringify({ supervisorPid: runtime.pid, instance: runtime.instance, detail: 'Original host adopted; no desktop or CLI launched.' }));
} else {
  const runtime = await resolveRuntime(context), state = await request(runtime, 'state');
  if (state.capabilities.layeredUpdates !== 1) throw new Error('Layered updates are not installed. Use explicit bootstrap with this same context.');
  const scoped = route => `${route}?${new URLSearchParams({ rootId: context.rootId })}`;
  const status = () => request(runtime, scoped('update-status'));
  let result;
  if (action === 'status') result = await status();
  else if (action === 'windows') result = await request(runtime, scoped('project-windows'));
  else if (action === 'open') result = await request(runtime, 'project-window-open', { rootId: context.rootId, path: options.project, agentId: options.agent ?? process.env.RENGINE_ORCHESTRATOR_SESSION });
  else if (action === 'window') result = await request(runtime, 'project-window-action', { rootId: context.rootId, windowId: options.window, action: options.action, screenshot: options.screenshot === true });
  else if (action === 'script') {
    if (!options.script) throw new Error('Provide --script FILE containing path and optional args. Choose --desktop ID.');
    result = await request(runtime, 'script-open', { ...JSON.parse(await readFile(options.script, 'utf8')), rootId: context.rootId, desktopId: options.desktop });
  } else if (action === 'show-session') result = await request(runtime, 'session-view', { rootId: context.rootId, id: options.session, desktopId: options.desktop });
  else if (action === 'report') {
    if (!options.report) throw new Error('Provide --report FILE containing windowId, key, kind, summary and optional detail/evidence/fromProject.');
    result = await request(runtime, 'integration-report', { ...JSON.parse(await readFile(options.report, 'utf8')), rootId: context.rootId });
  } else if (action === 'inbox') {
    const query = new URLSearchParams({ rootId: context.rootId, after: options.after ?? '0', projectSide: options['project-side'] === true });
    if (options.window) query.set('windowId', options.window);
    result = await request(runtime, `integration-inbox?${query}`);
  } else {
    const queued = await request(runtime, 'update-workspace', { rootId: context.rootId, desktopId: options.desktop, layers: (options.layers ?? 'workspace,desktop,connector').split(',') });
    console.log(JSON.stringify(queued));
    const deadline = Date.now() + 180000;
    for (;;) {
      const job = (await status()).jobs.find(job => job.id === queued.jobId);
      if (job && ['succeeded', 'failed'].includes(job.status)) { result = job; if (job.status === 'failed') process.exitCode = 1; break; }
      if (Date.now() > deadline) throw new Error('Update observation timed out. Inspect status; the operation was not canceled.');
      await delay(250);
    }
  }
  console.log(JSON.stringify(result, null, 2));
}
