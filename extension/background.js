// background.js — Service worker: calls Claude API and stores extracted event

// DIAGNOSTIC: confirms the reloaded worker is running THIS build.
console.log('[GmailGenie] background service worker loaded (client-side calendar build)');

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';

// claude-haiku is fast and cheap — ideal for extraction
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM_PROMPT = `You extract scheduling information from emails.
Return ONLY valid JSON — no markdown, no explanation, nothing else.

If an event or meeting is found:
{
  "event_found": true,
  "title": "short event title",
  "date": "YYYY-MM-DD or null",
  "time": "HH:MM in 24h format or null",
  "duration_minutes": integer or null,
  "location": "location string or null",
  "description": "one-sentence description or null",
  "confidence": "high" | "medium" | "low",
  "confidence_score": integer 0-100 (how sure you are this is a real, actionable event)
}

If no scheduling information is found:
{ "event_found": false }`;

// Track the latest processing job to ignore stale results when emails change quickly
let currentJobId = null;

// Google Calendar API — the extension writes events directly using the user's
// own OAuth token (obtained via chrome.identity). No backend server involved.
// sendUpdates=all so attendees, if any, are notified.
const CALENDAR_API_URL =
  'https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all';

// Returns e.g. "Wednesday, June 25, 2026" so Claude can resolve relative dates
function todayString() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
}

async function extractEvent(emailData, apiKey) {
  const emailText = [
    `Subject: ${emailData.subject}`,
    emailData.sender ? `From: ${emailData.sender}` : '',
    '',
    emailData.body
  ].filter(Boolean).join('\n');

  const res = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      // Required when calling the API directly from a browser/extension context
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: `Today's date: ${todayString()}\n\nEMAIL:\n${emailText}` }
      ]
    })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API error ${res.status}: ${body.substring(0, 200)}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text?.trim() ?? '';

  // Strip any accidental markdown fences
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude returned no JSON');

  return JSON.parse(jsonMatch[0]);
}

async function handleEmailOpened(emailData) {
  const jobId = Date.now().toString();
  currentJobId = jobId;

  // Immediately signal that we're working
  await chrome.storage.local.set({
    status: 'processing',
    emailData,
    event: null,
    error: null
  });

  try {
    const { apiKey } = await chrome.storage.local.get('apiKey');

    if (!apiKey) {
      if (currentJobId === jobId) {
        await chrome.storage.local.set({ status: 'no_api_key' });
      }
      return;
    }

    const event = await extractEvent(emailData, apiKey);

    if (currentJobId === jobId) {
      await chrome.storage.local.set({ status: 'done', event, error: null });

      // Badge mode — put a green dot on the icon to signal an event was found
      if (event.event_found) {
        const { notificationMode = 'none' } = await chrome.storage.local.get('notificationMode');
        if (notificationMode === 'badge') {
          chrome.action.setBadgeText({ text: '!' });
          chrome.action.setBadgeBackgroundColor({ color: '#188038' });
        }
      }
    }
  } catch (err) {
    if (currentJobId === jobId) {
      await chrome.storage.local.set({
        status: 'error',
        error: err.message,
        event: null
      });
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'EMAIL_OPENED') {
    handleEmailOpened(message.payload);
  } else if (message.type === 'CREATE_EVENT') {
    // Create the event directly on Google Calendar via chrome.identity — no
    // backend, no tab, no manual Save. Reply asynchronously with the result so
    // the popup or floating card can show success/error, hence `return true`.
    createCalendarEvent(message.event)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  } else if (message.type === 'OPEN_EDITOR') {
    openEditor();
  }
  return false;
});

// Open the editable "main pop up". Prefer the real toolbar popup
// (chrome.action.openPopup, Chrome 127+); fall back to a small popup window
// showing the same editable UI when that call isn't available/allowed.
async function openEditor() {
  try {
    if (chrome.action.openPopup) {
      await chrome.action.openPopup();
      console.log('[GmailGenie] opened toolbar popup for editing');
      return;
    }
  } catch (err) {
    console.log('[GmailGenie] openPopup failed, opening window instead:', err.message);
  }
  chrome.windows.create({
    url: chrome.runtime.getURL('popup.html'),
    type: 'popup',
    width: 384,
    height: 640
  });
}

