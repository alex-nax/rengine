const token = location.hash.slice(1);
const listeners = new Set();
let socket;
let reconnect;

export function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
function emit(value) { for (const listener of listeners) listener(value); }

export async function api(route, data) {
  const response = await fetch(`/api/${route}`, { method: data === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.error ?? `Request failed (${response.status})`); error.status = response.status; throw error; }
  return result;
}

export function send(message) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

export function connect() {
  if (socket && socket.readyState < WebSocket.CLOSING) return;
  socket = new WebSocket(`${location.origin.replace('http:', 'ws:')}/events?token=${encodeURIComponent(token)}`);
  socket.onmessage = event => { if (typeof event.data === 'string') emit(JSON.parse(event.data)); };
  socket.onclose = () => { emit({ type: 'disconnected' }); clearTimeout(reconnect); reconnect = setTimeout(connect, 1000); };
  socket.onerror = () => socket.close();
}

export const query = values => new URLSearchParams(values).toString();
