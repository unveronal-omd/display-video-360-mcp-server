// The "connect Google" step built into sign-in (Auth0 Connected Accounts, so Token Vault holds the user's Google token).
//
// /authorize         The MCP client's sign-in (this server is the advertised authorization server). The request is
//                    saved and the steps below run; /connect runs them without an MCP client.
// /connect           Auth0 login (Google connection, PKCE) for a My Account API token.
// /connect/callback  Code exchange, then a connected-accounts session for the DV360 scopes; redirect to Google.
// /connect/complete  Finish the session (Auth0 stores the Google tokens). From /authorize, continue at Auth0's
//                    /authorize with the saved request, which completes without a prompt (the user is signed in).
//
// Flow state lives in a short-lived encrypted, HttpOnly cookie, so any instance can serve any step.
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { GOOGLE_SCOPES, safeCode } from './token-vault.js';

const COOKIE = 'dv360_connect';
const COOKIE_PATH = '/connect';
const COOKIE_MAX_AGE_S = 600;
const MY_ACCOUNT_SCOPES = 'openid email create:me:connected_accounts';
const TIMEOUT_MS = 10_000;

export type ConnectOptions = {
  /** Auth0 issuer URL, ending in `/`. */
  readonly issuer: string;
  /** This server's public origin, e.g. `https://host`; callback URLs are built from it, never from the request. */
  readonly publicBaseUrl: string;
  /** The Regular Web Application MCP clients use; it also runs this flow. */
  readonly clientId: string;
  readonly clientSecret: string;
  readonly connection: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly onEvent?: (event: ConnectEvent) => void;
};

export type ConnectEvent = {
  readonly type: 'connect.step';
  readonly step: 'authorize' | 'start' | 'callback' | 'complete';
  readonly outcome: 'ok' | 'failed';
  readonly reason?: string;
  readonly httpStatus?: number;
  readonly code?: string;
};

export const CONNECT_PATHS = ['/authorize', '/connect', '/connect/callback', '/connect/complete'] as const;
export type ConnectPath = typeof CONNECT_PATHS[number];

type Flow = {
  readonly state?: string;
  readonly verifier?: string;
  readonly connectState?: string;
  readonly authSession?: string;
  readonly token?: string;
  readonly resume?: Record<string, string>;
  readonly exp: number;
};

// Moves a connect_code delivered in the URL fragment into the query string.
const FRAGMENT_PAGE = `<!doctype html><meta charset="utf-8"><title>Connecting…</title>
<script>
var p = new URLSearchParams(location.hash.slice(1));
if (p.get("connect_code") || p.get("error")) { location.replace(location.pathname + "?" + p.toString()); }
else { document.body.textContent = "Missing connect code. Start again from Claude, or open /connect."; }
</script><body></body>`;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
}

function page(title: string, message: string, status = 200): Response {
  const body = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
    + `<title>${escapeHtml(title)}</title><body style="font-family:system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem">`
    + `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body>`;
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

function redirect(location: string, cookie?: string): Response {
  const headers: Record<string, string> = { location, 'cache-control': 'no-store' };
  if (cookie !== undefined) headers['set-cookie'] = cookie;
  return new Response(null, { status: 302, headers });
}

function base64Url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

function pkceChallenge(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier).digest());
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

