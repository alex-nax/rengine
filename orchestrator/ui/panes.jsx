import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { api, query, send, subscribe } from './client.js';
import { getBuffer, saveBuffer, reloadBuffer } from './buffers.js';

export function TreePane({ root, openFile }) {
  const [revision, refresh] = useState(0);
  const [hidden, setHidden] = useState(false);
  return <div className="tree pane"><div className="pane-tools"><span title={root.path}>{root.name}</span>
    <button onClick={() => refresh(revision + 1)} title="Refresh project tree">↻</button>
    <label><input type="checkbox" checked={hidden} onChange={event => setHidden(event.target.checked)} />All</label></div>
    <div className="tree-path" title={root.path}>{root.path}</div>
    <Folder key={`${revision}:${hidden}`} root={root} path="" hidden={hidden} openFile={openFile} depth={0} />
  </div>;
}

function Folder({ root, path, hidden, openFile, depth }) {
  const [listing, setListing] = useState(null);
  const [expanded, setExpanded] = useState({});
  const [error, setError] = useState('');
  useEffect(() => { let alive = true; api(`tree?${query({ rootId: root.id, path, hidden })}`).then(data => { if (alive) setListing(data); }).catch(error => { if (alive) setError(error.message); }); return () => { alive = false; }; }, [root.id, path, hidden]);
  if (error) return <p className="error">{error}</p>;
  if (!listing) return <div className="muted pad">Loading…</div>;
  return <div>{listing.entries.map(entry => <React.Fragment key={entry.path}>
    <button className="tree-entry" style={{ paddingLeft: `${12 + depth * 14}px` }} title={entry.path}
      onClick={() => entry.directory ? setExpanded({ ...expanded, [entry.path]: !expanded[entry.path] }) : openFile(root.id, entry.path)}>
      <span aria-hidden="true" className="file-icon">{entry.directory ? expanded[entry.path] ? '▾' : '▸' : '·'}</span>{entry.name}
    </button>
    {entry.directory && expanded[entry.path] && <Folder root={root} path={entry.path} hidden={hidden} openFile={openFile} depth={depth + 1} />}
  </React.Fragment>)}{listing.truncated && <p className="muted pad">Showing the first 2,000 entries.</p>}</div>;
}

export function EditorPane({ rootId, path }) {
  const host = useRef(null);
  const [buffer, setBuffer] = useState(null);
  const [, redraw] = useState(0);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true; let detach;
    getBuffer(rootId, path).then(buffer => {
      if (!alive) return;
      setBuffer(buffer); host.current.appendChild(buffer.view.dom); buffer.view.requestMeasure();
      const listener = () => redraw(value => value + 1);
      buffer.listeners.add(listener); detach = () => buffer.listeners.delete(listener);
    }).catch(error => { if (alive) setError(error.message); });
    return () => { alive = false; detach?.(); };
  }, [rootId, path]);
  return <div className="editor pane">
    <div className="pane-tools"><span title={path}>{path}</span><span className="muted">{buffer?.dirty ? 'Unsaved' : 'Saved'}</span>
      <button aria-label="Save file" disabled={!buffer || Boolean(buffer.saving)} onClick={() => saveBuffer(buffer).catch(() => {})}>Save</button>
      <button disabled={!buffer} onClick={() => reloadBuffer(buffer).catch(error => setError(error.message))}>Discard & reload</button></div>
    {(error || buffer?.error) && <div className="error">{error || buffer.error}</div>}
    {buffer?.conflict && <div className="conflict">The file changed on disk. Your draft is retained.
      <button onClick={() => saveBuffer(buffer, true).catch(() => {})}>Save over disk version</button></div>}
    <div className="editor-host" ref={host} />
    <div className="editor-status">{buffer?.dirty ? buffer.checkpointAt ? 'Recovery draft retained locally' : 'Saving recovery draft…' : 'UTF-8 · explicit save'}<span>{rootId.slice(0, 8)}</span></div>
  </div>;
}

export function TerminalPane({ id }) {
  const host = useRef(null);
  const [status, setStatus] = useState('Attaching…');
  useEffect(() => {
    const terminal = new Terminal({ fontSize: 13, fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', cursorBlink: true, scrollback: 10000,
      theme: { background: '#12161b', foreground: '#d7dfe7', cursor: '#b5ddc5', selectionBackground: '#344b5d' }, allowProposedApi: false });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host.current);
    let attached = false; let sequence = 0; let pending = [];
    const apply = message => { if (message.sequence > sequence) { terminal.write(message.data); sequence = message.sequence; } };
    const off = subscribe(message => {
      if (message.type === 'hello') { attached = false; pending = []; send({ type: 'attach', id }); }
      if (message.type === 'disconnected') { terminal.options.disableStdin = true; setStatus('Disconnected — reconnecting'); }
      if (message.type === 'attached' && message.session.id === id) {
        terminal.reset(); terminal.write(message.session.output); sequence = message.session.sequence; attached = true;
        terminal.options.disableStdin = message.session.state !== 'running'; setStatus(`${message.session.state} · PID ${message.session.pid}`);
        for (const output of pending) apply(output); pending = []; resize();
      }
      if (message.type === 'output' && message.id === id) { if (attached) apply(message); else pending.push(message); }
      if (message.type === 'session' && message.session.id === id) {
        setStatus(`${message.session.state} · PID ${message.session.pid}`); terminal.options.disableStdin = message.session.state !== 'running';
      }
    });
    const resize = () => { if (host.current?.clientWidth > 0 && host.current?.clientHeight > 0) { fit.fit(); send({ type: 'resize', id, cols: terminal.cols, rows: terminal.rows }); } };
    const observer = new ResizeObserver(resize); observer.observe(host.current);
    const input = terminal.onData(data => send({ type: 'input', id, data }));
    send({ type: 'attach', id }); resize();
    return () => { off(); observer.disconnect(); input.dispose(); terminal.dispose(); };
  }, [id]);
  return <div className="terminal pane"><div ref={host} className="terminal-host" /><div className="terminal-status">{status}<span>Close tab to detach</span></div></div>;
}

export function SessionPane({ state, attach, refresh }) {
  const [error, setError] = useState('');
  return <div className="session-browser pane"><div className="pane-tools"><span>Retained sessions</span><button onClick={refresh}>Refresh</button></div>
    {error && <p className="error">{error}</p>}
    {state.sessions.length === 0 && <p className="muted pad">No sessions yet. Open a terminal or agent to begin.</p>}
    {state.sessions.map(session => <div className="session-row" key={session.id}><div><strong>{session.title}</strong>
      <div className="muted">{state.roots.find(root => root.id === session.rootId)?.path ?? session.rootId}</div>
      <div className="session-meta"><span>{session.state}</span><span>{session.pid}</span><span>{session.id.slice(0, 8)}</span></div></div>
      <button onClick={() => attach(session)}>Attach</button><button disabled={session.state === 'exited'} onClick={async () => {
        try { await api('stop', { id: session.id }); await refresh(); } catch (error) { setError(error.message); }
      }}>Stop</button></div>)}
    <h3 className="pad">Recovery drafts</h3>{state.drafts.map(draft => <div className="session-row" key={`${draft.rootId}:${draft.path}`}>
      <span>{draft.path}</span><button onClick={() => attach({ type: 'editor', ...draft })}>Open draft</button></div>)}
  </div>;
}