// ── Direct calendar creation (client-side) ───────────────────────────────────
// The extension writes the event straight to the user's Google Calendar using
// their own OAuth token from chrome.identity — no backend server, no calendar
// tab, no manual Save. Clicking "Add to Calendar" creates the event and that's it.

// The user's IANA timezone (e.g. "America/New_York"), resolved from the browser.
// Google interprets the event's wall-clock time in this zone.
function userTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

const pad = (n) => String(n).padStart(2, '0');

// Add `minutes` to a "YYYY-MM-DD" + "HH:MM" wall-clock pair, rolling over days
// as needed. Returns { date, time } as strings. Timezone-agnostic: the Date is
// only used for calendar arithmetic on the literal components.
function addMinutes(dateStr, timeStr, minutes) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  const dt = new Date(y, mo - 1, d, h, mi + minutes);
  return {
    date: `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`,
    time: `${pad(dt.getHours())}:${pad(dt.getMinutes())}`,
  };
}

// "YYYY-MM-DD" → next calendar day (for all-day event end dates, which are exclusive).
function nextDay(dateStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, mo - 1, d + 1);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

// Convert an extracted/edited event into a Google Calendar API event resource.
// Ported from backend/calendar_helper.py:build_event_body.
function buildEventBody(event) {
  const tz = userTimeZone();
  const body = { summary: event.title || 'Event from GmailGenie' };

  const date = event.date;
  const time = event.time;
  const duration = event.duration_minutes || 60;

  if (date && time) {
    const end = addMinutes(date, time, duration);
    body.start = { dateTime: `${date}T${time}:00`, timeZone: tz };
    body.end   = { dateTime: `${end.date}T${end.time}:00`, timeZone: tz };
  } else if (date) {
    // All-day event — end date is exclusive, so it's the following day.
    body.start = { date };
    body.end   = { date: nextDay(date) };
  }

  if (event.location)    body.location    = event.location;
  if (event.description) body.description = event.description;
  if (Array.isArray(event.attendees) && event.attendees.length) {
    body.attendees = event.attendees.map((email) => ({ email }));
  }

  return body;
}

// Get a Google OAuth access token via chrome.identity. `interactive: true`
// shows the Google consent/account-picker UI when there's no cached token.
function getAuthToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError?.message || 'No auth token returned'));
      } else {
        resolve(token);
      }
    });
  });
}

// Drop a token from Chrome's cache (e.g. after a 401) so the next request fetches a fresh one.
function removeCachedToken(token) {
  return new Promise((resolve) => chrome.identity.removeCachedAuthToken({ token }, resolve));
}

// POST the event body to the Calendar API with the given bearer token.
async function insertEvent(token, body) {
  return fetch(CALENDAR_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function createCalendarEvent(event) {
  console.log('[GmailGenie] creating calendar event via chrome.identity', event);

  let token;
  try {
    token = await getAuthToken(true);
  } catch (err) {
    console.log('[GmailGenie] Google sign-in failed:', err.message);
    return { ok: false, error: `Google sign-in failed or was cancelled: ${err.message}` };
  }

  const body = buildEventBody(event);

  try {
    let res = await insertEvent(token, body);

    // A cached token can be stale/revoked — refresh once and retry.
    if (res.status === 401) {
      await removeCachedToken(token);
      token = await getAuthToken(true);
      res = await insertEvent(token, body);
    }

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const msg = data.error?.message || `Calendar API error ${res.status}`;
      console.log('[GmailGenie] event creation failed:', msg);
      return { ok: false, error: msg };
    }

    console.log('[GmailGenie] event created', data.htmlLink);
    return { ok: true, htmlLink: data.htmlLink, id: data.id };
  } catch (err) {
    console.log('[GmailGenie] event creation request failed:', err.message);
    return { ok: false, error: `Could not reach Google Calendar: ${err.message}` };
  }
}
