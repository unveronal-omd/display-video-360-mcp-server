# Remote deployment (this fork)

This fork runs the shared server over Streamable HTTP behind Auth0, on Cloud Run. Everything specific to that lives in `src/remote/` plus the `Dockerfile`, the ignore files, [deployment.md](deployment.md) (operator note), and this guide. Shared code is unchanged from upstream; shared changes go upstream first and arrive here with `git pull upstream main`.

In progress: per-user Google access instead of the shared Google identity, see [per-user-google-plan.md](per-user-google-plan.md).

## Module map

| Module | Owns |
|---|---|
| `src/remote/main.ts` | The HTTP entry point and the only `listen()`. Shared `loadConfig` + `loadRemoteConfig`, the stderr JSON logger, either the shared `createRuntime` or (per-user mode) Token Vault + connect handler + user registry, the optional Auth0 verifier, signal shutdown with a 5 s force-close. |
| `src/remote/config.ts` | `loadRemoteConfig`: port, bind address, Auth0 issuer/audience/scope, Host and Origin allowlists. The only remote reader of `process.env`. Refuses a non-loopback bind without Auth0. |
| `src/remote/http.ts` | `node:http` handler: Host guard → Origin guard → public health/discovery routes → (per-user mode) GET-only connect routes → `/mcp` authorization gate → POST only → a fresh `McpServer` (from `runtime.createMcpServer`) and stateless transport per request. Never listens. |
| `src/remote/auth/token-verifier.ts` | Lazy Auth0 JWT verification with remote JWKS (RS256, exact audience); the token's `sub` goes into `extra.userId`. No logging or caller state. |
| `src/remote/auth/token-vault.ts` | Per-user mode: exchanges the caller's Auth0 token for their Google access token (Token Vault), cached per user until 2 minutes before expiry; user-safe errors with the `/connect` link; fixed-vocabulary events. |
| `src/remote/auth/connect.ts` | Per-user mode: the connect step (`/authorize`, `/connect`, `/connect/callback`, `/connect/complete`) with PKCE and an AES-GCM cookie; the authorization-server metadata. |
| `src/remote/user-runtime.ts` | Per-user runtimes (built by `main.ts` in per-user mode): a registry keyed by user ID with idle eviction and a size cap; the user fetch (user's token, no `x-goog-user-project`); `RemoteCredentialsError`, a `GoogleCredentialsError` with a remote-user message. |

Rules (`src/remote/boundaries.test.ts`): only `config.ts` reads the environment; only `main.ts` listens and builds the runtime; only `main.ts` and `http.ts` write output, never to stdout; only `auth/` imports `jose`; remote code reaches shared code only through `config`, `runtime`, and the logger, except `user-runtime.ts`, which may import exactly the modules `createRuntime` wires.

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `GOOGLE_CLOUD_QUOTA_PROJECT` | yes | As upstream. |
| `GOOGLE_APPLICATION_CREDENTIALS` | no | As upstream; on Cloud Run the mounted secret file. |
| `PORT` | no | Listen port, default `8237` (the image sets `8080`). |
| `MCP_BIND_ADDRESS` | no | Listen address, default `127.0.0.1`. Any non-loopback address requires both Auth0 settings. |
| `AUTH0_ISSUER` | with Auth0 | The Auth0 tenant URL (`https://…/`). |
| `AUTH0_AUDIENCE` | with Auth0 | The Auth0 API identifier: the public URL ending in `/mcp`, no trailing slash. |
| `AUTH0_REQUIRED_SCOPE` | no | Required permission, default `use:mcp`. |
| `MCP_ALLOWED_HOSTS` | no | Allowed `Host` names (comma-separated), default `localhost,127.0.0.1`. Must contain the public hostname when deployed. |
| `MCP_ALLOWED_ORIGINS` | no | Allowed browser `Origin` hostnames, same default. |
| `AUTH0_TOKEN_VAULT_CLIENT_ID`, `AUTH0_TOKEN_VAULT_CLIENT_SECRET` | per-user mode | The Custom API Client that performs the Token Vault exchange. |
| `AUTH0_CONNECT_CLIENT_ID`, `AUTH0_CONNECT_CLIENT_SECRET` | per-user mode | The Regular Web Application MCP clients use; it also runs the connect step. The secret also derives the cookie key. |
| `AUTH0_GOOGLE_CONNECTION` | no | Auth0 Google connection name, default `google-oauth2`. |

Per-user mode is on when all four `AUTH0_TOKEN_VAULT_*` / `AUTH0_CONNECT_*` values are set (with Auth0); setting only some stops startup. Without them the server uses its own Google credential for everyone. The public URL for callbacks is the origin of `AUTH0_AUDIENCE`. The startup line names the mode.

Local run: `npm run build`, then `GOOGLE_CLOUD_QUOTA_PROJECT=<project> npm run start:http` (or `npm run dev:http`). Without Auth0 settings it serves loopback only, with no sign-in.

## Decisions

- **Resource server only.** Auth0 handles sign-in and client registration; the server validates access tokens with the SDK's bearer helpers and serves protected-resource metadata. RS256 only; every verification failure gives the same fixed `invalid_token` answer; an unreachable key set gives `500`. Nothing about the caller (token, claim, user ID, header, IP) is logged or passed to tools.
- **Fail-closed remote bind:** a non-loopback address without both Auth0 settings stops startup. The image sets no bind address or Auth0 setting, so an image started without them stays on loopback.
- **The gate covers all of `/mcp` before the method check**; a rejected request never builds an MCP server, and the `Authorization` header is removed before the transport.
- **Stateless Streamable HTTP, POST only, plain `node:http`.** No sessions to store; a fresh server per request shares the runtime's clients, caches, and limits.
- **One shared Google identity:** everyone with the Auth0 role acts as the server's Google account. Access is granted per person through an Auth0 role. Being replaced by per-user access ([plan](per-user-google-plan.md)).
- **Per-user runtimes copy `createRuntime`'s wiring** instead of changing shared code (decided 2026-11-27: the work stays in this fork). One runtime per user keeps the advertiser directory cache, query cleanup, and Bid Manager limits apart between Google identities. `user-runtime.test.ts` pins a SHA-256 of `src/runtime.ts`, so any change there fails the suite until the copy is updated. Per-user fetches omit `x-goog-user-project`: users have no permission on a quota project. Each runtime has its own Bid Manager latch and pacer although the quota is per project; acceptable for a few users.
- **Cloud Run:** built from this public fork at an exact commit by Cloud Build and deployed by digest, manually; the Google credential is a Secret Manager file pinned to a numbered version; Cloud Run request logs (client IP) are excluded from storage. Details: [deployment.md](deployment.md).

## HTTP handler (`http.ts`)

Order per request: Host guard → Origin guard → public health/discovery routing → exact `/mcp` path → optional authorization gate → method → MCP hand-off. Guards run before routing, so a rejected request learns nothing about which paths exist.

- **Host guard (DNS rebinding):** a rebinding page makes the browser send requests to `127.0.0.1` under the attacker's domain, and the `Host` header carries that name. Matching is case-insensitive and ignores the port. A missing `Host` never reaches us: Node answers 400.
- **Origin guard:** a missing `Origin` passes, since non-browser clients (Claude Code, Claude Desktop, the SDK client) don't send one.
- **Path match is a plain string compare** of `req.url` before `?`. **Never use `new URL(req.url, base)`:** it treats `//evil.example/mcp` as scheme-relative and resolves `/mcp/../mcp`, turning both into `/mcp`. Two tests guard this.
- **POST only; GET and DELETE get 405.** In stateless mode, SDK 2.4.0 answers GET with a `200 text/event-stream` that stays open and never sends anything. The SDK client opens that GET right after `initialize`, so forwarding it would hold an idle socket and a full `McpServer` per client. The spec allows 405, and the SDK client treats it as "no standalone stream" (tested). `OPTIONS /mcp` also gets 405 after authorization. CORS is enabled only for public discovery documents; browser MCP transport support remains out of scope.
- **Per POST:** a new server and a new transport with `sessionIdGenerator: undefined`. The `close` listener is attached **before** `connect`, so the server is released even if `connect` or `handleRequest` throws. No `parsedBody` is passed, which keeps the transport's 4 MiB limit (413) in force.
- **Error containment:** before headers are sent → a fixed `500 Internal server error` body with no detail; after headers (SSE open) → `res.destroy()`, so the client sees a broken stream instead of hanging. `onError` runs after the response is handled, inside its own try/catch. The process never crashes on a request.
- **Pass-through statuses (verified, SDK 2.4.0):** request → `200` SSE with one `message` event; notification → `202`; bad `Accept` → `406`; bad `Content-Type` → `415`; bad JSON → `400 -32700`; unsupported `MCP-Protocol-Version` → `400`; over 4 MiB → `413`; unknown tool → `200` with JSON-RPC `-32602`; a throwing tool handler → a tool result with `isError: true` carrying the **raw** error message (so never rely on it for expected errors). No `Mcp-Session-Id` is ever sent.
- **Why plain `node:http`:** a framework adapter risked breaking the MCP handshake, and the SDK's framework-independent bearer helpers work directly with it.
- **Safe error reporting:** both the default reporter and production JSON logger write only the constructor class name (identifier checked, otherwise `Object`). Messages, stacks, and causes are never emitted.
- **Known issues:** a throwing `onError` inside `server.close().catch(onError)` would become an unhandled rejection (untested, low risk). The headers-already-sent branch has no test, because the SDK offers no way to fail after the SSE headers. IPv6 loopback (`[::1]`) is rejected by default, so clients must use `127.0.0.1`, not a `localhost` that resolves to `::1` first.

## Authorization

The server is a resource server, following the MCP authorization spec version **2025-11-25**. Auth0 handles sign-in and client registration; this server only validates access tokens. The audience is preserved exactly for JWT matching and metadata, and its path must be exactly `/mcp` (no trailing slash, query, or fragment): the discovery routes exist only for `/mcp`, so any other path would advertise a metadata URL that returns 404. Nothing about the caller is logged or passed to tools or Google; successful gate results are discarded and Authorization headers are removed before transport hand-off. Rejections emit one fixed-vocabulary reason and never construct an MCP server or transport.

**Verified against SDK 2.4.0 and jose 6.2.17, 2026-11-17:**

- The server package exports `OAuthError`, `OAuthErrorCode`, the verifier types, and all three bearer/discovery helpers from its root. `OAuthError` takes `(code, message, errorUri?)`. `AuthInfo` requires token, client ID and scopes; expiry and resource are optional in the type but required at runtime by our gate options.
- `verifyBearerToken` checks resource and scope, then expiry against the current clock with **no skew allowance**. Thus jose’s 30-second tolerance does not extend already-expired tokens through the HTTP gate; it applies to verifier checks such as `nbf` and direct verification. Resource comparison ignores fragments and one trailing slash; jose audience comparison remains exact.
- `bearerAuthChallengeResponse` produces OAuth JSON and a `WWW-Authenticate` challenge on 401/403. The header includes error, description, required scope, and metadata URL (quoted and escaped); 500 has no bearer challenge. The HTTP gate replaces arbitrary verifier error messages with fixed text before rendering.
- Node normally discards duplicate Authorization fields, and the SDK parser splits on spaces without rejecting extra fields. The gate explicitly counts raw Authorization fields and validates the complete header before calling the helper. It examines no other caller headers beyond the existing Host/Origin guards.
- Remote JWKS resolution is lazy, cached and bounded. Unknown keys and token/signature/claim failures are fixed invalid-token responses. Resolver fetch/timeout and unusable key-set failures are fixed server errors. No jose diagnostic text is inspected or exposed.

**Per-user mode** (decided 2026-11-27, same design as the GA4 and Google Ads servers): the protected-resource metadata names this server as the authorization server, and `/.well-known/oauth-authorization-server` advertises its `/authorize` with Auth0's token and registration endpoints, so Auth0 still issues every token. `/authorize` accepts only the connect client's code requests, runs the connect step (a plain Google login does not fill Token Vault), then resumes the saved request at Auth0 with the Google connection. The gate additionally requires a `sub`; the verified token goes to `createMcpServer` only as the user's Token Vault source, never to tools or logs. Logged events (`token_vault.exchange`, `connect.step`) carry fixed outcomes, HTTP status, and short Auth0 error codes only. Not yet verified live. Auth0 keeps one Google grant per user and connection, and each server's connect step replaces it (verified live 2026-11-27: a GA4 reconnect dropped the DV360 scopes). Sending `include_granted_scopes=true` in the connect request's `authorization_params` is rejected by Auth0 (400), so that does not fix it; a separate Token Vault connection per server is the next option ([plan](per-user-google-plan.md)). Known gaps: a Google token revoked mid-hour stays cached until it expires; each tool call during a cache miss makes its own exchange.

Public health and both protected-resource metadata URLs remain behind Host/Origin guards. Discovery’s wildcard CORS header does not bypass Origin validation. The real Auth0 token shape and the claude.ai registration were verified live afterwards (see below).

## Packaging

The two-stage image keeps source, tests, and development tools out of the runtime stage; production dependencies are installed directly from the lockfile. Node 24 matches the version used for development and validation. The build config excludes tests while the full typecheck still checks them. TypeScript does not remove stale output, so build into a fresh `dist/` after moving files.

`package.json` must remain beside `dist/` because startup and the MCP server import it for the version. The image leaves the bind address unset: deployment configures remote binding together with authorization, preserving loopback defaults and fail-closed startup. Exec-form startup delivers termination signals directly to Node. The image is built and validated by Cloud Build; there is no local Docker build.

## Verified against Auth0 and Cloud Run (2026-11-17)

- **Token shape:** `RS256` with a `kid`; `iss` is the tenant URL **with** a trailing slash; `aud` is a single string equal to the API identifier (the verifier also accepts a list containing it); the permission appears in both `scope` and `permissions`. A token with one changed signature character and no token both get `401`; no token or claim text is logged.
- **Build from a public GitHub repository:** `gcloud builds submit <repo>.git --git-source-revision=<commit> …` builds the `Dockerfile` at that commit. With a user-specified build account, Cloud Build first needs a regional log bucket created by hand. A private repository would need a Cloud Build ↔ GitHub connection instead.
- **Mounted secret:** an `authorized_user` file mounted at `/secrets/google/credentials.json` is readable by the image's non-root `node` user and loads through `GOOGLE_APPLICATION_CREDENTIALS`.
- **Two public URLs:** the deterministic `https://<service>-<number>.<region>.run.app` and a hashed `*.a.run.app`; with `MCP_ALLOWED_HOSTS` set to the deterministic host, the hashed one gets `403`.
- **Logs:** our JSON lines arrive as structured `jsonPayload` entries; a `_Default` sink exclusion stops Cloud Run request logs, but only a few minutes after it is created.
- **claude.ai organisation connector:** adding the server by URL, claude.ai detects sign-in from the `401` + metadata; "Use your own OAuth client" with a dedicated Auth0 application works, in the browser and in Claude Desktop.
- **Cancellation over stateless HTTP doesn't reach the running call** (SDK 2.4.0, 2025-era protocol): the cancel reaches a fresh per-request server. The call runs until its own budget ends. `src/remote/cancel-http.test.ts` records it.
