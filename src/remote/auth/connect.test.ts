import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { authorizationServerMetadata, createConnectHandler, type ConnectEvent, type ConnectPath } from './connect.js';
import { GOOGLE_SCOPES } from './token-vault.js';

const ISSUER = 'https://tenant.example.test/';
const BASE = 'https://mcp.example.test';
const CONNECT_URI = 'https://tenant.example.test/connect/google';

type Sent = { url: string; headers: Headers; body: string };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const idToken = (claims: Record<string, unknown>) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;

function setup(answers: Partial<Record<'token' | 'connect' | 'complete', () => Response>> = {}) {
  let clock = 1_700_000_000_000;
  const sent: Sent[] = [];
  const events: ConnectEvent[] = [];
  const handler = createConnectHandler({
    issuer: ISSUER, publicBaseUrl: BASE, clientId: 'connect-client', clientSecret: 'connect-secret-value', connection: 'google-oauth2',
    now: () => clock, onEvent: event => { events.push(event); },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      sent.push({ url, headers: new Headers(init?.headers), body: String(init?.body) });
      if (url === `${ISSUER}oauth/token`) {
        return answers.token?.() ?? json({ access_token: 'my-account-token', id_token: idToken({ email: 'person@example.test' }) });
      }
      if (url === `${ISSUER}me/v1/connected-accounts/connect`) {
        return answers.connect?.() ?? json({ connect_uri: CONNECT_URI, auth_session: 'session-1', connect_params: { ticket: 'ticket-1' } }, 201);
      }
      if (url === `${ISSUER}me/v1/connected-accounts/complete`) {
        return answers.complete?.() ?? json({ id: 'account-1', scopes: ['openid', 'profile', ...GOOGLE_SCOPES] }, 201);
      }
      throw new Error(`unexpected request ${url}`);
    }) as typeof fetch,
  });
  const call = (path: ConnectPath, query: Record<string, string> = {}, cookie?: string) =>
    handler(path, new URL(`${path}?${new URLSearchParams(query)}`, BASE), cookie);
  return { call, sent, events, advance: (ms: number) => { clock += ms; } };
}

function cookieOf(response: Response): string {
  const header = response.headers.get('set-cookie') ?? '';
  assert.match(header, /^dv360_connect=[^;]+; Max-Age=600; Path=\/connect; Secure; HttpOnly; SameSite=Lax$/);
  return header.split(';')[0];
}

const CLIENT_REQUEST = {
  response_type: 'code', client_id: 'connect-client', redirect_uri: 'https://claude.example.test/callback',
  state: 'client-state', code_challenge: 'client-challenge', code_challenge_method: 'S256', scope: 'use:mcp',
};

async function runToGoogle(context: ReturnType<typeof setup>, start: () => Promise<Response>) {
  const first = await start();
  assert.equal(first.status, 302);
  const login = new URL(first.headers.get('location')!);
  const second = await context.call('/connect/callback', { code: 'login-code', state: login.searchParams.get('state')! }, cookieOf(first));
  return { login, first, second };
}

