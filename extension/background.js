// background.js — Service worker: calls Claude API and stores extracted event

// DIAGNOSTIC: confirms the reloaded worker is running THIS build.
console.log('[GmailGenie] background service worker loaded (direct-create build)');

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

// Local Flask backend that writes events straight to Google Calendar via the API.
// Port 5001, not 5000: macOS AirPlay Receiver occupies 5000 and returns 403.
const BACKEND_URL = 'http://localhost:5001';

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
    // Create the event directly on Google Calendar via the backend — no tab
    // opens, no manual Save. Reply asynchronously with the result so the popup
    // or floating card can show success/error, hence `return true` below.
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

// ── Direct calendar creation ─────────────────────────────────────────────────
// POST the event to the local Flask backend, which writes it straight to Google
// Calendar via the API. No calendar tab opens and there is no manual Save step —
// clicking "Add to Calendar" creates the event and that's it.
async function createCalendarEvent(event) {
  console.log('[GmailGenie] creating calendar event via backend', event);
  try {
    const res = await fetch(`${BACKEND_URL}/create-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data.ok) {
      const msg = data.error || `Backend error ${res.status}`;
      console.log('[GmailGenie] event creation failed:', msg);
      return { ok: false, error: msg };
    }

    console.log('[GmailGenie] event created', data.htmlLink);
    return { ok: true, htmlLink: data.htmlLink, id: data.id };
  } catch (err) {
    // Almost always: the Flask backend isn't running on localhost:5001.
    console.log('[GmailGenie] event creation request failed:', err.message);
    return {
      ok: false,
      error: 'Could not reach the GmailGenie backend. Make sure it is running '
           + '(python app.py in the backend/ folder).',
    };
  }
}
