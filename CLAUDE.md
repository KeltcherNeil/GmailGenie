# GmailGenie — Claude Code Project Guide

## Project Overview

GmailGenie is a Chrome extension that reads Gmail emails and automatically suggests Google Calendar events using AI. When a user opens an email containing scheduling information, the extension detects it and offers a one-click button to add the event to their calendar.

The project is split into two parts:
- **Chrome Extension** (JavaScript) — reads Gmail DOM, shows popup UI, creates calendar events
- **Python Backend** (Flask) — handles all AI processing and email parsing

---

## Project Structure

```
gmailgenie/
├── extension/                  # Chrome extension files
│   ├── manifest.json           # Extension config
│   ├── content.js              # Reads Gmail DOM
│   ├── background.js           # Handles messaging between components
│   ├── popup.html              # Extension popup UI
│   ├── popup.js                # Popup logic
│   └── icons/                  # Extension icons
│
├── backend/                    # Python Flask server
│   ├── app.py                  # Main Flask app and API routes
│   ├── extractor.py            # AI-powered event extraction logic
│   ├── email_cleaner.py        # Preprocessing/cleaning email text
│   ├── auth.py                 # Per-user Google token verification (Phase 2)
│   └── requirements.txt        # Python dependencies
│
├── tests/                      # Test files
│   ├── test_emails/            # Sample emails for testing
│   │   ├── has_event/          # Emails that should trigger event creation
│   │   └── no_event/           # Emails that should not trigger anything
│   ├── test_extractor.py       # Unit tests for AI extraction
│   └── evaluate.py             # Evaluation script to measure accuracy
│
└── CLAUDE.md                   # This file
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Extension frontend | JavaScript (vanilla, no frameworks) |
| Extension styling | Plain CSS |
| Backend language | Python 3.11+ |
| Backend framework | Flask |
| AI model | Claude API (see `MODEL` in `backend/extractor.py`) |
| Calendar integration | Google Calendar API v3 |
| Auth | Google OAuth 2.0 |

---

## Architecture

```
Gmail Tab (content.js)
    → detects open email
    → extracts email text from DOM
    → sends to background.js

background.js
    → receives email text
    → calls Python backend at localhost:5001
    → stores result in chrome.storage

popup.html / popup.js
    → reads result from chrome.storage
    → shows suggested (editable) event to user
    → on "Add to Calendar", sends CREATE_EVENT to background.js
    → background.js gets the user's Google OAuth token (chrome.identity) and writes
      the event straight to the Google Calendar API — no backend, no tab, no manual Save

Python Backend (app.py)
    → receives email text
    → cleans it (email_cleaner.py)
    → sends to Claude API with extraction prompt (extractor.py)
    → returns structured JSON event details