test('sign-in from an MCP client connects Google, then resumes the client request at Auth0', async () => {
  const context = setup();
  const { login, first, second } = await runToGoogle(context, () => context.call('/authorize', CLIENT_REQUEST));

  assert.equal(`${login.origin}${login.pathname}`, `${ISSUER}authorize`);
  const verifierFromChallenge = login.searchParams.get('code_challenge');
  assert.deepEqual(Object.fromEntries([...login.searchParams].filter(([name]) => !['state', 'code_challenge'].includes(name))), {
    response_type: 'code', client_id: 'connect-client', redirect_uri: `${BASE}/connect/callback`,
    scope: 'openid email create:me:connected_accounts', audience: `${ISSUER}me/`, connection: 'google-oauth2',
    code_challenge_method: 'S256',
  });
  assert.ok(!cookieOf(first).includes('client-state'), 'the cookie is encrypted, not readable');

  const [tokenRequest, connectRequest] = context.sent;
  const form = new URLSearchParams(tokenRequest.body);
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('code'), 'login-code');
  assert.equal(form.get('redirect_uri'), `${BASE}/connect/callback`);
  assert.equal(createHash('sha256').update(form.get('code_verifier')!).digest('base64url'), verifierFromChallenge);
  assert.equal(connectRequest.headers.get('authorization'), 'Bearer my-account-token');
  const connectBody = JSON.parse(connectRequest.body);
  assert.deepEqual(connectBody.scopes, ['openid', 'profile', ...GOOGLE_SCOPES]);
  assert.deepEqual(connectBody.authorization_params, { login_hint: 'person@example.test' });
  assert.equal(connectBody.redirect_uri, `${BASE}/connect/complete`);

  assert.equal(second.status, 302);
  assert.equal(second.headers.get('location'), `${CONNECT_URI}?ticket=ticket-1`);
  const third = await context.call('/connect/complete', { connect_code: 'code-1', state: connectBody.state }, cookieOf(second));
  assert.deepEqual(JSON.parse(context.sent[2].body), { auth_session: 'session-1', connect_code: 'code-1', redirect_uri: `${BASE}/connect/complete` });
  assert.equal(third.status, 302);
  const resumed = new URL(third.headers.get('location')!);
  assert.equal(`${resumed.origin}${resumed.pathname}`, `${ISSUER}authorize`);
  assert.deepEqual(Object.fromEntries(resumed.searchParams), { ...CLIENT_REQUEST, connection: 'google-oauth2' });
  assert.match(third.headers.get('set-cookie')!, /^dv360_connect=; Max-Age=0;/);
  assert.deepEqual(context.events.map(event => `${event.step}:${event.outcome}`), ['authorize:ok', 'callback:ok', 'complete:ok']);
});

test('the manual /connect flow ends on a confirmation page', async () => {
  const context = setup();
  const { second } = await runToGoogle(context, () => context.call('/connect'));
  const state = JSON.parse(context.sent[1].body).state;
  const done = await context.call('/connect/complete', { connect_code: 'code-1', state }, cookieOf(second));
  assert.equal(done.status, 200);
  assert.match(await done.text(), /Google account connected/);
});

for (const [name, query] of [
  ['another client', { ...CLIENT_REQUEST, client_id: 'other-client' }],
  ['no redirect URI', { ...CLIENT_REQUEST, redirect_uri: '' }],
  ['a non-code response type', { ...CLIENT_REQUEST, response_type: 'token' }],
] as const) {
  test(`/authorize refuses ${name}`, async () => {
    const context = setup();
    const response = await context.call('/authorize', query);
    assert.equal(response.status, 400);
    assert.equal(context.sent.length, 0);
    assert.deepEqual(context.events, [{ type: 'connect.step', step: 'authorize', outcome: 'failed', reason: 'request' }]);
  });
}

test('the callback refuses a missing, tampered, mismatched, or expired flow', async () => {
  const context = setup();
  const first = await context.call('/authorize', CLIENT_REQUEST);
  const state = new URL(first.headers.get('location')!).searchParams.get('state')!;
  const cookie = cookieOf(first);
  const tampered = cookie.slice(0, -2) + (cookie.endsWith('AA') ? 'BB' : 'AA');
  for (const [query, sentCookie] of [
    [{ code: 'c', state }, undefined],
    [{ code: 'c', state }, tampered],
    [{ code: 'c', state: 'other' }, cookie],
  ] as const) {
    assert.equal((await context.call('/connect/callback', query, sentCookie)).status, 400);
  }
  context.advance(601_000);
  assert.equal((await context.call('/connect/callback', { code: 'c', state }, cookie)).status, 400);
  assert.equal(context.sent.length, 0, 'no Auth0 call without a valid flow');
});

