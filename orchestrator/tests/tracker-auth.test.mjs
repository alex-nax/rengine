import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { begin, cancel, refresh, revoke, parseCredential, expiring, challengeFor, callbackUri, CALLBACK_PORTS } from '../server/tracker-auth.mjs';
import { credential } from '../server/tracker.mjs';

const base64url = buffer => buffer.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

async function workspace(clientId = 'client-fixture') {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-auth-'));
  await mkdir(path.join(directory, 'trackers'), { recursive: true });
  if (clientId) await writeFile(path.join(directory, 'trackers', 'oauth.json'), JSON.stringify({ linear: { clientId } }));
  return directory;
}
const stored = async (directory, project) =>
  parseCredential(await readFile(path.join(directory, 'trackers', `${project}.token`), 'utf8'));

test('the challenge is the SHA-256 of the verifier, which is what makes a public client safe', () => {
  // If this were the verifier itself, an interceptor holding the code could redeem it.
  assert.equal(challengeFor('abc'), base64url(createHash('sha256').update('abc').digest()));
  assert.equal(challengeFor('abc'), 'ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
  assert.ok(!challengeFor('abc').includes('='), 'base64url carries no padding');
});

test('a browser sign-in stores a grant, and the exchange proves possession of the verifier', async () => {
  const state = await workspace();
  try {
    let exchanged = null;
    const started = await begin(state, 'kohai', { fetch: async (url, options) => {
      exchanged = Object.fromEntries(new URLSearchParams(options.body));
      assert.equal(url, 'https://api.linear.app/oauth/token');
      assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');
      return { ok: true, status: 200, json: async () => ({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 86399 }) };
    } });

    const authorize = new URL(started.url);
    assert.equal(authorize.origin + authorize.pathname, 'https://linear.app/oauth/authorize');
    assert.equal(authorize.searchParams.get('response_type'), 'code');
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authorize.searchParams.get('client_id'), 'client-fixture');
    assert.ok(CALLBACK_PORTS.map(callbackUri).includes(authorize.searchParams.get('redirect_uri')),
      'the redirect is one of the registered fixed ports, because Linear matches them exactly');
    const challenge = authorize.searchParams.get('code_challenge');
    const returnedState = authorize.searchParams.get('state');
    assert.ok(returnedState && returnedState.length > 20, 'a state is sent');

    // The browser comes back to the loopback listener.
    const response = await fetch(`${started.redirect}?code=the-code&state=${encodeURIComponent(returnedState)}`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Signed in/);
    const outcome = await started.settled;
    assert.equal(outcome.ok, true);

    assert.equal(exchanged.grant_type, 'authorization_code');
    assert.equal(exchanged.code, 'the-code');
    assert.equal(exchanged.client_secret, undefined, 'a public client ships no secret');
    assert.equal(challengeFor(exchanged.code_verifier), challenge, 'the verifier matches the challenge that was sent');

    const grant = await stored(state, 'kohai');
    assert.equal(grant.kind, 'oauth');
    assert.equal(grant.accessToken, 'access-1');
    assert.equal(grant.refreshToken, 'refresh-1');
    assert.ok(Date.parse(grant.expiresAt) > Date.now(), 'the moment of expiry is stored, not the span');
  } finally { cancel(); await rm(state, { recursive: true, force: true }); }
});

test('a callback carrying the wrong state stores nothing', async () => {
  const state = await workspace();
  try {
    let called = false;
    const started = await begin(state, 'kohai', { fetch: async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; } });
    const response = await fetch(`${started.redirect}?code=stolen&state=not-the-one`);
    assert.equal(response.status, 400);
    assert.match(await response.text(), /did not match/);
    assert.equal(called, false, 'no exchange is attempted');
    await assert.rejects(() => readFile(path.join(state, 'trackers', 'kohai.token'), 'utf8'));
  } finally { cancel(); await rm(state, { recursive: true, force: true }); }
});

