// content.js — Reads email DOM on Gmail and Outlook, sends data to background.js

// ── Platform detection ────────────────────────────────────────────────────────

const PLATFORM = (() => {
  const h = window.location.hostname;
  if (h === 'mail.google.com') return 'gmail';
  if (h.includes('outlook')) return 'outlook';
  return null;
})();

if (!PLATFORM) {
  throw new Error('GmailGenie: unsupported host, content script exiting.');
}

// ── Shared state ──────────────────────────────────────────────────────────────

let lastEmailId  = null;
let debounceTimer = null;

// ── Gmail helpers ─────────────────────────────────────────────────────────────

function getGmailEmailId() {
  // Gmail hash: #inbox/AbCd1234  #all/AbCd1234  #label/Work/AbCd1234
  const match = window.location.hash.match(/#[^/]+\/([A-Za-z0-9]+)(?:\/|$)/);
  if (match) return match[1];

  // Fallback for reading-pane / split-view where the hash has no message ID:
  // fingerprint the visible email body so we still detect new emails
  const bodyEl = getGmailBodyEl();
  if (!bodyEl) return null;
  const snippet = bodyEl.innerText.trim().substring(0, 80);
  return snippet.length > 10 ? 'body:' + btoa(encodeURIComponent(snippet)).substring(0, 30) : null;
}

function isVisible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
}

function getGmailBodyEl() {
  const selectors = ['.a3s.aiL', '.a3s', '.ii.gt .a3s', '.gs .a3s', '.adn.ads .a3s'];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    // Require the element to be visible — Gmail caches hidden .a3s elements
    // in the DOM when the user returns to the inbox, which would cause false triggers
    if (el && el.innerText.trim().length > 10 && isVisible(el)) {
      console.log('[GmailGenie] body found via selector:', sel);
      return el;
    }
  }
  console.log('[GmailGenie] no body element found — tried:', selectors.join(', '));
  return null;
}

function getGmailContent() {
  const bodyEl = getGmailBodyEl();
  if (!bodyEl) return null;

  const body = bodyEl.innerText.trim();
  if (!body) return null;

  // Subject is optional — no-subject emails don't always render h2.hP
  const subjectEl = document.querySelector('h2.hP');
  const subject   = subjectEl?.innerText.trim() || '(no subject)';

  const senderEl = document.querySelector('.gD');
  const sender   = senderEl
    ? senderEl.getAttribute('email') || senderEl.innerText.trim()
    : '';

  return { subject, body: body.substring(0, 1500), sender, platform: 'gmail' };
}

// ── Outlook helpers ───────────────────────────────────────────────────────────

function getOutlookEmailId() {
  // Full-screen view: URL contains /id/<messageId>
  const urlMatch = window.location.href.match(/\/id\/([A-Za-z0-9%_=+/-]{10,})/i);
  if (urlMatch) return decodeURIComponent(urlMatch[1]).substring(0, 60);

  // Reading-pane view: URL doesn't change — use a fingerprint of the body text
  const bodyEl = getOutlookBodyEl();
  if (!bodyEl) return null;
  const snippet = bodyEl.innerText.trim().substring(0, 80);
  return snippet.length > 10 ? btoa(encodeURIComponent(snippet)).substring(0, 30) : null;
}

function getOutlookBodyEl() {
  // Outlook uses aria-label reliably across consumer and enterprise versions
  const selectors = [
    '[aria-label="Message body"]',
    'div[class*="ReadingPane"] [role="document"]',
    '[data-app-section="ConversationContainer"] [role="document"]',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.innerText.trim().length > 20) return el;
  }
  return null;
}

function getOutlookSubject() {
  // Try attribute-based selectors first (more stable than class names)
  const candidates = [
    document.querySelector('[data-testid="subject"]'),
    document.querySelector('[aria-label^="Subject:"]'),
    document.querySelector('[class*="subject" i]'),
    document.querySelector('[class*="Subject" i]'),
  ];
  for (const el of candidates) {
    if (el && el.innerText.trim()) return el.innerText.trim();
  }

  // Fall back to page title: "My Subject - Outlook" or "My Subject - Mail"
  const title = document.title || '';
  const stripped = title.replace(/\s*[-–|]\s*(Outlook|Mail|Microsoft Outlook)\s*$/i, '').trim();
  return stripped || 'Email';
}

function getOutlookSender() {
  // Outlook renders sender info with aria-label or data attributes
  const fromEl = document.querySelector('[aria-label^="From"]') ||
                 document.querySelector('[data-testid="senderName"]');
  if (fromEl) return fromEl.innerText.trim();

  // Outlook sometimes puts sender email in a mailto link
  const mailtoEl = document.querySelector('a[href^="mailto:"]');
  if (mailtoEl) return mailtoEl.href.replace('mailto:', '').split('?')[0];

  return '';
}

