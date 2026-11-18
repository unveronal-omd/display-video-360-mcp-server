import { createServer as createNodeServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { NodeStreamableHTTPServerTransport, hostHeaderValidation, originValidation } from '@modelcontextprotocol/node';
import { bearerAuthChallengeResponse, getOAuthProtectedResourceMetadataUrl, OAuthError, OAuthErrorCode, verifyBearerToken, type McpServer, type OAuthTokenVerifier } from '@modelcontextprotocol/server';
import type { RemoteConfig } from './config.js';

export type AuthRejectReason = 'no_token' | 'invalid_token' | 'insufficient_scope' | 'verifier_unavailable';

export type HttpServerOptions = {
  readonly verifier?: OAuthTokenVerifier;
  readonly onAuthReject?: (reason: AuthRejectReason) => void;
  /** Builds the MCP server for one request using process-level dependencies. */
  readonly createMcpServer: () => McpServer;
  /** Receives unexpected errors after the response. Defaults to stderr. */
  readonly onError?: (error: unknown) => void;
};

function reportError(error: unknown): void {
  console.error(JSON.stringify({ type: 'http.error', errorClass: httpErrorClass(error) }));
}

export function httpErrorClass(error: unknown): string {
  try {
    const name = error != null ? Object.getPrototypeOf(error)?.constructor?.name : undefined;
    return typeof name === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(name) ? name : 'Object';
  } catch { return 'Object'; }
}

async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
  const body = await response.text();
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(body);
}

function writeJsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { ...headers, 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

export function createHttpServer(config: RemoteConfig, options: HttpServerOptions): Server {
  if (config.auth && !options.verifier) throw new Error('Authorization requires a token verifier');
  const validateHost = hostHeaderValidation([...config.allowedHosts]);
  const validateOrigin = originValidation([...config.allowedOrigins]);
  const createMcpServer = options.createMcpServer;
  const onError = options.onError ?? reportError;

  return createNodeServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (!validateHost(req, res) || !validateOrigin(req, res)) return;

      const path = (req.url ?? '').split('?', 1)[0];
      if (path === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      if (config.auth && (path === '/.well-known/oauth-protected-resource'
        || path === '/.well-known/oauth-protected-resource/mcp')) {
        const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization' };
        if (req.method === 'OPTIONS') {
          res.writeHead(204, cors);
          res.end();
        } else if (req.method === 'GET') {
          res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ resource: config.auth.audience, authorization_servers: [config.auth.issuer],
            scopes_supported: [config.auth.requiredScope], bearer_methods_supported: ['header'] }));
        } else {
          writeJsonRpcError(res, 405, -32000, 'Method not allowed.', { ...cors, Allow: 'GET, OPTIONS' });
        }
        return;
      }
      if (path !== '/mcp') {
        writeJsonRpcError(res, 404, -32000, 'Not Found');
        return;
      }
      if (config.auth) {
        const authOptions = { verifier: options.verifier!, requiredScopes: [config.auth.requiredScope],
          resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(config.auth.audience)),
          expectedResource: new URL(config.auth.audience) };
        try {
          // Node normally discards duplicate Authorization fields; the SDK only splits on spaces.
          const count = req.rawHeaders.filter((_, index) => index % 2 === 0
            && req.rawHeaders[index].toLowerCase() === 'authorization').length;
          if (count > 1 || (req.headers.authorization !== undefined
            && !/^Bearer [^\s,]+$/i.test(req.headers.authorization))) {
            throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid access token');
          }
          await verifyBearerToken(req.headers.authorization, authOptions);
        } catch (error) {
          const code = error instanceof OAuthError ? error.code : OAuthErrorCode.ServerError;
          const reason: AuthRejectReason = code === OAuthErrorCode.InsufficientScope ? 'insufficient_scope'
            : code === OAuthErrorCode.InvalidToken ? (req.headers.authorization === undefined ? 'no_token' : 'invalid_token')
            : 'verifier_unavailable';
          // Sanitize even an injected verifier's errors before letting the SDK render them.
          const safeError = new OAuthError(
            reason === 'insufficient_scope' ? OAuthErrorCode.InsufficientScope
              : reason === 'verifier_unavailable' ? OAuthErrorCode.ServerError : OAuthErrorCode.InvalidToken,
            reason === 'insufficient_scope' ? 'Insufficient scope'
              : reason === 'verifier_unavailable' ? 'Token verification unavailable' : 'Invalid access token');
          await sendWebResponse(res, bearerAuthChallengeResponse(safeError, authOptions));
          try { options.onAuthReject?.(reason); } catch { /* Reporting must not break a rejection. */ }
          return;
        }
      }
      if (req.method !== 'POST') {
        writeJsonRpcError(res, 405, -32000, 'Method not allowed.', { Allow: 'POST' });
        return;
      }

      // Do not forward caller credentials to the transport or MCP request context.
      if (config.auth) {
        delete req.headers.authorization;
        req.rawHeaders = req.rawHeaders.filter((_, index, headers) =>
          headers[index - index % 2].toLowerCase() !== 'authorization');
      }

      const server = createMcpServer();
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { void server.close().catch(onError); });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
      } else {
        writeJsonRpcError(res, 500, -32603, 'Internal server error');
      }
      try { onError(error); } catch { /* Reporting must never throw out of the listener. */ }
    }
  });
}
