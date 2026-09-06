import { randomUUID } from 'node:crypto';
import { fail } from './store.mjs';

export class Desktops {
  constructor(store, sessions, timeout = 4000) { this.store = store; this.sessions = sessions; this.timeout = timeout; this.clients = new Map(); this.pending = new Map(); }
  register(socket, data) {
    if (!Array.isArray(data.rootIds) || data.rootIds.length > 128 || !Array.isArray(data.sessionIds) || data.sessionIds.length > 64) fail('Invalid desktop bindings.');
    const rootIds = [...new Set(data.rootIds)], sessionIds = [...new Set(data.sessionIds)];
    for (const root of rootIds) this.store.root(root);
    for (const id of sessionIds) if (!rootIds.includes(this.sessions.snapshot(id).rootId)) fail('Desktop session has a different root.');
    let desktop = this.clients.get(socket);
    if (!desktop) {
      desktop = { id: randomUUID(), socket }; this.clients.set(socket, desktop);
      socket.once('close', () => {
        this.clients.delete(socket);
        for (const [id, request] of this.pending) if (request.desktop === desktop) this.finish(id, new Error('Desktop disconnected before acknowledging reload.'));
      });
    }
    Object.assign(desktop, { rootIds, sessionIds, canReload: data.canReload === true, canAttach: data.canAttach === true,
      ...(typeof data.owner === 'string' && typeof data.view === 'string' ? { owner: data.owner.slice(0, 64), view: data.view.slice(0, 64) } : {}) });
    socket.send(JSON.stringify({ type: 'desktop-registered', id: desktop.id }));
  }
  list(rootId) {
    this.store.root(rootId);
    return [...this.clients.values()].filter(x => x.rootIds.includes(rootId)).map(({ socket, ...desktop }) => desktop);
  }
  target(rootId, desktopId, action) {
    this.store.root(rootId);
    const desktop = [...this.clients.values()].find(x => x.id === desktopId && x.rootIds.includes(rootId));
    if (!desktop) fail('Desktop is not attached to this project.', 404);
    if (action === 'reload' && !desktop.canReload) fail('This desktop was not started through the reload-capable launcher.', 409);
    if (action === 'attach-session' && !desktop.canAttach) fail('Update this desktop before opening script tabs.', 409);
    if ([...this.pending.values()].some(x => x.desktop === desktop)) fail('A desktop action is already pending.', 409);
    return desktop;
  }
  reload(rootId, desktopId) { return this.action(rootId, desktopId, 'reload'); }
  attach(rootId, desktopId, session) {
    if (session.rootId !== rootId) fail('Session belongs to another root.', 403);
    return this.action(rootId, desktopId, 'attach-session', { session });
  }
  action(rootId, desktopId, action, payload = {}) {
    const desktop = this.target(rootId, desktopId, action);
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.finish(requestId, new Error('Desktop did not acknowledge the action.')), this.timeout);
      this.pending.set(requestId, { desktop, action, timer, resolve, reject });
      try { desktop.socket.send(JSON.stringify({ type: 'desktop-action', action, desktopId, requestId, ...payload })); }
      catch (error) { this.finish(requestId, error); }
    });
  }
  acknowledge(socket, data) {
    const request = this.pending.get(data.requestId);
    if (!request || request.desktop.socket !== socket) fail('Unknown desktop action acknowledgement.');
    this.finish(data.requestId, data.accepted === true ? null : new Error(`Desktop rejected ${request.action === 'reload' ? 'reload' : 'session attachment'} because it is closing or cannot perform it.`));
  }
  finish(id, error) {
    const request = this.pending.get(id); if (!request) return;
    clearTimeout(request.timer); this.pending.delete(id);
    if (error) request.reject(error);
    else request.resolve({ requestId: id, desktopId: request.desktop.id, status: 'accepted', detail: request.action === 'reload' ? 'Native reload requested. Re-list desktops after rebuild; accepted does not mean the build succeeded.' : 'Retained session attached to a native tab.' });
  }
}