```

---

## Key Conventions

### Python Backend

- All routes live in `app.py`, logic lives in separate helper modules
- AI extraction logic belongs in `extractor.py`, not in `app.py`
- Always clean email text before sending to the AI (remove quoted replies, signatures)
- The AI always returns JSON. A single email can contain **zero, one, or several**
  events, so the response is always an `events` array — an empty array means none.
- The extractor also detects **availability requests** — emails asking the READER
  for a time ("when can you play tennis?"). These are reported in a separate
  `availability_request` field (`null` when absent), never as an event.
- Never hardcode API keys — always use environment variables via `python-dotenv`
- All responses from the backend follow this structure:

```json
{
  "events": [
    {
      "title": "Project sync",
      "date": "2024-03-15",
      "time": "14:00",
      "duration_minutes": 60,
      "attendees": ["alice@example.com"],
      "location": "Zoom",
      "description": "one-sentence summary or null",
      "confidence": "high"
    }
  ],
  "availability_request": {
    "activity": "play tennis",
    "duration_minutes": 60,
    "requester_name": "Sam",
    "confidence": "high"
  }
}
```

(`availability_request` is `null` unless the email asks the reader for a time.)

- `extractor._normalize()` coerces older single-event shapes (`{"event_found": …}`)
  into the `events` array, and `background.js`'s `normalizeEvents()` does the same on
  the client — so a stale backend/extension during a deploy still works.
- Extraction must scan the **whole** email and ignore narrative/past content (recaps,
  sports scores, results). Because scheduling info often sits at the very end of a long
  message, the body-length caps (`content.js` ~8000, `email_cleaner` ~6000) are kept
  generous so trailing events are not truncated away before the AI sees them.

### JavaScript Extension

- Keep JS logic minimal — no business logic, just DOM reading and API calls
- content.js only reads the DOM and sends messages — it does not process anything
- background.js handles all fetch calls to the Python backend
- Use `chrome.storage.local` for passing data between content.js and popup.js
- Gmail's email body selector is `.a3s` — if this breaks, inspect the Gmail DOM to find the updated class

### General

- Never commit API keys or OAuth credentials to the repo
- Keep a `.env.example` file showing what environment variables are needed
- Test AI prompts in isolation using `tests/test_extractor.py` before wiring into the extension

---

## Environment Variables

Create a `.env` file in the `backend/` directory (see `.env.example`):

```
ANTHROPIC_API_KEY=your_key_here      # required — server-side Claude key
ALLOWED_ORIGINS=chrome-extension://<id>   # prod: origins allowed to call /extract-event (unset = check disabled)
GOOGLE_CLIENT_ID=<id>.apps.googleusercontent.com  # prod: per-user auth; must match manifest oauth2.client_id (unset = auth disabled)
FLASK_ENV=development
```
Both `ALLOWED_ORIGINS` and `GOOGLE_CLIENT_ID` disable their check when unset, for
local dev. **Never deploy to production with either unset.** The extension's Google
OAuth client is configured in `manifest.json`; the backend verifies tokens minted for
that same client (`backend/auth.py`).

---

## Running the Project Locally

### Running the backend server (shell)

The backend serves `/extract-event` and `/health`. It holds the Anthropic key
server-side and does the Claude extraction; the extension (`background.js`) POSTs
email text to it and never sees the key. Calendar creation stays client-side in the
extension (`chrome.identity`). For production this backend is **deployed to Google
Cloud Run** — see `backend/DEPLOY.md`. Run it locally (below) for development; point
`BACKEND_URL` in `background.js` at `http://localhost:5001`.

For local dev the origin check is disabled unless you set `ALLOWED_ORIGINS`; to mirror
production, start it with:
```bash
ALLOWED_ORIGINS="chrome-extension://<your-extension-id>" ../.venv/bin/python app.py
```

**One-time setup — create the virtualenv and install dependencies:**
```bash
cd /Users/neilkeltcher/GmailGenie          # repo root
python3 -m venv .venv                        # creates .venv/ (gitignored)
./.venv/bin/pip install -r backend/requirements.txt
```

**Start the server:**
```bash
cd /Users/neilkeltcher/GmailGenie/backend
../.venv/bin/python app.py
# → "Running on http://127.0.0.1:5001"
```
Keep this terminal window **open** — the server runs only as long as the shell is
running. Do your testing in Gmail with this window left open in the background.

**Stop the server:**
- In the same terminal window, press **`Ctrl+C`**, or simply **close the window**.
- If it's running detached / you lost the window, find and kill it by port:
  ```bash
  lsof -nP -iTCP:5001 -sTCP:LISTEN     # shows the PID in the last column
  kill <PID>                            # stop that process
  ```

**Check whether it's running:**
```bash
curl -s http://localhost:5001/health   # prints {"status":"ok"} when up
```

> **macOS note:** the backend defaults to port **5001**, not 5000. macOS's AirPlay
> Receiver (Control Center) listens on port 5000 and returns `403 Forbidden` to
> every request, so a backend on 5000 is unreachable from the extension. The
> extension is hardcoded to talk to `http://localhost:5001`. If you change `PORT`,
> update `BACKEND_URL` in `extension/background.js` and the `host_permissions`
> entry in `extension/manifest.json` to match.

**Load the Chrome extension:**
1. Go to `chrome://extensions`
2. Enable Developer Mode
3. Click Load Unpacked → select the `extension/` folder
4. Open Gmail and open any email to test

---

## Deploying changes to production

> **Gotcha (this bites every time):** the installed extension talks to the **hosted
> Cloud Run backend**, not localhost — `BACKEND_URL` in `extension/background.js`
> points at the `run.app` URL. So editing the prompt / `extractor.py` /
> `email_cleaner.py` locally changes **nothing the browser sees** until you redeploy.
> A change is only live once BOTH steps below are done.

