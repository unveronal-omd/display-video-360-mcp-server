// Exchanges a user's Auth0 access token for their Google access token through Auth0 Token Vault.
// Auth0 keeps the Google refresh token; this server only holds short-lived access tokens, in memory, per user.

export const DISPLAY_VIDEO_SCOPE = 'https://www.googleapis.com/auth/display-video';
export const BID_MANAGER_SCOPE = 'https://www.googleapis.com/auth/doubleclickbidmanager';
export const GOOGLE_SCOPES = [DISPLAY_VIDEO_SCOPE, BID_MANAGER_SCOPE] as const;

const GRANT_TYPE = 'urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token';
const SUBJECT_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
const REQUESTED_TOKEN_TYPE = 'http://auth0.com/oauth/token-type/federated-connection-access-token';
const EXPIRY_MARGIN_MS = 120_000;
const TIMEOUT_MS = 10_000;

export type TokenVaultErrorKind = 'not_found' | 'unavailable';

/** The user's Google token could not be obtained. The message is safe to show to the user. */
export class TokenVaultError extends Error {
  readonly kind: TokenVaultErrorKind;

  constructor(kind: TokenVaultErrorKind, message: string) {
    super(message);
    this.name = 'TokenVaultError';
    this.kind = kind;
  }
}

export type TokenVaultOutcome = 'ok' | 'not_connected' | 'scope_missing' | 'misconfigured' | 'error' | 'unreachable';
export type TokenVaultEvent = {
  readonly type: 'token_vault.exchange';
  readonly outcome: TokenVaultOutcome;
  readonly httpStatus?: number;
  readonly code?: string;
};

export type TokenVaultOptions = {
  /** Auth0 issuer URL, ending in `/`. */
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly connection: string;
  /** The page a user opens to connect Google, named in the "not connected" message. */
  readonly connectUrl: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly onEvent?: (event: TokenVaultEvent) => void;
};

export type TokenVault = {
  /** A Google access token for the user, from the cache or a new exchange. */
  readonly getGoogleToken: (userId: string, auth0AccessToken: string) => Promise<string>;
};

/** Only short machine codes from Auth0 are logged, never descriptions or tokens. */
export function safeCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z0-9_.:-]{1,64}$/i.test(value) ? value : undefined;
}

export function createTokenVault(options: TokenVaultOptions): TokenVault {
  const fetchRequest = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const report = (event: Omit<TokenVaultEvent, 'type'>) => {
    try { options.onEvent?.({ type: 'token_vault.exchange', ...event }); } catch { /* Reporting must not break a call. */ }
  };
  const notConnected = () => new TokenVaultError('not_found', `Your Google account is not connected to this server. Open ${options.connectUrl} `
    + 'in your browser, sign in with the Google account that has DV360 access, allow access, then try again.');
  const unavailable = () => new TokenVaultError('unavailable', 'Could not get your Google access right now. Try again shortly.');
  // User ID (Auth0 `sub`) -> Google access token and the time to stop using it.
  const cache = new Map<string, { token: string; until: number }>();

  return {
    async getGoogleToken(userId, auth0AccessToken) {
      const cached = cache.get(userId);
      if (cached && cached.until > now()) return cached.token;

      let response: Response;
      let body: Record<string, unknown> = {};
      try {
        response = await fetchRequest(new URL('oauth/token', options.issuer), {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            client_id: options.clientId, client_secret: options.clientSecret, grant_type: GRANT_TYPE,
            subject_token: auth0AccessToken, subject_token_type: SUBJECT_TOKEN_TYPE,
            requested_token_type: REQUESTED_TOKEN_TYPE, connection: options.connection,
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const parsed: unknown = await response.json().catch(() => undefined);
        if (parsed !== null && typeof parsed === 'object') body = parsed as Record<string, unknown>;
      } catch {
        report({ outcome: 'unreachable' });
        throw unavailable();
      }

      const code = safeCode(body.error);
      if (response.status !== 200) {
        const httpStatus = response.status;
        if (code === 'invalid_client' || code === 'unauthorized_client') {
          report({ outcome: 'misconfigured', httpStatus, code });
          throw unavailable();
        }
        if (httpStatus === 400 || httpStatus === 401 || httpStatus === 403) {
          report({ outcome: 'not_connected', httpStatus, ...(code ? { code } : {}) });
          throw notConnected();
        }
        report({ outcome: 'error', httpStatus, ...(code ? { code } : {}) });
        throw unavailable();
      }

      const token = body.access_token;
      if (typeof token !== 'string' || token === '') {
        report({ outcome: 'error', httpStatus: 200 });
        throw unavailable();
      }
      if (typeof body.scope === 'string') {
        const granted = body.scope.split(' ');
        if (!GOOGLE_SCOPES.every(scope => granted.includes(scope))) {
          report({ outcome: 'scope_missing' });
          throw notConnected();
        }
      }

      const ttl = (typeof body.expires_in === 'number' ? body.expires_in * 1000 : 0) - EXPIRY_MARGIN_MS;
      if (ttl > 0) {
        const time = now();
        for (const [id, entry] of cache) if (entry.until <= time) cache.delete(id);
        cache.set(userId, { token, until: time + ttl });
      }
      report({ outcome: 'ok' });
      return token;
    },
  };
}
