import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadRemoteConfig as loadConfig } from './config.js';

const BASE_ENV = { GOOGLE_CLOUD_QUOTA_PROJECT: 'test-quota-project' };

test('uses default configuration when variables are unset', () => {
  assert.deepEqual(loadConfig({ ...BASE_ENV }), {
    port: 8237,
    bindAddress: '127.0.0.1',
    auth: undefined,
    perUser: undefined,
    allowedHosts: ['localhost', '127.0.0.1'],
    allowedOrigins: ['localhost', '127.0.0.1'],
  });
});

for (const [input, expected] of [
  ['8080', 8080],
  ['1', 1],
  ['65535', 65535],
  [' 8080 ', 8080],
  ['', 8237],
  ['   ', 8237],
] as const) {
  test(`accepts PORT ${JSON.stringify(input)}`, () => {
    assert.equal(loadConfig({ ...BASE_ENV, PORT: input }).port, expected);
  });
}

for (const input of ['0', '-1', '65536', 'abc', '80abc', '80.5', '0x50', '1e3']) {
  test(`rejects PORT ${JSON.stringify(input)}`, () => {
    assert.throws(() => loadConfig({ ...BASE_ENV, PORT: input }), /PORT/);
  });
}

const allowlistCases: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['example.com', ['example.com']],
  ['a.com,b.com', ['a.com', 'b.com']],
  [' a.com , b.com ', ['a.com', 'b.com']],
  ['a.com,', ['a.com']],
  ['a.com,,b.com', ['a.com', 'b.com']],
  ['Example.COM', ['example.com']],
  ['a.com,A.com,b.com', ['a.com', 'b.com']],
  ['', ['localhost', '127.0.0.1']],
  ['   ', ['localhost', '127.0.0.1']],
];

for (const [variable, property, otherProperty] of [
  ['MCP_ALLOWED_HOSTS', 'allowedHosts', 'allowedOrigins'],
  ['MCP_ALLOWED_ORIGINS', 'allowedOrigins', 'allowedHosts'],
] as const) {
  for (const [input, expected] of allowlistCases) {
    test(`parses ${variable} ${JSON.stringify(input)} independently`, () => {
      const config = loadConfig({ ...BASE_ENV, [variable]: input });
      assert.deepEqual(config[property], expected);
      assert.deepEqual(config[otherProperty], ['localhost', '127.0.0.1']);
    });
  }

  test(`rejects ${variable} with no entries`, () => {
    assert.throws(() => loadConfig({ ...BASE_ENV, [variable]: ',' }), new RegExp(variable));
  });
}

test('preserves wildcard origin schemes', () => {
  assert.deepEqual(loadConfig({ ...BASE_ENV, MCP_ALLOWED_ORIGINS: 'vscode-webview://*' }).allowedOrigins, ['vscode-webview://*']);
});

test('ignores HOST and bind-address variables other than MCP_BIND_ADDRESS', () => {
  const config = loadConfig({ ...BASE_ENV, HOST: '0.0.0.0', BIND_ADDRESS: '0.0.0.0' });
  assert.deepEqual(Object.keys(config).sort(), ['allowedHosts', 'allowedOrigins', 'auth', 'bindAddress', 'perUser', 'port']);
  assert.deepEqual(config, loadConfig({ ...BASE_ENV }));
});

test('ignores the quota project, which the shared loadConfig reads', () => {
  assert.equal('googleCloudQuotaProject' in loadConfig({}), false);
});

