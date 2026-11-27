# Plan: per-user Google access

Status: planned (2026-11-27). Work through the steps in order; mark each one done here with its date.

## Goal

Each person signs in with their own Google account, and every DV360 and Bid Manager call runs with **that person's** Google token, so they see only the partners and advertisers their account can already access. There is no shared Google identity and no fallback to one. Local stdio mode is unchanged.

## Design

Same as the GA4 and Google Ads MCP servers (separate repositories; GA4 is tested live with two users), ported to TypeScript:

1. **Sign-in starts here.** Protected-resource metadata names this server as the authorization server; `/.well-known/oauth-authorization-server` advertises our `/authorize` but Auth0's token and registration endpoints, so Auth0 still issues every token.
2. **Connect step inside sign-in.** `/authorize` saves the client's request, runs the Auth0 Connected Accounts flow (My Account API) for the two DV360 scopes, then resumes the request at Auth0, which completes without another prompt. A plain Google login does not fill Token Vault. `/connect` runs the same step by hand.
3. **Every tool call** exchanges the caller's Auth0 token for their Google access token through Token Vault, cached in memory per user (`sub`) until 2 minutes before expiry.

DV360-specific differences from GA4:

| Topic | Change | Why |
| --- | --- | --- |
| Caches and query cleanup | One runtime per user (keyed by `sub`, evicted when idle) | The advertiser directory cache and Bid Manager query cleanup are process-wide today; shared, they would leak data between users |
| `x-goog-user-project` | Not sent on per-user calls | Users lack `serviceusage.services.use` on the quota project; quota goes to the OAuth client's project |
| Bid Manager latch and pacer | One per user runtime at first | Quota is per project; acceptable for a few users. Sharing them would need a shared-code option (later, if needed) |
| Runtime wiring | A copy of `createRuntime`'s wiring in `src/remote/` | Keeps shared code unchanged; a test flags upstream wiring changes |
| Flow cookie | Encrypted (AES-GCM), not only signed | GA4's signed cookie carries a readable My Account token |
| Logging | Fixed reasons only; no raw exception text, tokens, or user IDs | Keeps the existing "nothing about the caller is logged" rule |

Scopes: `https://www.googleapis.com/auth/display-video`, `https://www.googleapis.com/auth/doubleclickbidmanager`.

## Steps

All code changes stay in this repository, in `src/remote/`; shared code is not changed. The shared modules `createRuntime` wires together are already exported, so the fork builds its own runtime from them.

### 1. Per-user runtime (`src/remote/`) — done 2026-11-27
- `user-runtime.ts`: builds one runtime per user from the shared modules (same wiring as `src/runtime.ts`) with a given authorized fetch; a registry keyed by `sub` with idle eviction and a size cap.
- The per-user fetch takes a token source, sets `authorization`, and does not send `x-goog-user-project`.
- Credential failures throw a `GoogleCredentialsError` subclass whose message suits remote users (the shared messages point to the local login command); the shared code shows `error.message` and checks `instanceof`, so it handles them unchanged.
- A test that fails if `src/runtime.ts` wiring changes, so the fork's copy is updated with it.
- Tests: two users never share a cache; idle eviction; no `x-goog-user-project`; credential errors reach the tool result.
- Done when: `npm run typecheck`, `npm test`, `npm run build` pass; stdio unchanged.

