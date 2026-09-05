import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Actions, DockLocation, Layout, Model } from 'flexlayout-react';
import { api, connect, subscribe } from './client.js';
import { flushBuffers, setVim } from './buffers.js';
import { EditorPane, SessionPane, TerminalPane, TreePane } from './panes.jsx';
import { GamePane } from './game.jsx';
import 'flexlayout-react/style/dark.css';
import '@xterm/xterm/css/xterm.css';
import './style.css';

function initialLayout(root) {
  return { global: { tabSetEnableDeleteWhenEmpty: false, tabEnablePopout: false, splitterSize: 6 }, borders: [],
    layout: { type: 'row', children: [
      ...(root ? [{ type: 'tabset', weight: 23, children: [{ type: 'tab', id: `tree:${root.id}`, name: root.name,
        component: 'tree', config: { rootId: root.id } }] }] : []),
      { type: 'tabset', id: 'main', weight: 77, active: true, children: [] },
    ] } };
}

function App({ initial }) {
  const requested = new URLSearchParams(location.search);
  const [state, setState] = useState(initial);
  const [rootId, selectRoot] = useState(requested.get('root') ?? initial.roots[0]?.id ?? '');
  const [agent, selectAgent] = useState(initial.preferences.agent ?? '');
  const [vim, changeVim] = useState(initial.preferences.vim ?? false);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [model] = useState(() => Model.fromJson(initial.layout ?? initialLayout(initial.roots.find(root => root.id === rootId))));
  const layoutWrite = useRef(Promise.resolve());
  const timer = useRef();
  const persist = () => {
    clearTimeout(timer.current);
    const layout = model.toJson();
    layoutWrite.current = layoutWrite.current.catch(() => {}).then(() => api('layout', { layout }));
    return layoutWrite.current;
  };
  const refresh = async () => { const next = await api('state'); setState(next); return next; };
  const act = async task => { setBusy(true); setError(''); try { return await task(); } catch (error) { setError(error.message); } finally { setBusy(false); } };
  const add = (tab, location = DockLocation.CENTER) => {
    if (model.getNodeById(tab.id)) { model.doAction(Actions.selectTab(tab.id)); return; }
    let target = model.getActiveTabset();
    if (location === DockLocation.CENTER && tab.component !== 'tree' && target?.getSelectedNode()?.getComponent() === 'tree') {
      target = model.getNodeById('main');
    }
    target ??= model.getNodeById('main') ?? model.getRootRow().getChildren().find(node => node.getType() === 'tabset');
    model.doAction(Actions.addTab({ type: 'tab', ...tab }, target?.getId() ?? model.getRootRow().getId(), location, -1, true));
  };
  const openFile = (boundRoot, path) => add({ id: `file:${JSON.stringify([boundRoot, path])}`, name: path.split('/').pop(), component: 'editor', config: { rootId: boundRoot, path } });
  const attach = session => {
    if (session.type === 'editor') return openFile(session.rootId, session.path);
    add({ id: `session:${session.id}`, name: session.title, component: session.type === 'game' ? 'game' : 'terminal', config: { id: session.id, rootId: session.rootId } });
  };
  const launch = (type, action = 'launch') => act(async () => {
    await api('preferences', { agent, vim });
    const session = await api('terminal', { rootId, type, ...(type === 'agent' ? { agent: agent || undefined, action: agent ? action : 'menu' } : {}) });
    attach(session); await refresh();
  });
  const tree = id => { const root = state.roots.find(value => value.id === id); if (root) add({ id: `tree:${id}`, name: root.name, component: 'tree', config: { rootId: id } }); };
  useEffect(() => {
    setVim(vim).catch(error => setError(error.message));
    if (requested.has('root')) tree(rootId);
    for (const name of ['terminal', 'agent', 'game']) {
      const session = initial.sessions.find(item => item.id === requested.get(name));
      if (session) attach(session);
    }
    const off = subscribe(message => {
      if (message.type === 'hello') { setConnected(true); refresh().catch(error => setError(error.message)); }
      if (message.type === 'disconnected') setConnected(false);
      if (message.type === 'session') setState(previous => ({ ...previous, sessions: [...previous.sessions.filter(item => item.id !== message.session.id), message.session] }));
    });
    connect();
    const removeClose = window.rengine?.onPrepareClose(async () => {
      try { await flushBuffers(); await persist(); window.rengine.finishClose(); }
      catch (error) { setError(`Could not retain workspace before closing: ${error.message}`); window.rengine.cancelClose(error.message); }
    });
    return () => { off(); removeClose?.(); clearTimeout(timer.current); };
  }, []);
  const factory = node => {
    const config = node.getConfig();
    const root = state.roots.find(root => root.id === config?.rootId);
    if (node.getComponent() === 'sessions') return <SessionPane state={state} attach={attach} refresh={refresh} />;
    if (!root && config?.rootId) return <p className="error">The bound project is unavailable. Reopen its original root.</p>;
    switch (node.getComponent()) {
      case 'tree': return <TreePane root={root} openFile={openFile} />;
      case 'editor': return <EditorPane {...config} />;
      case 'terminal': return <TerminalPane {...config} />;
      case 'game': return <GamePane {...config} name={root.name} />;
      default: return <div className="empty-pane"><strong>Your workspace</strong><p>Open a tree, terminal or agent here.</p><p>Drag tabs to arrange your panes.</p></div>;
    }
  };
  return <div className="workspace">
    <header><div className="brand">r<span>Engine</span></div><div className="workspace-title">WORKSPACE</div>
      <span className={`connection ${connected ? 'online' : ''}`}>{connected ? 'Connected' : 'Reconnecting'}</span></header>
    <div className="toolbar">
      <select aria-label="Project for new sessions" value={rootId} onChange={event => selectRoot(event.target.value)}>
        {!state.roots.length && <option value="">No project</option>}{state.roots.map(root => <option key={root.id} value={root.id}>{root.name} · {root.path}</option>)}
      </select>
      <button disabled={busy} onClick={() => act(async () => {
        const chosen = await window.rengine?.chooseProject(); if (!chosen) return;
        const root = await api('roots', { path: chosen }); const next = await refresh(); selectRoot(root.id);
        add({ id: `tree:${root.id}`, name: next.roots.find(item => item.id === root.id).name, component: 'tree', config: { rootId: root.id } });
      })}>Add project</button>
      <button disabled={!rootId} onClick={() => tree(rootId)}>Project tree</button>
      <button disabled={!rootId || busy} onClick={() => launch('terminal')}>New terminal</button>
      <button disabled={!rootId || busy} onClick={() => act(async () => { attach(await api('game', { rootId })); await refresh(); })}>Launch NOLF</button>
      <button onClick={() => act(async () => { await flushBuffers(); await refresh(); add({ id: 'sessions', name: 'Sessions', component: 'sessions' }); })}>Session browser</button>
      <div className="toolbar-spacer" />
      <button title="Split active pane vertically" onClick={() => add({ id: crypto.randomUUID(), name: 'Empty pane', component: 'empty' }, DockLocation.RIGHT)}>Split right</button>
      <button title="Split active pane horizontally" onClick={() => add({ id: crypto.randomUUID(), name: 'Empty pane', component: 'empty' }, DockLocation.BOTTOM)}>Split down</button>
    </div>
    <div className="agent-bar"><span>AGENT</span><input aria-label="Preferred CLI agent" placeholder="Choose in terminal, or enter codex / claude / path" value={agent} onChange={event => selectAgent(event.target.value)} />
      <button disabled={!rootId || busy} onClick={() => launch('agent')}>Launch agent</button>
      <button disabled={!rootId || busy} onClick={() => launch('agent', 'menu')}>Manage agents</button>
      <div className="toolbar-spacer" /><label><input type="checkbox" checked={vim} onChange={event => {
        const enabled = event.target.checked; changeVim(enabled); act(async () => { await setVim(enabled); await api('preferences', { vim: enabled }); });
      }} /> Vim mode</label></div>
    {error && <div className="workspace-error" role="alert">{error}<button onClick={() => setError('')}>Dismiss</button></div>}
    <main><Layout model={model} factory={factory} onTabSetPlaceHolder={() => <div className="empty-pane"><strong>Your workspace</strong><p>Open a tree, terminal or agent here.</p><p>Use Split to arrange new panes.</p></div>}
      onModelChange={() => { clearTimeout(timer.current); timer.current = setTimeout(() => persist().catch(error => setError(error.message)), 150); }}
      onAction={action => {
        if (action.type === Actions.DELETE_TAB || action.type === Actions.DELETE_TABSET) {
          act(async () => { await flushBuffers(); model.doAction(action); }); return undefined;
        }
        return action;
      }} /></main>
    <footer><span>{state.roots.length} project{state.roots.length === 1 ? '' : 's'}</span><span>{state.sessions.filter(session => session.state === 'running').length} running sessions</span>
      <span className="toolbar-spacer" /><span>Views detach · Stop sessions in the browser</span></footer>
  </div>;
}

api('state').then(initial => createRoot(document.getElementById('root')).render(<App initial={initial} />))
  .catch(error => { document.getElementById('root').textContent = `Unable to open workspace: ${error.message}`; });
