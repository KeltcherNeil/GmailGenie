// background.js — Service worker: calls the hosted extraction backend and stores
// the extracted event. Calendar creation is client-side (chrome.identity); Claude
// extraction is server-side (see backend/), so the Anthropic key never ships here.

// DIAGNOSTIC: confirms the reloaded worker is running THIS build.
console.log('[GmailGenie] background service worker loaded (availability-wizard build, v1.6.1)');

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
async function extractEvent(emailData, token) {
  const headers = { 'Content-Type': 'application/json' };
  // The backend ties extraction spend to a signed-in Google user. Send the
  // user's own OAuth token so it can verify identity + rate-limit per account.
  if (token) headers['Authorization'] = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`${BACKEND_URL}/extract-event`, {
      method: 'POST',
      headers,
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
    if (res.status === 401) {
      // Not signed in (or token rejected) — the popup should prompt to connect.
      const err = new Error('Google sign-in required');
      err.code = 'AUTH_REQUIRED';
      throw err;
    }
    if (res.status === 429) {
      throw new Error('Rate limit reached — please wait a moment and try again.');
    }
    throw new Error(data.error || `Extraction failed (${res.status})`);
  }

  return normalizeExtraction(data);
}

// The backend returns { events: [ {…}, … ], availability_request: {…}|null }.
// Older builds returned a single { event_found, title, … } object. Coerce any
// of these into { events, availability } so the rest of the extension only
// deals with one shape.
function normalizeExtraction(data) {
  let events = [];
  if (Array.isArray(data?.events)) {
    events = data.events.filter((e) => e && typeof e === 'object');
  } else if (data && data.event_found) {
    // Legacy single-event shape.
    const { event_found, ...event } = data;
    events = [event];
  }

  const ar = data?.availability_request;
  const availability = (ar && typeof ar === 'object' && ar.activity) ? ar : null;

  return { events, availability };
}

async function handleEmailOpened(emailData) {
  const jobId = Date.now().toString();
  currentJobId = jobId;

  // Immediately signal that we're working. processingStartedAt lets the popup
  // detect a job that died mid-flight (e.g. the extension was reloaded while
  // extracting, killing the worker) and recover instead of spinning forever.
  await chrome.storage.local.set({
    status: 'processing',
    processingStartedAt: Date.now(),
    emailData,
    events: null,
    availability: null,
    error: null
  });

  try {
    // Use a silently-cached Google token if the user has already connected. If
    // not, we still call the backend: in dev (auth disabled) it works tokenless;
    // in prod it returns 401, which we surface as an "auth_required" state below.
    const token = await getAuthTokenSilent();
    const { events, availability } = await extractEvent(emailData, token);

    if (currentJobId === jobId) {
      await chrome.storage.local.set({ status: 'done', events, availability, error: null });

      // Badge mode — put a green dot on the icon to signal something was found.
      // An availability request only counts when the scheduler is enabled.
      const { notificationMode = 'none', availabilityEnabled } =
        await chrome.storage.local.get(['notificationMode', 'availabilityEnabled']);
      if (events.length || (availability && availabilityEnabled !== false)) {
        if (notificationMode === 'badge') {
          chrome.action.setBadgeText({ text: events.length > 1 ? String(events.length) : '!' });
          chrome.action.setBadgeBackgroundColor({ color: '#188038' });
        }
      }
    }
  } catch (err) {
    if (currentJobId === jobId) {
      if (err.code === 'AUTH_REQUIRED') {
        await chrome.storage.local.set({ status: 'auth_required', error: null, events: null, availability: null });
      } else {
        await chrome.storage.local.set({ status: 'error', error: err.message, events: null, availability: null });
      }
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
  } else if (message.type === 'CONNECT_GOOGLE') {
    // User clicked "Connect Google" in the popup. Interactive sign-in, then
    // re-run extraction on the last email with the freshly cached token.
    connectGoogleAndRescan()
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  } else if (message.type === 'AVAILABILITY_OPTIONS') {
    // Availability wizard step 1: read the user's calendar (client-side),
    // send anonymous busy blocks to the backend, get back candidate days.
    availabilityOptions(message.durationMinutes, message.preferredDates, message.preferredTime)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  } else if (message.type === 'AVAILABILITY_RECOMMEND') {
    // Availability wizard step 3: exact slot + drafted reply for the chosen
    // day/bucket. Reuses the busy blocks fetched for the options step.
    availabilityRecommend(message.payload)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  } else if (message.type === 'OPEN_EDITOR') {
    openEditor(message.autoStart);
  }
  return false;
});

// Silently return a cached Google token, or null if the user hasn't connected
// yet. Never shows UI — safe to call on every email open.
function getAuthTokenSilent() {
  return new Promise((resolve) => {
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      void chrome.runtime.lastError; // not signed in yet — not an error here
      resolve(token || null);
    });
  });
}

