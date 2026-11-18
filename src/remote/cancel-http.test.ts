// A-9 of the shared reliability suite, over this fork's real HTTP transport: the real tool handlers, services,
// clients and request loop against a scripted fake Google (../composition-harness.test.ts). All time is fake.
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { loadRemoteConfig } from './config.js';
import { createHttpServer } from './http.js';
import { createServer } from '../server.js';
import { checkRedaction, composition, googleError, json, queryId, title, type LogEventLine } from '../composition-harness.test.js';

const partners = '/v4/partners';
const partnerList = () => json({ partners: [{ partnerId: queryId, displayName: title }] });
const types = (events: readonly LogEventLine[]) => events.map(event => event.type);

// Recorded as a characterization test (verified 2026-11-13, SDK 2.4.0): our server offers only the 2025-era protocol (the
// SDK 2.4.0 default). In that era the client cancels by POSTing notifications/cancelled; in stateless mode that POST
// reaches a fresh per-request server that cannot match it to the running call, so the call keeps going until it
// ends by itself (within its retry budget). The 2026 era would abort the call's own HTTP stream instead, but our
// server does not offer it. Change this test deliberately if cancellation over HTTP is ever made to work.
test('A-9 over real HTTP (2025-era protocol) a client cancel does not reach the running call', { timeout: 10_000 }, async t => {
  const h = await composition(t, { heldSleeps: true, random: () => 0.5 });
  const httpServer = createHttpServer(loadRemoteConfig({}),
    { createMcpServer: () => createServer(h.deps) });
  const closedWaiters: (() => void)[] = [];
  httpServer.on('request', (_req, res) => { res.on('close', () => closedWaiters.shift()?.()); });
  t.after(() => new Promise<void>(resolve => { httpServer.closeAllConnections(); httpServer.close(() => resolve()); }));
  await new Promise<void>((resolve, reject) => { httpServer.once('error', reject); httpServer.listen(0, '127.0.0.1', resolve); });
  const { port } = httpServer.address() as AddressInfo;
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  const client = new Client({ name: 'cancel-test', version: '1' });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal(transport.protocolVersion, '2025-11-25');

  h.steps.push({ path: partners, respond: () => googleError(503) });
  const controller = new AbortController();
  const logged = h.nextEvent(event => event.type === 'tool.call');
  const result = client.callTool({ name: 'list_partners', arguments: {} }, { signal: controller.signal });
  result.catch(() => {});
  const sleep = await h.nextSleep();
  assert.equal(sleep.ms, 500);
  const fetchSignal = h.requests[0].signal;
  assert.ok(fetchSignal && !fetchSignal.aborted);

  // The next HTTP exchange to finish is the client's cancellation POST (the call's own stream stays open).
  const cancellationHandled = new Promise<void>(resolve => { closedWaiters.push(resolve); });
  controller.abort();
  await assert.rejects(result);
  await cancellationHandled;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetchSignal.aborted, false);
  assert.equal(sleep.signal?.aborted, false);

  // The abandoned call finishes on its own: the retry is sent and the tool call is logged as a success.
  h.steps.push({ path: partners, respond: partnerList });
  sleep.release();
  const tool = await logged;
  assert.equal(h.requests.length, 2);
  assert.deepEqual(types(h.eventsOf(tool.callId as string)), ['google.request', 'google.retry', 'google.request', 'tool.call']);
  assert.equal(tool.outcome, 'ok');
  checkRedaction(h.lines);
});
