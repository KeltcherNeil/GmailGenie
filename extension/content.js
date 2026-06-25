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

function getGmailBodyEl() {
  const selectors = ['.a3s.aiL', '.a3s', '.ii.gt .a3s', '.gs .a3s', '.adn.ads .a3s'];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.innerText.trim().length > 10) return el;
  }
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

  return { subject, body: body.substring(0, 3000), sender, platform: 'gmail' };
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

  return { subject, body: body.substring(0, 3000), sender, platform: 'outlook' };
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

// ── Navigation detection ──────────────────────────────────────────────────────

function scheduleCheck() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(checkForEmailChange, 1200);
}

// Gmail: hash-based routing
window.addEventListener('hashchange', scheduleCheck);

// Outlook: uses History API (pushState / replaceState) — detect via popstate
window.addEventListener('popstate', scheduleCheck);

// Both: catch framework-driven URL changes and lazy-loaded content
let lastHref = location.href;
const observer = new MutationObserver(() => {
  if (location.href !== lastHref) {
    lastHref = location.href;
    scheduleCheck();
  } else {
    scheduleCheck();
  }
});
observer.observe(document.body, { childList: true, subtree: true });

// Initial check after the page has had time to render
setTimeout(checkForEmailChange, 2000);
