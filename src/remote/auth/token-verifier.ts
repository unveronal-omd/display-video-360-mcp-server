import { OAuthError, OAuthErrorCode, type OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';

export function createAuth0Verifier(options: {
  readonly issuer: string;
  readonly audience: string;
  readonly keys?: JWTVerifyGetKey;
}): OAuthTokenVerifier {
  // Constructing the resolver is lazy: only verification can fetch the key set.
  const keys = options.keys ?? createRemoteJWKSet(new URL('.well-known/jwks.json', options.issuer), {
    timeoutDuration: 5000, cooldownDuration: 30_000, cacheMaxAge: 300_000,
  });
  return {
    async verifyAccessToken(token) {
      try {
        const { payload } = await jwtVerify(token, async (header, jwt) => {
          try { return await keys(header, jwt); } catch (error) {
            // Key selection failures are invalid tokens. Fetch/timeout or unusable key-set
            // failures belong to the server; never inspect or expose their messages.
            if (!(error instanceof errors.JOSEError)
              || error instanceof errors.JWKSTimeout || error instanceof errors.JWKSInvalid
              || error.code === 'ERR_JOSE_GENERIC') {
              throw new OAuthError(OAuthErrorCode.ServerError, 'Token verification unavailable');
            }
            throw error;
          }
        }, {
          issuer: options.issuer, audience: options.audience, algorithms: ['RS256'],
          requiredClaims: ['exp'], clockTolerance: 30,
        });
        return {
          token,
          clientId: typeof payload.azp === 'string' ? payload.azp
            : typeof payload.client_id === 'string' ? payload.client_id : 'unknown',
          scopes: typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [],
          expiresAt: payload.exp!,
          resource: new URL(options.audience),
          // The Auth0 user ID keys per-user Google access; it is never logged or passed to tools.
          ...(typeof payload.sub === 'string' && payload.sub !== '' ? { extra: { userId: payload.sub } } : {}),
        };
      } catch (error) {
        if (error instanceof OAuthError && error.code === OAuthErrorCode.ServerError) throw error;
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid access token');
      }
    },
  };
}