/** The email claim of an ID token, used only as a Google login hint; it comes straight from Auth0 over TLS. */
function idTokenEmail(idToken: unknown): string | undefined {
  if (typeof idToken !== 'string') return undefined;
  try {
    const claims: unknown = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8'));
    const email = (claims as Record<string, unknown> | null)?.email;
    return typeof email === 'string' && email !== '' && email.length <= 254 ? email : undefined;
  } catch {
    return undefined;
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const parsed: unknown = await response.json().catch(() => undefined);
  return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
}

export type ConnectHandler = (path: ConnectPath, url: URL, cookieHeader: string | undefined) => Promise<Response>;

export function createConnectHandler(options: ConnectOptions): ConnectHandler {
  const fetchRequest = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const callbackUrl = `${options.publicBaseUrl}/connect/callback`;
  const completeUrl = `${options.publicBaseUrl}/connect/complete`;
  const key = Buffer.from(hkdfSync('sha256', options.clientSecret, 'dv360-mcp-connect', 'flow-cookie', 32));
  const report = (event: Omit<ConnectEvent, 'type'>) => {
    try { options.onEvent?.({ type: 'connect.step', ...event }); } catch { /* Reporting must not break a step. */ }
  };

  function seal(flow: Omit<Flow, 'exp'>): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = JSON.stringify({ ...flow, exp: Math.floor(now() / 1000) + COOKIE_MAX_AGE_S });
    const sealed = Buffer.concat([iv, cipher.update(data, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    return `${COOKIE}=${base64Url(sealed)}; Max-Age=${COOKIE_MAX_AGE_S}; Path=${COOKIE_PATH}; Secure; HttpOnly; SameSite=Lax`;
  }

  function open(cookieHeader: string | undefined): Flow | undefined {
    const value = readCookie(cookieHeader, COOKIE);
    if (value === undefined) return undefined;
    try {
      const sealed = Buffer.from(value, 'base64url');
      if (sealed.length < 29) return undefined;
      const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
      decipher.setAuthTag(sealed.subarray(sealed.length - 16));
      const data = Buffer.concat([decipher.update(sealed.subarray(12, sealed.length - 16)), decipher.final()]).toString('utf8');
      const flow = JSON.parse(data) as Flow;
      return typeof flow.exp === 'number' && flow.exp * 1000 > now() ? flow : undefined;
    } catch {
      return undefined;
    }
  }

  const clearCookie = `${COOKIE}=; Max-Age=0; Path=${COOKIE_PATH}; Secure; HttpOnly; SameSite=Lax`;

  function fail(step: ConnectEvent['step'], reason: string, extra: { httpStatus?: number; code?: string } = {}): Response {
    report({ step, outcome: 'failed', reason, ...extra });
    const response = page('Could not connect Google', 'Something went wrong. Close this tab and connect again from Claude. '
      + 'If it keeps failing, contact the server administrator.', 400);
    response.headers.set('set-cookie', clearCookie);
    return response;
  }

  function auth0Error(body: Record<string, unknown>): string | undefined {
    return safeCode(body.error) ?? safeCode(body.title);
  }

  function begin(step: 'authorize' | 'start', resume?: Record<string, string>): Response {
    const state = base64Url(randomBytes(24));
    const verifier = base64Url(randomBytes(48));
    const query = new URLSearchParams({
      response_type: 'code', client_id: options.clientId, redirect_uri: callbackUrl, scope: MY_ACCOUNT_SCOPES,
      audience: new URL('me/', options.issuer).href, connection: options.connection, state,
      code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256',
    });
    report({ step, outcome: 'ok' });
    return redirect(`${new URL('authorize', options.issuer).href}?${query}`, seal({ state, verifier, ...(resume ? { resume } : {}) }));
  }

  async function post(path: string, body: unknown, init: { token?: string; form?: boolean } = {}): Promise<Response> {
    const headers: Record<string, string> = { accept: 'application/json',
      'content-type': init.form ? 'application/x-www-form-urlencoded' : 'application/json' };
    if (init.token !== undefined) headers.authorization = `Bearer ${init.token}`;
    return fetchRequest(new URL(path, options.issuer), {
      method: 'POST', headers, signal: AbortSignal.timeout(TIMEOUT_MS),
      body: init.form ? new URLSearchParams(body as Record<string, string>).toString() : JSON.stringify(body),
    });
  }

  async function callback(url: URL, cookieHeader: string | undefined): Promise<Response> {
    const flow = open(cookieHeader);
    const params = url.searchParams;
    if (flow?.state === undefined || flow.verifier === undefined || params.get('state') !== flow.state) {
      return fail('callback', 'state');
    }
    if (params.has('error')) return fail('callback', 'login_error', { code: safeCode(params.get('error')) });

    const tokenResponse = await post('oauth/token', {
      grant_type: 'authorization_code', client_id: options.clientId, client_secret: options.clientSecret,
      code: params.get('code') ?? '', redirect_uri: callbackUrl, code_verifier: flow.verifier,
    }, { form: true });
    const tokens = await readJson(tokenResponse);
    if (tokenResponse.status !== 200 || typeof tokens.access_token !== 'string') {
      return fail('callback', 'code_exchange', { httpStatus: tokenResponse.status, code: auth0Error(tokens) });
    }
    const myAccountToken = tokens.access_token;

    const connectState = base64Url(randomBytes(24));
    const email = idTokenEmail(tokens.id_token);
    const connectResponse = await post('me/v1/connected-accounts/connect', {
      connection: options.connection, redirect_uri: completeUrl, state: connectState,
      scopes: ['openid', 'profile', ...GOOGLE_SCOPES],
      // Pre-select the Google account just used, so Google doesn't show its account chooser again.
      ...(email ? { authorization_params: { login_hint: email } } : {}),
    }, { token: myAccountToken });
    const session = await readJson(connectResponse);
    const connectUri = session.connect_uri;
    const ticket = (session.connect_params as Record<string, unknown> | undefined)?.ticket;
    if ((connectResponse.status !== 200 && connectResponse.status !== 201) || typeof connectUri !== 'string'
      || !connectUri.startsWith('https://') || typeof ticket !== 'string' || typeof session.auth_session !== 'string') {
      return fail('callback', 'connect', { httpStatus: connectResponse.status, code: auth0Error(session) });
    }
    report({ step: 'callback', outcome: 'ok' });
    const target = new URL(connectUri);
    target.searchParams.set('ticket', ticket);
    return redirect(target.href, seal({
      connectState, authSession: session.auth_session, token: myAccountToken, ...(flow.resume ? { resume: flow.resume } : {}),
    }));
  }

  async function complete(url: URL, cookieHeader: string | undefined): Promise<Response> {
    const params = url.searchParams;
    if (!params.has('connect_code') && !params.has('error')) {
      return new Response(FRAGMENT_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    }
    const flow = open(cookieHeader);
    if (flow?.authSession === undefined || flow.token === undefined) return fail('complete', 'session');
    if (params.has('state') && params.get('state') !== flow.connectState) return fail('complete', 'state');
    if (params.has('error')) return fail('complete', 'google_error', { code: safeCode(params.get('error')) });

    const completeResponse = await post('me/v1/connected-accounts/complete', {
      auth_session: flow.authSession, connect_code: params.get('connect_code'), redirect_uri: completeUrl,
    }, { token: flow.token });
    const body = await readJson(completeResponse);
    if (completeResponse.status !== 200 && completeResponse.status !== 201) {
      return fail('complete', 'complete', { httpStatus: completeResponse.status, code: auth0Error(body) });
    }
    const scopes = Array.isArray(body.scopes) ? body.scopes : [];
    let response: Response;
    if (!GOOGLE_SCOPES.every(scope => scopes.includes(scope))) {
      report({ step: 'complete', outcome: 'failed', reason: 'scope_missing' });
      response = page('DV360 access missing', 'Your Google account was connected, but DV360 access was not allowed. '
        + 'Connect again from Claude and allow both Display & Video 360 permissions.', 400);
    } else if (flow.resume) {
      report({ step: 'complete', outcome: 'ok' });
      const resume = new URLSearchParams({ ...flow.resume, connection: options.connection });
      response = redirect(`${new URL('authorize', options.issuer).href}?${resume}`);
    } else {
      report({ step: 'complete', outcome: 'ok' });
      response = page('Google account connected', 'You can close this tab and go back to Claude.');
    }
    response.headers.set('set-cookie', clearCookie);
    return response;
  }

  return async (path, url, cookieHeader) => {
    try {
      switch (path) {
        case '/authorize': {
          // Only the configured client may sign in through here; Auth0 still checks its redirect URI and PKCE at the end.
          const resume = Object.fromEntries(url.searchParams);
          if (resume.client_id !== options.clientId || !resume.redirect_uri || resume.response_type !== 'code') {
            return fail('authorize', 'request');
          }
          return begin('authorize', resume);
        }
        case '/connect': return begin('start');
        case '/connect/callback': return await callback(url, cookieHeader);
        case '/connect/complete': return await complete(url, cookieHeader);
      }
    } catch {
      return fail(path === '/connect/complete' ? 'complete' : path === '/connect/callback' ? 'callback' : 'start', 'unreachable');
    }
  };
}

/** RFC 8414 metadata: sign-in starts here; tokens and client registration stay at Auth0. */
export function authorizationServerMetadata(options: { readonly issuer: string; readonly publicBaseUrl: string; readonly scope: string }) {
  return {
    issuer: `${options.publicBaseUrl}/`,
    authorization_endpoint: `${options.publicBaseUrl}/authorize`,
    token_endpoint: new URL('oauth/token', options.issuer).href,
    registration_endpoint: new URL('oidc/register', options.issuer).href,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    scopes_supported: [options.scope],
  };
}
