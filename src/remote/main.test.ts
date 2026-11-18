import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createConnection, createServer, type Server } from 'node:net';
import { request } from 'node:http';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import packageJson from '../../package.json' with { type: 'json' };

const BASE_ENV = { GOOGLE_CLOUD_QUOTA_PROJECT: 'test-quota-project' };
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const INDEX = fileURLToPath(new URL('./main.ts', import.meta.url));

type RunningProcess = {
  kill: (signal: NodeJS.Signals) => void;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  waitForListening: () => Promise<number>;
  stderrLines: () => string[];
  stdout: () => string;
};

function startProcess(t: TestContext, env: Record<string, string>): RunningProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', INDEX], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let finished = false;
  let resolveListening!: (port: number) => void;
  let rejectListening!: (error: Error) => void;
  const listening = new Promise<number>((resolve, reject) => {
    resolveListening = resolve;
    rejectListening = reject;
  });
  void listening.catch(() => {});
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => {
    stderr += chunk;
    const match = /listening on http:\/\/127\.0\.0\.1:(\d+)\/mcp/.exec(stderr);
    if (match) resolveListening(Number(match[1]));
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', error => {
      rejectListening(error);
      reject(error);
    });
    // close follows exit and pipe draining, so captured output is complete.
    child.once('close', (code, signal) => {
      finished = true;
      rejectListening(new Error(`Server exited before listening: ${stderr}`));
      resolve({ code, signal });
    });
  });
  void exited.catch(() => {});
  t.after(async () => {
    if (!finished) child.kill('SIGKILL');
    await exited.catch(() => {});
  });
  return {
    kill: signal => { assert.ok(child.kill(signal), `Could not send ${signal}`); },
    exited,
    waitForListening: () => listening,
    stderrLines: () => stderr.split('\n').filter(Boolean),
    stdout: () => stdout,
  };
}

async function listenOnFreePort(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  const port = await listenOnFreePort(server);
  await closeServer(server);
  return port;
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  test(`entry point serves health and shuts down on ${signal}`, { timeout: 15000 }, async t => {
    const port = await freePort();
    const running = startProcess(t, { ...BASE_ENV, PORT: String(port) });
    assert.equal(await running.waitForListening(), port);
    const listeningLine = `display-video-360-mcp-server ${packageJson.version} listening on http://127.0.0.1:${port}/mcp`;
    assert.equal(running.stderrLines()[0], listeningLine);
    const client = new Client({ name: 'entrypoint-test', version: '1.0.0' });
    t.after(async () => { await client.close().catch(() => {}); });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    assert.equal((await client.listTools()).tools.length, 14);
    assert.deepEqual(running.stderrLines().filter(line => line.startsWith('{')), []);
    const result = await client.callTool({ name: 'health', arguments: {} });
    assert.notEqual(result.isError, true);
    assert.equal((result.structuredContent as Record<string, unknown> | undefined)?.status, 'ok');
    const start = performance.now();
    running.kill(signal);
    assert.deepEqual(await running.exited, { code: 0, signal: null });
    assert.ok(performance.now() - start < 3000, 'Idle shutdown must finish before the force timeout');
    assert.deepEqual(running.stderrLines().filter(line => !line.startsWith('{')), [listeningLine,
      `display-video-360-mcp-server received ${signal}, shutting down`, 'display-video-360-mcp-server stopped']);
    const events = running.stderrLines().filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'tool.call');
    assert.equal(events[0].tool, 'health');
    assert.equal(events[0].outcome, 'ok');
    assert.match(events[0].callId, /^[0-9a-f]{16}$/);
    assert.equal(typeof events[0].durationMs, 'number');
    assert.equal(running.stdout(), '');
  });
}

test('environment cannot override the loopback bind address', { timeout: 15000 }, async t => {
  const port = await freePort();
  const running = startProcess(t, { ...BASE_ENV, PORT: String(port), HOST: '0.0.0.0', BIND_ADDRESS: '0.0.0.0' });
  assert.equal(await running.waitForListening(), port);
  assert.equal(running.stderrLines()[0],
    `display-video-360-mcp-server ${packageJson.version} listening on http://127.0.0.1:${port}/mcp`);
  running.kill('SIGTERM');
  assert.deepEqual(await running.exited, { code: 0, signal: null });
});

