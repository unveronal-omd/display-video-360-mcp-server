import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import { createLocalJWKSet, errors, exportJWK, exportSPKI, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { createAuth0Verifier } from './token-verifier.js';

const ISSUER = 'https://issuer.example/';
const AUDIENCE = 'https://mcp.example/mcp';
const MARKER = 'privateClaimMarkerABC123';
const NOW = 1_800_000_000;
const pair = await generateKeyPair('RS256', { extractable: true });
const jwk = { ...await exportJWK(pair.publicKey), kid: 'first', alg: 'RS256' };
const keys = createLocalJWKSet({ keys: [jwk] });
const verifier = createAuth0Verifier({ issuer: ISSUER, audience: AUDIENCE, keys });

function sign(payload: JWTPayload = {}, alg = 'RS256', kid = 'first'): Promise<string> {
  return new SignJWT({ iss: ISSUER, aud: AUDIENCE, exp: NOW + 300, scope: 'use:mcp read:other', azp: 'fake-client', marker: MARKER, ...payload })
    .setProtectedHeader({ alg, kid }).sign(pair.privateKey);
}

function invalidToken(error: unknown): boolean {
  assert.ok(error instanceof OAuthError);
  assert.equal(error.code, OAuthErrorCode.InvalidToken);
  assert.equal(error.message, 'Invalid access token');
  assert.doesNotMatch(JSON.stringify(error.toResponseObject()), new RegExp(MARKER));
  return true;
}

test('valid RS256 token returns the required AuthInfo fields', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW * 1000 });
  const token = await sign();
  assert.deepEqual(await verifier.verifyAccessToken(token), {
    token, clientId: 'fake-client', scopes: ['use:mcp', 'read:other'], expiresAt: NOW + 300, resource: new URL(AUDIENCE),
  });
});

test('audience arrays may contain this resource among other audiences', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW * 1000 });
  assert.equal((await verifier.verifyAccessToken(await sign({ aud: ['https://other.example/mcp', AUDIENCE] }))).resource?.href, AUDIENCE);
});

for (const [label, payload] of [
  ['client_id fallback', { azp: undefined, client_id: 'second-client' }],
  ['non-string azp fallback', { azp: 42, client_id: 'second-client' }],
  ['unknown client', { azp: undefined, client_id: undefined }],
  ['non-string clients', { azp: {}, client_id: 42 }],
] as const) {
  test(label, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: NOW * 1000 });
    const info = await verifier.verifyAccessToken(await sign(payload));
    assert.equal(info.clientId, typeof payload.client_id === 'string' ? payload.client_id : 'unknown');
  });
}

for (const scope of [undefined, ['use:mcp'], 42, {}]) {
  test(`non-string scope ${JSON.stringify(scope)} grants no scopes`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: NOW * 1000 });
    assert.deepEqual((await verifier.verifyAccessToken(await sign({ scope }))).scopes, []);
  });
}

const badTokens: ReadonlyArray<readonly [string, () => Promise<string>]> = [
  ['wrong issuer', () => sign({ iss: `https://${MARKER}.example/` })],
  ['wrong audience', () => sign({ aud: `https://${MARKER}.example/mcp` })],
  ['expired', () => sign({ exp: NOW - 60 })],
  ['future nbf', () => sign({ nbf: NOW + 60 })],
  ['missing exp', () => sign({ exp: undefined })],
  ['none algorithm', async () => `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from(JSON.stringify({ iss: ISSUER, aud: AUDIENCE, exp: NOW + 300, marker: MARKER })).toString('base64url')}.`],
  ['HS256 public key confusion', async () => new SignJWT({ iss: ISSUER, aud: AUDIENCE, exp: NOW + 300, marker: MARKER }).setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode(await exportSPKI(pair.publicKey)))],
  ['RS384 algorithm', async () => new SignJWT({ iss: ISSUER, aud: AUDIENCE, exp: NOW + 300 }).setProtectedHeader({ alg: 'RS384', kid: 'first' }).sign((await generateKeyPair('RS384')).privateKey)],
  ['unknown kid', () => sign({}, 'RS256', MARKER)],
  ['tampered payload', async () => {
    const token = await sign();
    const [header, , signature] = token.split('.');
    return `${header}.${Buffer.from(JSON.stringify({ iss: ISSUER, aud: AUDIENCE, exp: NOW + 300, scope: MARKER })).toString('base64url')}.${signature}`;
  }],
  ['tampered signature', async () => {
    const parts = (await sign()).split('.');
    parts[2] = `${parts[2][0] === 'A' ? 'B' : 'A'}${parts[2].slice(1)}`;
    return parts.join('.');
  }],
  ['two parts', async () => (await sign()).split('.').slice(0, 2).join('.')],
  ['four parts', async () => `${await sign()}.${MARKER}`],
  ['empty token', async () => ''],
];
for (const [label, makeToken] of badTokens) {
  test(`${label} gives the same fixed invalid-token error`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: NOW * 1000 });
    await assert.rejects(verifier.verifyAccessToken(await makeToken()), invalidToken);
  });
}

for (const [secondsPastExpiry, accepted] of [[10, true], [60, false]] as const) {
  test(`clock tolerance ${accepted ? 'accepts' : 'rejects'} ${secondsPastExpiry}s past expiry`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: NOW * 1000 });
    const result = verifier.verifyAccessToken(await sign({ exp: NOW - secondsPastExpiry }));
    if (accepted) assert.equal((await result).expiresAt, NOW - secondsPastExpiry);
    else await assert.rejects(result, invalidToken);
  });
}

for (const [label, error] of [
  ['timeout', new errors.JWKSTimeout(MARKER)],
  ['fetch failure', new TypeError(`fetch failed ${MARKER}`)],
] as const) {
  test(`unavailable key set (${label}) returns a fixed server error`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: NOW * 1000 });
    const unavailable = createAuth0Verifier({ issuer: ISSUER, audience: AUDIENCE, keys: async () => { throw error; } });
    await assert.rejects(unavailable.verifyAccessToken(await sign()), failure => {
      assert.ok(failure instanceof OAuthError);
      assert.equal(failure.code, OAuthErrorCode.ServerError);
      assert.doesNotMatch(JSON.stringify(failure.toResponseObject()), new RegExp(MARKER));
      return true;
    });
  });
}

test('a rotating key resolver verifies tokens signed by both key generations', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW * 1000 });
  const next = await generateKeyPair('RS256');
  const nextKeys = createLocalJWKSet({ keys: [{ ...await exportJWK(next.publicKey), kid: 'next', alg: 'RS256' }] });
  let active = keys;
  const rotating = createAuth0Verifier({ issuer: ISSUER, audience: AUDIENCE, keys: (...args) => active(...args) });
  await rotating.verifyAccessToken(await sign());
  active = nextKeys;
  const token = await new SignJWT({ iss: ISSUER, aud: AUDIENCE, exp: NOW + 300 }).setProtectedHeader({ alg: 'RS256', kid: 'next' }).sign(next.privateKey);
  assert.equal((await rotating.verifyAccessToken(token)).token, token);
});

test('constructing a remote verifier never fetches keys at startup', t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network access'); });
  createAuth0Verifier({ issuer: 'https://127.0.0.1:1/', audience: AUDIENCE });
  assert.equal(fetch.mock.callCount(), 0);
});
