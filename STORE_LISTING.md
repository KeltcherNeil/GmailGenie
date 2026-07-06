# Chrome Web Store & OAuth submission kit

Copy-paste source for the Web Store listing, the data-use disclosures, and the Google
OAuth consent-screen verification. Fill the `<…>` placeholders before submitting.

---

## 1. Packaging the upload

The store wants a ZIP of the extension directory (not the repo root):

```bash
cd extension && zip -r ../gmailgenie-1.0.0.zip . -x '.*'
```

Bump `version` in `manifest.json` for every new upload (store rejects duplicate
versions).

---

## 2. Store listing copy

**Name:** GmailGenie

**Short description** (≤132 chars):
> Turn emails into calendar events. GmailGenie spots meetings and appointments in Gmail and adds them to Google Calendar in one click.

**Category:** Productivity

**Detailed description:**
> GmailGenie reads the email you're currently viewing in Gmail and detects any
> meetings, appointments, or events it mentions — then lets you add them to Google
> Calendar with a single click.
>
> • One click from email to calendar — no copying dates and times by hand.
> • Handles multiple events in one email (e.g. "this Tuesday at 6:30, next Tuesday at 8").
> • Edit the title, date, time, and location before you add it.
> • Events are created directly on your Google Calendar from your browser.
>
> GmailGenie only reads the message you have open, never stores your email content,
> and never sells your data. See our privacy policy for details.

**Single-purpose description** (required):
> GmailGenie detects scheduling information in the Gmail message the user is viewing
> and creates a corresponding Google Calendar event.

**Screenshots to capture** (1280×800 or 640×400): the event card popup on an email;
a multi-event email showing "2 events detected"; the "Added to Calendar ✓" state.

**Privacy policy URL:** `<host PRIVACY.md at a public URL — e.g. GitHub Pages>`

---

## 3. Permissions justification (Web Store review asks for each)

| Item | Justification |
|---|---|
| `activeTab` | Send a "scan this email" message to the Gmail tab the user is actively viewing when they open the popup. |
| `storage` | Save the detected event(s) and the user's notification preference locally so the popup can display them. |
| `identity` | Google Sign-In so the user can create calendar events and so the backend can confirm a signed-in user (calendar scope). |
| host: `mail.google.com` | Read the open email's text to detect scheduling info. |
| host: `gmailgenie-…run.app` | Send the email text to our extraction backend. |
| host: `googleapis.com/calendar/v3` | Create the approved event on the user's Google Calendar. |
| Remote code | None. The extension bundles all its JS; nothing is fetched and executed. |

---

## 4. Data-use disclosures (Web Store "Privacy practices" tab)

- **What user data is collected:** "Personal communications" (email content of the
  open message). No authentication info stored; no location, financial, health,
  personal identifiers, web history, or activity logging.
- **Purpose:** App functionality only (detecting events in the email being viewed).
- Certify: **not sold to third parties**, **not used for purposes unrelated to the
  single purpose**, **not used for creditworthiness/lending**.
- **Data handling:** email text is transmitted to our backend + Anthropic solely to
  extract event details and is **not retained**. Disclose Anthropic as a service
  provider.
- Link the hosted privacy policy.

---

## 5. Google OAuth consent screen / verification

The `calendar.events` scope is **sensitive**, so the consent screen must be verified
before public users can grant it without an "unverified app" warning (test users work
without verification, capped at 100).

**Publishing status:** move from "Testing" to "In production," then submit for
verification.

**Scopes requested & justification:**

| Scope | Why |
|---|---|
| `openid`, `email` | Identify the signed-in user so the backend can authorize per-account access and rate-limit (prevents anonymous abuse of the extraction service). |
| `.../auth/calendar.events` | Create the calendar events the user approves. GmailGenie only creates/edits events the user explicitly adds; it does not read the user's existing calendar. |

**Verification needs:** a verified app homepage + the hosted privacy-policy URL on the
same domain, an authorized domain, and (Google may request) a short demo video showing
the consent flow and how the scope is used.

---

## 6. After the store assigns the published extension ID

Publishing gives the extension a **new, stable ID** (different from the unpacked dev
ID). Then:

1. In Google Cloud Console → Credentials, set the OAuth **Chrome Extension** client's
   Application ID (or Item ID) to the published extension ID. Keep the client id in
   `manifest.json` in sync.
2. Update the backend's `ALLOWED_ORIGINS` to `chrome-extension://<published-id>` and
   confirm `GOOGLE_CLIENT_ID` matches, then redeploy:
   ```bash
   gcloud run deploy gmailgenie --source backend --region us-central1 \
     --update-env-vars "ALLOWED_ORIGINS=chrome-extension://<published-id>"
   ```
3. Narrow `manifest.json` `host_permissions` to the exact backend URL (already done)
   and re-verify `/health`.

---

## 7. Pre-launch checklist

- [ ] Backend deployed with `ANTHROPIC_API_KEY` (secret), `ALLOWED_ORIGINS`, `GOOGLE_CLIENT_ID` set
- [ ] Anthropic spend alert + Cloud Run budget alert configured
- [ ] Privacy policy hosted at a public URL
- [ ] OAuth consent screen submitted for verification
- [ ] $5 Web Store developer account registered
- [ ] Listing copy, screenshots, and data disclosures filled in
- [ ] Post-publish: OAuth client ID + `ALLOWED_ORIGINS` updated to published extension ID