for (const [name, env, message] of [
  ['invalid port', { PORT: 'abc' }, 'PORT must be an integer between 1 and 65535 (received "abc")'],
  ['empty host allowlist', { MCP_ALLOWED_HOSTS: ',' }, 'MCP_ALLOWED_HOSTS must contain at least one entry (received ",")'],
] as const) {
  test(`entry point rejects ${name}`, { timeout: 15000 }, async t => {
    const running = startProcess(t, { ...BASE_ENV, ...env });
    assert.deepEqual(await running.exited, { code: 1, signal: null });
    assert.deepEqual(running.stderrLines(), [`display-video-360-mcp-server failed to start: ${message}`]);
  });
}

test('entry point reports an occupied port', { timeout: 15000 }, async t => {
  const blocker = createServer();
  t.after(() => closeServer(blocker));
  const port = await listenOnFreePort(blocker);
  const running = startProcess(t, { ...BASE_ENV, PORT: String(port) });
  assert.deepEqual(await running.exited, { code: 1, signal: null });
  assert.equal(running.stderrLines().length, 1);
  assert.match(running.stderrLines()[0], /^display-video-360-mcp-server failed to start: listen EADDRINUSE/);
});

test('entry point rejects a missing quota project', { timeout: 15000 }, async t => {
  const running = startProcess(t, {});
  assert.deepEqual(await running.exited, { code: 1, signal: null });
  assert.deepEqual(running.stderrLines(), [
    'display-video-360-mcp-server failed to start: GOOGLE_CLOUD_QUOTA_PROJECT must be a Google Cloud project ID (received undefined)',
  ]);
});

test('non-loopback bind without auth exits 1 before any socket opens', { timeout: 15000 }, async t => {
  // Reserve the same port on loopback. If startup tries a wildcard bind it would
  // fail with EADDRINUSE, rather than the config error asserted below.
  const blocker = createServer();
  await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', resolve));
  t.after(async () => { if (blocker.listening) await closeServer(blocker); });
  const address = blocker.address();
  assert.ok(address && typeof address !== 'string');
  const running = startProcess(t, { ...BASE_ENV, PORT: String(address.port), MCP_BIND_ADDRESS: '0.0.0.0' });
  assert.deepEqual(await running.exited, { code: 1, signal: null });
  assert.deepEqual(running.stderrLines(), [
    'display-video-360-mcp-server failed to start: AUTH0_ISSUER and AUTH0_AUDIENCE are required',
  ]);
  assert.equal(running.stdout(), '');
  await closeServer(blocker);
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: address.port });
    socket.once('connect', () => { socket.destroy(); reject(new Error('Unexpected open socket')); });
    socket.once('error', error => { assert.equal((error as NodeJS.ErrnoException).code, 'ECONNREFUSED'); resolve(); });
  });
});

function getStatus(port: number, path: string, method = 'GET'): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, agent: false }, res => {
      res.resume();
      res.once('end', () => resolve(res.statusCode!));
    });
    req.once('error', reject);
    req.end();
  });
}

test('auth starts lazily with an unreachable issuer and logs only fixed reject data', { timeout: 15000 }, async t => {
  const port = await freePort();
  const running = startProcess(t, { ...BASE_ENV, PORT: String(port), MCP_BIND_ADDRESS: '127.0.0.1',
    AUTH0_ISSUER: 'https://127.0.0.1:1/', AUTH0_AUDIENCE: 'https://mcp.example.test/mcp' });
  assert.equal(await running.waitForListening(), port);
  assert.equal(await getStatus(port, '/health'), 200);
  assert.equal(await getStatus(port, '/mcp', 'POST'), 401);
  running.kill('SIGTERM');
  assert.deepEqual(await running.exited, { code: 0, signal: null });
  const events = running.stderrLines().filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  assert.equal(events.length, 1);
  const { ts, ...event } = events[0];
  assert.equal(typeof ts, 'string');
  assert.deepEqual(event, { type: 'auth.reject', reason: 'no_token' });
  assert.equal(running.stdout(), '');
});
