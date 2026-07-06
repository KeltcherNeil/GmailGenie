# Deploying the extraction service to Google Cloud Run

The extraction backend (`/extract-event`, `/health`) is a stateless Flask app. It
holds the Anthropic API key server-side so end users never paste a key or run a
shell. Calendar creation stays client-side in the extension (`chrome.identity`).

## Prerequisites (one-time)

1. Install the [gcloud CLI](https://cloud.google.com/sdk/docs/install) and run
   `gcloud auth login`.
2. Pick/create a project and set it:
   ```bash
   gcloud config set project YOUR_PROJECT_ID
   ```
3. Enable the services:
   ```bash
   gcloud services enable run.googleapis.com cloudbuild.googleapis.com
   ```

## Deploy

From the repo root:

```bash
gcloud run deploy gmailgenie \
  --source backend \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars "ANTHROPIC_API_KEY=sk-ant-...,ALLOWED_ORIGINS=chrome-extension://YOUR_EXTENSION_ID,GOOGLE_CLIENT_ID=YOUR_CLIENT_ID.apps.googleusercontent.com"
```

> Once env vars/secrets are set on the service, later `gcloud run deploy --source backend`
> calls **preserve** them — omit `--set-env-vars` unless you intend to replace the whole set.

- `--source backend` builds the `backend/Dockerfile` with Cloud Build — no local
  Docker needed.
- `--allow-unauthenticated` makes the endpoint publicly reachable (the extension
  isn't a Google-authenticated caller). Abuse protection is the app's job — see below.
- `ANTHROPIC_API_KEY` — your key. **Store it as a secret, not in shell history, for
  anything beyond testing** (see "Hardening").
- `ALLOWED_ORIGINS` — comma-separated Chrome extension origins allowed to call
  `/extract-event`, e.g. `chrome-extension://mhcloobbehmmanfjdcejglmndcogejjp`.
  **If unset, the origin check is disabled — never deploy without it.**

Cloud Run prints a service URL like `https://gmailgenie-xxxxxxxx-uc.a.run.app`.

## Point the extension at it

1. In `extension/background.js`, set `BACKEND_URL` to your Cloud Run URL.
2. `extension/manifest.json` already allows `https://*.run.app/*`. Narrow it to your
   exact URL (`https://gmailgenie-xxxxxxxx-uc.a.run.app/*`) before publishing.
3. Reload the extension at `chrome://extensions`.

Verify:
```bash
curl https://gmailgenie-xxxxxxxx-uc.a.run.app/health   # → {"status":"ok"}
```

## Config reference

| Env var | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Server-side Claude key |
| `ALLOWED_ORIGINS` | yes (prod) | Comma-separated extension origins; disables origin check if unset |
| `GOOGLE_CLIENT_ID` | yes (prod) | Extension's OAuth client id; callers must present a Google token minted for it (per-user auth). Disables auth if unset. Must equal `manifest.json`'s `oauth2.client_id` |
| `RATE_LIMITS` | no | Per-IP limits, default `30 per minute;300 per day` |
| `PORT` | no | Injected by Cloud Run (8080); local dev defaults to 5001 |

## Abuse protection (Phase 1) — and its limits

`/extract-event` spends your Anthropic credits on every call, so it's guarded by:

1. **Origin allowlist** (`ALLOWED_ORIGINS`) — rejects requests whose `Origin` isn't
   your extension. Cheap, but an `Origin` header can be spoofed by a non-browser client.
2. **Per-IP rate limiting** — in-memory (per instance). Because Cloud Run scales to
   multiple instances, the effective limit is `limit × instances`. Good enough as a
   floor; not a hard global cap.

**Phase 2 (implemented):** per-user auth in `auth.py`. The extension sends the user's
Google token; the backend verifies it was minted for this extension's OAuth client
(`GOOGLE_CLIENT_ID`) and rate-limits per Google account. Enable it by setting
`GOOGLE_CLIENT_ID`; leave it unset only for local dev.

## Hardening (recommended before any real launch)

- **Secret Manager for the key** instead of `--set-env-vars`:
  ```bash
  echo -n "sk-ant-..." | gcloud secrets create anthropic-key --data-file=-
  gcloud run deploy gmailgenie --source backend --region us-central1 \
    --allow-unauthenticated \
    --update-secrets "ANTHROPIC_API_KEY=anthropic-key:latest" \
    --set-env-vars "ALLOWED_ORIGINS=chrome-extension://YOUR_EXTENSION_ID,GOOGLE_CLIENT_ID=YOUR_CLIENT_ID.apps.googleusercontent.com"
  ```
- **Global rate limits**: point flask-limiter at Redis/Memorystore via a
  `storage_uri` so limits hold across instances.
- **Min instances = 0** (default) keeps idle cost near $0; set `--min-instances 1`
  only if cold starts bother you (~$7/mo).