**1. Redeploy the backend** — for any change under `backend/` (including the prompt):
```bash
cd /Users/neilkeltcher/GmailGenie
gcloud run deploy gmailgenie --source backend --region us-central1 --allow-unauthenticated
```
Existing env vars and the `anthropic-key` secret are **preserved** across deploys —
do not pass `--set-env-vars` unless you intend to replace the whole set.

**2. Reload the extension** — for any change under `extension/`:
`chrome://extensions` → GmailGenie → ↻ reload → reopen the email (or click
"Scan current email" in the popup).

**Deployed service (current):**

| | |
|---|---|
| Project | `gmailgenie-neil-4821` |
| Service / region | `gmailgenie` / `us-central1` |
| URL | `https://gmailgenie-485353812643.us-central1.run.app` |
| Anthropic key | Secret Manager secret `anthropic-key` (not a plain env var) |
| `ALLOWED_ORIGINS` | `chrome-extension://mhcloobbehmmanfjdcejglmndcogejjp` |

**Verify a deploy:**
```bash
curl -s https://gmailgenie-485353812643.us-central1.run.app/health   # → {"status":"ok"}
```
See `backend/DEPLOY.md` for first-time setup, secrets, and hardening.

---

## Publishing to the Chrome Web Store (launch checklist)

Detailed final steps to take GmailGenie from "works for test users" to a public
install. **Current state (2026-07-07):**

- Everything lives in GCP project **`gmailgenie-neil-4821`** (owner `n87821395@gmail.com`).
- OAuth client **`485353812643-d4sfmug4qjl03sk13dljbhkq0sojk4vf.apps.googleusercontent.com`**
  (type Chrome Extension), set in `manifest.json` `oauth2.client_id` and backend `GOOGLE_CLIENT_ID`.
- Stable dev extension ID **`hlhkdgonhlbhpbgmocoifmhineflnlkk`** (pinned by the `key` in
  `manifest.json`; private key `extension-key.pem`, gitignored).
- Custom domain **`getgenie-mail.xyz`** (Porkbun) → GitHub Pages, HTTPS enforced.
  Home `https://getgenie-mail.xyz/`, privacy `https://getgenie-mail.xyz/privacy.html`.
  Verified in Google Search Console.
- Backend enforces per-user Google auth; app OAuth status is **Testing** (test users only).

### Step 1 — Finish OAuth consent + verification  *(in progress)*
1. Console → **APIs & Services → OAuth consent screen** (a.k.a. Google Auth Platform),
   project `gmailgenie-neil-4821`.
2. **Branding:** App name `GmailGenie`; support email; App home page
   `https://getgenie-mail.xyz/`; Privacy policy `https://getgenie-mail.xyz/privacy.html`;
   **Authorized domains:** `getgenie-mail.xyz`.
3. **Data Access:** scopes `openid`, `email`, `.../auth/calendar.events`.
4. **Audience → Publish app** (Testing → In production).
5. **Verification Center → submit for verification.** Scope justifications: see
   `STORE_LISTING.md` §5. `calendar.events` is **sensitive** (not restricted, because we
   scrape the Gmail DOM instead of using a Gmail API scope) → standard verification, no
   CASA security assessment.
6. Google usually emails asking for an **unlisted YouTube demo video** showing the consent
   flow + the extension creating a calendar event. Reply with it.
7. **Wait:** sensitive-scope verification typically takes a few days to ~2 weeks.

### Step 2 — Package the extension
```bash
cd extension && zip -r ../gmailgenie-<version>.zip . -x '.*'
```
- Bump `manifest.json` `version` for every upload (the store rejects duplicate versions).
- **`key` caveat:** the manifest currently pins a `key` for a stable *dev* ID. The Web Store
  assigns its **own** ID on first upload, which will differ from `hlhkdgon…` unless you
  deliberately keep the same key. Simplest path: upload as-is, note the **published ID** the
  store assigns, then reconcile in Step 4.

