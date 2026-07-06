# GmailGenie

A Chrome extension that detects scheduling information in the Gmail email you're
reading and adds it to Google Calendar in one click — powered by Claude.

Open an email that mentions a meeting, appointment, or match time, and GmailGenie
surfaces the event(s) it found with an editable card. Click **Add to Calendar** and
it's created on your Google Calendar. Emails with several events return all of them.

## How it works

```
Gmail tab (content.js)         reads the open email's text from the page
      │
      ▼
background.js (service worker) POSTs the text (+ your Google token) to the backend
      │
      ▼
Backend on Cloud Run           cleans the text, calls Claude to extract event JSON,
(app.py + extractor.py)        returns { "events": [ … ] }  — never stores the email
      │
      ▼
popup.js / floating card       shows editable event card(s)
      │  "Add to Calendar"
      ▼
Google Calendar API            event created directly from your browser via your
                               own OAuth token (chrome.identity) — no server involved
```

- **Extraction** runs server-side so the Anthropic key never ships in the extension.
- **Calendar creation** is fully client-side (your OAuth token → Google directly).
- The backend requires a Google token minted for this extension and rate-limits per
  account, so its Anthropic spend is tied to real signed-in users.

## Repository layout

| Path | What |
|---|---|
| `extension/` | The Chrome extension (MV3): `manifest.json`, `content.js`, `background.js`, `popup.*` |
| `backend/` | Flask extraction service — `app.py`, `extractor.py`, `email_cleaner.py`, `auth.py`, `Dockerfile`, `DEPLOY.md` |
| `tests/` | Unit tests (`test_extractor.py`, `test_auth.py`) + accuracy eval (`evaluate.py`) over `test_emails/` |
| `CLAUDE.md` | Detailed developer/architecture guide |
| `PRIVACY.md` | Privacy policy |

## Quick start (local dev)

```bash
python3 -m venv .venv
./.venv/bin/pip install -r backend/requirements.txt
cd backend && ../.venv/bin/python app.py      # serves http://localhost:5001
```

Load the extension: `chrome://extensions` → Developer Mode → **Load Unpacked** →
select `extension/`. For local dev, point `BACKEND_URL` in `background.js` at
`http://localhost:5001` (with `ALLOWED_ORIGINS`/`GOOGLE_CLIENT_ID` unset locally, the
origin and auth checks are disabled). See `CLAUDE.md` for the full setup, and
`backend/DEPLOY.md` for deploying the backend to Cloud Run.

## Tests

```bash
./.venv/bin/python tests/test_extractor.py    # extraction + cleaner (mocked API)
./.venv/bin/python tests/test_auth.py         # token verification (mocked Google)
./.venv/bin/python tests/evaluate.py          # accuracy over sample emails (real API key)
```

## Privacy

GmailGenie reads only the email you're actively viewing, does not store email content
server-side, and never sells data. See [PRIVACY.md](PRIVACY.md).

## License

[MIT](LICENSE)
