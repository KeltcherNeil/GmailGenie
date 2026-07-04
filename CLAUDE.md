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
│   ├── calendar_helper.py      # Google Calendar API helpers
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
    → calls Python backend at localhost:5000
    → stores result in chrome.storage

popup.html / popup.js
    → reads result from chrome.storage
    → shows suggested (editable) event to user
    → on "Add to Calendar", sends CREATE_EVENT to background.js
    → background.js POSTs the event to the backend /create-event, which writes it
      straight to Google Calendar via the API — no calendar tab opens, no manual Save

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
GOOGLE_CLIENT_ID=your_client_id
GOOGLE_CLIENT_SECRET=your_client_secret
FLASK_ENV=development
```

---

## Running the Project Locally

**Start the Python backend:**
```bash
cd backend
pip install -r requirements.txt
python app.py
# Server runs at http://localhost:5000
```

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
| POST | `/create-event` | Takes an event JSON object, creates it on the user's primary Google Calendar via the API, returns `{ ok, id, htmlLink }` |
| GET | `/health` | Health check — returns 200 if server is running |

**Note on `/create-event` OAuth:** the first call runs `calendar_helper.get_calendar_service()`,
which needs `backend/credentials.json` (a **Desktop** OAuth client downloaded from Google Cloud
Console) and opens a browser once for consent, writing `backend/token.json`. Both files are
gitignored. Subsequent calls reuse/refresh the token silently.

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

**New behaviour (current):**
1. User clicks **Add to Calendar** (popup) or **Add to Google Calendar** (floating card).
2. The extension sends a `CREATE_EVENT` message to `background.js`.
3. `background.js` → `createCalendarEvent()` POSTs the event to the backend `POST /create-event`.
4. The backend uses `calendar_helper.get_calendar_service()` + `create_event()` to insert the
   event on the user's primary Google Calendar via the API.
5. The button shows **Creating… → Added to Calendar ✓** (or an error). No tab ever opens.

**Where this logic lives now:**
- `extension/popup.js` → `createEvent()` — sends `CREATE_EVENT`, renders the button states.
- `extension/content.js` → `createEventFromCard()` — same for the floating card.
- `extension/background.js` → `CREATE_EVENT` handler + `createCalendarEvent()` — POSTs to the backend.
- `backend/app.py` → `POST /create-event` — validates and calls `calendar_helper.create_event()`.
- `backend/calendar_helper.py` → `get_calendar_service()` / `create_event()` — Google Calendar API.

**Requirement:** the backend needs `backend/credentials.json` (a Desktop OAuth client) and does a
one-time browser consent on first create (writes `backend/token.json`). Both files are gitignored.

---

## Known Limitations & Gotchas

- Gmail's DOM class names are obfuscated and may change — if content.js stops working, inspect Gmail's HTML to find the new email body selector
- The Flask backend must be running locally for the extension to work — there is no hosted backend yet
- OAuth tokens expire — the backend refreshes them automatically (`calendar_helper.get_calendar_service` uses the stored `backend/token.json` refresh token)
- The backend must be running for **event creation** too, not just extraction — `POST /create-event` is what writes to Google Calendar
- Emails with multiple scheduling requests in one thread may only extract the most recent one
- Timezone handling is not yet implemented — all times are treated as local time

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
