import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTokenVault, GOOGLE_SCOPES, TokenVaultError, type TokenVaultEvent } from './token-vault.js';

const ISSUER = 'https://tenant.example.test/';
const CONNECT_URL = 'https://mcp.example.test/connect';
const SCOPE = GOOGLE_SCOPES.join(' ');

function setup(responses: Array<Response | Error>) {
  let clock = 1_000_000;
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const events: TokenVaultEvent[] = [];
  const vault = createTokenVault({
    issuer: ISSUER, clientId: 'vault-client', clientSecret: 'vault-secret-value', connection: 'google-oauth2',
    connectUrl: CONNECT_URL, now: () => clock, onEvent: event => { events.push(event); },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      const next = responses.shift();
      if (next === undefined) throw new Error('unexpected request');
      if (next instanceof Error) throw next;
      return next;
    }) as typeof fetch,
  });
  return { vault, requests, events, advance: (ms: number) => { clock += ms; } };
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const granted = (token: string, expiresIn = 3600) => json({ access_token: token, expires_in: expiresIn, scope: SCOPE, token_type: 'Bearer' });

test('exchanges the Auth0 token for the Google token with the Token Vault grant', async () => {
  const { vault, requests, events } = setup([granted('google-token-a')]);
  assert.equal(await vault.getGoogleToken('auth0|a', 'auth0-token-a'), 'google-token-a');
  assert.deepEqual(requests, [{ url: `${ISSUER}oauth/token`, body: {
    client_id: 'vault-client', client_secret: 'vault-secret-value',
    grant_type: 'urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token',
    subject_token: 'auth0-token-a', subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    requested_token_type: 'http://auth0.com/oauth/token-type/federated-connection-access-token', connection: 'google-oauth2',
  } }]);
  assert.deepEqual(events, [{ type: 'token_vault.exchange', outcome: 'ok' }]);
});

test('caches per user until two minutes before expiry', async () => {
  const { vault, requests, advance } = setup([granted('a-1'), granted('b-1'), granted('a-2')]);
  assert.equal(await vault.getGoogleToken('auth0|a', 't'), 'a-1');
  assert.equal(await vault.getGoogleToken('auth0|b', 't'), 'b-1', 'another user never gets user A\'s token');
  advance(3600_000 - 120_000 - 1);
  assert.equal(await vault.getGoogleToken('auth0|a', 't'), 'a-1');
  advance(1);
  assert.equal(await vault.getGoogleToken('auth0|a', 't'), 'a-2');
  assert.equal(requests.length, 3);
});

test('a token that expires within the margin is used once but not cached', async () => {
  const { vault, requests } = setup([granted('short', 60), granted('next')]);
  assert.equal(await vault.getGoogleToken('auth0|a', 't'), 'short');
  assert.equal(await vault.getGoogleToken('auth0|a', 't'), 'next');
  assert.equal(requests.length, 2);
});

for (const status of [400, 401, 403]) {
  test(`Auth0 ${status} means not connected, with the connect link`, async () => {
    const { vault, events } = setup([json({ error: 'federated_connection_refresh_token_not_found', error_description: 'secret detail' }, status)]);
    await assert.rejects(vault.getGoogleToken('auth0|a', 't'), (error: unknown) =>
      error instanceof TokenVaultError && error.kind === 'not_found' && error.message.includes(CONNECT_URL));
    assert.deepEqual(events, [{ type: 'token_vault.exchange', outcome: 'not_connected', httpStatus: status,
      code: 'federated_connection_refresh_token_not_found' }]);
  });
}

test('a client misconfiguration is not blamed on the user', async () => {
  const { vault, events } = setup([json({ error: 'unauthorized_client' }, 403)]);
  await assert.rejects(vault.getGoogleToken('auth0|a', 't'), (error: unknown) =>
    error instanceof TokenVaultError && error.kind === 'unavailable' && !error.message.includes(CONNECT_URL));
  assert.deepEqual(events, [{ type: 'token_vault.exchange', outcome: 'misconfigured', httpStatus: 403, code: 'unauthorized_client' }]);
});

test('server errors, network failures, and empty answers are temporary', async () => {
  const { vault, events } = setup([json({ error: 'temporarily_unavailable' }, 503), new TypeError('fetch failed: secret-host'), json({}), json('x')]);
  for (let index = 0; index < 4; index++) {
    await assert.rejects(vault.getGoogleToken('auth0|a', 't'), (error: unknown) =>
      error instanceof TokenVaultError && error.kind === 'unavailable' && !error.message.includes('secret'));
  }
  assert.deepEqual(events.map(event => event.outcome), ['error', 'unreachable', 'error', 'error']);
});

test('a token without both DV360 scopes asks the user to connect again', async () => {
  const { vault, events } = setup([json({ access_token: 'g', expires_in: 3600, scope: GOOGLE_SCOPES[0] })]);
  await assert.rejects(vault.getGoogleToken('auth0|a', 't'), (error: unknown) =>
    error instanceof TokenVaultError && error.kind === 'not_found');
  assert.deepEqual(events, [{ type: 'token_vault.exchange', outcome: 'scope_missing' }]);
});

test('events never carry tokens, secrets, or Auth0 descriptions', async () => {
  const { vault, events } = setup([granted('google-secret-token'), json({ error: 'bad code with spaces', error_description: 'auth0|a' }, 401)]);
  await vault.getGoogleToken('auth0|a', 'auth0-secret-token');
  await vault.getGoogleToken('auth0|b', 'auth0-secret-token').catch(() => {});
  const logged = JSON.stringify(events);
  for (const value of ['google-secret-token', 'auth0-secret-token', 'vault-secret-value', 'auth0|', 'spaces']) {
    assert.ok(!logged.includes(value), value);
  }
});
