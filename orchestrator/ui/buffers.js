import { EditorView, keymap } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { basicSetup } from 'codemirror';
import { cpp } from '@codemirror/lang-cpp';
import { javascript } from '@codemirror/lang-javascript';
import { vim } from '@replit/codemirror-vim';
import { api, query } from './client.js';

const buffers = new Map();
let vimEnabled = false;
const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: '#15191f', color: '#dce2ea', fontSize: '13px' },
  '.cm-content': { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', caretColor: '#a1d4bd' },
  '.cm-gutters': { backgroundColor: '#15191f', color: '#687584', border: 'none' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: '#1d252e' },
  '.cm-scroller': { overflow: 'auto' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: '#344553' },
  '.cm-cursor': { borderLeftColor: '#b8e7d0' },
}, { dark: true });

function notify(buffer) { for (const listener of buffer.listeners) listener(); }
function schedule(buffer) {
  clearTimeout(buffer.timer);
  buffer.timer = setTimeout(() => checkpoint(buffer).catch(error => { buffer.error = error.message; notify(buffer); }), 250);
}

async function checkpoint(buffer) {
  clearTimeout(buffer.timer);
  if (buffer.saving) { await buffer.saving; return checkpoint(buffer); }
  if (!buffer.dirty) return buffer.flight;
  const draft = { rootId: buffer.rootId, path: buffer.path, text: buffer.text, baseVersion: buffer.version };
  buffer.flight = buffer.flight.catch(() => {}).then(() => api('draft', draft));
  await buffer.flight;
  buffer.checkpointAt = Date.now();
  notify(buffer);
}

export async function getBuffer(rootId, path) {
  const id = JSON.stringify([rootId, path]);
  if (buffers.has(id)) return buffers.get(id);
  const loading = (async () => {
    const file = await api(`file?${query({ rootId, path })}`);
    const buffer = { rootId, path: file.path, text: file.draft?.text ?? file.text, version: file.draft ? file.draft.baseVersion : file.version,
      dirty: Boolean(file.draft), error: '', conflict: Boolean(file.draft && file.draft.baseVersion !== file.version),
      checkpointAt: file.draft?.updatedAt, listeners: new Set(), flight: Promise.resolve(), vim: new Compartment() };
    const language = /\.(cpp|cc|c|h|hpp)$/.test(path) ? cpp() : /\.[cm]?[jt]sx?$/.test(path) ? javascript({ typescript: /\.tsx?$/.test(path), jsx: /x$/.test(path) }) : [];
    buffer.view = new EditorView({ state: EditorState.create({ doc: buffer.text, extensions: [basicSetup, theme, language,
      buffer.vim.of(vimEnabled ? vim() : []), EditorView.contentAttributes.of({ 'aria-label': `Editor ${path}` }),
      keymap.of([{ key: 'Mod-s', run: () => { saveBuffer(buffer).catch(() => {}); return true; } }]),
      EditorView.updateListener.of(update => {
        if (!update.docChanged) return;
        buffer.text = update.state.doc.toString(); buffer.dirty = true; buffer.error = ''; notify(buffer); schedule(buffer);
      })] }) });
    return buffer;
  })();
  buffers.set(id, loading);
  try { return await loading; } catch (error) { buffers.delete(id); throw error; }
}

export async function saveBuffer(buffer, overwrite = false) {
  if (buffer.saving) return buffer.saving;
  const action = (async () => {
    try {
      await checkpoint(buffer);
      const text = buffer.text;
      let version = buffer.version;
      if (overwrite) version = (await api(`file?${query({ rootId: buffer.rootId, path: buffer.path })}`)).version;
      const file = await api('save', { rootId: buffer.rootId, path: buffer.path, text, version });
      buffer.version = file.version; buffer.dirty = buffer.text !== text; buffer.error = ''; buffer.conflict = false;
    } catch (error) { buffer.error = error.message; buffer.conflict = error.status === 409; throw error; }
    finally { buffer.saving = null; notify(buffer); if (buffer.dirty && !buffer.conflict) schedule(buffer); }
  })();
  buffer.saving = action;
  notify(buffer);
  return action;
}

export async function reloadBuffer(buffer) {
  clearTimeout(buffer.timer);
  if (buffer.saving) await buffer.saving;
  await buffer.flight;
  const file = await api(`file?${query({ rootId: buffer.rootId, path: buffer.path })}`);
  await api('discard', { rootId: buffer.rootId, path: buffer.path });
  buffer.view.dispatch({ changes: { from: 0, to: buffer.view.state.doc.length, insert: file.text } });
  clearTimeout(buffer.timer);
  buffer.text = file.text; buffer.version = file.version; buffer.dirty = false; buffer.error = ''; buffer.conflict = false;
  notify(buffer);
}

export async function flushBuffers() { for (const buffer of buffers.values()) await checkpoint(await buffer); }
export async function setVim(enabled) {
  vimEnabled = enabled;
  for (const promise of buffers.values()) { const buffer = await promise; buffer.view.dispatch({ effects: buffer.vim.reconfigure(enabled ? vim() : []) }); }
}
