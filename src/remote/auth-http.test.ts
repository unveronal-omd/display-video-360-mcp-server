import assert from 'node:assert/strict';
import { request, type IncomingHttpHeaders } from 'node:http';
import { test, type TestContext } from 'node:test';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { createAuth0Verifier } from './auth/token-verifier.js';
import { loadRemoteConfig as loadConfig } from './config.js';
import { createHttpServer, type HttpServerOptions } from './http.js';
import { createServer } from '../server.js';
import { createJsonLogger } from '../integrations/google/log.js';

const ISSUER = 'https://issuer.example/';
const AUDIENCE = 'https://resource.example/mcp';
const METADATA_URL = 'https://resource.example/.well-known/oauth-protected-resource/mcp';
const BASE_ENV = { GOOGLE_CLOUD_QUOTA_PROJECT: 'test-quota-project' };
const AUTH_ENV = { ...BASE_ENV, AUTH0_ISSUER: ISSUER, AUTH0_AUDIENCE: AUDIENCE };
const pair = await generateKeyPair('RS256');
const keys = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'local', alg: 'RS256' }] });
const verifier = createAuth0Verifier({ issuer: ISSUER, audience: AUDIENCE, keys });
const fakeDeps = { reporting: {
  async startAdHocReport() { throw new Error('Unexpected reporting call'); },
  async startSavedReport() { throw new Error('Unexpected reporting call'); },
  async collectReport() { throw new Error('Unexpected reporting call'); },
  async listSavedQueries() { throw new Error('Unexpected reporting call'); },
}, metadata: {
  async list() { throw new Error('Unexpected metadata call'); },
  async get() { throw new Error('Unexpected metadata call'); },
  async find() { throw new Error('Unexpected metadata call'); },
  async describeTarget() { throw new Error('Unexpected metadata call'); },
}, performance: { async getPerformance() { throw new Error('Unexpected performance call'); } } };
const INITIALIZE = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'auth-test', version: '0.0.0' },
} });
const POST_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

async function sign(payload: JWTPayload = {}): Promise<string> {
  return new SignJWT({ iss: ISSUER, aud: AUDIENCE, exp: Math.floor(Date.now() / 1000) + 300, scope: 'use:mcp', ...payload })
    .setProtectedHeader({ alg: 'RS256', kid: 'local' }).sign(pair.privateKey);
}

async function startServer(t: TestContext, options: Partial<HttpServerOptions> = {}, auth = true) {
  let built = 0;
  const server = createHttpServer(loadConfig(auth ? AUTH_ENV : BASE_ENV), {
    verifier,
    createMcpServer: () => { built++; return createServer(fakeDeps); },
    ...options,
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close(error => error ? reject(error) : resolve());
  }));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { port: address.port, built: () => built };
}

