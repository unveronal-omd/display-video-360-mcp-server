# Deployment (operator note)

How this fork runs the server on Cloud Run and how to operate it. The HTTP and Auth0 code is in `src/remote/` ([remote.md](remote.md)). This repository is public: real project IDs, numbers, tenant names, URLs, and account names are **not** written here. Placeholders: `<project>` (the Cloud project ID), `<number>` (its project number), `<region>` (`europe-west3`), `<tenant>` (the Auth0 tenant host), `<repo>` (this fork's GitHub URL). Decisions behind this setup: [remote.md](remote.md#decisions).

## What exists

| Piece | Name | Notes |
|---|---|---|
| Cloud Run service | `dv360-mcp-server` | One revision serving 100 %; public at the IAM layer (invoker check off), the app requires an Auth0 token |
| Public URL | `https://dv360-mcp-server-<number>.<region>.run.app` | The only allowed host (`MCP_ALLOWED_HOSTS`); the hashed `*.a.run.app` address gets `403` |
| Image | `<region>-docker.pkg.dev/<project>/cloud-run-source-deploy/dv360-mcp-server:<short commit>` | Built from this fork on GitHub by Cloud Build; deployed by digest; starts `node dist/remote/main.js` |
| Runtime account | `dv360-mcp-run@<project>.iam.gserviceaccount.com` | Only grant: Secret Accessor on the credential secret |
| Build account | `dv360-mcp-build@<project>.iam.gserviceaccount.com` | `roles/run.builder`, plus object admin and bucket reader on the build-log bucket only |
| Build-log bucket | `gs://<number>-<region>-cloudbuild-logs` | Created by hand (the build account may not create buckets); objects deleted after 30 days |
| Google credential | Secret `dv360-google-credentials` | `authorized_user` JSON of the shared DV360 account (two DV360 scopes only), mounted as `/secrets/google/credentials.json`, **pinned to a numbered version** |
| Request-log exclusion | `dv360-mcp-request-logs` on the `_Default` sink | Cloud Run request logs (client IP, user agent) are not stored; our application logs are |

Service settings: max one instance (service and revision level; a limit, not a lock), min zero, 2 GiB, 1 CPU with startup boost, CPU only during requests, concurrency 10, timeout 300 s. Environment: `GOOGLE_CLOUD_QUOTA_PROJECT=<project>`, `MCP_BIND_ADDRESS=0.0.0.0`, `AUTH0_ISSUER=https://<tenant>/`, `AUTH0_AUDIENCE=https://dv360-mcp-server-<number>.<region>.run.app/mcp`, `MCP_ALLOWED_HOSTS=dv360-mcp-server-<number>.<region>.run.app`, `GOOGLE_APPLICATION_CREDENTIALS=/secrets/google/credentials.json`.

Auth0: API "DV360 MCP Server" (identifier = the public URL + `/mcp`, no trailing slash; permission `use:mcp`; RBAC on, permissions in the token; offline access off), application "DV360 MCP" (Regular Web Application; callback `https://claude.ai/api/mcp/auth_callback`; grant types authorization code and refresh token; user-delegated access to `use:mcp` only), role "DV360 MCP User" (grants `use:mcp`; assign it to each person). The claude.ai organisation connector uses the URL above and the "DV360 MCP" application's client ID and secret ("Use your own OAuth client", not automatic registration).

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
4. Check: `GET /health` → `200`; `POST /mcp` without a token → `401` with `resource_metadata`; one real question in Claude.

## Renew the Google credential
Needed when tool calls fail with the "Google login has expired or was revoked" message. Its lifetime under the organisation's policy is still being measured (see `current-state.md`).
1. Log in as the shared account with only the two DV360 scopes, using the new project's Desktop OAuth client, writing an `authorized_user` file outside the repository (mode 600).
2. `gcloud secrets versions add dv360-google-credentials --project <project> --data-file=<file>` → note the new version number `N`.
3. `gcloud run services update dv360-mcp-server --project <project> --region <region> --update-secrets=/secrets/google/credentials.json=dv360-google-credentials:N` (creates a new revision; a running process keeps its cached credential, so a new revision is required).
4. Ask one Google-backed question (e.g. list partners). Only then disable the old version: `gcloud secrets versions disable <old> --secret dv360-google-credentials --project <project>`.

Find lapses in Cloud Logging (service `dv360-mcp-server`): `jsonPayload.kind="expired_or_revoked"` on `tool.call` lines, and `jsonPayload.type="google.request" AND jsonPayload.httpStatus=401`. Detection is reactive: only Google-backed calls reveal a lapse; `/health` does not.

## Give or remove access
- Give: Auth0 → User Management → Roles → "DV360 MCP User" → Users → Assign. The person also needs an Auth0 account in the tenant.
- Remove: unassign the role. Tokens already issued stay valid until they expire (access-token lifetime 24 h); for immediate containment use the rollback below.

## Rollback and containment (in this order)
1. Cut access at once: `gcloud run services update dv360-mcp-server --project <project> --region <region> --invoker-iam-check` (only accounts with Cloud Run Invoker can call it), or `--ingress internal`.
2. Fix or roll back: deploy the previous image digest (step 3 of "Deploy").
3. Credential problems: revoke the shared account's grant for the OAuth client in its Google account settings; disabling a secret version alone does not stop a running revision.
4. Re-open: `--no-invoker-iam-check` after the checks in "Deploy" step 4 pass.

## Known limitations
- One instance is a limit, not a lock: during a revision change two processes can overlap briefly, and a cold start resets the in-process Bid Manager daily-limit latch, pacer, and caches. Google still enforces the quota.
- A client's cancel does not stop the server's work; Cloud Run's 300 s timeout does not stop work already running.
- Request logs created before the exclusion took effect (a few minutes after creation) remain until their normal expiry.
