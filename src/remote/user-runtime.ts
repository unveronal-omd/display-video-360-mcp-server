// One runtime per signed-in user, so caches, query cleanup and limits are never shared between Google identities.
// The wiring copies src/runtime.ts (user-runtime.test.ts fails when that file changes); only the authorized fetch differs.
import type { Runtime } from '../runtime.js';
import { createServer } from '../server.js';
import { createToolRunner } from '../tools/call.js';
import { createPerformanceService } from '../combined/performance.js';
import { YOUTUBE_FILTER_LEVELS } from '../combined/presets.js';
import type { LogLine } from '../integrations/google/log.js';
import { GoogleCredentialsError, type AuthorizedFetch, type GoogleCredentialsErrorKind } from '../integrations/google/auth.js';
import { createBidManagerClient } from '../integrations/bidmanager/client.js';
import { createQueryCleanup, CLEANUP_MIN_INTERVAL_MS } from '../integrations/bidmanager/cleanup.js';
import { createReportingService } from '../integrations/bidmanager/reporting.js';
import { createDv360Client } from '../integrations/dv360/client.js';
import { createMetadataService } from '../integrations/dv360/metadata.js';

/** Returns the user's current Google access token; throws a GoogleCredentialsError when there is none. */
export type GoogleTokenSource = () => Promise<string>;

/** A credential failure whose message is written for remote users (the shared messages name the local login command). */
export class RemoteCredentialsError extends GoogleCredentialsError {
  constructor(kind: GoogleCredentialsErrorKind, message: string) {
    super(kind);
    this.message = message;
  }
}

const UNAVAILABLE = 'Could not get your Google access right now. Try again shortly.';

/**
 * Calls Google with the user's token. Unlike the shared fetch it sends no `x-goog-user-project`: users have no
 * permission on a quota project, so quota is billed to the project that owns the OAuth client.
 */
export function createUserFetch(getToken: GoogleTokenSource, fetchRequest: typeof fetch = globalThis.fetch): AuthorizedFetch {
  return async (url, init = {}) => {
    let token: string;
    try {
      token = await getToken();
    } catch (error) {
      throw error instanceof GoogleCredentialsError ? error : new RemoteCredentialsError('unavailable', UNAVAILABLE);
    }
    const headers = new Headers(init.headers);
    headers.delete('x-goog-user-project');
    headers.set('authorization', `Bearer ${token}`);
    return fetchRequest(url, { method: init.method, headers, body: init.body, signal: init.signal });
  };
}

/** Same wiring as createRuntime in src/runtime.ts, with the given authorized fetch. */
function createUserRuntime(authorizedFetch: AuthorizedFetch, log: (event: LogLine) => void): Runtime {
  const runtime = { logger: log };
  const runTool = createToolRunner({ log });
  const client = createBidManagerClient(authorizedFetch, { runtime });
  const reporting = createReportingService({ client, cleanup: createQueryCleanup(client, { minIntervalMs: CLEANUP_MIN_INTERVAL_MS }) });
  const metadata = createMetadataService({ client: createDv360Client(authorizedFetch, { runtime }) });
  const performance = createPerformanceService({ metadata, reporting, youtubeFilterLevels: YOUTUBE_FILTER_LEVELS });
  return {
    createMcpServer: () => createServer({ reporting, metadata, performance, runTool }),
    log,
  };
}

export type UserRuntimeRegistryOptions = {
  readonly log: (event: LogLine) => void;
  /** A user's runtime (and its caches) is dropped after this long without a request. */
  readonly idleMs?: number;
  /** At most this many runtimes are kept; the least recently used goes first. */
  readonly maxUsers?: number;
  readonly now?: () => number;
  readonly fetch?: typeof fetch;
};

export type UserRuntimeRegistry = {
  /** The user's runtime, created on first use. `getToken` replaces the previous source, so the newest sign-in is used. */
  readonly runtimeFor: (userId: string, getToken: GoogleTokenSource) => Runtime;
  readonly size: () => number;
};

export const DEFAULT_IDLE_MS = 30 * 60 * 1000;
export const DEFAULT_MAX_USERS = 100;

export function createUserRuntimeRegistry(options: UserRuntimeRegistryOptions): UserRuntimeRegistry {
  const { log, idleMs = DEFAULT_IDLE_MS, maxUsers = DEFAULT_MAX_USERS, now = Date.now } = options;
  if (!(idleMs > 0) || !Number.isInteger(maxUsers) || maxUsers < 1) throw new Error('Invalid user runtime limits');
  // Map order is least recently used first: each use moves the entry to the end.
  const entries = new Map<string, { runtime: Runtime; getToken: GoogleTokenSource; lastUsed: number }>();

  return {
    runtimeFor(userId, getToken) {
      if (userId === '') throw new Error('A user ID is required');
      const time = now();
      for (const [id, entry] of entries) {
        if (time - entry.lastUsed < idleMs) break;
        entries.delete(id);
      }
      let entry = entries.get(userId);
      if (entry === undefined) {
        const created = { getToken, lastUsed: time, runtime: undefined as unknown as Runtime };
        created.runtime = createUserRuntime(createUserFetch(() => created.getToken(), options.fetch), log);
        entry = created;
      } else {
        entries.delete(userId);
        entry.getToken = getToken;
        entry.lastUsed = time;
      }
      entries.set(userId, entry);
      while (entries.size > maxUsers) entries.delete(entries.keys().next().value!);
      return entry.runtime;
    },
    size: () => entries.size,
  };
}
