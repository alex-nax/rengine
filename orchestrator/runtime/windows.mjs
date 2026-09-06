import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fail } from './protocol.mjs';

export async function windowStore(directory) {
  const filename = path.join(directory, 'project-windows.json');
  let state = { version: 1, windows: [], reports: [] }, serial = Promise.resolve();
  try { state = JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (state.version !== 1 || !Array.isArray(state.windows) || !Array.isArray(state.reports)) fail('Unsupported project window store.');
  const write = action => {
    const result = serial.then(async () => {
      const next = structuredClone(state), value = action(next), bytes = JSON.stringify(next);
      if (Buffer.byteLength(bytes) > 32 * 1024 * 1024) fail('Project window store is full; archive it before adding more data.', 409);
      const temp = `${filename}.tmp`;
      await writeFile(temp, bytes, { mode: 0o600 }); await rename(temp, filename); state = next; return value;
    });
    serial = result.catch(() => {}); return result;
  };
  const own = (data, rootId, id) => {
    const window = data.windows.find(x => x.id === id && [x.originRootId, x.projectRootId].includes(rootId));
    if (!window) fail('Window is not linked to this project.', 404); return window;
  };
  return {
    list: rootId => state.windows.filter(x => [x.originRootId, x.projectRootId].includes(rootId)).map(({ layout, ...x }) => x),
    get: (rootId, id) => structuredClone(own(state, rootId, id)),
    async create(originRootId, project, agentId) {
      return write(data => {
        const existing = data.windows.find(x => x.originRootId === originRootId && x.projectRootId === project.id && x.agentId === agentId);
        if (existing) return structuredClone(existing);
        if (data.windows.length >= 64) fail('Project window limit reached.', 409);
        const window = { id: randomUUID(), originRootId, projectRootId: project.id, agentId, title: project.name, createdAt: Date.now(), layout: null };
        data.windows.push(window); return structuredClone(window);
      });
    },
    async layout(id, layout) {
      if (!layout || typeof layout !== 'object' || JSON.stringify(layout).length > 1024 * 1024) fail('Invalid project window layout.');
      return write(data => {
        const window = data.windows.find(x => x.id === id); if (!window) fail('Unknown project window.', 404);
        window.layout = layout; return { saved: true };
      });
    },
    stateLayout(id) { const window = state.windows.find(x => x.id === id); if (!window) fail('Unknown project window.', 404); return window.layout; },
    report(rootId, input) {
      return write(data => {
        const window = own(data, rootId, input.windowId);
        const senderRootId = input.fromProject === true ? window.projectRootId : rootId;
        if (input.fromProject && rootId !== window.originRootId) fail('Only the originating agent may report its linked project findings.', 403);
        const destinationRootId = senderRootId === window.originRootId ? window.projectRootId : window.originRootId;
        const { key, kind, summary, detail = '', evidence = [] } = input;
        if (typeof key !== 'string' || !key.length || key.length > 128 || !['issue', 'status'].includes(kind) ||
            typeof summary !== 'string' || !summary.trim() || summary.length > 2000 || typeof detail !== 'string' || detail.length > 16000 ||
            !Array.isArray(evidence) || evidence.length > 10 || evidence.some(x => typeof x !== 'string' || x.length > 2048)) fail('Invalid integration report.');
        const content = { windowId: window.id, reportedByRootId: rootId, senderRootId, destinationRootId, key, kind, summary, detail, evidence };
        const existing = data.reports.find(x => x.windowId === window.id && x.senderRootId === senderRootId && x.key === key);
        if (existing) {
          if (Object.keys(content).some(k => JSON.stringify(content[k]) !== JSON.stringify(existing[k]))) fail('Report retry key already has different content.', 409);
          return { report: existing, reused: true };
        }
        if (data.reports.length >= 10000) fail('Integration report limit reached; archive before adding reports.', 409);
        const report = { ...content, sequence: (data.reports.at(-1)?.sequence ?? 0) + 1, timestamp: Date.now() };
        data.reports.push(report); return { report, reused: false };
      });
    },
    inbox(rootId, { after = 0, windowId, projectSide = false } = {}) {
      if (!Number.isSafeInteger(after) || after < 0) fail('Invalid inbox cursor.');
      const window = windowId ? own(state, rootId, windowId) : null;
      if (projectSide && (!window || rootId !== window.originRootId)) fail('Choose an originating project window for its project inbox.', 403);
      const recipient = projectSide ? window.projectRootId : rootId;
      const reports = state.reports.filter(x => x.sequence > after && x.destinationRootId === recipient && (!window || x.windowId === window.id)).slice(0, 100);
      return { reports, cursor: reports.at(-1)?.sequence ?? after, hasMore: state.reports.some(x => x.sequence > (reports.at(-1)?.sequence ?? after) && x.destinationRootId === recipient && (!window || x.windowId === window.id)) };
    },
  };
}

export function nativeControl(child) {
  let serial = -1, buffer = ''; const pending = new Map();
  const finish = (id, error, value) => { const request = pending.get(id); if (!request) return; pending.delete(id); clearTimeout(request.timer); error ? request.reject(error) : request.resolve(value); };
  child.stdout.on('data', bytes => {
    buffer += bytes;
    if (buffer.length > 8 * 1024 * 1024) { buffer = ''; for (const id of pending.keys()) finish(id, new Error('Native inspection exceeded its bounded response.')); return; }
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { const value = JSON.parse(line); finish(value.id, null, value.result); } catch { /* Native diagnostics are separate from replies. */ }
    }
  });
  child.once('exit', () => { for (const id of pending.keys()) finish(id, new Error('Native window exited.')); });
  child.stdin.on('error', error => { for (const id of pending.keys()) finish(id, error); });
  return command => new Promise((resolve, reject) => {
    const id = serial--, timer = setTimeout(() => finish(id, new Error('Native window did not respond.')), 5000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ ...command, id })}\n`, error => { if (error) finish(id, error); });
  });
}

export async function inspectWindow(record, directory, screenshot) {
  const state = await record.control({ op: 'control-state' });
  if (!state || typeof state !== 'object') fail('Native window does not support inspection.', 409);
  delete state.state;
  let snapshot;
  if (screenshot) {
    const captures = path.join(directory, 'inspection'); await mkdir(captures, { recursive: true, mode: 0o700 });
    snapshot = path.join(captures, `${record.binding.owner}-${randomUUID()}.bmp`);
    if (await record.control({ op: 'control-snapshot', path: snapshot }) !== true) fail('Native snapshot failed.');
  }
  return { pid: record.child.pid, state, diagnostics: record.diagnostics, ...(snapshot ? { snapshot } : {}) };
}
