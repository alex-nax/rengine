/* Browser sign-in for a tracker provider (spec 083).
 *
 * The desktop is a public client: it cannot keep a secret, so this is the authorization code flow
 * with PKCE. Linear's own parameter table lists client_secret as optional once code_verifier is
 * present, on the exchange and on every refresh of a grant created this way, so no secret is shipped
 * or stored.
 *
 * The redirect port is fixed rather than ephemeral, which is the one place this departs from the
 * usual native-app shape. Linear matches redirect URIs exactly and implements no port wildcard, so a
 * callback on an OS-assigned port would never be accepted. The listener is opened only for the
 * duration of a sign-in and bound to the loopback interface.
 */
import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fail } from './store.mjs';

/* Register these as redirect URIs once, when creating the application. Several so a busy port does
   not end the attempt; the setup message lists every one so they can be pasted together. */
export const CALLBACK_PORTS = [47821, 47822, 47823, 47824, 47825];
export const CALLBACK_PATH = '/tracker/callback';
export const callbackUri = port => `http://127.0.0.1:${port}${CALLBACK_PATH}`;

const AUTHORIZE = 'https://linear.app/oauth/authorize';
const TOKEN = 'https://api.linear.app/oauth/token';
const REVOKE = 'https://api.linear.app/oauth/revoke';
/* Comma separated, which is Linear's own departure from the usual space separation. */
const SCOPES = 'read';
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
/* Refresh before the hour is out rather than on expiry, so an in-flight read never races it. */
const REFRESH_MARGIN_MS = 60 * 60 * 1000;

const base64url = buffer => buffer.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
export const challengeFor = verifier => base64url(createHash('sha256').update(verifier).digest());

/* Where a person puts the client id after registering the application once. It is not a secret, but
   it is per-workspace, so it lives beside the workspace state rather than in the source. */
export async function client(stateDirectory) {
  try {
    const value = JSON.parse(await readFile(path.join(stateDirectory, 'trackers', 'oauth.json'), 'utf8'));
    return value?.linear?.clientId ? { clientId: String(value.linear.clientId) } : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function setupInstructions(stateDirectory) {
  return {
    step1: 'Create an application at https://linear.app/settings/api/applications/new',
    step2: `Register these redirect URIs on it: ${CALLBACK_PORTS.map(callbackUri).join(' ')}`,
    step3: `Write its client id to ${path.join(stateDirectory, 'trackers', 'oauth.json')} as {"linear":{"clientId":"..."}}`,
    note: 'The client secret is not needed and should not be stored: this is a public client using PKCE.',
  };
}

/* One sign-in at a time per workspace. A second start replaces the first rather than leaving a
   listener and a pending state behind. */
let pending = null;

export function cancel() {
  if (!pending) return;
  clearTimeout(pending.timer);
  pending.server.close();
  pending = null;
}

async function listen(server) {
  for (const port of CALLBACK_PORTS) {
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
      });
      return port;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  return null;
}

const page = message => `<!doctype html><meta charset="utf-8"><title>rEdit</title>
<body style="font:14px system-ui;padding:3rem;color:#242424"><p>${message}</p></body>`;

/* Starts a sign-in: returns the URL to open. The browser comes back to the loopback listener, which
   completes the exchange and stores the grant, so the desktop only ever handles a URL. */
export async function begin(stateDirectory, project, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const registered = await client(stateDirectory);
  if (!registered) fail('No Linear application is registered for this workspace yet.', 409);
  cancel();

  const verifier = base64url(randomBytes(32));
  const state = base64url(randomBytes(24));
  const server = http.createServer();
  const port = await listen(server);
  if (port === null) fail(`Every sign-in port is busy (${CALLBACK_PORTS.join(', ')}). Close what is using one and try again.`, 503);
  const redirect = callbackUri(port);

  const settled = new Promise(resolve => {
    server.on('request', async (request, response) => {
      const target = new URL(request.url, redirect);
      if (target.pathname !== CALLBACK_PATH) { response.writeHead(404).end(); return; }
      const returned = target.searchParams.get('state') ?? '';
      /* The callback carries no workspace credential, so the one-time state is what authorises it. */
      const expected = Buffer.from(state);
      const actual = Buffer.from(returned);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        response.writeHead(400, { 'Content-Type': 'text/html' }).end(page('That sign-in did not match this workspace. Nothing was stored.'));
        return;
      }
      const denied = target.searchParams.get('error');
      if (denied) {
        response.writeHead(200, { 'Content-Type': 'text/html' }).end(page('Sign-in was declined. You can close this tab.'));
        cancel(); resolve({ ok: false, error: denied });
        return;
      }
      try {
        const grant = await exchange(fetchImpl, {
          clientId: registered.clientId, code: target.searchParams.get('code'), redirect, verifier,
        });
        await store(stateDirectory, project, grant);
        response.writeHead(200, { 'Content-Type': 'text/html' }).end(page('Signed in. You can close this tab and go back to rEdit.'));
        cancel(); resolve({ ok: true });
      } catch (error) {
        response.writeHead(500, { 'Content-Type': 'text/html' }).end(page(`Sign-in failed: ${error.message}`));
        cancel(); resolve({ ok: false, error: error.message });
      }
    });
  });

  pending = { server, state, verifier, project, timer: setTimeout(cancel, SIGN_IN_TIMEOUT_MS) };
  pending.timer.unref?.();

  const url = new URL(AUTHORIZE);
  url.searchParams.set('client_id', registered.clientId);
  url.searchParams.set('redirect_uri', redirect);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challengeFor(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  return { url: url.toString(), redirect, settled };
}

/* The sign-in route body, shared by the session host and the workspace worker so the two cannot
   drift: before an application is registered there is nothing to open, so the answer is what to do. */
export async function signIn(stateDirectory, project, options = {}) {
  if (!(await client(stateDirectory))) return { ok: false, setup: setupInstructions(stateDirectory) };
  const started = await begin(stateDirectory, project, options);
  return { ok: true, url: started.url, redirect: started.redirect };
}

async function exchange(fetchImpl, { clientId, code, redirect, verifier }) {
  if (!code) throw new Error('the provider returned no code');
  const body = new URLSearchParams({
    code, redirect_uri: redirect, client_id: clientId,
    code_verifier: verifier, grant_type: 'authorization_code',
  });
  const response = await fetchImpl(TOKEN, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(),
  });
  if (!response.ok) throw new Error(`the provider answered ${response.status}`);
  return grantFrom(await response.json());
}

