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
    → shows suggested event to user
    → on button click, calls Google Calendar API to create event

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
| GET | `/health` | Health check — returns 200 if server is running |

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

**Status:** ✅ Fixed — see "Root cause & fix" below. Kept here for context.

**What should happen (desired behaviour):**
1. User clicks **Add to Google Calendar** (popup) or the floating card's calendar button.
2. A new tab opens on Google Calendar's event-template page (`/calendar/render?action=TEMPLATE&...`).
3. User clicks **Save** in Google Calendar and the event is created successfully.
4. **The calendar tab should automatically close**, and focus should return to the
   original Gmail (or Outlook) tab the user came from.

**What actually happens:**
- Steps 1–3 work: the event is created correctly in Google Calendar.
- Step 4 fails: the calendar tab stays open, and the user is left sitting on the Google
  Calendar view instead of being returned to their email. They have to manually close the
  tab and switch back.

**Where this logic lives:**
- `extension/popup.js` → `openGoogleCalendar(event)` — opens the calendar tab and stores
  `calSourceTabId` (the Gmail tab to return to) and `calTabId` (the calendar tab to close)
  in `chrome.storage.local`.
- `extension/content.js` (~line 353) → floating card sends an `OPEN_CALENDAR` message to the
  background worker instead of opening the tab itself.
- `extension/background.js` → `openCalendarTab(url, sourceTabId)` — the message-based path
  that also records `calSourceTabId` / `calTabId`.
- `extension/background.js` → `chrome.tabs.onUpdated` listener (~line 164) — the auto-return
  detector. It watches the tracked calendar tab and, once `isCalendarHomeUrl(tab.url)`
  returns true, focuses `calSourceTabId` and calls `chrome.tabs.remove()` on the calendar tab.
- `extension/background.js` → `isCalendarHomeUrl(url)` (~line 149) — decides whether the
  calendar tab has "landed" on the main calendar view after a save.

**How the current design is supposed to detect a save:**
After saving, Google Calendar navigates the tab away from the `?action=TEMPLATE` template
page back to the main calendar view (e.g. `/calendar/u/0/r/week/...`). The extension treats
"navigated to the main calendar home URL" as the signal that the save completed, then closes
the tab and returns focus. The most recent commit ("Fix auto-return: handle account-prefixed
URLs and SPA navigation") added handling for the `/u/<n>/` account prefix and for
client-side SPA navigations (`changeInfo.url` in addition to `status === 'complete'`).

**Why it may still be failing (observations — not yet verified):**
- **The post-save URL may not match `isCalendarHomeUrl`.** Google Calendar may redirect to a
  URL shape the regex `^\/calendar\/(u\/\d+\/)?r(\/|$)/` doesn't cover (e.g. an `eventedit`
  view, an `/eventedit/`/`/r/eventedit` intermediate, a lingering `action`/other query param,
  a different host locale, or a "saved" confirmation view), so the listener never fires.
- **The tab-tracking IDs may be lost.** The MV3 service worker (`background.js`) can be torn
  down between opening the calendar tab and the save completing. If it restarts, in-memory
  state is gone — this design stores the IDs in `chrome.storage.local` so they should survive,
  but the `chrome.tabs.onUpdated` listener must be re-registered on wake-up for the event to
  be caught at all.
- **The save may not trigger a tracked navigation.** If Google Calendar saves via a
  background XHR/fetch and updates the view without a URL change the listener can see, neither
  `status === 'complete'` nor `changeInfo.url` fires for the tracked tab.
- **Source-tab focus vs. tab-close are coupled.** Both happen only inside the
  `isCalendarHomeUrl` branch, so if detection fails, neither the close nor the return occurs.

**How to reproduce:**
1. Open an email in Gmail that contains a clear event.
2. In the GmailGenie popup, click **Add to Google Calendar**.
3. In the calendar tab that opens, click **Save**.
4. Observe: the event is created, but the calendar tab remains open and focus does not return
   to the Gmail tab.

**Root cause & fix:**
The failure was **lost tab-tracking state**, specifically a race in the popup path. When the
user clicked **Add to Google Calendar**, `popup.js` opened the calendar tab itself with
`chrome.tabs.create()` and then recorded the tracking IDs with a fire-and-forget
`chrome.storage.local.set({ calSourceTabId, calTabId })`. Opening a new tab shifts focus away
from the popup, which **closes the popup and destroys its JS context** — often before that
async storage write completed. With `calTabId` never persisted, the `chrome.tabs.onUpdated`
listener in `background.js` could never match the calendar tab (`tabId !== calTabId`), so it
never closed the tab or switched back. (The floating-card path in `content.js` was unaffected
because it already routed through the always-alive background worker.)

The fix routes the popup path through the background service worker too:
- `popup.js` → `openGoogleCalendar()` now sends
  `{ type: 'OPEN_CALENDAR', url, sourceTabId }` instead of creating the tab itself. It passes
  `sourceTabId` explicitly because a popup has no `sender.tab`.
- `background.js` → the `OPEN_CALENDAR` handler uses `message.sourceTabId ?? sender.tab?.id`,
  so both the popup and the floating card work.
- `background.js` → `openCalendarTab()` now **awaits** the `chrome.storage.local.set()` so the
  tracking IDs are guaranteed persisted before the user can save.

Because the background worker stays alive across the tab creation, the storage write always
completes, so the auto-return listener reliably matches the calendar tab and closes it /
returns focus after the save lands on the main calendar view.

---

## Known Limitations & Gotchas

- Gmail's DOM class names are obfuscated and may change — if content.js stops working, inspect Gmail's HTML to find the new email body selector
- The Flask backend must be running locally for the extension to work — there is no hosted backend yet
- OAuth tokens expire — the extension handles refresh automatically via Chrome's identity API
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
