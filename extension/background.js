// background.js — Service worker: calls Claude API and stores extracted event

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

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // React both to full page loads (status === 'complete') and to client-side
  // SPA navigations (changeInfo.url). Google Calendar swaps to the main view
  // after saving via history.pushState, which only fires changeInfo.url —
  // gating solely on 'complete' would miss the save.
  if (changeInfo.status !== 'complete' && !changeInfo.url) return;
  if (!tab.url) return;

  const { calTabId, calSourceTabId } = await chrome.storage.local.get([
    'calTabId', 'calSourceTabId'
  ]);

  if (tabId !== calTabId) return;

  // Wait until we're on the main calendar home — this is the definitive signal
  // that the event was saved and all redirects are complete. Firing on any
  // earlier URL causes the "Leave site?" dialog because Chrome detects the
  // form is still active during intermediate redirects.
  if (!isCalendarHomeUrl(tab.url)) return;

  if (calSourceTabId) {
    chrome.tabs.update(calSourceTabId, { active: true }).catch(() => {});
  }
  chrome.tabs.remove(tabId);
  chrome.storage.local.remove(['calTabId', 'calSourceTabId']);
});