type RawResponse = { status: number; headers: IncomingHttpHeaders; body: string };
function rawRequest(port: number, init: { method?: string; path?: string; headers?: Record<string, string | string[]>; body?: string } = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, agent: false, method: init.method ?? 'POST', path: init.path ?? '/mcp', headers: init.headers }, res => {
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

function assertChallenge(response: RawResponse, status: number, code: string): void {
  assert.equal(response.status, status);
  assert.equal(JSON.parse(response.body).error, code);
  assert.match(response.headers['www-authenticate']!, /^Bearer /);
  assert.ok(response.headers['www-authenticate']!.includes(`error="${code}"`));
  assert.ok(response.headers['www-authenticate']!.includes(`resource_metadata="${METADATA_URL}"`));
  assert.ok(response.headers['www-authenticate']!.includes('scope="use:mcp"'));
}

test('health is public and discloses only status with auth enabled or disabled', async t => {
  for (const auth of [true, false]) {
    const server = await startServer(t, {}, auth);
    const response = await rawRequest(server.port, { method: 'GET', path: '/health' });
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-type'], 'application/json');
    assert.equal(response.body, '{"status":"ok"}');
    assert.equal(server.built(), 0);
  }
});

for (const method of ['POST', 'GET', 'OPTIONS', 'HEAD', 'DELETE']) {
  test(`unauthenticated ${method} /mcp stops at the gate before MCP processing`, async t => {
    const reasons: string[] = [];
    const server = await startServer(t, { onAuthReject: reason => reasons.push(reason) });
    const response = await rawRequest(server.port, { method });
    if (method === 'HEAD') {
      assert.equal(response.status, 401);
      assert.match(response.headers['www-authenticate']!, /resource_metadata=/);
      assert.equal(response.body, '');
    } else assertChallenge(response, 401, 'invalid_token');
    assert.deepEqual(reasons, ['no_token']);
    assert.equal(server.built(), 0);
  });
}

test('valid RS256 token with required scope reaches the SSE initialize handshake', async t => {
  const server = await startServer(t);
  const response = await rawRequest(server.port, { headers: { ...POST_HEADERS, authorization: `Bearer ${await sign()}` }, body: INITIALIZE });
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type']!, /^text\/event-stream/);
  assert.match(response.body, /display-video-360-mcp-server/);
  assert.equal(server.built(), 1);
});

for (const method of ['GET', 'OPTIONS', 'HEAD']) {
  test(`authenticated ${method} /mcp retains POST-only behavior`, async t => {
    const server = await startServer(t);
    const response = await rawRequest(server.port, { method, headers: { authorization: `Bearer ${await sign()}` } });
    assert.equal(response.status, 405);
    assert.equal(response.headers.allow, 'POST');
    assert.equal(server.built(), 0);
  });
}

test('missing required scope returns a discovery challenge and fixed reject reason', async t => {
  const reasons: string[] = [];
  const server = await startServer(t, { onAuthReject: reason => reasons.push(reason) });
  assertChallenge(await rawRequest(server.port, { headers: { authorization: `Bearer ${await sign({ scope: 'read:other' })}` } }), 403, 'insufficient_scope');
  assert.deepEqual(reasons, ['insufficient_scope']);
  assert.equal(server.built(), 0);
});

for (const [label, payload] of [
  ['wrong audience', { aud: 'https://other.example/mcp' }],
  ['wrong issuer', { iss: 'https://other.example/' }],
  ['expired', { exp: 1 }],
] as const) {
  test(`${label} token returns 401 before MCP processing`, async t => {
    const reasons: string[] = [];
    const server = await startServer(t, { onAuthReject: reason => reasons.push(reason) });
    assertChallenge(await rawRequest(server.port, { headers: { authorization: `Bearer ${await sign(payload)}` } }), 401, 'invalid_token');
    assert.deepEqual(reasons, ['invalid_token']);
    assert.equal(server.built(), 0);
  });
}

test('none algorithm token returns 401', async t => {
  const server = await startServer(t);
  const token = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ iss: ISSUER, aud: AUDIENCE, exp: 9_999_999_999, scope: 'use:mcp' })).toString('base64url')}.`;
  assertChallenge(await rawRequest(server.port, { headers: { authorization: `Bearer ${token}` } }), 401, 'invalid_token');
  assert.equal(server.built(), 0);
});

test('duplicate Authorization headers reject even when the first token is valid', async t => {
  const reasons: string[] = [];
  const server = await startServer(t, { onAuthReject: reason => reasons.push(reason) });
  const token = await sign();
  assertChallenge(await rawRequest(server.port, { headers: { authorization: [`Bearer ${token}`, `Bearer ${token}`] } }), 401, 'invalid_token');
  assert.deepEqual(reasons, ['invalid_token']);
  assert.equal(server.built(), 0);
});

for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
  test(`${path} serves public metadata with CORS and rejects other methods`, async t => {
    const server = await startServer(t);
    const response = await rawRequest(server.port, { method: 'GET', path });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { resource: AUDIENCE, authorization_servers: [ISSUER], scopes_supported: ['use:mcp'], bearer_methods_supported: ['header'] });
    assert.equal(response.headers['access-control-allow-origin'], '*');
    const preflight = await rawRequest(server.port, { method: 'OPTIONS', path });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.body, '');
    assert.equal(preflight.headers['access-control-allow-origin'], '*');
    assert.ok(preflight.headers['access-control-allow-methods']?.includes('GET'));
    assert.ok(preflight.headers['access-control-allow-methods']?.includes('OPTIONS'));
    const post = await rawRequest(server.port, { path });
    assert.equal(post.status, 405);
    assert.equal(post.headers.allow, 'GET, OPTIONS');
    assert.equal(server.built(), 0);
  });
  test(`${path} is absent when auth is disabled`, async t => {
    const server = await startServer(t, {}, false);
    for (const method of ['GET', 'POST', 'OPTIONS']) assert.equal((await rawRequest(server.port, { path, method })).status, 404);
  });
}

for (const path of ['/health', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/mcp']) {
  test(`Host and Origin guards run before ${path}`, async t => {
    const reasons: string[] = [];
    const server = await startServer(t, { onAuthReject: reason => reasons.push(reason) });
    const badHost = await rawRequest(server.port, { method: 'GET', path, headers: { host: 'evil.example' } });
    assert.equal(badHost.status, 403);
    assert.match(badHost.body, /Invalid Host/);
    const badOrigin = await rawRequest(server.port, { method: 'GET', path, headers: { origin: 'https://evil.example' } });
    assert.equal(badOrigin.status, 403);
    assert.deepEqual(reasons, []);
    assert.equal(server.built(), 0);
  });
}

test('trailing slash and unknown MCP paths retain exact 404 matching', async t => {
  const reasons: string[] = [];
  const server = await startServer(t, { onAuthReject: reason => reasons.push(reason) });
  for (const path of ['/mcp/', '/MCP', '//evil.example/mcp', '/mcp/../mcp']) {
    assert.equal((await rawRequest(server.port, { path })).status, 404);
  }
  assert.deepEqual(reasons, []);
  assert.equal(server.built(), 0);
});

test('key-set outage returns server_error and verifier_unavailable without MCP processing', async t => {
  const reasons: string[] = [];
  const unavailable = createAuth0Verifier({ issuer: ISSUER, audience: AUDIENCE, keys: async () => { throw new TypeError('fetch failed privateResolverMarker'); } });
  const server = await startServer(t, { verifier: unavailable, onAuthReject: reason => reasons.push(reason) });
  const response = await rawRequest(server.port, { headers: { authorization: `Bearer ${await sign()}` } });
  assert.equal(response.status, 500);
  assert.equal(JSON.parse(response.body).error, 'server_error');
  assert.doesNotMatch(response.body, /privateResolverMarker/);
  assert.deepEqual(reasons, ['verifier_unavailable']);
  assert.equal(server.built(), 0);
});

// Capture the same JSON logging path wired by index.ts, plus all direct output.
test('rejections expose only fixed reasons and never token, claim, header, or jose text', async t => {
  const marker = 'privateTokenClaimHeaderMarkerABC123';
  const lines: string[] = [];
  const directOutput: string[] = [];
  const stderrWrite = process.stderr.write.bind(process.stderr);
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stderr, 'write', (...args: Parameters<typeof process.stderr.write>) => { directOutput.push(String(args[0])); return stderrWrite(...args); });
  t.mock.method(process.stdout, 'write', (...args: Parameters<typeof process.stdout.write>) => { directOutput.push(String(args[0])); return stdoutWrite(...args); });
  const log = createJsonLogger({ write: line => lines.push(line), now: () => 0 });
  const server = await startServer(t, { onAuthReject: reason => log({ type: 'auth.reject', reason }) });
  const invalid = await sign({ iss: `https://${marker}.example/`, sub: marker, azp: marker, scope: marker });
  const noScope = await sign({ sub: marker, azp: marker, scope: marker });
  const bodies: string[] = [];
  const headerCases: Record<string, string>[] = [{}, { authorization: `Bearer ${invalid}` }, { authorization: `Bearer ${noScope}` }, { authorization: marker }];
  for (const headers of headerCases) {
    const response = await rawRequest(server.port, { headers: { ...headers, 'x-private-header': marker } });
    bodies.push(response.body, JSON.stringify(response.headers));
  }
  const unavailable = await startServer(t, { verifier: createAuth0Verifier({ issuer: ISSUER, audience: AUDIENCE, keys: async () => { throw new TypeError(`fetch failed ${marker}`); } }), onAuthReject: reason => log({ type: 'auth.reject', reason }) });
  bodies.push((await rawRequest(unavailable.port, { headers: { authorization: `Bearer ${invalid}` } })).body);
  assert.deepEqual(lines.map(line => JSON.parse(line).reason), ['no_token', 'invalid_token', 'insufficient_scope', 'invalid_token', 'verifier_unavailable']);
  for (const line of lines) assert.deepEqual(Object.keys(JSON.parse(line)).sort(), ['reason', 'ts', 'type']);
  const output = [...lines, ...directOutput, ...bodies].join('\n');
  for (const secret of [marker, Buffer.from(marker).toString('base64url'), invalid, noScope]) assert.equal(output.includes(secret), false);
  assert.equal(server.built(), 0);
  assert.equal(unavailable.built(), 0);
});

