// background.js — Service worker: calls Claude API and stores extracted event

// DIAGNOSTIC: confirms the reloaded worker is running THIS build.
console.log('[GmailGenie] background service worker loaded (auto-return debug build)');

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
  "confidence": "high" | "medium" | "low"
}

If no scheduling information is found:
{ "event_found": false }`;

// Track the latest processing job to ignore stale results when emails change quickly
let currentJobId = null;

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

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === 'EMAIL_OPENED') {
    handleEmailOpened(message.payload);
  } else if (message.type === 'OPEN_CALENDAR') {
    // Both the floating card (content script) and the popup route here so we can
    // track the calendar tab. Content scripts carry sender.tab; the popup does
    // not, so it passes sourceTabId explicitly in the message.
    openCalendarTab(message.url, message.sourceTabId ?? sender.tab?.id);
  }
  return false;
});

async function openCalendarTab(url, sourceTabId) {
  const calTab = await chrome.tabs.create({ url });
  // Await the write: the auto-return listener can only match the calendar tab
  // once calTabId is persisted, and the user may save the event quickly.
  await chrome.storage.local.set({ calSourceTabId: sourceTabId, calTabId: calTab.id });
  console.log('[GmailGenie] calendar tab opened & tracked', { calTabId: calTab.id, calSourceTabId: sourceTabId });
}

// ── Auto-return after calendar save ──────────────────────────────────────────
// When the user saves an event, Google Calendar redirects from the
// /render?action=TEMPLATE page to the main /r/ calendar view.
// We detect that redirect, switch focus back to the Gmail/Outlook tab,
// and close the Calendar tab.

// Returns true only when Google Calendar has fully landed on the main calendar
// view after saving — i.e. /calendar/r or /calendar/r/week/2026/6/... etc.
// Any edit/template/intermediate URL returns false so we never close prematurely.
function isCalendarHomeUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname !== 'calendar.google.com') return false;
    // Must be under the SPA calendar view. Google prefixes the path with an
    // account segment when you're signed in, e.g. /calendar/u/0/r/week/...,
    // so allow an optional /u/<n>/ before /r.
    if (!/^\/calendar\/(u\/\d+\/)?r(\/|$)/.test(u.pathname)) return false;
    // Must NOT be an editing or template page
    if (u.pathname.includes('eventedit')) return false;
    if (u.searchParams.has('action')) return false;
    return true;
  } catch { return false; }
}

// Shared handler: decides whether a navigation on the tracked calendar tab means
// the event was saved (landed on the main calendar view) and, if so, returns to
// the source tab and closes the calendar tab. Idempotent — clearing the tracking
// IDs makes any duplicate event from another source a no-op.
async function maybeAutoReturn(tabId, url, source) {
  const { calTabId, calSourceTabId } = await chrome.storage.local.get([
    'calTabId', 'calSourceTabId'
  ]);

  if (tabId !== calTabId) return;

  const home = url ? isCalendarHomeUrl(url) : false;
  // DIAGNOSTIC: every navigation seen on the tracked calendar tab, and how it
  // was classified. This is the key line for diagnosing why the tab won't close.
  console.log('[GmailGenie] cal-tab nav', { source, url, isCalendarHome: home });

  // Wait until we're on the main calendar home — the definitive "saved" signal.
  if (!home) return;

  // Clear tracking first so the other navigation sources (three listeners fire
  // for the same save) don't double-run this close sequence.
  await chrome.storage.local.remove(['calTabId', 'calSourceTabId']);

  console.log('[GmailGenie] auto-return firing → focus', calSourceTabId, 'close', tabId);

  // The event is already saved, but Google Calendar leaves a "beforeunload"
  // guard armed for a moment during the save transition. Closing the tab would
  // trigger the "Leave site? Changes you made may not be saved" dialog. Inject a
  // capture-phase beforeunload listener that stops that guard from running, so
  // the tab closes silently with no prompt.
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        window.addEventListener('beforeunload', (e) => {
          e.stopImmediatePropagation();
          delete e.returnValue;
        }, true);
      },
    });
    console.log('[GmailGenie] beforeunload guard suppressed on cal tab');
  } catch (err) {
    console.log('[GmailGenie] beforeunload suppress failed (closing anyway):', err.message);
  }

  if (calSourceTabId) {
    chrome.tabs.update(calSourceTabId, { active: true }).catch(() => {});
  }
  chrome.tabs.remove(tabId).catch(() => {});
}

// Path 1 — classic tab updates (full loads + some SPA URL changes).
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' && !changeInfo.url) return;
  if (!tab.url) return;
  maybeAutoReturn(tabId, tab.url, 'tabs.onUpdated');
});

// Path 2 — webNavigation catches Google Calendar's history.pushState transition
// after saving, which tabs.onUpdated can miss. This is the more reliable signal.
const CAL_FILTER = { url: [{ hostEquals: 'calendar.google.com' }] };
chrome.webNavigation.onHistoryStateUpdated.addListener((d) => {
  maybeAutoReturn(d.tabId, d.url, 'webNavigation.onHistoryStateUpdated');
}, CAL_FILTER);
chrome.webNavigation.onCompleted.addListener((d) => {
  maybeAutoReturn(d.tabId, d.url, 'webNavigation.onCompleted');
}, CAL_FILTER);
