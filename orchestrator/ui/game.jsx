import React, { useEffect, useRef, useState } from 'react';

const keyCodes = {
  Enter: 40, Escape: 41, Backspace: 42, Tab: 43, Space: 44, Minus: 45, Equal: 46, BracketLeft: 47, BracketRight: 48,
  Backslash: 49, Semicolon: 51, Quote: 52, Backquote: 53, Comma: 54, Period: 55, Slash: 56, CapsLock: 57,
  PrintScreen: 70, ScrollLock: 71, Pause: 72, Insert: 73, Home: 74, PageUp: 75, Delete: 76, End: 77, PageDown: 78,
  ArrowRight: 79, ArrowLeft: 80, ArrowDown: 81, ArrowUp: 82, NumLock: 83, NumpadDivide: 84, NumpadMultiply: 85,
  NumpadSubtract: 86, NumpadAdd: 87, NumpadEnter: 88, Numpad0: 98, NumpadDecimal: 99,
  ControlLeft: 224, ShiftLeft: 225, AltLeft: 226, MetaLeft: 227, ControlRight: 228, ShiftRight: 229, AltRight: 230, MetaRight: 231,
};
for (let index = 0; index < 26; index++) keyCodes[`Key${String.fromCharCode(65 + index)}`] = 4 + index;
for (let index = 1; index <= 9; index++) { keyCodes[`Digit${index}`] = 29 + index; keyCodes[`Numpad${index}`] = 88 + index; }
keyCodes.Digit0 = 39;
for (let index = 1; index <= 12; index++) keyCodes[`F${index}`] = 57 + index;

export function GamePane({ id, name }) {
  const canvas = useRef(null);
  const socket = useRef(null);
  const [status, setStatus] = useState('Connecting to game');
  const [size, setSize] = useState('');
  const [captured, setCaptured] = useState(false);
  const send = (kind, values = []) => { if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ kind, values })); };
  useEffect(() => {
    let alive = true; let reconnect; let draw; let latest;
    const connect = () => {
      if (!alive) return;
      const ws = new WebSocket(`${location.origin.replace('http:', 'ws:')}/surface?token=${encodeURIComponent(location.hash.slice(1))}&id=${encodeURIComponent(id)}`);
      ws.binaryType = 'arraybuffer'; socket.current = ws;
      ws.onmessage = event => {
        if (typeof event.data === 'string') { const message = JSON.parse(event.data); setStatus(message.error ?? message.status); return; }
        latest = event.data;
        if (draw) return;
        draw = requestAnimationFrame(() => {
          draw = null;
          const frame = new DataView(latest);
          if (frame.byteLength < 24) return;
          const width = frame.getUint32(4, true), height = frame.getUint32(8, true);
          if (width < 1 || width > 1920 || height < 1 || height > 1080 || frame.byteLength !== 24 + width * height * 4) return;
          const target = canvas.current;
          if (!target) return;
          if (target.width !== width || target.height !== height) { target.width = width; target.height = height; }
          const pixels = new Uint8ClampedArray(width * height * 4);
          const source = new Uint8Array(latest, 24);
          for (let row = 0; row < height; row++) pixels.set(source.subarray(row * width * 4, (row + 1) * width * 4), (height - 1 - row) * width * 4);
          target.getContext('2d', { alpha: false }).putImageData(new ImageData(pixels, width, height), 0, 0);
          target.dataset.sequence = String(frame.getUint32(12, true));
          setSize(`${width} × ${height}`);
        });
      };
      ws.onclose = event => { if (alive) { setStatus(event.reason || 'Game disconnected'); if (event.code !== 1000 && event.code !== 1008) reconnect = setTimeout(connect, 1000); } };
      ws.onerror = () => ws.close();
    };
    const release = () => send(6);
    const pointer = () => { const locked = document.pointerLockElement === canvas.current; setCaptured(locked); if (!locked) release(); };
    window.addEventListener('blur', release); document.addEventListener('pointerlockchange', pointer);
    const observer = new ResizeObserver(() => { if (!canvas.current?.clientWidth || !canvas.current?.clientHeight) release(); });
    observer.observe(canvas.current);
    connect();
    return () => { alive = false; clearTimeout(reconnect); cancelAnimationFrame(draw); release(); socket.current?.close(); observer.disconnect();
      window.removeEventListener('blur', release); document.removeEventListener('pointerlockchange', pointer); if (document.pointerLockElement === canvas.current) document.exitPointerLock(); };
  }, [id]);
  const coordinates = event => {
    const rect = canvas.current.getBoundingClientRect();
    return [Math.round((event.clientX - rect.left) * canvas.current.width / rect.width), Math.round((event.clientY - rect.top) * canvas.current.height / rect.height)];
  };
  const key = (event, down) => { const scancode = keyCodes[event.code]; if (scancode !== undefined) { event.preventDefault(); event.stopPropagation(); send(1, [scancode, down ? 1 : 0, event.repeat ? 1 : 0]); } };
  return <div className="game pane"><div className="pane-tools"><span>{name ?? 'NOLF'} · {status}</span><span className="muted">{size}</span>
    <button onClick={() => { canvas.current.focus(); canvas.current.requestPointerLock()?.catch(error => setStatus(error.message)); }}>{captured ? 'Mouse captured · Esc releases' : 'Capture mouse'}</button></div>
    <div className="game-stage"><canvas ref={canvas} aria-label="Live NOLF game" tabIndex={0} width={1280} height={720}
      onFocus={() => send(5, [1])} onBlur={() => send(5, [0])} onContextMenu={event => event.preventDefault()}
      onKeyDown={event => key(event, true)} onKeyUp={event => key(event, false)}
      onMouseDown={event => { canvas.current.focus(); send(5, [1]); send(3, [[1, 2, 3, 4, 5][event.button], 1, ...coordinates(event)]); }}
      onMouseUp={event => send(3, [[1, 2, 3, 4, 5][event.button], 0, ...coordinates(event)])}
      onMouseMove={event => send(2, [...coordinates(event), Math.round(event.movementX), Math.round(event.movementY)])}
      onWheel={event => send(4, [Math.sign(-event.deltaX), Math.sign(-event.deltaY)])} /></div>
    <div className="terminal-status"><span>Click game to focus · Capture mouse for relative aiming</span><span>Close tab to detach</span></div></div>;
}
