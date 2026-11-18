// HTTP entry point of the deployment fork: the shared runtime behind Streamable HTTP and Auth0.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import packageJson from '../../package.json' with { type: 'json' };
import { loadConfig } from '../config.js';
import { createJsonLogger } from '../integrations/google/log.js';
import { createRuntime } from '../runtime.js';
import { createAuth0Verifier } from './auth/token-verifier.js';
import { loadRemoteConfig } from './config.js';
import { createHttpServer, httpErrorClass } from './http.js';

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

async function main(): Promise<void> {
  const config = loadConfig();
  const remoteConfig = loadRemoteConfig();
  const log = createJsonLogger({ write: line => { process.stderr.write(line); }, now: Date.now });
  const runtime = createRuntime(config, { log });
  const verifier = remoteConfig.auth ? createAuth0Verifier(remoteConfig.auth) : undefined;
  const httpServer = createHttpServer(remoteConfig, {
    createMcpServer: runtime.createMcpServer,
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
  console.error(`${NAME} ${packageJson.version} listening on http://${remoteConfig.bindAddress}:${port}/mcp`);
}

main().catch((error: unknown) => {
  console.error(`${NAME} failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
