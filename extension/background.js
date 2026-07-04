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
  "confidence": "high" | "medium" | "low",
  "confidence_score": integer 0-100 (how sure you are this is a real, actionable event)
}

If no scheduling information is found:
{ "event_found": false }`;

// Track the latest processing job to ignore stale results when emails change quickly
let currentJobId = null;
const SAVE_CLICK_AUTO_RETURN_DELAY_MS = 5500;

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
  } else if (message.type === 'CALENDAR_SAVE_CLICKED') {
    handleCalendarSaveClicked(sender.tab?.id);
  } else if (message.type === 'CALENDAR_SAVE_COMPLETED') {
    handleCalendarSaveCompleted(sender.tab?.id, message.reason);
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

async function openCalendarTab(url, sourceTabId) {
  const calTab = await chrome.tabs.create({ url });
  // Await the write: the auto-return listener can only match the calendar tab
  // once calTabId is persisted, and the user may save the event quickly.
  await chrome.storage.local.set({
    calSourceTabId: sourceTabId,
    calTabId: calTab.id,
    calSaveClickedAt: null,
    calSaveCompletedAt: null
  });
  console.log('[GmailGenie] calendar tab opened & tracked', { calTabId: calTab.id, calSourceTabId: sourceTabId });
  installCalendarSaveWatcher(calTab.id);
  setTimeout(() => installCalendarSaveWatcher(calTab.id), 1500);
  setTimeout(() => installCalendarSaveWatcher(calTab.id), 3500);
}

// ── Auto-return after calendar save ──────────────────────────────────────────
// Google Calendar can show the unsaved event editor while the URL is already
// /calendar/u/0/r. URL navigation is useful for diagnostics, but the tab only
// closes after the injected watcher sees Save clicked and the editor disappear.

// Returns true for the main calendar view, whether or not the event editor is
// open. This is logged for debugging but is not enough by itself to close.
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

// Shared handler logs navigation on the tracked calendar tab. It intentionally
// does not close the tab; Calendar's editor can be open on the same /r URL.
async function maybeAutoReturn(tabId, url, source) {
  const { calTabId } = await chrome.storage.local.get('calTabId');

  if (tabId !== calTabId) return;

  const home = url ? isCalendarHomeUrl(url) : false;
  // DIAGNOSTIC: every navigation seen on the tracked calendar tab, and how it
  // was classified. This is the key line for diagnosing why the tab won't close.
  console.log('[GmailGenie] cal-tab nav', { source, url, isCalendarHome: home });

  // Google Calendar can show the unsaved event editor while the URL is already
  // /calendar/u/0/r, so URL changes are diagnostic only. The close sequence is
  // triggered by the injected watcher after Save is clicked and the editor exits.
}

async function finishAutoReturn(tabId, calSourceTabId, source) {
  const { calTabId } = await chrome.storage.local.get('calTabId');
  if (tabId !== calTabId) return;

  // Clear tracking first so duplicate signals from navigation and click
  // detection don't double-run this close sequence.
  await chrome.storage.local.remove([
    'calTabId', 'calSourceTabId', 'calSaveClickedAt', 'calSaveCompletedAt'
  ]);

  console.log('[GmailGenie] auto-return firing → focus', calSourceTabId, 'close', tabId, 'via', source);

  // The event is already saved, but Google Calendar leaves a "beforeunload"
  // guard armed for a moment during the save transition. Closing the tab would
  // trigger the "Leave site? Changes you made may not be saved" dialog. Inject a
  // capture-phase beforeunload listener that stops that guard from running, so
  // the tab closes silently with no prompt.
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      // MAIN world: run in the page's own JS context so our capture-phase
      // listener can actually stop Google Calendar's page-level beforeunload
      // handler. In the default ISOLATED world our listener can't block it.
      world: 'MAIN',
      func: () => {
        const stop = (e) => {
          e.stopImmediatePropagation();
          e.stopPropagation();
          delete e.returnValue;
        };
        // Capture phase runs before Google's target/bubble handler, so
        // stopImmediatePropagation prevents theirs from arming the dialog.
        window.addEventListener('beforeunload', stop, true);
        try { window.onbeforeunload = null; } catch (_) {}
      },
    });
    console.log('[GmailGenie] beforeunload guard suppressed on cal tab (MAIN world)');
  } catch (err) {
    console.log('[GmailGenie] beforeunload suppress failed (closing anyway):', err.message);
  }

  if (calSourceTabId) {
    chrome.tabs.update(calSourceTabId, { active: true }).catch(() => {});
  }
  chrome.tabs.remove(tabId).catch(() => {});
}

async function installCalendarSaveWatcher(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (saveClickAutoReturnDelayMs) => {
        if (window.__gmailGenieCalendarSaveWatcherInstalled) return;
        window.__gmailGenieCalendarSaveWatcherInstalled = true;

        const isVisible = (el) => {
          if (!(el instanceof Element)) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };

        const textFrom = (el) => [
          el.innerText,
          el.textContent,
          el.getAttribute?.('aria-label'),
          el.getAttribute?.('data-tooltip'),
          el.getAttribute?.('title')
        ].filter(Boolean).join(' ').trim();

        const isSaveControl = (el) => {
          if (!(el instanceof Element)) return false;
          const control = el.closest('button,[role="button"],[jsaction*="click"]');
          if (!control || !isVisible(control)) return false;
          return /\bsave\b/i.test(textFrom(control)) || /\bsave\b/i.test(textFrom(el));
        };

        const hasSaveControl = () => {
          const controls = document.querySelectorAll('button,[role="button"],[jsaction*="click"]');
          return [...controls].some(isSaveControl);
        };

        const waitForSaveToFinish = () => {
          const startedAt = Date.now();
          const maxWaitMs = 20000;
          let stableChecks = 0;
          let sent = false;

          const sendCompleted = (reason) => {
            if (sent) return;
            sent = true;
            try {
              chrome.runtime.sendMessage({ type: 'CALENDAR_SAVE_COMPLETED', reason });
            } catch (_) {}
          };

          window.setTimeout(() => {
            sendCompleted('save-click-delay');
          }, saveClickAutoReturnDelayMs);

          const timer = window.setInterval(() => {
            if (Date.now() - startedAt > maxWaitMs) {
              window.clearInterval(timer);
              return;
            }

            if (hasSaveControl()) {
              stableChecks = 0;
              return;
            }

            stableChecks += 1;
            if (stableChecks < 2) return;

            window.clearInterval(timer);
            sendCompleted('save-control-gone');
          }, 500);
        };

        const onClick = (event) => {
          if (event.__gmailGenieSaveHandled) return;
          const path = event.composedPath?.() || [];
          if (!path.some(isSaveControl)) return;
          event.__gmailGenieSaveHandled = true;
          try { chrome.runtime.sendMessage({ type: 'CALENDAR_SAVE_CLICKED' }); } catch (_) {}
          waitForSaveToFinish();
        };

        window.addEventListener('click', onClick, true);
        document.addEventListener('click', onClick, true);
      },
      args: [SAVE_CLICK_AUTO_RETURN_DELAY_MS],
    });
    console.log('[GmailGenie] calendar save watcher installed', { tabId });
  } catch (err) {
    console.log('[GmailGenie] calendar save watcher install failed:', err.message);
  }
}

async function handleCalendarSaveClicked(tabId) {
  const { calTabId } = await chrome.storage.local.get('calTabId');
  if (tabId !== calTabId) return;

  const clickedAt = Date.now();
  await chrome.storage.local.set({ calSaveClickedAt: clickedAt });
  console.log('[GmailGenie] calendar save click detected', { tabId, clickedAt });

  setTimeout(async () => {
    const state = await chrome.storage.local.get([
      'calTabId', 'calSourceTabId', 'calSaveClickedAt'
    ]);
    if (state.calTabId !== tabId || state.calSaveClickedAt !== clickedAt) return;
    await finishAutoReturn(tabId, state.calSourceTabId, 'calendar-save-click-delay');
  }, SAVE_CLICK_AUTO_RETURN_DELAY_MS);
}

async function handleCalendarSaveCompleted(tabId, reason) {
  const { calTabId, calSourceTabId, calSaveClickedAt } = await chrome.storage.local.get([
    'calTabId', 'calSourceTabId', 'calSaveClickedAt'
  ]);
  if (tabId !== calTabId || !calSaveClickedAt) return;

  const completedAt = Date.now();
  await chrome.storage.local.set({ calSaveCompletedAt: completedAt });
  console.log('[GmailGenie] calendar save completed', { tabId, completedAt, reason });
  await finishAutoReturn(tabId, calSourceTabId, `calendar-save-complete:${reason || 'unknown'}`);
}

// Path 1 — classic tab updates (full loads + some SPA URL changes).
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' && !changeInfo.url) return;
  const url = changeInfo.url || tab.url;
  if (!url) return;
  chrome.storage.local.get('calTabId').then(({ calTabId }) => {
    if (tabId === calTabId) installCalendarSaveWatcher(tabId);
  });
  maybeAutoReturn(tabId, url, 'tabs.onUpdated');
});

// Path 2 — webNavigation catches Google Calendar's history.pushState transition
// after saving, which tabs.onUpdated can miss. This is the more reliable signal.
const CAL_FILTER = { url: [{ hostEquals: 'calendar.google.com' }] };
chrome.webNavigation.onHistoryStateUpdated.addListener((d) => {
  chrome.storage.local.get('calTabId').then(({ calTabId }) => {
    if (d.tabId === calTabId) installCalendarSaveWatcher(d.tabId);
  });
  maybeAutoReturn(d.tabId, d.url, 'webNavigation.onHistoryStateUpdated');
}, CAL_FILTER);
chrome.webNavigation.onCompleted.addListener((d) => {
  chrome.storage.local.get('calTabId').then(({ calTabId }) => {
    if (d.tabId === calTabId) installCalendarSaveWatcher(d.tabId);
  });
  maybeAutoReturn(d.tabId, d.url, 'webNavigation.onCompleted');
}, CAL_FILTER);
