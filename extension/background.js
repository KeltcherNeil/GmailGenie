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
    // Floating card routes here so we can track the calendar tab
    openCalendarTab(message.url, sender.tab?.id);
  }
  return false;
});

async function openCalendarTab(url, sourceTabId) {
  const calTab = await chrome.tabs.create({ url });
  chrome.storage.local.set({ calSourceTabId: sourceTabId, calTabId: calTab.id });
}

// ── Auto-return after calendar save ──────────────────────────────────────────
// When the user saves an event, Google Calendar redirects from the
// /render?action=TEMPLATE page to the main /r/ calendar view.
// We detect that redirect, switch focus back to the Gmail/Outlook tab,
// and close the Calendar tab.

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;
  if (!tab.url.includes('calendar.google.com')) return;

  const { calTabId, calSourceTabId } = await chrome.storage.local.get([
    'calTabId', 'calSourceTabId'
  ]);

  if (tabId !== calTabId) return;

  // Still on the template form or the "more options" edit form — not saved yet
  if (tab.url.includes('action=TEMPLATE')) return;
  if (tab.url.includes('action=EDIT') || tab.url.includes('eventedit')) return;

  // Landed on the main calendar view (/calendar/r...) — event was saved
  if (calSourceTabId) {
    chrome.tabs.update(calSourceTabId, { active: true }).catch(() => {});
  }
  chrome.tabs.remove(tabId);
  chrome.storage.local.remove(['calTabId', 'calSourceTabId']);
});
