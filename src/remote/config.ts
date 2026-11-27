import { isIP } from 'node:net';

export type AuthConfig = {
  readonly issuer: string;
  readonly audience: string;
  readonly requiredScope: string;
};

// Per-user Google access (Auth0 Token Vault). Without it the server uses its own Google credential for everyone.
export type PerUserConfig = {
  /** This server's public origin, taken from AUTH0_AUDIENCE (no trailing slash). */
  readonly publicBaseUrl: string;
  readonly tokenVaultClientId: string;
  readonly tokenVaultClientSecret: string;
  readonly connectClientId: string;
  readonly connectClientSecret: string;
  readonly googleConnection: string;
};

// HTTP and authorization settings of the remote entry point. The Google quota project is read by the
// shared loadConfig in src/config.ts.
export type RemoteConfig = {
  readonly port: number;
  readonly bindAddress: string;
  readonly auth: AuthConfig | undefined;
  readonly perUser: PerUserConfig | undefined;
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
};

function parseAllowlist(value: string | undefined, variableName: string): string[] {
  if (value === undefined || value.trim() === '') {
    return ['localhost', '127.0.0.1'];
  }

  const entries = [...new Set(
    value.split(',').map(entry => entry.trim().toLowerCase()).filter(Boolean),
  )];
  if (entries.length === 0) {
    throw new Error(`${variableName} must contain at least one entry (received ${JSON.stringify(value)})`);
  }

  for (const entry of entries) {
    if (entry.includes('://') && !(variableName === 'MCP_ALLOWED_ORIGINS'
      && /^(?!https?:)[a-z][a-z0-9+.-]*:\/\/\*$/.test(entry))) {
      throw new Error(`${variableName} must list the bare hostname (non-HTTP scheme wildcards are allowed for origins)`);
    }
  }
  return entries;
}

export function loadRemoteConfig(env: NodeJS.ProcessEnv = process.env): RemoteConfig {
  const portValue = env.PORT?.trim();
  let port = 8237;
  if (portValue !== undefined && portValue !== '') {
    port = Number(portValue);
    if (!/^\d+$/.test(portValue) || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`PORT must be an integer between 1 and 65535 (received ${JSON.stringify(env.PORT)})`);
    }
  }

  const allowedHosts = parseAllowlist(env.MCP_ALLOWED_HOSTS, 'MCP_ALLOWED_HOSTS');
  const allowedOrigins = parseAllowlist(env.MCP_ALLOWED_ORIGINS, 'MCP_ALLOWED_ORIGINS');

  const bindAddress = env.MCP_BIND_ADDRESS?.trim() || '127.0.0.1';
  if (bindAddress !== 'localhost' && !isIP(bindAddress)) {
    throw new Error('MCP_BIND_ADDRESS must be an IP literal or localhost');
  }
  const issuerValue = env.AUTH0_ISSUER?.trim() || undefined;
  const audience = env.AUTH0_AUDIENCE?.trim() || undefined;
  if (Boolean(issuerValue) !== Boolean(audience)) {
    throw new Error('AUTH0_ISSUER and AUTH0_AUDIENCE must be configured together');
  }
  let auth: AuthConfig | undefined;
  if (issuerValue && audience) {
    let issuerUrl: URL;
    let audienceUrl: URL;
    try { issuerUrl = new URL(issuerValue); } catch {
      throw new Error('AUTH0_ISSUER must be an HTTPS URL without query or fragment');
    }
    if (issuerUrl.protocol !== 'https:' || issuerValue.includes('?') || issuerValue.includes('#')) {
      throw new Error('AUTH0_ISSUER must be an HTTPS URL without query or fragment');
    }
    try { audienceUrl = new URL(audience); } catch {
      throw new Error('AUTH0_AUDIENCE must be an absolute resource URL');
    }
    // The path must be exactly /mcp: it is the only endpoint, and the discovery routes are served
    // only for it, so any other path would advertise a metadata URL that returns 404.
    if (!(audienceUrl.protocol === 'https:' || (audienceUrl.protocol === 'http:' && isLoopback(audienceUrl.hostname)))
      || audienceUrl.pathname !== '/mcp' || audience.includes('?') || audience.includes('#')) {
      throw new Error('AUTH0_AUDIENCE must be the HTTPS (or loopback HTTP) URL of the /mcp endpoint, without trailing slash, query, or fragment');
    }
    const requiredScope = env.AUTH0_REQUIRED_SCOPE?.trim() || 'use:mcp';
    if (!/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(requiredScope)) {
      throw new Error('AUTH0_REQUIRED_SCOPE must be a valid OAuth scope token');
    }
    auth = { issuer: issuerValue.endsWith('/') ? issuerValue : issuerValue + '/', audience, requiredScope };
  }
  if (!isLoopback(bindAddress) && !auth) {
    throw new Error('AUTH0_ISSUER and AUTH0_AUDIENCE are required');
  }
  const perUser = loadPerUserConfig(env, auth);
  return {
    port,
    bindAddress,
    auth,
    perUser,
    allowedHosts,
    allowedOrigins,
  };
}

const PER_USER_VARIABLES = ['AUTH0_TOKEN_VAULT_CLIENT_ID', 'AUTH0_TOKEN_VAULT_CLIENT_SECRET',
  'AUTH0_CONNECT_CLIENT_ID', 'AUTH0_CONNECT_CLIENT_SECRET'] as const;

function loadPerUserConfig(env: NodeJS.ProcessEnv, auth: AuthConfig | undefined): PerUserConfig | undefined {
  const values = PER_USER_VARIABLES.map(name => env[name]?.trim() ?? '');
  if (values.every(value => value === '')) return undefined;
  if (values.some(value => value === '')) {
    throw new Error(`${PER_USER_VARIABLES.join(', ')} must be configured together`);
  }
  if (!auth) throw new Error('Per-user Google access requires AUTH0_ISSUER and AUTH0_AUDIENCE');
  const googleConnection = env.AUTH0_GOOGLE_CONNECTION?.trim() || 'google-oauth2';
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(googleConnection)) {
    throw new Error('AUTH0_GOOGLE_CONNECTION must be an Auth0 connection name');
  }
  const [tokenVaultClientId, tokenVaultClientSecret, connectClientId, connectClientSecret] = values;
  return {
    publicBaseUrl: new URL(auth.audience).origin,
    tokenVaultClientId, tokenVaultClientSecret, connectClientId, connectClientSecret, googleConnection,
  };
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || (isIP(host) === 6 && new URL(`http://[${host}]/`).hostname === '[::1]') || host === '[::1]'
    || (isIP(host) === 4 && host.startsWith('127.'));
}
