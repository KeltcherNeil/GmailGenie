// background.js — Service worker: calls the hosted extraction backend and stores
// the extracted event. Calendar creation is client-side (chrome.identity); Claude
// extraction is server-side (see backend/), so the Anthropic key never ships here.

// DIAGNOSTIC: confirms the reloaded worker is running THIS build.
console.log('[GmailGenie] background service worker loaded (hosted-extraction build)');

// Hosted extraction service. The backend holds the Anthropic key and returns the
// extracted event JSON — the extension sends only the email text.
//   • Production (Cloud Run): the URL below.
//   • Local dev: swap to 'http://localhost:5001' and run backend/ locally.
// Keep this in sync with the host_permissions entry in manifest.json.
const BACKEND_URL = 'https://gmailgenie-485353812643.us-central1.run.app';

// Track the latest processing job to ignore stale results when emails change quickly
let currentJobId = null;

// Google Calendar API — the extension writes events directly using the user's
// own OAuth token (obtained via chrome.identity). No backend server involved.
// sendUpdates=all so attendees, if any, are notified.
const CALENDAR_API_URL =
  'https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all';

// The user's LOCAL date (e.g. "Wednesday, July 08, 2026"), sent so the backend can
// resolve relative dates like "this Thursday" against the user's calendar, not the
// server's UTC clock.
function localTodayString() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
}

// POST the email text to the hosted backend, which cleans it, calls Claude with
// the operator's key, and returns the structured event JSON.
async function extractEvent(emailData) {
  let res;
  try {
    res = await fetch(`${BACKEND_URL}/extract-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subject: emailData.subject || '',
        sender:  emailData.sender || '',
        body:    emailData.body || '',
        today:   localTodayString(),
      }),
    });
  } catch (err) {
    // Network failure — backend unreachable (down, wrong URL, offline).
    throw new Error('Could not reach the GmailGenie service. Please try again later.');
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    if (res.status === 429) {
      throw new Error('Rate limit reached — please wait a moment and try again.');
    }
    throw new Error(data.error || `Extraction failed (${res.status})`);
  }

  return normalizeEvents(data);
}

// The backend returns { events: [ {…}, … ] }. Older builds returned a single
// { event_found, title, … } object. Coerce either into a plain array of event
// objects so the rest of the extension only deals with one shape.
function normalizeEvents(data) {
  if (Array.isArray(data?.events)) {
    return data.events.filter((e) => e && typeof e === 'object');
  }
  // Legacy single-event shape.
  if (data && data.event_found) {
    const { event_found, ...event } = data;
    return [event];
  }
  return [];
}

async function handleEmailOpened(emailData) {
  const jobId = Date.now().toString();
  currentJobId = jobId;

  // Immediately signal that we're working
  await chrome.storage.local.set({
    status: 'processing',
    emailData,
    events: null,
    error: null
  });

  try {
    const events = await extractEvent(emailData);

    if (currentJobId === jobId) {
      await chrome.storage.local.set({ status: 'done', events, error: null });

      // Badge mode — put a green dot on the icon to signal event(s) were found
      if (events.length) {
        const { notificationMode = 'none' } = await chrome.storage.local.get('notificationMode');
        if (notificationMode === 'badge') {
          chrome.action.setBadgeText({ text: events.length > 1 ? String(events.length) : '!' });
          chrome.action.setBadgeBackgroundColor({ color: '#188038' });
        }
      }
    }
  } catch (err) {
    if (currentJobId === jobId) {
      await chrome.storage.local.set({
        status: 'error',
        error: err.message,
        events: null
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