function getOutlookContent() {
  const bodyEl = getOutlookBodyEl();
  if (!bodyEl) return null;

  const body    = bodyEl.innerText.trim();
  const subject = getOutlookSubject();
  const sender  = getOutlookSender();

  if (!body || body.length < 10) return null;

  return { subject, body: body.substring(0, 1500), sender, platform: 'outlook' };
}

// ── Unified check ─────────────────────────────────────────────────────────────

function getCurrentEmailId() {
  return PLATFORM === 'gmail' ? getGmailEmailId() : getOutlookEmailId();
}

function getCurrentEmailContent() {
  return PLATFORM === 'gmail' ? getGmailContent() : getOutlookContent();
}

function checkForEmailChange() {
  const currentId = getCurrentEmailId();
  console.log('[GmailGenie] check — platform:', PLATFORM, 'id:', currentId, 'last:', lastEmailId);

  if (!currentId) {
    // Not in an email view — reset so the popup shows idle state
    if (lastEmailId !== null) {
      lastEmailId = null;
      chrome.storage.local.set({ status: 'idle', event: null, error: null, emailData: null });
    }
    return;
  }

  if (currentId === lastEmailId) return; // Same email, nothing to do

  const emailData = getCurrentEmailContent();
  if (!emailData) return; // Content not loaded yet — observer will fire again

  lastEmailId = currentId;

  chrome.runtime.sendMessage({ type: 'EMAIL_OPENED', payload: emailData }, () => {
    // chrome.runtime.lastError just means the service worker was sleeping;
    // Chrome wakes it on the next message, so silently ignore.
    void chrome.runtime.lastError;
  });
}

// ── Extension validity guard ──────────────────────────────────────────────────
// After the extension is reloaded, the old content script becomes "invalidated"
// and all chrome.* calls throw. This guard detects that and shuts down cleanly.

function isExtensionValid() {
  try { return !!chrome.runtime?.id; } catch { return false; }
}

// ── Navigation detection ──────────────────────────────────────────────────────

// For DOM-only mutations (no URL change): debounce to avoid hammering on every
// Gmail animation or real-time email-list update.
function scheduleCheck() {
  if (!isExtensionValid()) { observer.disconnect(); return; }
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(checkForEmailChange, 500);
}

// On explicit navigation (user clicked a new email): try immediately, then
// retry at 350 ms and 750 ms in case the email body hasn't rendered yet.
// lastEmailId guards prevent double-processing the same email.
function onNavigate() {
  if (!isExtensionValid()) return;
  clearTimeout(debounceTimer);
  checkForEmailChange();                                 // 0 ms — best case
  debounceTimer = setTimeout(checkForEmailChange, 350); // 350 ms — typical
  setTimeout(checkForEmailChange, 750);                 // 750 ms — slow render
}

// Gmail: hash-based routing
window.addEventListener('hashchange', onNavigate);

// Outlook: uses History API (pushState / replaceState)
window.addEventListener('popstate', onNavigate);

// Both: catch framework-driven URL changes and lazy-loaded content
let lastHref = location.href;
const observer = new MutationObserver(() => {
  if (location.href !== lastHref) {
    lastHref = location.href;
    onNavigate();    // URL changed — treat as navigation
  } else {
    scheduleCheck(); // same URL, DOM mutated — normal debounce
  }
});
observer.observe(document.body, { childList: true, subtree: true });

// ── Floating card ─────────────────────────────────────────────────────────────

const CARD_ID = 'gmailgenie-floating-card';

function removeCard() {
  document.getElementById(CARD_ID)?.remove();
}

function buildCalUrl(ev) {
  if (!ev.date) return null;
  const d = ev.date.replace(/-/g, '');
  const t = ev.time ? ev.time.replace(':', '') + '00' : null;
  const start = t ? `${d}T${t}` : d;
  let end;
  if (t) {
    const mins = ev.duration_minutes || 60;
    const [yr, mo, dy, hr, mn] = [
      +ev.date.slice(0,4), +ev.date.slice(5,7)-1, +ev.date.slice(8,10),
      +ev.time.slice(0,2), +ev.time.slice(3,5)
    ];
    const e = new Date(yr, mo, dy, hr, mn + mins);
    const p = n => String(n).padStart(2,'0');
    end = `${e.getFullYear()}${p(e.getMonth()+1)}${p(e.getDate())}T${p(e.getHours())}${p(e.getMinutes())}00`;
  } else {
    const nd = new Date(ev.date + 'T00:00:00');
    nd.setDate(nd.getDate() + 1);
    const p = n => String(n).padStart(2,'0');
    end = `${nd.getFullYear()}${p(nd.getMonth()+1)}${p(nd.getDate())}`;
  }
  const params = new URLSearchParams({ action: 'TEMPLATE' });
  params.set('text', ev.title || 'Event');
  if (start && end) params.set('dates', `${start}/${end}`);
  if (ev.location)    params.set('location', ev.location);
  if (ev.description) params.set('details',  ev.description);
  return `https://calendar.google.com/calendar/render?${params}`;
}

