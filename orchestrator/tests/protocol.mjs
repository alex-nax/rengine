import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

export function checkConnection(value) {
  const url = new URL(value.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      !/^[0-9a-f]{64}$/.test(value.token) || !/^[0-9a-f-]{36}$/.test(value.instance)) throw new Error('Invalid local workspace connection.');
  return { url: value.url, token: value.token, instance: value.instance,
    ...(Number.isSafeInteger(value.pid) && value.pid > 0 ? { pid: value.pid } : {}) };
}
export function authenticated(request, token, url) {
  const candidate = request.headers.authorization?.replace(/^Bearer /, '');
  return typeof candidate === 'string' && /^[0-9a-f]{64}$/.test(candidate) &&
    timingSafeEqual(Buffer.from(candidate), Buffer.from(token)) && (!request.headers.origin || request.headers.origin === url);
}
export function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(value));
}
export function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
export async function body(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) fail('Expected application/json.', 415);
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 8 * 1024 * 1024) fail('Request body is too large.', 413); chunks.push(chunk); }
  let data; try { data = JSON.parse(Buffer.concat(chunks)); } catch { fail('Malformed JSON.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('Expected an object.');
  return data;
}
export function forward(request, response, target, done = () => {}) {
  if (!request.url.startsWith('/') || request.url.startsWith('//')) { json(response, 400, { error: 'Expected a workspace-relative endpoint.' }); done(); return; }
  const headers = { ...request.headers, host: new URL(target.url).host, authorization: `Bearer ${target.token}` };
  delete headers.origin;
  const upstream = http.request(new URL(request.url, target.url), { method: request.method, headers }, incoming => {
    response.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(response);
  });
  let completed = false;
  const finish = () => { if (!completed) { completed = true; done(); } };
  upstream.on('error', error => { if (!response.headersSent) json(response, 502, { error: error.message }); else response.destroy(); finish(); });
  response.once('finish', finish);
  response.once('close', () => { upstream.destroy(); finish(); });
  request.pipe(upstream);
}
export function tunnel(request, socket, head, target, done) {
  if (!request.url.startsWith('/') || request.url.startsWith('//')) { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); done(); return; }
  const url = new URL(request.url, target.url); url.searchParams.set('token', target.token);
  const headers = { ...request.headers, host: url.host }; delete headers.origin;
  const upstream = http.request(url, { headers });
  let peer, completed = false;
  const finish = () => { if (!completed) { completed = true; peer?.destroy(); upstream.destroy(); done(); } };
  socket.once('close', finish); socket.on('error', finish);
  upstream.once('upgrade', (response, stream, extra) => {
    peer = stream;
    socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n${Object.entries(response.headers).map(([k,v]) => `${k}: ${v}\r\n`).join('')}\r\n`);
    if (extra.length) socket.write(extra); if (head.length) stream.write(head);
    stream.on('error', () => socket.destroy()); stream.once('close', () => socket.destroy());
    socket.pipe(stream).pipe(socket);
  });
  upstream.once('response', () => socket.destroy());
  upstream.once('error', () => socket.destroy()); upstream.end();
}