### 2. Token Vault and connect flow (`src/remote/`) — done 2026-11-27
- `auth/token-vault.ts`: token exchange, per-`sub` cache, safe user-facing errors with the `/connect` link.
- `auth/connect.ts`: `/authorize`, `/connect`, `/connect/callback`, `/connect/complete`; PKCE, encrypted cookie, `login_hint`, scope check on completion.
- `http.ts`: authorization-server metadata, protected-resource metadata pointing at this server, the connect routes, and `createMcpServer(user)` with the verified token's `sub`, wired to the step 1 registry.
- `config.ts`: new settings (Token Vault client, connect client, Google connection name; the public URL is the audience's origin). All four client values or none: none keeps the shared credential (rollback), some stops startup.
- Tests for each module; `docs/remote.md` updated.
- Done when: `npm run typecheck`, `npm test`, `npm run build` pass.

### 3. Google Cloud (console, manual) — done 2026-11-27
In the project that owns the OAuth client of the shared Auth0 Google connection (not the project behind the current shared credential):
- Enable the Display & Video 360 API and the Bid Manager API.
- Consent screen: add both scopes under Data Access; add the pilot users as test users.
- Done when: both APIs are enabled and both scopes are listed.

### 4. Auth0 (dashboard, manual) — done 2026-11-27
- DV360 MCP application: only the `google-oauth2` connection; user access to the My Account API with `create:me:connected_accounts`; add `https://<service>/connect/callback` and `https://<service>/connect/complete` to Allowed Callback URLs.
- New Custom API Client for the DV360 MCP API (grant type Token Vault only, only the Google connection); its secret goes to Secret Manager.
- Confirm the Google connection still has Connected Accounts and Offline Access on (shared with GA4, GSC, Ads; do not change other settings).
- Done when: GA4, GSC, and Ads connectors still work after the change.
- Notes (2026-11-27): the tenant's application limit was reached; the unused, auto-created "DV360 MCP Server (Test Application)" (machine-to-machine) was deleted to make room. Other connections on the DV360 MCP application stay on until the cut-over; the connect step always forces the Google connection. The Google connection's own scopes stay unchanged (Basic and Extended Profile); DV360 scopes are requested only in the connect step.

### 5. Deploy — done 2026-11-27
- Secrets: Token Vault client secret and connect client secret in Secret Manager, readable by the runtime account, pinned versions.
- Cloud Run: new env vars and secret references; build at an exact commit and deploy by digest (see `docs/deployment.md`). Keep the shared credential mounted but unused until step 6 passes, for rollback.
- Done when: a new revision serves 100 % and `/health` answers.

### 6. Verify live

Results so far (2026-11-27):
- Endpoints after deploy: health 200; `/mcp` without token 401 with `resource_metadata`; metadata names this server; `/connect` redirects to Auth0; `/authorize` refuses an unknown client; startup line says per-user mode.
- First user: reconnect in claude.ai ran Google sign-in and the DV360 permission screen and returned to Claude; logs show `authorize`, `callback`, `complete` ok, then `token_vault.exchange` ok and `list_partners` ok.
- Second user (different DV360 access): connected and saw only their own partners, different from the first user's. The first try failed with `scope_missing` (not both DV360 permissions ticked on Google's screen) and was refused as designed; tell users to tick both permissions.
- Local stdio (built server, MCP client over stdio): 14 tools listed, `health` ok.
- **Shared connection: the newest connect step wins (found 2026-11-27).** After a GA4 reconnect, the next DV360 Token Vault exchange (once the one-hour cache expired) returned a Google token without the DV360 scopes (`scope_missing`). Auth0 keeps one Google grant per user for the shared `google-oauth2` connection, and each server's connect step replaces it; GA4 and Ads already had this between them. An earlier "GA4 still works after DV360" result was most likely GA4's own token cache.
- **Fix chosen: option A**, `include_granted_scopes=true` in every server's connect step, so each new grant keeps the earlier ones. Experiment on DV360 first (reconnect DV360, then check that the Token Vault token carries the Analytics and DV360 scopes and that GA4 still works after its cache expires); if it holds, add the same line to the GA4 and Ads connect steps and repeat the cross-server test in both directions. Rejected for now: a Token Vault-only connection per server (needs tenant support, does not fix GA4 vs Ads) and every server requesting every scope.
- No token / invalid token → 401.
- Reconnect in claude.ai: Google sign-in and DV360 permission screen, then back to Claude with no link to paste.
- Two users with different DV360 access each see only their own partners and advertisers (`list_partners`, an advertiser search, one report).
- A call more than one hour after sign-in still works (Token Vault refresh).
- A user who has not connected gets the `/connect` message.
- **Shared connection (first live check):** a user who already uses another per-user server on the same Auth0 Google connection (GA4 or Ads) connects DV360; their other servers must still work, and DV360 must still work afterwards. If a new connect step replaces the earlier connected account, consider asking Google for `include_granted_scopes=true` in the connect step (unverified through Auth0).
- stdio mode still works locally.

### 7. Clean up
- Remove the shared credential mount and disable its secret versions; revoke its grant.
- Update `docs/deployment.md`, `docs/remote.md`, `docs/decisions.md`, `docs/current-state.md`; delete this plan or mark it done.

## Known limits

- All per-user servers share one Auth0 Google connection and one Google client; a connect step replaces the stored Google grant (verified 2026-11-27). Until every server includes earlier grants, a user must reconnect a server after connecting another.

- Consent screen in Testing mode: test users only (≤ 100), and users reconnect about every 7 days until the app is verified.
- Each user's Bid Manager queries and limits are tracked per user runtime; a cold start resets them (as today).
