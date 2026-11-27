import assert from 'node:assert/strict';
import { request, type IncomingHttpHeaders } from 'node:http';
import { test, type TestContext } from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import type { ConnectHandler } from './auth/connect.js';
import { createAuth0Verifier } from './auth/token-verifier.js';
import { loadRemoteConfig } from './config.js';
import { createHttpServer, type VerifiedUser } from './http.js';
import { createServer } from '../server.js';

const ISSUER = 'https://issuer.example/';
const AUDIENCE = 'https://resource.example/mcp';
const ENV = {
  GOOGLE_CLOUD_QUOTA_PROJECT: 'test-quota-project', AUTH0_ISSUER: ISSUER, AUTH0_AUDIENCE: AUDIENCE,
  AUTH0_TOKEN_VAULT_CLIENT_ID: 'vault-client', AUTH0_TOKEN_VAULT_CLIENT_SECRET: 'vault-secret',
  AUTH0_CONNECT_CLIENT_ID: 'connect-client', AUTH0_CONNECT_CLIENT_SECRET: 'connect-secret',
};
const pair = await generateKeyPair('RS256');
const keys = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'local', alg: 'RS256' }] });
const verifier = createAuth0Verifier({ issuer: ISSUER, audience: AUDIENCE, keys });
const unexpected = async () => { throw new Error('Unexpected service call'); };
const fakeDeps = {
  reporting: { startAdHocReport: unexpected, startSavedReport: unexpected, collectReport: unexpected, listSavedQueries: unexpected },
  metadata: { list: unexpected, get: unexpected, find: unexpected, describeTarget: unexpected },
  performance: { getPerformance: unexpected },
};
const INITIALIZE = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'per-user-test', version: '0.0.0' },
} });
const POST_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

async function sign(payload: JWTPayload = {}): Promise<string> {
  return new SignJWT({ iss: ISSUER, aud: AUDIENCE, sub: 'auth0|user-a', exp: Math.floor(Date.now() / 1000) + 300, scope: 'use:mcp', ...payload })
    .setProtectedHeader({ alg: 'RS256', kid: 'local' }).sign(pair.privateKey);
}

async function start(t: TestContext, env: Record<string, string> = ENV) {
  const users: Array<VerifiedUser | undefined> = [];
  const connectCalls: Array<{ path: string; url: string; cookie?: string }> = [];
  const connect: ConnectHandler = async (path, url, cookie) => {
    connectCalls.push({ path, url: url.href, cookie });
    return new Response(null, { status: 302, headers: { location: 'https://issuer.example/authorize?x=1', 'set-cookie': 'dv360_connect=v; Path=/connect' } });
  };
  const server = createHttpServer(loadRemoteConfig(env), {
    verifier, connect,
    createMcpServer: user => { users.push(user); return createServer(fakeDeps); },
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close(error => error ? reject(error) : resolve());
  }));
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { port: address.port, users, connectCalls };
}

type RawResponse = { status: number; headers: IncomingHttpHeaders; body: string };
function raw(port: number, init: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, agent: false, method: init.method ?? 'GET', path: init.path ?? '/', headers: init.headers }, res => {
      res.setEncoding('utf8');
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(init.body);
  });
}

test('protected-resource metadata names this server as the authorization server', async t => {
  const { port } = await start(t);
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    const response = await raw(port, { path });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body).authorization_servers, ['https://resource.example/']);
  }
});

test('the authorization-server metadata is served only with per-user access', async t => {
  const perUser = await start(t);
  const metadata = await raw(perUser.port, { path: '/.well-known/oauth-authorization-server' });
  assert.equal(metadata.status, 200);
  assert.equal(metadata.headers['access-control-allow-origin'], '*');
  const body = JSON.parse(metadata.body);
  assert.equal(body.authorization_endpoint, 'https://resource.example/authorize');
  assert.equal(body.token_endpoint, `${ISSUER}oauth/token`);

  const { AUTH0_TOKEN_VAULT_CLIENT_ID: _a, AUTH0_TOKEN_VAULT_CLIENT_SECRET: _b, AUTH0_CONNECT_CLIENT_ID: _c, AUTH0_CONNECT_CLIENT_SECRET: _d, ...shared } = ENV;
  const sharedServer = await start(t, shared);
  assert.equal((await raw(sharedServer.port, { path: '/.well-known/oauth-authorization-server' })).status, 404);
  assert.deepEqual(JSON.parse((await raw(sharedServer.port, { path: '/.well-known/oauth-protected-resource' })).body).authorization_servers, [ISSUER]);
  assert.equal((await raw(sharedServer.port, { path: '/authorize?client_id=x' })).status, 404);
  assert.deepEqual(sharedServer.connectCalls, []);
});

test('connect routes pass the query and cookie to the connect handler and relay its answer', async t => {
  const { port, connectCalls, users } = await start(t);
  for (const path of ['/authorize', '/connect', '/connect/callback', '/connect/complete']) {
    const response = await raw(port, { path: `${path}?state=s1`, headers: { cookie: 'dv360_connect=abc' } });
    assert.equal(response.status, 302);
    assert.equal(response.headers.location, 'https://issuer.example/authorize?x=1');
    assert.deepEqual(response.headers['set-cookie'], ['dv360_connect=v; Path=/connect']);
  }
  assert.deepEqual(connectCalls.map(call => call.path), ['/authorize', '/connect', '/connect/callback', '/connect/complete']);
  assert.equal(connectCalls[0].url, 'https://resource.example/authorize?state=s1', 'built from the public URL, not the Host header');
  assert.equal(connectCalls[0].cookie, 'dv360_connect=abc');
  assert.deepEqual(users, []);
});

test('connect routes accept GET only', async t => {
  const { port, connectCalls } = await start(t);
  const response = await raw(port, { method: 'POST', path: '/connect/callback' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.allow, 'GET');
  assert.deepEqual(connectCalls, []);
});

test('the verified caller reaches createMcpServer', async t => {
  const { port, users } = await start(t);
  const token = await sign();
  const response = await raw(port, { method: 'POST', path: '/mcp', headers: { ...POST_HEADERS, authorization: `Bearer ${token}` }, body: INITIALIZE });
  assert.equal(response.status, 200);
  assert.deepEqual(users, [{ userId: 'auth0|user-a', accessToken: token }]);
});

test('a token without a user ID is rejected in per-user mode', async t => {
  const { port, users } = await start(t);
  const token = await new SignJWT({ iss: ISSUER, aud: AUDIENCE, exp: Math.floor(Date.now() / 1000) + 300, scope: 'use:mcp' })
    .setProtectedHeader({ alg: 'RS256', kid: 'local' }).sign(pair.privateKey);
  const response = await raw(port, { method: 'POST', path: '/mcp', headers: { ...POST_HEADERS, authorization: `Bearer ${token}` }, body: INITIALIZE });
  assert.equal(response.status, 401);
  assert.equal(JSON.parse(response.body).error, 'invalid_token');
  assert.deepEqual(users, []);
});

test('per-user config without a connect handler refuses to build the server', () => {
  assert.throws(() => createHttpServer(loadRemoteConfig(ENV), { verifier, createMcpServer: () => createServer(fakeDeps) }),
    /requires the connect handler/);
});