function fmtCardDate(ev) {
  const parts = [];
  if (ev.date) {
    try {
      parts.push(new Date(ev.date + 'T00:00:00').toLocaleDateString('en-US',
        { weekday: 'short', month: 'short', day: 'numeric' }));
    } catch { parts.push(ev.date); }
  }
  if (ev.time) {
    const [h, m] = ev.time.split(':').map(Number);
    parts.push(`${h%12||12}:${String(m).padStart(2,'0')} ${h>=12?'PM':'AM'}`);
  }
  return parts.join(' · ');
}

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function showEventCard(ev) {
  removeCard();
  const calUrl  = buildCalUrl(ev);
  const dateStr = fmtCardDate(ev);

  const card = document.createElement('div');
  card.id = CARD_ID;
  card.innerHTML = `
    <style>
      #gmailgenie-floating-card {
        position: fixed; bottom: 24px; right: 24px; width: 300px;
        background: #fff; border-radius: 12px;
        box-shadow: 0 4px 24px rgba(0,0,0,0.18);
        font-family: 'Google Sans', Roboto, Arial, sans-serif;
        font-size: 14px; color: #202124;
        z-index: 2147483647; border: 1px solid #e0e0e0; overflow: hidden;
        animation: gg-in 0.25s ease;
      }
      @keyframes gg-in {
        from { transform: translateY(16px); opacity: 0; }
        to   { transform: translateY(0);    opacity: 1; }
      }
      #gmailgenie-floating-card .gg-head {
        display: flex; align-items: center; justify-content: space-between;
        padding: 10px 14px; background: #1a73e8; color: #fff;
      }
      #gmailgenie-floating-card .gg-head-title {
        font-size: 12px; font-weight: 600; letter-spacing: 0.2px;
      }
      #gmailgenie-floating-card .gg-x {
        background: none; border: none; color: #fff; cursor: pointer;
        font-size: 15px; opacity: 0.8; padding: 0; line-height: 1;
      }
      #gmailgenie-floating-card .gg-x:hover { opacity: 1; }
      #gmailgenie-floating-card .gg-body { padding: 12px 14px; }
      #gmailgenie-floating-card .gg-title {
        font-weight: 600; font-size: 14px; margin-bottom: 8px; line-height: 1.3;
      }
      #gmailgenie-floating-card .gg-row {
        display: flex; gap: 6px; font-size: 12px; color: #5f6368; margin-bottom: 3px;
      }
      #gmailgenie-floating-card .gg-btn {
        display: block; width: 100%; margin-top: 12px; padding: 9px;
        background: #188038; color: #fff; border: none; border-radius: 4px;
        font-size: 13px; font-weight: 500; cursor: pointer;
        font-family: inherit; text-align: center;
      }
      #gmailgenie-floating-card .gg-btn:hover { background: #0d6b2e; }
    </style>
    <div class="gg-head">
      <span class="gg-head-title">&#128197; GmailGenie detected an event</span>
      <button class="gg-x" id="gg-close">&#10005;</button>
    </div>
    <div class="gg-body">
      <div class="gg-title">${esc(ev.title || 'Untitled Event')}</div>
      ${dateStr    ? `<div class="gg-row"><span>&#128197;</span><span>${esc(dateStr)}</span></div>` : ''}
      ${ev.location? `<div class="gg-row"><span>&#128205;</span><span>${esc(ev.location)}</span></div>` : ''}
      ${calUrl     ? `<button class="gg-btn" id="gg-cal">&#10133; Add to Google Calendar</button>` : ''}
    </div>
  `;
  document.body.appendChild(card);
  document.getElementById('gg-close').addEventListener('click', removeCard);
  document.getElementById('gg-cal')?.addEventListener('click', () => {
    window.open(calUrl, '_blank');
    removeCard();
  });
}

// Watch storage — show or remove card based on current mode
chrome.storage.onChanged.addListener((_, area) => {
  if (area !== 'local') return;
  chrome.storage.local.get(['status', 'event', 'notificationMode'], (data) => {
    if (data.status === 'done' && data.event?.event_found && data.notificationMode === 'card') {
      showEventCard(data.event);
    } else if (data.status === 'idle') {
      removeCard();
    }
  });
});

// ── Manual scan (from popup "Scan current email" button) ──────────────────────

// Allow the popup to manually trigger a scan (bypasses debounce + resets lastEmailId)
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'SCAN_NOW') {
    console.log('[GmailGenie] manual scan triggered');
    clearTimeout(debounceTimer);
    lastEmailId = null; // force re-detection even if same email
    checkForEmailChange();
  }
});

// Initial check after the page has had time to render
// Reduced from 2000ms — content script runs at document_idle so page is ready
setTimeout(checkForEmailChange, 800);