const AUTH = { AUTH0_ISSUER: 'https://auth.example.test', AUTH0_AUDIENCE: 'https://mcp.example.test/mcp' };
for (const bindAddress of ['localhost', '127.0.0.1', '127.23.45.67', '::1', '0:0:0:0:0:0:0:1', '0.0.0.0', '::', '192.0.2.1']) {
  for (const enabled of [true, false]) {
    test(`bind ${bindAddress} with auth ${enabled}`, () => {
      const env = { ...BASE_ENV, ...(enabled ? AUTH : {}), MCP_BIND_ADDRESS: bindAddress };
      const loopback = ['localhost', '127.0.0.1', '127.23.45.67', '::1', '0:0:0:0:0:0:0:1'].includes(bindAddress);
      if (enabled || loopback) assert.equal(loadConfig(env).bindAddress, bindAddress);
      else assert.throws(() => loadConfig(env), { message: 'AUTH0_ISSUER and AUTH0_AUDIENCE are required' });
    });
  }
}
test('normalizes issuer, preserves exact audience, and defaults scope', () => {
  assert.deepEqual(loadConfig({ ...BASE_ENV, ...AUTH }).auth,
    { issuer: AUTH.AUTH0_ISSUER + '/', audience: AUTH.AUTH0_AUDIENCE, requiredScope: 'use:mcp' });
  assert.equal(loadConfig({ ...BASE_ENV, ...AUTH, AUTH0_REQUIRED_SCOPE: 'custom:scope' }).auth?.requiredScope, 'custom:scope');
});
for (const env of [
  { AUTH0_ISSUER: AUTH.AUTH0_ISSUER }, { AUTH0_AUDIENCE: AUTH.AUTH0_AUDIENCE },
  { ...AUTH, AUTH0_ISSUER: 'http://auth.example.test' },
  { ...AUTH, AUTH0_ISSUER: 'https://auth.example.test/#fragment' },
  { ...AUTH, AUTH0_ISSUER: 'https://auth.example.test/?query=1' },
  { ...AUTH, AUTH0_AUDIENCE: 'https://mcp.example.test/mcp/' },
  { ...AUTH, AUTH0_AUDIENCE: 'https://mcp.example.test/mcp#fragment' },
  { ...AUTH, AUTH0_AUDIENCE: 'https://mcp.example.test/mcp?x=1' },
  { ...AUTH, AUTH0_AUDIENCE: 'https://mcp.example.test/api/mcp' },
  { ...AUTH, AUTH0_AUDIENCE: 'https://mcp.example.test/MCP' },
  { ...AUTH, AUTH0_AUDIENCE: 'https://mcp.example.test' },
  { ...AUTH, AUTH0_AUDIENCE: 'not-a-url' },
  { ...AUTH, AUTH0_AUDIENCE: 'http://mcp.example.test/mcp' },
  { ...AUTH, AUTH0_REQUIRED_SCOPE: 'two scopes' },
  { ...AUTH, AUTH0_REQUIRED_SCOPE: 'bad"scope' },
  { ...AUTH, AUTH0_REQUIRED_SCOPE: 'bad\\scope' },
  { MCP_BIND_ADDRESS: 'garbage' },
]) test(`rejects invalid authorization config ${JSON.stringify(env)}`, () => {
  assert.throws(() => loadConfig({ ...BASE_ENV, ...env }));
});
for (const audience of ['http://127.0.0.1/mcp', 'http://localhost/mcp', 'http://[::1]/mcp']) {
  test(`allows loopback audience ${audience}`, () => {
    assert.equal(loadConfig({ ...BASE_ENV, ...AUTH, AUTH0_AUDIENCE: audience }).auth?.audience, audience);
  });
}
for (const variable of ['MCP_ALLOWED_HOSTS', 'MCP_ALLOWED_ORIGINS']) {
  for (const value of ['http://*', 'https://*', 'https://app.internal']) {
    test(`rejects full origin ${variable}=${value}`, () => {
      assert.throws(() => loadConfig({ ...BASE_ENV, [variable]: value }), /bare hostname/);
    });
  }
}
test('host allowlist rejects scheme wildcard', () => {
  assert.throws(() => loadConfig({ ...BASE_ENV, MCP_ALLOWED_HOSTS: 'vscode-webview://*' }), /bare hostname/);
});

const PER_USER = {
  AUTH0_TOKEN_VAULT_CLIENT_ID: 'vault-client', AUTH0_TOKEN_VAULT_CLIENT_SECRET: 'vault-secret',
  AUTH0_CONNECT_CLIENT_ID: 'connect-client', AUTH0_CONNECT_CLIENT_SECRET: 'connect-secret',
};

test('per-user access is off without its settings', () => {
  assert.equal(loadConfig({ ...BASE_ENV, ...AUTH }).perUser, undefined);
  assert.equal(loadConfig({ ...BASE_ENV, ...AUTH, AUTH0_TOKEN_VAULT_CLIENT_ID: '  ', AUTH0_GOOGLE_CONNECTION: 'other' }).perUser, undefined);
});

test('per-user access takes its public URL from the audience and defaults the Google connection', () => {
  assert.deepEqual(loadConfig({ ...BASE_ENV, ...AUTH, ...PER_USER }).perUser, {
    publicBaseUrl: 'https://mcp.example.test',
    tokenVaultClientId: 'vault-client', tokenVaultClientSecret: 'vault-secret',
    connectClientId: 'connect-client', connectClientSecret: 'connect-secret', googleConnection: 'google-oauth2',
    tokenVaultConnection: 'google-oauth2',
  });
  assert.equal(loadConfig({ ...BASE_ENV, ...AUTH, ...PER_USER, AUTH0_GOOGLE_CONNECTION: 'google-custom' }).perUser?.googleConnection, 'google-custom');
  assert.equal(loadConfig({ ...BASE_ENV, ...AUTH, ...PER_USER, AUTH0_GOOGLE_CONNECTION: 'google-custom' }).perUser?.tokenVaultConnection, 'google-custom',
    'the Token Vault connection defaults to the sign-in connection');
  const split = loadConfig({ ...BASE_ENV, ...AUTH, ...PER_USER, AUTH0_TOKEN_VAULT_CONNECTION: 'google-vault' }).perUser;
  assert.equal(split?.googleConnection, 'google-oauth2');
  assert.equal(split?.tokenVaultConnection, 'google-vault');
});

for (const name of Object.keys(PER_USER)) {
  test(`per-user access refuses to start without ${name}`, () => {
    assert.throws(() => loadConfig({ ...BASE_ENV, ...AUTH, ...PER_USER, [name]: '' }), /must be configured together/);
  });
}

test('per-user access requires Auth0 and a valid connection name', () => {
  assert.throws(() => loadConfig({ ...BASE_ENV, ...PER_USER }), /requires AUTH0_ISSUER and AUTH0_AUDIENCE/);
  assert.throws(() => loadConfig({ ...BASE_ENV, ...AUTH, ...PER_USER, AUTH0_GOOGLE_CONNECTION: 'bad name' }), /AUTH0_GOOGLE_CONNECTION/);
  assert.throws(() => loadConfig({ ...BASE_ENV, ...AUTH, ...PER_USER, AUTH0_TOKEN_VAULT_CONNECTION: 'bad name' }), /AUTH0_TOKEN_VAULT_CONNECTION/);
});
