// Boundary rules for the deployment add-ons in src/remote/. The shared boundary test skips this folder.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const sources = readdirSync(new URL('.', import.meta.url), { recursive: true })
  .filter((path): path is string => typeof path === 'string' && path.endsWith('.ts') && !path.endsWith('.test.ts'))
  .map(path => ({ path, content: readFileSync(new URL(path, import.meta.url), 'utf8') }));

function assertNoViolations(rule: string, violates: (path: string, content: string) => boolean): void {
  assert.deepEqual(sources.filter(({ path, content }) => violates(path, content)).map(({ path }) => `${path}: ${rule}`), []);
}

const importSpecifier = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["'`]([^"'`]+)["'`]/g;
const specifiers = (content: string) => [...content.matchAll(importSpecifier)].map(match => match[1]);

test('the remote sources exist', () => {
  assert.deepEqual(sources.map(({ path }) => path).sort(), ['auth/connect.ts', 'auth/token-vault.ts', 'auth/token-verifier.ts', 'config.ts', 'http.ts', 'main.ts', 'user-runtime.ts']);
});

test('only remote config reads the environment', () => {
  assertNoViolations('only config.ts may read the environment', (path, content) => path !== 'config.ts' && /process\.env/.test(content));
});

test('only main listens, and only on the validated remote config', () => {
  assertNoViolations('only main.ts may listen', (path, content) => path !== 'main.ts' && /\.listen\s*\(/.test(content));
  const main = sources.find(({ path }) => path === 'main.ts')!;
  assert.match(main.content, /httpServer\.listen\(remoteConfig\.port, remoteConfig\.bindAddress/);
  assert.doesNotMatch(main.content, /BIND_ADDRESS/);
});

test('only main builds the runtime', () => {
  assertNoViolations('only main.ts may call createRuntime', (path, content) => path !== 'main.ts' && /\bcreateRuntime\s*\(/.test(content));
});

test('only main and http write to the console or stderr, and nothing writes to stdout', () => {
  const directOutput = /console\.|process\.stderr|process\.stdout/;
  const stdoutWrite = /console\.(?:log|info|debug|table|dir|trace)\b|process\.stdout/;
  assert.ok(stdoutWrite.test('console.log(x)') && stdoutWrite.test('process.stdout.write(x)'));
  assertNoViolations('only main.ts and http.ts may write output', (path, content) => path !== 'main.ts' && path !== 'http.ts' && directOutput.test(content));
  assertNoViolations('no stdout writes', (_path, content) => stdoutWrite.test(content));
});

test('auth imports only jose, the server SDK, Node built-ins, and its own files', () => {
  const allowed = (value: string) => value === 'jose' || value === '@modelcontextprotocol/server' || value.startsWith('node:')
    || /^\.\/[a-z-]+\.js$/.test(value);
  assert.equal(allowed('../config.js'), false);
  assert.equal(allowed('./token-vault.js'), true);
  assertNoViolations('auth dependency allowlist', (path, content) => path.startsWith('auth/') && specifiers(content).some(value => !allowed(value)));
});

test('only main and http import auth, and jose stays inside auth', () => {
  const authImport = (value: string) => /(?:^|\/)auth\//.test(value) && !value.includes('integrations/');
  const importsJose = (value: string) => value === 'jose' || value.startsWith('jose/');
  assert.ok(specifiers("import { x } from './auth/token-verifier.js'").some(authImport));
  assertNoViolations('only main.ts and http.ts may import auth', (path, content) =>
    !path.startsWith('auth/') && path !== 'main.ts' && path !== 'http.ts' && specifiers(content).some(authImport));
  assertNoViolations('only auth imports jose', (path, content) => !path.startsWith('auth/') && specifiers(content).some(importsJose));
});

test('remote code reaches the shared code only through config, runtime, and the logger', () => {
  const sharedAllowed = ['../config.js', '../runtime.js', '../integrations/google/log.js', '../../package.json'];
  assertNoViolations('remote may import only config, runtime, and the logger from the shared code', (path, content) => path !== 'user-runtime.ts'
    && specifiers(content).some(value => value.startsWith('../') && !value.startsWith('../auth') && !sharedAllowed.includes(value)));
});

test('only user-runtime wires the shared modules, and only those createRuntime wires', () => {
  // The modules src/runtime.ts imports, plus the credential error type; user-runtime.ts copies that wiring per user.
  const wiring = ['../runtime.js', '../server.js', '../tools/call.js', '../combined/performance.js', '../combined/presets.js',
    '../integrations/google/log.js', '../integrations/google/auth.js', '../integrations/bidmanager/client.js',
    '../integrations/bidmanager/cleanup.js', '../integrations/bidmanager/reporting.js', '../integrations/dv360/client.js',
    '../integrations/dv360/metadata.js'];
  assertNoViolations('user-runtime.ts may import only the shared modules createRuntime wires', (path, content) =>
    path === 'user-runtime.ts' && specifiers(content).some(value => !wiring.includes(value)));
});