// Interactive Google sign-in, then re-extract the stored email so the popup
// updates from "connect" to the detected events.
async function connectGoogleAndRescan() {
  try {
    await getAuthToken(true);
  } catch (err) {
    return { ok: false, error: `Google sign-in failed or was cancelled: ${err.message}` };
  }
  const { emailData } = await chrome.storage.local.get('emailData');
  if (emailData) handleEmailOpened(emailData);
  return { ok: true };
}

// Open the editable "main pop up". Prefer the real toolbar popup
// (chrome.action.openPopup, Chrome 127+); fall back to a small popup window
// showing the same editable UI when that call isn't available/allowed.
// autoStart: the floating card's "Pick a time" was clicked — flag (with a
// timestamp so a stale flag can't fire later) that the popup should skip the
// wizard intro and go straight to checking the calendar.
async function openEditor(autoStart) {
  if (autoStart) {
    await chrome.storage.local.set({ wizardAutoStart: Date.now() });
  }
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

// ── Availability wizard ("when can you play tennis?") ────────────────────────
// The user's calendar is read HERE, client-side, with the same calendar.events
// scope used for event creation (it also permits reading events — no new OAuth
// scope). Only anonymous busy blocks — local start/end stamps, no titles — are
// sent to the backend, which computes free days/buckets deterministically
// (backend/availability.py) and has Claude draft the reply email.

// How far ahead to read the calendar. Comfortably covers the options scan
// window (backend SCAN_LIMIT_DAYS = 14).
const BUSY_LOOKAHEAD_DAYS = 15;

// A Date → the user's LOCAL wall-clock stamp "YYYY-MM-DDTHH:MM" (no timezone).
// All availability math happens in this format so the backend stays tz-free.
function toLocalStamp(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
         `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// GET the user's upcoming events and reduce them to busy blocks. Skips
// cancelled events, invitations the user declined, working-location banners,
// and all-day events (birthdays/reminders). Any other TIMED event counts as
// busy — including ones marked "Free" in Google Calendar. For this product,
// on-your-calendar means you're busy; honoring the Free flag made an
// 11:00–2:30 "school" event invisible and the wizard offered noon over it.
async function fetchBusyBlocks(token) {
  const now = new Date();
  const params = new URLSearchParams({
    timeMin: now.toISOString(),
    timeMax: new Date(now.getTime() + BUSY_LOOKAHEAD_DAYS * 864e5).toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '250',
  });

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  if (!res.ok) {
    const err = new Error(`Could not read your calendar (${res.status})`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const busy = [];
  for (const ev of data.items || []) {
    if (ev.status === 'cancelled') continue;
    if (ev.eventType === 'workingLocation') continue;           // "working from home" banner, not a commitment
    if (!ev.start?.dateTime || !ev.end?.dateTime) continue;     // all-day
    const self = (ev.attendees || []).find((a) => a.self);
    if (self && self.responseStatus === 'declined') continue;
    busy.push({
      start: toLocalStamp(new Date(ev.start.dateTime)),
      end:   toLocalStamp(new Date(ev.end.dateTime)),
    });
  }
  return busy;
}

// fetchBusyBlocks with the same stale-token retry used for event creation.
async function fetchBusyBlocksFresh(token) {
  try {
    return await fetchBusyBlocks(token);
  } catch (err) {
    if (err.status !== 401) throw err;
    await removeCachedToken(token);
    return fetchBusyBlocks(await getAuthToken(true));
  }
}

// POST a JSON payload to a backend route, mapping errors the same way the
// extraction call does (401 → connect prompt, 429 → rate limit).
async function backendPost(path, payload, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`${BACKEND_URL}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new Error('Could not reach the GmailGenie service. Please try again later.');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) {
      const err = new Error('Google sign-in required');
      err.code = 'AUTH_REQUIRED';
      throw err;
    }
    if (res.status === 429) {
      throw new Error('Rate limit reached — please wait a moment and try again.');
    }
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

// Wizard step 1 — candidate days. Interactive auth is fine here: the user just
// clicked "Find a time", so a consent popup (first run only) is expected.
async function availabilityOptions(durationMinutes, preferredDates, preferredTime) {
  const token = await getAuthToken(true);
  const busy = await fetchBusyBlocksFresh(token);
  const data = await backendPost('/availability/options', {
    busy,
    now: toLocalStamp(new Date()),
    duration_minutes: durationMinutes || 60,
    preferred_dates: Array.isArray(preferredDates) ? preferredDates : [],
    preferred_time: preferredTime || '',
  }, token);
  // Return the busy blocks too — the popup passes them back on the recommend
  // step so the calendar isn't re-fetched (and options/recommend stay consistent).
  return {
    ok: true,
    days: data.days || [],
    unavailablePreferred: data.unavailable_preferred || [],
    busy,
  };
}

// Wizard step 3 — exact slot + drafted reply for the chosen day/bucket.
async function availabilityRecommend(payload) {
  const token = await getAuthToken(true);
  const data = await backendPost('/availability/recommend', {
    ...payload,
    now: toLocalStamp(new Date()),
  }, token);
  return { ok: true, ...data };
}