test('a declined sign-in says so and leaves no grant', async () => {
  const state = await workspace();
  try {
    const started = await begin(state, 'kohai', { fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
    const authorize = new URL(started.url);
    const response = await fetch(`${started.redirect}?error=access_denied&state=${encodeURIComponent(authorize.searchParams.get('state'))}`);
    assert.match(await response.text(), /declined/);
    const outcome = await started.settled;
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error, 'access_denied');
  } finally { cancel(); await rm(state, { recursive: true, force: true }); }
});

test('sign-in refuses before an application is registered, and names the setup', async () => {
  const state = await workspace(null);
  try {
    await assert.rejects(() => begin(state, 'kohai', { fetch: async () => ({}) }), /No Linear application is registered/);
  } finally { await rm(state, { recursive: true, force: true }); }
});

test('a grant refreshes before it lapses, rotates, and survives a failed refresh', async () => {
  const state = await workspace();
  try {
    const soon = new Date(Date.now() + 60000).toISOString();
    await writeFile(path.join(state, 'trackers', 'kohai.token'),
      JSON.stringify({ kind: 'oauth', accessToken: 'old', refreshToken: 'r1', expiresAt: soon }));
    assert.equal(expiring(await stored(state, 'kohai')), true, 'a grant inside the margin is due');

    let sent = null;
    const token = await credential(state, 'kohai', { fetch: async (url, options) => {
      sent = Object.fromEntries(new URLSearchParams(options.body));
      return { ok: true, status: 200, json: async () => ({ access_token: 'new', refresh_token: 'r2', expires_in: 86399 }) };
    } });
    assert.equal(token, 'new', 'the reader hands back the refreshed token');
    assert.equal(sent.grant_type, 'refresh_token');
    assert.equal(sent.refresh_token, 'r1');
    assert.equal(sent.client_secret, undefined, 'refreshing a PKCE grant needs no secret either');
    const rotated = await stored(state, 'kohai');
    assert.equal(rotated.refreshToken, 'r2', 'the refresh token rotates and the new one is kept');

    // A refresh that fails keeps what it had: Linear allows the request to be replayed for thirty
    // minutes, and a cleared grant could not use that.
    await writeFile(path.join(state, 'trackers', 'kohai.token'),
      JSON.stringify({ kind: 'oauth', accessToken: 'still-here', refreshToken: 'r2', expiresAt: soon }));
    const kept = await credential(state, 'kohai', { fetch: async () => ({ ok: false, status: 500 }) });
    assert.equal(kept, 'still-here', 'the token it had is still usable');
    assert.equal((await stored(state, 'kohai')).refreshToken, 'r2', 'and the refresh token was not thrown away');
  } finally { await rm(state, { recursive: true, force: true }); }
});

test('a pasted personal key still works and is never refreshed', async () => {
  const state = await workspace();
  try {
    await writeFile(path.join(state, 'trackers', 'kohai.token'), 'lin_api_pasted\n');
    let called = false;
    const token = await credential(state, 'kohai', { fetch: async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; } });
    assert.equal(token, 'lin_api_pasted', 'a bare line is a personal key');
    assert.equal(called, false, 'a key that never expires is never refreshed');
  } finally { await rm(state, { recursive: true, force: true }); }
});

test('signing out revokes at the provider and clears the stored grant', async () => {
  const state = await workspace();
  try {
    await writeFile(path.join(state, 'trackers', 'kohai.token'),
      JSON.stringify({ kind: 'oauth', accessToken: 'access-1', refreshToken: 'r1', expiresAt: new Date(Date.now() + 8.64e7).toISOString() }));
    let revoked = null;
    const result = await revoke(state, 'kohai', { fetch: async (url, options) => {
      revoked = { url, body: Object.fromEntries(new URLSearchParams(options.body)) };
      return { ok: true, status: 200 };
    } });
    assert.equal(result.revoked, true);
    assert.equal(revoked.url, 'https://api.linear.app/oauth/revoke');
    assert.equal(revoked.body.token, 'access-1', 'the token goes in the token field');
    assert.equal(revoked.body.token_type_hint, 'access_token');
    assert.equal(await credential(state, 'kohai'), null, 'and nothing is left to read');
  } finally { await rm(state, { recursive: true, force: true }); }
});
