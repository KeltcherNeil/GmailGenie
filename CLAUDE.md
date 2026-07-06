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
| AI model | Claude API (claude-sonnet-4-6) |
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
- The AI should always return JSON — if no event is found, return `{"event_found": false}`
- Never hardcode API keys — always use environment variables via `python-dotenv`
- All responses from the backend should follow this structure:

```json
{
  "event_found": true,
  "title": "Project sync",
  "date": "2024-03-15",
  "time": "14:00",
  "duration_minutes": 60,
  "attendees": ["alice@example.com"],
  "location": "Zoom",
  "confidence": "high"
}
```

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

Create a `.env` file in the `backend/` directory:

```
ANTHROPIC_API_KEY=your_key_here
FLASK_ENV=development
```
(Google OAuth is configured in the extension's `manifest.json`, not here — the backend does no
Google auth.)

---

## Running the Project Locally

### Running the backend server (shell)

The backend now only serves `/extract-event` and `/health` (calendar creation runs
client-side in the extension). Note: the extension currently calls the Anthropic API
directly from `background.js`, so this local server isn't required for the current
extension flow — it's kept for the `tests/` extraction/eval scripts and future use.

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

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| POST | `/extract-event` | Takes email text, returns extracted event JSON |
| GET | `/health` | Health check — returns 200 if server is running |

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
  token via `chrome.identity` and calls the Google Calendar API directly. `buildEventBody()` ports
  the old `calendar_helper.build_event_body()` to JS (with real timezone via `Intl`).
- `extension/manifest.json` → `oauth2` block (client ID + `calendar.events` scope) and the
  `identity` permission.

**Requirement:** a Google OAuth **Chrome-Extension** client ID must be set in `manifest.json`'s
`oauth2.client_id` (see "Google OAuth setup" below). Each user consents once in their own browser;
Chrome caches and refreshes the token automatically. The old server-side calendar code
(`backend/calendar_helper.py`, `credentials.json`, `token.json`, the `/create-event` route, and
the Google client libraries in `requirements.txt`) has been **removed** — the backend no longer
touches Google Calendar.

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
- Extraction currently calls the Anthropic API **directly** from `background.js` using the user's own key (stored in `chrome.storage.local`) — there is no hosted extraction backend yet.
- Emails with multiple scheduling requests in one thread may only extract the most recent one
- Timezone: events are created in the user's browser timezone (`Intl.DateTimeFormat().resolvedOptions().timeZone`). The email's own stated timezone, if different, is not yet parsed.

---

## Future Improvements (not yet built)

- Availability detection: read existing calendar events and suggest free slots when someone asks "when are you free?"
- Multi-event extraction: handle emails containing more than one proposed meeting time
- Confidence scoring: only show the popup when extraction confidence is above a threshold
- Hosted backend: deploy Flask app to Railway or Render so others can install the extension

### Outlook — Microsoft Graph API integration

Currently the extension reads Outlook by scraping the DOM when Outlook web is open in Chrome.
This does NOT work in the native Outlook desktop app.

The proper fix is to replace the DOM scraper with **Microsoft Graph API** calls:

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