// A verifier supplied to the HTTP seam must not leak an arbitrary OAuth message.
test('unexpected verifier errors are contained without exposing their message', async t => {
  const server = await startServer(t, { verifier: { async verifyAccessToken() { throw new Error('privateUnexpectedVerifierMarker'); } } });
  const response = await rawRequest(server.port, { headers: { authorization: 'Bearer fake-token' } });
  assert.equal(response.status, 500);
  assert.doesNotMatch(response.body, /privateUnexpectedVerifierMarker/);
  assert.equal(server.built(), 0);
});


for (const [label, makeError, errorClass] of [
  ['Error message and cause', () => new Error('privateDefaultErrorMarker', { cause: new Error('privateDefaultCauseMarker') }), 'Error'],
  ['own constructor spoof', () => ({ constructor: { name: 'privateDefaultConstructorMarker' }, message: 'privateDefaultErrorMarker' }), 'Object'],
  ['null', () => null, 'Object'],
  ['throwing prototype', () => { const { proxy, revoke } = Proxy.revocable({}, {}); revoke(); return proxy; }, 'Object'],
  ['non-identifier class name', () => Object.create({ constructor: { name: 'private default class marker!' } }), 'Object'],
] as const) {
  test(`default onError logs only the class for ${label}`, async t => {
    const lines: unknown[][] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args); });
    const server = await startServer(t, { createMcpServer: () => { throw makeError(); } }, false);
    const response = await rawRequest(server.port, { headers: POST_HEADERS, body: INITIALIZE });
    assert.equal(response.status, 500);
    assert.deepEqual(lines, [[JSON.stringify({ type: 'http.error', errorClass })]]);
    assert.doesNotMatch(response.body + JSON.stringify(lines), /privateDefault|private default/);
  });
}

test('accepted credentials never reach the MCP tool request context', async t => {
  let seen: { authorization: string | null | undefined; authInfo: unknown } | undefined;
  const server = await startServer(t, { createMcpServer: () => {
    const mcp = new McpServer({ name: 'credential-boundary-test', version: '0.0.0' });
    mcp.registerTool('inspect_context', { inputSchema: z.object({}) }, async (_args, ctx) => {
      seen = { authorization: ctx.http?.req?.headers.get('authorization'), authInfo: ctx.http?.authInfo };
      return { content: [{ type: 'text', text: 'ok' }] };
    });
    return mcp;
  } });
  const response = await rawRequest(server.port, { headers: { ...POST_HEADERS, authorization: `Bearer ${await sign()}`, 'mcp-protocol-version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'inspect_context', arguments: {} } }) });
  assert.equal(response.status, 200);
  assert.ok(seen, 'tool must run so the absence of credentials is observed');
  assert.equal(seen.authorization, null);
  assert.equal(seen.authInfo, undefined);
});