test('a login error or a failed code exchange stops the flow without leaking details', async () => {
  const context = setup({ token: () => json({ error: 'invalid_grant', error_description: 'secret detail' }, 403) });
  const first = await context.call('/connect');
  const state = new URL(first.headers.get('location')!).searchParams.get('state')!;
  const denied = await context.call('/connect/callback', { error: 'access_denied', state }, cookieOf(first));
  assert.equal(denied.status, 400);
  const failed = await context.call('/connect/callback', { code: 'c', state }, cookieOf(first));
  assert.equal(failed.status, 400);
  assert.ok(!(await failed.text()).includes('secret detail'));
  assert.deepEqual(context.events.slice(1), [
    { type: 'connect.step', step: 'callback', outcome: 'failed', reason: 'login_error', code: 'access_denied' },
    { type: 'connect.step', step: 'callback', outcome: 'failed', reason: 'code_exchange', httpStatus: 403, code: 'invalid_grant' },
  ]);
});

test('a connect answer without an HTTPS connect URI is refused', async () => {
  const context = setup({ connect: () => json({ connect_uri: 'http://evil.example.test', auth_session: 's', connect_params: { ticket: 't' } }, 201) });
  const { second } = await runToGoogle(context, () => context.call('/connect'));
  assert.equal(second.status, 400);
});

test('completion without both DV360 scopes explains what to allow', async () => {
  const context = setup({ complete: () => json({ scopes: ['openid', GOOGLE_SCOPES[0]] }, 201) });
  const { second } = await runToGoogle(context, () => context.call('/authorize', CLIENT_REQUEST));
  const done = await context.call('/connect/complete', { connect_code: 'c', state: JSON.parse(context.sent[1].body).state }, cookieOf(second));
  assert.equal(done.status, 400);
  assert.match(await done.text(), /DV360 access missing/);
  assert.equal(done.headers.get('location'), null, 'the sign-in does not resume');
});

test('completion refuses a wrong state, a missing session, or a Google error', async () => {
  const context = setup();
  const { second } = await runToGoogle(context, () => context.call('/connect'));
  assert.equal((await context.call('/connect/complete', { connect_code: 'c', state: 'other' }, cookieOf(second))).status, 400);
  assert.equal((await context.call('/connect/complete', { connect_code: 'c' })).status, 400);
  assert.equal((await context.call('/connect/complete', { error: 'access_denied' }, cookieOf(second))).status, 400);
  assert.equal(context.sent.length, 2, 'the complete call was never made');
});

test('completion without a code in the query serves the fragment page', async () => {
  const context = setup();
  const response = await context.call('/connect/complete');
  assert.equal(response.status, 200);
  assert.match(await response.text(), /location\.hash/);
});

test('an unreachable Auth0 gives the failure page', async () => {
  const context = setup({ token: () => { throw new TypeError('fetch failed'); } });
  const { second } = await runToGoogle(context, () => context.call('/connect'));
  assert.equal(second.status, 400);
  assert.deepEqual(context.events.at(-1), { type: 'connect.step', step: 'callback', outcome: 'failed', reason: 'unreachable' });
});

test('events never carry tokens, secrets, codes, or the email', async () => {
  const context = setup();
  const { second } = await runToGoogle(context, () => context.call('/authorize', CLIENT_REQUEST));
  await context.call('/connect/complete', { connect_code: 'code-1', state: JSON.parse(context.sent[1].body).state }, cookieOf(second));
  const logged = JSON.stringify(context.events);
  for (const value of ['my-account-token', 'connect-secret-value', 'login-code', 'code-1', 'person@example.test', 'session-1', 'client-state']) {
    assert.ok(!logged.includes(value), value);
  }
});

test('the authorization-server metadata sends sign-in here and tokens to Auth0', () => {
  assert.deepEqual(authorizationServerMetadata({ issuer: ISSUER, publicBaseUrl: BASE, scope: 'use:mcp' }), {
    issuer: `${BASE}/`, authorization_endpoint: `${BASE}/authorize`, token_endpoint: `${ISSUER}oauth/token`,
    registration_endpoint: `${ISSUER}oidc/register`, response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'], scopes_supported: ['use:mcp'],
  });
});
