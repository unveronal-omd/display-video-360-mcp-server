import assert from 'node:assert/strict';
import { request, type IncomingHttpHeaders } from 'node:http';
import { test, type TestContext } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import packageJson from '../../package.json' with { type: 'json' };
import { loadRemoteConfig as loadConfig } from './config.js';
import { createHttpServer, type HttpServerOptions } from './http.js';
import { createServer } from '../server.js';

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

const BASE_ENV = { GOOGLE_CLOUD_QUOTA_PROJECT: 'test-quota-project' };
const POST_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const INITIALIZE = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw-test', version: '0.0.0' } } });
const VALID_POST = { headers: POST_HEADERS, body: INITIALIZE };

async function startServer(t: TestContext, options: Partial<HttpServerOptions> = {}, config = loadConfig({ ...BASE_ENV })): Promise<number> {
  const server = createHttpServer(config, { createMcpServer: () => createServer(fakeDeps), ...options });
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
  return address.port;
}

type RawResponse = { status: number; headers: IncomingHttpHeaders; body: string };
async function rawRequest(port: number, init: {
  method?: string; path?: string; headers?: Record<string, string>; body?: string; setHost?: boolean;
} = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, agent: false, method: init.method ?? 'POST',
      path: init.path ?? '/mcp', headers: init.headers, setHost: init.setHost ?? true }, res => {
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

function assertJsonRpcError(response: RawResponse, status: number, code: number, messagePattern?: RegExp): void {
  assert.equal(response.status, status);
  assert.equal(response.headers['content-type'], 'application/json');
  const body = JSON.parse(response.body);
  assert.equal(body.jsonrpc, '2.0');
  assert.equal(body.id, null);
  assert.equal(body.error.code, code);
  if (messagePattern) assert.match(body.error.message, messagePattern);
}

async function connectClient(t: TestContext, port: number): Promise<Client> {
  const client = new Client({ name: 'http-test-client', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return client;
}

test('HTTP client initializes, lists health, and calls it', async t => {
  const client = await connectClient(t, await startServer(t));
  assert.deepEqual(client.getServerVersion(), { name: 'display-video-360-mcp-server', version: packageJson.version });
  assert.equal((await client.listTools()).tools.length, 14);
  const result = await client.callTool({ name: 'health', arguments: {} });
  assert.notEqual(result.isError, true);
  assert.equal((result.structuredContent as Record<string, unknown> | undefined)?.status, 'ok');
});

test('concurrent HTTP tool calls are isolated', async t => {
  const client = await connectClient(t, await startServer(t));
  const results = await Promise.all([client.callTool({ name: 'health', arguments: {} }), client.callTool({ name: 'health', arguments: {} })]);
  for (const result of results) {
    assert.notEqual(result.isError, true);
    assert.equal((result.structuredContent as Record<string, unknown> | undefined)?.status, 'ok');
  }
});

test('client tolerates 405 on its standalone GET stream', { timeout: 5000 }, async t => {
  let sawGet!: () => void;
  const getSeen = new Promise<void>(resolve => { sawGet = resolve; });
  const server = createHttpServer(loadConfig({ ...BASE_ENV }), { createMcpServer: () => createServer(fakeDeps) });
  server.on('request', req => { if (req.method === 'GET') sawGet(); });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close(error => error ? reject(error) : resolve());
  }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const client = await connectClient(t, address.port);
  await getSeen;
  assert.equal((await client.listTools()).tools[0].name, 'health');
});

test('raw initialize is SSE without a session ID and absent Origin passes', async t => {
  const response = await rawRequest(await startServer(t), VALID_POST);
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type']!, /^text\/event-stream/);
  assert.equal(response.headers['mcp-session-id'], undefined);
  assert.match(response.body, /display-video-360-mcp-server/);
});

test('query string is ignored', async t => {
  assert.equal((await rawRequest(await startServer(t), { ...VALID_POST, path: '/mcp?x=1' })).status, 200);
});

test('initialized notification returns 202', async t => {
  assert.equal((await rawRequest(await startServer(t), { headers: POST_HEADERS,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })).status, 202);
});

for (const path of ['/', '/other', '/mcp/', '/MCP', '/mcp/extra', '//evil.example/mcp', '/mcp/../mcp']) {
  test(`unknown path ${path} returns 404`, async t => {
    assertJsonRpcError(await rawRequest(await startServer(t), { ...VALID_POST, path }), 404, -32000, /^Not Found$/);
  });
}
for (const method of ['GET', 'DELETE', 'PUT', 'PATCH', 'OPTIONS']) {
  test(`${method} on mcp returns 405`, { timeout: 5000 }, async t => {
    const response = await rawRequest(await startServer(t), { method, headers: { accept: 'text/event-stream' } });
    assertJsonRpcError(response, 405, -32000, /^Method not allowed\.$/);
    assert.equal(response.headers.allow, 'POST');
  });
}
test('HEAD returns 405 with no body', async t => {
  const response = await rawRequest(await startServer(t), { method: 'HEAD' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.allow, 'POST');
  assert.equal(response.body, '');
});

test('rejected requests do not build an MCP server', async t => {
  let count = 0;
  const port = await startServer(t, { createMcpServer: () => { count++; return createServer(fakeDeps); } });
  await rawRequest(port, { path: '/other' });
  await rawRequest(port, { method: 'GET' });
  await rawRequest(port, { headers: { host: 'evil.example' } });
  assert.equal((await rawRequest(port, VALID_POST)).status, 200);
  assert.equal(count, 1);
});

for (const init of [{}, { path: '/other' }, { method: 'GET' }]) {
  test(`Host guard rejects before routing ${JSON.stringify(init)}`, async t => {
    assertJsonRpcError(await rawRequest(await startServer(t), { ...VALID_POST, ...init,
      headers: { ...POST_HEADERS, host: 'evil.example' } }), 403, -32000, /Invalid Host/);
  });
}
test('Host matching ignores case and port', async t => {
  assert.equal((await rawRequest(await startServer(t), { ...VALID_POST, headers: { ...POST_HEADERS, host: 'LOCALHOST:9999' } })).status, 200);
});
test('IPv6 loopback Host is rejected by default', async t => {
  assert.equal((await rawRequest(await startServer(t), { headers: { host: '[::1]:8237' } })).status, 403);
});
test('Node rejects a missing Host with 400', async t => {
  assert.equal((await rawRequest(await startServer(t), { ...VALID_POST, setHost: false })).status, 400);
});
for (const origin of ['http://localhost:5173', 'http://127.0.0.1:8237']) {
  test(`allowed Origin ${origin} passes`, async t => {
    assert.equal((await rawRequest(await startServer(t), { ...VALID_POST, headers: { ...POST_HEADERS, origin } })).status, 200);
  });
}
for (const origin of ['https://evil.example', 'null', 'not a url']) {
  test(`disallowed Origin ${origin} returns 403`, async t => {
    assertJsonRpcError(await rawRequest(await startServer(t), { ...VALID_POST, headers: { ...POST_HEADERS, origin } }), 403, -32000);
  });
}
test('Host guard runs before Origin guard', async t => {
  assertJsonRpcError(await rawRequest(await startServer(t), { headers: { host: 'evil.example', origin: 'https://evil.example' } }), 403, -32000, /Invalid Host/);
});
test('custom Host allowlist replaces defaults', async t => {
  const port = await startServer(t, undefined, loadConfig({ ...BASE_ENV, MCP_ALLOWED_HOSTS: 'mcp.internal' }));
  assert.equal((await rawRequest(port, { ...VALID_POST, headers: { ...POST_HEADERS, host: 'mcp.internal' } })).status, 200);
  assert.equal((await rawRequest(port, VALID_POST)).status, 403);
});
test('custom Origin allowlist replaces defaults', async t => {
  const port = await startServer(t, undefined, loadConfig({ ...BASE_ENV, MCP_ALLOWED_ORIGINS: 'app.internal' }));
  assert.equal((await rawRequest(port, { ...VALID_POST, headers: { ...POST_HEADERS, origin: 'https://app.internal' } })).status, 200);
  assert.equal((await rawRequest(port, { ...VALID_POST, headers: { ...POST_HEADERS, origin: 'http://localhost:5173' } })).status, 403);
});

test('throwing factory returns generic 500 and reports the original error', async t => {
  const error = new Error('secret-detail-xyz');
  const errors: unknown[] = [];
  const port = await startServer(t, { createMcpServer: () => { throw error; }, onError: error => errors.push(error) });
  const response = await rawRequest(port, VALID_POST);
  assertJsonRpcError(response, 500, -32603, /^Internal server error$/);
  assert.doesNotMatch(response.body, /secret-detail-xyz/);
  assert.deepEqual(errors, [error]);
});
test('HTTP server survives a factory failure', async t => {
  let calls = 0;
  const port = await startServer(t, { createMcpServer: () => {
    if (++calls === 1) throw new Error('first call');
    return createServer(fakeDeps);
  }, onError: () => {} });
  assert.equal((await rawRequest(port, VALID_POST)).status, 500);
  assert.equal((await rawRequest(port, VALID_POST)).status, 200);
});
test('throwing error reporter does not break the response', async t => {
  const onUnhandled = (error: unknown) => assert.fail(`Unhandled rejection: ${String(error)}`);
  process.once('unhandledRejection', onUnhandled);
  t.after(() => process.removeListener('unhandledRejection', onUnhandled));
  const port = await startServer(t, { createMcpServer: () => { throw new Error('factory broke'); },
    onError: () => { throw new Error('reporter broke'); } });
  assert.equal((await rawRequest(port, VALID_POST)).status, 500);
});
test('per-request MCP server is closed after response', { timeout: 5000 }, async t => {
  let closed!: () => void;
  const closure = new Promise<void>(resolve => { closed = resolve; });
  const port = await startServer(t, { createMcpServer: () => {
    const server = createServer(fakeDeps);
    const originalClose = server.close.bind(server);
    server.close = async () => { await originalClose(); closed(); };
    return server;
  } });
  assert.equal((await rawRequest(port, VALID_POST)).status, 200);
  await closure;
});
test('transport rejects POST without Accept', async t => {
  assert.equal((await rawRequest(await startServer(t), { headers: { 'content-type': 'application/json' }, body: INITIALIZE })).status, 406);
});
test('transport rejects invalid JSON', async t => {
  assert.equal((await rawRequest(await startServer(t), { headers: POST_HEADERS, body: '{not json' })).status, 400);
});
