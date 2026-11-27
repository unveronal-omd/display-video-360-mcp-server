import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { GoogleCredentialsError } from '../integrations/google/auth.js';
import type { LogLine } from '../integrations/google/log.js';
import type { Runtime } from '../runtime.js';
import { createUserFetch, createUserRuntimeRegistry, RemoteCredentialsError } from './user-runtime.js';

// Fingerprint of src/runtime.ts. When it changes, update the wiring copy in user-runtime.ts to match, then this value.
const RUNTIME_SHA256 = '1c6d33052030d2736e22f4f4d03f9bd76bbb71bfbba5e387e76d2f1cd8f9d631';

type Seen = { url: string; authorization: string | null; userProject: string | null };

function fakeGoogle() {
  const seen: Seen[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const url = String(input);
    seen.push({ url, authorization: headers.get('authorization'), userProject: headers.get('x-goog-user-project') });
    const advertisers = [{ name: 'advertisers/10', advertiserId: '10', partnerId: '1', displayName: 'Synthetic Advertiser', entityStatus: 'ENTITY_STATUS_ACTIVE' }];
    return new Response(JSON.stringify({ advertisers }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { seen, fetch };
}

async function connect(t: TestContext, runtime: Runtime): Promise<Client> {
  const server = runtime.createMcpServer();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  t.after(() => client.close());
  t.after(() => server.close());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

const findAdvertiser = { name: 'find_entities', arguments: { type: 'advertiser', name: 'synthetic', partnerId: '1' } };

test('src/runtime.ts is unchanged since the wiring in user-runtime.ts was copied from it', () => {
  const source = readFileSync(new URL('../runtime.ts', import.meta.url));
  assert.equal(createHash('sha256').update(source).digest('hex'), RUNTIME_SHA256,
    'src/runtime.ts changed: update createUserRuntime in src/remote/user-runtime.ts to match, then RUNTIME_SHA256');
});

test('the user fetch sends the user token and never x-goog-user-project', async () => {
  const google = fakeGoogle();
  const fetch = createUserFetch(async () => 'user-token-a', google.fetch);
  await fetch('https://example.test/x', { headers: { 'x-goog-user-project': 'injected', accept: 'application/json' } });
  assert.deepEqual(google.seen, [{ url: 'https://example.test/x', authorization: 'Bearer user-token-a', userProject: null }]);
});

test('the user fetch passes credential errors through and turns other token failures into a safe one', async () => {
  const google = fakeGoogle();
  const notConnected = new RemoteCredentialsError('not_found', 'Connect your Google account first.');
  await assert.rejects(createUserFetch(async () => { throw notConnected; }, google.fetch)('https://example.test/x'),
    error => error === notConnected);
  await assert.rejects(createUserFetch(async () => { throw new Error('secret-detail'); }, google.fetch)('https://example.test/x'),
    (error: unknown) => error instanceof GoogleCredentialsError && error.kind === 'unavailable' && !error.message.includes('secret-detail'));
  assert.deepEqual(google.seen, []);
});

test('a remote credential error keeps its kind and class but carries its own message', () => {
  const error = new RemoteCredentialsError('expired_or_revoked', 'Reconnect your Google account.');
  assert.ok(error instanceof GoogleCredentialsError);
  assert.equal(error.kind, 'expired_or_revoked');
  assert.equal(error.message, 'Reconnect your Google account.');
});

test('each user has their own runtime and cache, and calls Google with their own token', async t => {
  const google = fakeGoogle();
  const events: LogLine[] = [];
  const registry = createUserRuntimeRegistry({ log: event => { events.push(event); }, fetch: google.fetch });
  const runtimeA = registry.runtimeFor('user-a', async () => 'token-a');
  assert.equal(registry.runtimeFor('user-a', async () => 'token-a'), runtimeA);
  const runtimeB = registry.runtimeFor('user-b', async () => 'token-b');
  assert.notEqual(runtimeA, runtimeB);

  const clientA = await connect(t, runtimeA);
  const first = await clientA.callTool(findAdvertiser);
  assert.notEqual(first.isError, true, JSON.stringify(first.content));
  const fetchesForA = google.seen.length;
  assert.ok(fetchesForA > 0);
  await clientA.callTool(findAdvertiser);
  assert.equal(google.seen.length, fetchesForA, "user A's second search is served from user A's cache");

  const clientB = await connect(t, runtimeB);
  await clientB.callTool(findAdvertiser);
  const fetchesForB = google.seen.slice(fetchesForA);
  assert.ok(fetchesForB.length > 0, "user B never reads user A's cache");
  assert.ok(google.seen.slice(0, fetchesForA).every(request => request.authorization === 'Bearer token-a'));
  assert.ok(fetchesForB.every(request => request.authorization === 'Bearer token-b'));
  assert.ok(google.seen.every(request => request.userProject === null));
});

test('the newest token source is used for an existing user', async t => {
  const google = fakeGoogle();
  const registry = createUserRuntimeRegistry({ log: () => {}, fetch: google.fetch });
  const runtime = registry.runtimeFor('user-a', async () => 'old-token');
  assert.equal(registry.runtimeFor('user-a', async () => 'new-token'), runtime);
  const client = await connect(t, runtime);
  await client.callTool(findAdvertiser);
  assert.ok(google.seen.length > 0);
  assert.ok(google.seen.every(request => request.authorization === 'Bearer new-token'));
});

test('a credential error reaches the tool result with its remote message', async t => {
  const registry = createUserRuntimeRegistry({ log: () => {}, fetch: fakeGoogle().fetch });
  const runtime = registry.runtimeFor('user-a', async () => {
    throw new RemoteCredentialsError('not_found', 'Your Google account is not connected. Open the connect link, then try again.');
  });
  const client = await connect(t, runtime);
  const result = await client.callTool({ name: 'list_partners', arguments: {} });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /Your Google account is not connected\. Open the connect link, then try again\./);
});

test('idle runtimes are dropped and a new one is built on the next use', () => {
  let clock = 0;
  const registry = createUserRuntimeRegistry({ log: () => {}, idleMs: 1000, now: () => clock });
  const first = registry.runtimeFor('user-a', async () => 't');
  clock = 500;
  registry.runtimeFor('user-b', async () => 't');
  clock = 1200;
  registry.runtimeFor('user-b', async () => 't');
  assert.equal(registry.size(), 1, 'user A was idle for 1200 ms and is dropped');
  assert.notEqual(registry.runtimeFor('user-a', async () => 't'), first);
  assert.equal(registry.size(), 2);
});

test('above the cap the least recently used runtime is dropped', () => {
  const registry = createUserRuntimeRegistry({ log: () => {}, maxUsers: 2 });
  const a = registry.runtimeFor('user-a', async () => 't');
  registry.runtimeFor('user-b', async () => 't');
  registry.runtimeFor('user-a', async () => 't');
  registry.runtimeFor('user-c', async () => 't');
  assert.equal(registry.size(), 2);
  assert.equal(registry.runtimeFor('user-a', async () => 't'), a, 'user A was used recently and stays');
  assert.equal(registry.size(), 2);
});

test('invalid limits and an empty user ID are refused', () => {
  assert.throws(() => createUserRuntimeRegistry({ log: () => {}, idleMs: 0 }));
  assert.throws(() => createUserRuntimeRegistry({ log: () => {}, maxUsers: 0 }));
  assert.throws(() => createUserRuntimeRegistry({ log: () => {} }).runtimeFor('', async () => 't'));
});