### Step 3 — Chrome Web Store submission
1. Register a **Chrome Web Store developer account** — one-time **$5** fee
   (https://chrome.google.com/webstore/devconsole).
2. Create item → upload the zip → fill the listing (copy in `STORE_LISTING.md` §2),
   **Privacy practices** disclosures (§4), and screenshots.
3. Submit for review. Extension review (separate from OAuth verification) is usually hours
   to a few days.

### Step 4 — Post-publish reconciliation  *(CRITICAL — do immediately after publish)*
The store assigns a new extension ID. Then:
1. Console → **Clients** → edit the OAuth client → set **Item ID** to the published ID.
2. Update backend `ALLOWED_ORIGINS=chrome-extension://<published-id>` and redeploy:
   ```bash
   gcloud run deploy gmailgenie --source backend --region us-central1 \
     --update-env-vars "ALLOWED_ORIGINS=chrome-extension://<published-id>"
   ```
3. Install from the store → Connect Google → confirm extraction + event creation work.

---

## Costs (everything that costs money)

| Item | Cost | Notes |
|---|---|---|
| **Chrome Web Store developer account** | **$5 one-time** | Required to publish any extension. |
| **Domain `getgenie-mail.xyz`** (Porkbun) | ~**$2.04 first year, ~$12.98/yr** renewal | Only needed for OAuth verification (authorized domain + privacy host). Auto-renew optional. |
| **Anthropic API (Claude)** | **Pay-per-use — main variable cost** | One `MODEL` call (Haiku, see `extractor.py`) per email extraction. Small per call, but scales with users. **Set a hard limit** at console.anthropic.com → Billing → Usage limits. |
| **Google Cloud Run** | **~$0 at low traffic** | Scales to zero (min-instances 0); generous free tier. Budget alert set at $25/mo. Cost only if traffic is high or you set min-instances ≥1 (~$7/mo). |
| Cloud Build (runs on each deploy) | Negligible | Within free tier for normal deploy cadence. |
| Secret Manager (Anthropic key) | Negligible | Fractions of a cent/month. |
| Google OAuth verification | Free | — |
| Google Search Console | Free | — |
| GitHub Pages (privacy/home hosting) | Free | — |
| Google Calendar API | Free | Standard quota is ample. |

**Bottom line:** fixed costs are tiny (**$5 once + ~$2–13/yr domain**). The only cost that
grows with usage is the **Anthropic API** — protect it with a per-account usage limit in the
Anthropic console (the backend already caps *anonymous* abuse via per-user auth). Cloud Run
is effectively free until real scale.

---

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| POST | `/extract-event` | Takes email text, returns extracted events + `availability_request` |
| POST | `/availability/options` | Takes busy blocks + local now, returns free days/buckets (no AI call) |
| POST | `/availability/recommend` | Takes busy blocks + chosen day/bucket, returns exact slot + drafted reply |
| GET | `/health` | Health check — returns 200 if server is running |

All POST routes share the same guard stack (origin allowlist → per-user Google
auth → rate limit) via `_request_gate()` in `app.py`.

**Note:** calendar creation is **not** a backend endpoint. It runs entirely in the Chrome
extension via `chrome.identity` + the Google Calendar API (see the "New behaviour" section under
Problems). The backend never touches Google Calendar.

---

## Testing

**Run extraction tests:**
```bash
cd tests
python test_extractor.py
```

**Run availability-wizard tests** (slot math + routes; no API key needed):
```bash
python tests/test_availability.py
```

**Run full evaluation on test email dataset:**
```bash
python evaluate.py
# Outputs accuracy metrics across has_event/ and no_event/ samples
```

When adding new test emails, add the expected output as a matching `.json` file:
```
tests/test_emails/has_event/email_001.txt       # raw email text
tests/test_emails/has_event/email_001_expected.json  # expected extraction output
```

---

## Problems (Active Issues)

### 1. Calendar tab does not auto-close / return to email after saving

**Status:** ✅ Superseded — the whole "open a Google Calendar tab and click Save" flow was
removed. GmailGenie now creates the event directly via the Google Calendar API, so there is no
calendar tab to close and no manual Save step. See the new flow below.

**Old behaviour (removed):**
Clicking **Add to Calendar** built a `calendar.google.com/calendar/render?action=TEMPLATE` deeplink,
opened it in a new tab, and the user clicked **Save** there. A fragile auto-return system in
`background.js` (tab tracking via `calTabId`/`calSourceTabId`, `chrome.tabs.onUpdated` /
`chrome.webNavigation` listeners, an injected save-button watcher, and a `beforeunload` suppressor)
tried to detect the save and close the tab. It was unreliable and has been deleted.

**New behaviour (current) — fully client-side, no backend:**
1. User clicks **Add to Calendar** (popup) or **Add to Google Calendar** (floating card).
2. The extension sends a `CREATE_EVENT` message to `background.js`.
3. `background.js` → `createCalendarEvent()` gets the user's own Google OAuth token via
   `chrome.identity.getAuthToken()` and `POST`s the event straight to the Google Calendar API
   (`https://www.googleapis.com/calendar/v3/calendars/primary/events`).
4. The button shows **Creating… → Added to Calendar ✓** (or an error). No tab ever opens, and
   **no local server is involved** — the token and the API call live entirely in the extension.

**Where this logic lives now:**
- `extension/popup.js` → `createEvent()` — sends `CREATE_EVENT`, renders the button states.
- `extension/content.js` → `createEventFromCard()` — same for the floating card.
- `extension/background.js` → `CREATE_EVENT` handler + `createCalendarEvent()` — gets the OAuth
  token via `chrome.identity` and calls the Google Calendar API directly. `buildEventBody()`
  builds the Calendar API event resource (with real timezone via `Intl`).
- `extension/manifest.json` → `oauth2` block (client ID + `calendar.events` scope) and the
  `identity` permission.

**Requirement:** a Google OAuth **Chrome-Extension** client ID must be set in `manifest.json`'s
`oauth2.client_id` (see "Google OAuth setup" below). Each user consents once in their own browser;
Chrome caches and refreshes the token automatically. The old server-side calendar code and its
OAuth client-secret / token files were **removed** — the backend no longer touches Google Calendar,
so no Google credentials or tokens live on the server or in this repo. The backend's only secret is
the Anthropic key, which is held in Secret Manager (never committed).

---

### Google OAuth setup (one-time, developer)

`chrome.identity.getAuthToken` needs an OAuth client that matches this extension's ID:

1. **Get the extension ID:** load `extension/` unpacked at `chrome://extensions` and copy the ID.
   (To keep the ID stable across machines/reloads, pin it by adding a `"key"` to `manifest.json`.)
2. **Google Cloud Console** → APIs & Services → **Enable** the *Google Calendar API*.
3. **Credentials → Create Credentials → OAuth client ID → Application type: "Chrome Extension"**,
   paste the extension ID.
4. Copy the generated client ID (`…apps.googleusercontent.com`) into `manifest.json` →
   `oauth2.client_id`, replacing the `YOUR_GOOGLE_OAUTH_CLIENT_ID…` placeholder.
5. Add yourself as a **test user** on the OAuth consent screen (or publish it) so consent succeeds.
6. Reload the extension. First "Add to Calendar" opens the Google account/consent picker once.

---

## Known Limitations & Gotchas

- Gmail's DOM class names are obfuscated and may change — if content.js stops working, inspect Gmail's HTML to find the new email body selector
- Calendar creation is **fully client-side** (`chrome.identity` + direct Calendar API) — no server needed. OAuth tokens are cached and refreshed by Chrome automatically.
- Extraction runs **server-side**: `background.js` POSTs email text (plus the user's Google token) to the hosted backend (`/extract-event`), which calls Claude with the operator's key. Users never paste a key. The endpoint is guarded by (1) an `ALLOWED_ORIGINS` allowlist, (2) **per-user Google-identity auth** (`auth.py` — the caller must present a token minted for this extension's OAuth client), and (3) rate limiting (per account when authed, else per IP). When `GOOGLE_CLIENT_ID` is set, an unauthenticated call gets 401 and the popup shows a "Connect Google" prompt. Deploy: `backend/DEPLOY.md`.
- Emails with several scheduling requests now return **all** of them (`events` array);
  the popup shows a stacked list and the floating card lists each with its own button
- Timezone: events are created in the user's browser timezone (`Intl.DateTimeFormat().resolvedOptions().timeZone`). The email's own stated timezone, if different, is not yet parsed.

---

## Availability wizard ("when can you play tennis?")

When an email asks the READER for a time instead of proposing one, the popup
walks the user through a 3-step wizard driven by their real calendar, so a
booked day or part of day is **never offered**:

1. **Pick a day** — the next 3 days (starting tomorrow) that have free time;
   fully-booked days are simply not shown (scan window: 14 days).
2. **Pick a part of day** — Morning 8–12 / Midday 12–5 / Evening 5–9; booked
   buckets are disabled with a "Booked" tag.
3. **Recommendation** — the earliest free slot (30-min grid) in that bucket,
   plus a Claude-drafted reply. Buttons: **Add to Calendar** (existing
   `CREATE_EVENT` path) and **Reply in Gmail** (opens a prefilled compose
   window — GmailGenie never sends email itself).

**Where the pieces live:**

- `backend/extractor.py` — the extraction prompt also returns `availability_request`
- `backend/availability.py` — ALL slot math: deterministic, tz-free, unit-tested
  in `tests/test_availability.py`. The "never recommend a busy time" guarantee
  lives here, not in a prompt.
- `backend/composer.py` — Claude drafts the reply for the already-picked slot;
  falls back to a plain template if the API call fails.
- `extension/background.js` — reads the calendar client-side (`fetchBusyBlocks`),
  handles `AVAILABILITY_OPTIONS` / `AVAILABILITY_RECOMMEND` messages.
- `extension/popup.js` — the wizard UI (`buildWizard`/`wireWizard`); state lives
  in the module-level `wiz`, reset whenever a new email is scanned.
- `extension/content.js` — compact floating card ("Pick a time") in card mode.

**Key design decisions:**

- **No new OAuth scope.** Calendar reading uses the existing `calendar.events`
  scope (it permits reading events too). Do NOT add `calendar.readonly` —
  adding a scope would restart the in-progress OAuth verification.
- **Privacy:** the calendar is read entirely client-side; only anonymous busy
  blocks (start/end stamps, no titles/attendees) are sent to the backend.
- **Timezone-free backend:** the extension converts everything to the user's
  local wall-clock (`YYYY-MM-DDTHH:MM` naive stamps) before sending, so
  `availability.py` does plain datetime math.
- Events marked "Free" (transparent), declined invitations, and all-day events
  do not count as busy.

---

## Future Improvements (not yet built)

- ~~Availability detection: read existing calendar events and suggest free slots when someone asks "when are you free?"~~ ✅ done (see "Availability wizard")
- ~~Multi-event extraction: handle emails containing more than one proposed meeting time~~ ✅ done
- Confidence scoring: only show the popup when extraction confidence is above a threshold
- Hosted backend: deploy Flask app to Railway or Render so others can install the extension

### Outlook — Microsoft Graph API integration

**Outlook support was removed for the v1 public launch** — the manifest and
`content.js` are Gmail-only. The earlier Outlook DOM-scraper was fragile (broke on
Outlook updates, didn't work in the native desktop app) and widened host permissions
for store review. If Outlook comes back, do it properly with the **Microsoft Graph
API** rather than DOM scraping:

**User experience:**
- Gmail: zero setup (DOM reading, no auth)
- Outlook: one-time "Sign in with Microsoft" OAuth click in the popup — same flow users
  already know from connecting Outlook to Slack, Zoom, etc.

**Popup UI to build:**
```
Gmail        ✅ Connected
Outlook      [ Connect Microsoft Account ]
```

**API approach:**
- Auth:    Chrome's `chrome.identity.launchWebAuthFlow` with PKCE (no client secret needed)
- Email:   `GET https://graph.microsoft.com/v1.0/me/messages/{id}`
- Perms:   `Mail.Read` + `offline_access` (delegated, user-level)
- Token:   Store in `chrome.storage.local`, refresh automatically

**What Neil needs to do first (one-time developer setup):**
1. Go to portal.azure.com → App registrations → New registration
2. Set redirect URI to `chrome-extension://<extension-id>/oauth.html`
3. Add `Mail.Read` delegated permission (no admin consent required)
4. Copy the Application (client) ID into the extension

**Why this is better than DOM scraping:**
- Works in the desktop app, web app, anywhere — API-level not DOM-level
- Microsoft maintains it — no broken selectors when Outlook updates
- Returns clean structured JSON including native calendar invite fields
- Can detect new emails without the user having one actively open