const grantFrom = body => ({
  kind: 'oauth',
  accessToken: body.access_token,
  refreshToken: body.refresh_token ?? null,
  /* expires_in is seconds; storing the moment rather than the span means a restart does not lose it. */
  expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000).toISOString() : null,
});

async function store(stateDirectory, project, grant) {
  const directory = path.join(stateDirectory, 'trackers');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${project}.token`), JSON.stringify(grant, null, 2), { mode: 0o600 });
}

/* A stored grant is JSON; a pasted personal key is a bare line. Both are valid and the difference is
   only that one expires, so the reader accepts either rather than forcing a migration. */
export function parseCredential(text) {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith('{')) return { kind: 'key', accessToken: trimmed, refreshToken: null, expiresAt: null };
  try {
    const value = JSON.parse(trimmed);
    return value.accessToken ? { kind: 'oauth', accessToken: value.accessToken, refreshToken: value.refreshToken ?? null, expiresAt: value.expiresAt ?? null } : null;
  } catch { return null; }
}

export const expiring = grant =>
  grant?.kind === 'oauth' && grant.expiresAt !== null && Date.parse(grant.expiresAt) - Date.now() < REFRESH_MARGIN_MS;

/* Refresh rotates: the old refresh token is consumed and a new one comes back. Linear allows the
   original request to be replayed for thirty minutes so a dropped response does not strand the
   grant, which is why a failed refresh keeps the stored token rather than clearing it. */
export async function refresh(stateDirectory, project, grant, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const registered = await client(stateDirectory);
  if (!registered || !grant?.refreshToken) return grant;
  const body = new URLSearchParams({
    refresh_token: grant.refreshToken, grant_type: 'refresh_token', client_id: registered.clientId,
  });
  const response = await fetchImpl(TOKEN, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(),
  });
  if (!response.ok) return grant;
  const next = grantFrom(await response.json());
  if (!next.accessToken) return grant;
  const merged = { ...next, refreshToken: next.refreshToken ?? grant.refreshToken };
  await store(stateDirectory, project, merged);
  return merged;
}

export async function revoke(stateDirectory, project, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  let grant = null;
  try { grant = parseCredential(await readFile(path.join(stateDirectory, 'trackers', `${project}.token`), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (grant?.kind === 'oauth' && grant.accessToken) {
    const body = new URLSearchParams({ token: grant.accessToken, token_type_hint: 'access_token' });
    try { await fetchImpl(REVOKE, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() }); }
    catch { /* the local grant is dropped either way; a token the provider still holds is revocable there */ }
  }
  await writeFile(path.join(stateDirectory, 'trackers', `${project}.token`), '', { mode: 0o600 });
  return { revoked: grant !== null };
}
