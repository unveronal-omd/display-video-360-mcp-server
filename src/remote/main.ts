// HTTP entry point of the deployment fork: the shared runtime behind Streamable HTTP and Auth0.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import packageJson from '../../package.json' with { type: 'json' };
import { loadConfig } from '../config.js';
import { createJsonLogger } from '../integrations/google/log.js';
import { createRuntime } from '../runtime.js';
import { createConnectHandler } from './auth/connect.js';
import { createAuth0Verifier } from './auth/token-verifier.js';
import { createTokenVault, TokenVaultError } from './auth/token-vault.js';
import { loadRemoteConfig, type AuthConfig, type PerUserConfig } from './config.js';
import { createHttpServer, httpErrorClass, type HttpServerOptions } from './http.js';
import { createUserRuntimeRegistry, RemoteCredentialsError } from './user-runtime.js';
import type { LogLine } from '../integrations/google/log.js';

const NAME = 'display-video-360-mcp-server';
const SHUTDOWN_TIMEOUT_MS = 5000;

function registerShutdown(httpServer: Server): void {
  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`${NAME} received ${signal}, shutting down`);

    const forceClose = setTimeout(() => {
      console.error(`${NAME} shutdown timed out after ${SHUTDOWN_TIMEOUT_MS} ms, closing open connections`);
      httpServer.closeAllConnections();
    }, SHUTDOWN_TIMEOUT_MS);
    forceClose.unref();

    httpServer.close(error => {
      clearTimeout(forceClose);
      if (error) {
        console.error(`${NAME} shutdown failed: ${error.message}`);
        process.exitCode = 1;
        return;
      }
      console.error(`${NAME} stopped`);
    });
    httpServer.closeIdleConnections();
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

/** Per-user Google access: each caller gets their own runtime, calling Google with their Token Vault token. */
function perUserAccess(auth: AuthConfig, perUser: PerUserConfig, log: (event: LogLine) => void) {
  const vault = createTokenVault({
    issuer: auth.issuer, clientId: perUser.tokenVaultClientId, clientSecret: perUser.tokenVaultClientSecret,
    connection: perUser.tokenVaultConnection, connectUrl: `${perUser.publicBaseUrl}/connect`, onEvent: log,
  });
  const registry = createUserRuntimeRegistry({ log });
  const createMcpServer: HttpServerOptions['createMcpServer'] = user => {
    // http.ts always passes the caller in per-user mode; refuse rather than fall back to a shared identity.
    if (user === undefined) throw new Error('Per-user access requires a verified caller');
    return registry.runtimeFor(user.userId, () => vault.getGoogleToken(user.userId, user.accessToken).catch((error: unknown) => {
      throw error instanceof TokenVaultError ? new RemoteCredentialsError(error.kind, error.message) : error;
    })).createMcpServer();
  };
  const connect = createConnectHandler({
    issuer: auth.issuer, publicBaseUrl: perUser.publicBaseUrl, clientId: perUser.connectClientId,
    clientSecret: perUser.connectClientSecret, connection: perUser.googleConnection,
    vaultConnection: perUser.tokenVaultConnection, onEvent: log,
  });
  return { createMcpServer, connect };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const remoteConfig = loadRemoteConfig();
  const log = createJsonLogger({ write: line => { process.stderr.write(line); }, now: Date.now });
  const verifier = remoteConfig.auth ? createAuth0Verifier(remoteConfig.auth) : undefined;
  const access = remoteConfig.auth && remoteConfig.perUser
    ? perUserAccess(remoteConfig.auth, remoteConfig.perUser, log)
    : { createMcpServer: createRuntime(config, { log }).createMcpServer, connect: undefined };
  const httpServer = createHttpServer(remoteConfig, {
    ...access,
    verifier,
    onAuthReject: reason => { log({ type: 'auth.reject', reason }); },
    onError: error => { log({ type: 'http.error', errorClass: httpErrorClass(error) }); },
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(remoteConfig.port, remoteConfig.bindAddress, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  registerShutdown(httpServer);
  const { port } = httpServer.address() as AddressInfo;
  console.error(`${NAME} ${packageJson.version} listening on http://${remoteConfig.bindAddress}:${port}/mcp`
    + ` (Google access: ${remoteConfig.perUser ? 'per user' : 'shared credential'})`);
}

main().catch((error: unknown) => {
  console.error(`${NAME} failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
