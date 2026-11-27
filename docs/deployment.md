# Deployment (operator note)

How this fork runs the server on Cloud Run and how to operate it. The HTTP and Auth0 code is in `src/remote/` ([remote.md](remote.md)). This repository is public: real project IDs, numbers, tenant names, URLs, and account names are **not** written here. Placeholders: `<project>` (the Cloud project ID), `<number>` (its project number), `<region>` (`europe-west3`), `<tenant>` (the Auth0 tenant host), `<repo>` (this fork's GitHub URL), `<login project>` (the Cloud project that owns the Google OAuth client of the tenant's Google connections; not `<project>`), `<vault connection>` (this server's own Token Vault connection). Decisions behind this setup: [remote.md](remote.md#decisions).

## What exists

| Piece | Name | Notes |
|---|---|---|
| Cloud Run service | `dv360-mcp-server` | One revision serving 100 %; public at the IAM layer (invoker check off), the app requires an Auth0 token |
| Public URL | `https://dv360-mcp-server-<number>.<region>.run.app` | The only allowed host (`MCP_ALLOWED_HOSTS`); the hashed `*.a.run.app` address gets `403` |
| Image | `<region>-docker.pkg.dev/<project>/cloud-run-source-deploy/dv360-mcp-server:<short commit>` | Built from this fork on GitHub by Cloud Build; deployed by digest; starts `node dist/remote/main.js` |
| Runtime account | `dv360-mcp-run@<project>.iam.gserviceaccount.com` | Only grants: Secret Accessor on the two Auth0 client secrets below |
| Build account | `dv360-mcp-build@<project>.iam.gserviceaccount.com` | `roles/run.builder`, plus object admin and bucket reader on the build-log bucket only |
| Build-log bucket | `gs://<number>-<region>-cloudbuild-logs` | Created by hand (the build account may not create buckets); objects deleted after 30 days |
| Auth0 client secrets | Secrets `dv360-mcp-auth0-connect-client-secret`, `dv360-mcp-auth0-token-vault-client-secret` | Passed as `AUTH0_CONNECT_CLIENT_SECRET` and `AUTH0_TOKEN_VAULT_CLIENT_SECRET`, **pinned to numbered versions** |
| Former shared credential | Secret `dv360-google-credentials` | Retired 2026-11-27: not mounted, version disabled, its Google grant revoked. Kept only as history |
| Request-log exclusion | `dv360-mcp-request-logs` on the `_Default` sink | Cloud Run request logs (client IP, user agent) are not stored; our application logs are |

Service settings: max one instance (service and revision level; a limit, not a lock), min zero, 2 GiB, 1 CPU with startup boost, CPU only during requests, concurrency 10, timeout 300 s. Environment: `GOOGLE_CLOUD_QUOTA_PROJECT=<project>`, `MCP_BIND_ADDRESS=0.0.0.0`, `AUTH0_ISSUER=https://<tenant>/`, `AUTH0_AUDIENCE=https://dv360-mcp-server-<number>.<region>.run.app/mcp`, `MCP_ALLOWED_HOSTS=dv360-mcp-server-<number>.<region>.run.app`, `AUTH0_CONNECT_CLIENT_ID=<DV360 MCP client ID>`, `AUTH0_TOKEN_VAULT_CLIENT_ID=<DV360 MCP Token Vault client ID>`, `AUTH0_TOKEN_VAULT_CONNECTION=<vault connection>`, and the two secrets above. The startup line ends `(Google access: per user)`. `GOOGLE_CLOUD_QUOTA_PROJECT` is still required at startup but per-user calls do not use it; there is no Google credential on the service.

Auth0: API "DV360 MCP Server" (identifier = the public URL + `/mcp`, no trailing slash; permission `use:mcp`; RBAC on, permissions in the token; offline access off), application "DV360 MCP" (Regular Web Application; callback `https://claude.ai/api/mcp/auth_callback`; grant types authorization code and refresh token; user-delegated access to `use:mcp` only), role "DV360 MCP User" (grants `use:mcp`; assign it to each person). The claude.ai organisation connector uses the URL above and the "DV360 MCP" application's client ID and secret ("Use your own OAuth client", not automatic registration).

Per-user access (2026-11-27), all in the same tenant:
- "DV360 MCP": also callbacks `https://<public URL>/connect/callback` and `/connect/complete`; user-delegated access to the Auth0 My Account API with `create:me:connected_accounts` and `read:me:connected_accounts`; connections `google-oauth2` (sign-in) and `<vault connection>` only.
- "DV360 MCP Token Vault": Custom API Client created from the API's Add Application button; grant type Token Vault only; connection `<vault connection>` only.
- `<vault connection>`: a second Google connection with the same Google client as `google-oauth2` but a client secret of its own; sign-in off, Connected Accounts on, offline access; enabled for the two apps above only. The dashboard allows one Google connection, so it was created with the Auth0 CLI (`auth0 api post connections`). It keeps this server's Google grant apart from the other servers that share `google-oauth2`.
- Google (`<login project>`): Display & Video 360 and Bid Manager APIs enabled; both scopes under Data Access; each user listed as a test user while the consent screen is in Testing mode.

## Rules for every command
- Always pass `--project <project>`, and `--region <region>` for Cloud Run. The machine's default `gcloud` project is a different one.
- Before changing anything: `gcloud auth list` (the deploying account), `gcloud projects describe <project> --format="value(name,projectNumber)"`.
- Keep OAuth client files and generated credentials **outside** the repository (they live under `~/.config/dv360-mcp/`).

## Deploy a new version (manual, from GitHub `main`)
1. Shared changes go to the upstream repository first; pull them here with `git pull upstream main`, run `npm install` and `npm test`, then push this fork's `main`. Pushing does **not** deploy.
2. Build from GitHub at that exact commit:
   ```
   gcloud builds submit <repo>.git --git-source-revision=<full commit SHA> \
     --tag <region>-docker.pkg.dev/<project>/cloud-run-source-deploy/dv360-mcp-server:<short SHA> \
     --project <project> --region <region> \
     --service-account projects/<project>/serviceAccounts/dv360-mcp-build@<project>.iam.gserviceaccount.com \
     --default-buckets-behavior=REGIONAL_USER_OWNED_BUCKET
   ```
3. Deploy that image by digest (all other settings are kept):
   ```
   gcloud run deploy dv360-mcp-server --project <project> --region <region> \
     --image <region>-docker.pkg.dev/<project>/cloud-run-source-deploy/dv360-mcp-server@sha256:<digest> \
     --update-labels source=github,commit=<short SHA>
   ```
   After a rollback with `update-traffic --to-revisions`, traffic stays pinned and a new deploy gets 0 %; finish with `gcloud run services update-traffic dv360-mcp-server --project <project> --region <region> --to-latest`.
4. Check: `GET /health` → `200`; `POST /mcp` without a token → `401` with `resource_metadata`; one real question in Claude.

## Users' Google access
Each person connects their own Google account when they connect the connector in Claude (Google sign-in, then the DV360 permission screen with **both** permissions ticked). When a tool answers that the Google account is not connected, the person reconnects the connector. In Testing mode Google ends the grant after about 7 days.

Find problems in Cloud Logging (service `dv360-mcp-server`): `jsonPayload.type="connect.step"` (`outcome`, `reason`: e.g. `scope_missing` when a permission was not ticked) and `jsonPayload.type="token_vault.exchange"` (`outcome`: `not_connected`, `scope_missing`, `misconfigured`, `error`, `unreachable`). Lines carry no user identity by design.

## Give or remove access
- Give: Auth0 → User Management → Roles → "DV360 MCP User" → Users → Assign. The person also needs an Auth0 account in the tenant, and must be a test user on the consent screen in `<login project>` while it is in Testing mode.
- Remove: unassign the role. Tokens already issued stay valid until they expire (access-token lifetime 24 h); for immediate containment use the rollback below.

## Rollback and containment (in this order)
1. Cut access at once: `gcloud run services update dv360-mcp-server --project <project> --region <region> --invoker-iam-check` (only accounts with Cloud Run Invoker can call it), or `--ingress internal`.
2. Fix or roll back: deploy the previous image digest (step 3 of "Deploy").
3. A person's Google access: they remove the app (`auth0.com`) under their Google account's linked apps, which ends every server's grant for them. Rolling back to the shared credential is no longer possible (retired 2026-11-27).
4. Re-open: `--no-invoker-iam-check` after the checks in "Deploy" step 4 pass.

## Known limitations
- Access is per claude.ai account, not per person: people sharing one claude.ai login share its connector sign-in, and all act as whoever connected last.
- GA4 and Ads still share the `google-oauth2` grant and replace each other's on reconnect; DV360 is not affected.
- One instance is a limit, not a lock: during a revision change two processes can overlap briefly, and a cold start resets the in-process Bid Manager daily-limit latch, pacer, and caches. Google still enforces the quota.
- A client's cancel does not stop the server's work; Cloud Run's 300 s timeout does not stop work already running.
- Request logs created before the exclusion took effect (a few minutes after creation) remain until their normal expiry.
