// content.js — Reads the open Gmail email from the DOM and sends it to background.js

// ── State ─────────────────────────────────────────────────────────────────────

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

  // Cap generously: scheduling details often sit at the END of a long email/thread,
  // so a tight cap silently drops them before the backend ever sees them. The
  // backend's email_cleaner applies the final bound after stripping quotes/signatures.
  return { subject, body: body.substring(0, 8000), sender, platform: 'gmail' };
}

// ── Email-change detection ────────────────────────────────────────────────────

function checkForEmailChange() {
  const currentId = getGmailEmailId();
  console.log('[GmailGenie] check — id:', currentId, 'last:', lastEmailId);

  if (!currentId) {
    // Not in an email view — reset so the popup shows idle state
    if (lastEmailId !== null) {
      lastEmailId = null;
      chrome.storage.local.set({ status: 'idle', events: null, availability: null, error: null, emailData: null });
    }
    return;
  }

  if (currentId === lastEmailId) return; // Same email, nothing to do

  const emailData = getGmailContent();
  if (!emailData) return; // Content not loaded yet — observer will fire again

  lastEmailId = currentId;

  safeSendMessage({ type: 'EMAIL_OPENED', payload: emailData });
}

// ── Extension validity guard ──────────────────────────────────────────────────
// After the extension is reloaded, the old content script becomes "invalidated"
// and all chrome.* calls throw. This guard detects that and shuts down cleanly.

function isExtensionValid() {
  try { return !!chrome.runtime?.id; } catch { return false; }
}

function safeSendMessage(message, callback) {
  if (!isExtensionValid()) {
    // Report failure to any caller expecting a response so its UI can recover.
    if (callback) callback({ ok: false, error: 'Extension reloaded — refresh the page.' });
    return;
  }
  try {
    chrome.runtime.sendMessage(message, (response) => {
      // Reading lastError clears the "unchecked runtime.lastError" warning.
      const err = chrome.runtime.lastError;
      if (callback) callback(err ? { ok: false, error: err.message } : response);
    });
  } catch (_) {
    if (callback) callback({ ok: false, error: 'Could not reach the extension.' });
  }
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

// Catch framework-driven URL changes and lazy-loaded content
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

// Confidence as 0–100. Prefer the numeric model score, else map high/medium/low.
function cardConfidencePercent(ev) {
  const raw = ev.confidence_score;
  if (typeof raw === 'number' && isFinite(raw)) {
    return Math.max(0, Math.min(100, Math.round(raw)));
  }
  return ({ high: 92, medium: 66, low: 34 })[ev.confidence] ?? 66;
}

// Build the inner HTML for a single event block within the floating card.
// `i` indexes the event so buttons/status don't collide when several are shown.
function eventBlockHTML(ev, i) {
  // The event can be created directly on Google Calendar as long as it has a
  // date; time/duration are optional (all-day event otherwise).
  const canCreate = !!ev.date;
  const dateStr   = fmtCardDate(ev);

  const pct   = cardConfidencePercent(ev);
  const level = pct >= 80 ? 'high' : pct >= 50 ? 'medium' : 'low';

  return `
    <div class="gg-event" data-idx="${i}">
      <div class="gg-title">${esc(ev.title || 'Untitled Event')}</div>

      <div class="gg-conf">
        <div class="gg-conf-head">
          <span class="gg-conf-label">Confidence</span>
          <span class="gg-conf-pct">${pct}%</span>
        </div>
        <div class="gg-track"><div class="gg-fill ${level}" style="width:${pct}%"></div></div>
      </div>

      <div class="gg-editable" data-idx="${i}" title="Edit event">
        <div class="gg-card">
          ${dateStr    ? `<div class="gg-row"><svg class="gg-mi" viewBox="0 0 24 24"><path d="M20 3h-1V1h-2v2H7V1H5v2H4c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 18H4V8h16v13z"/></svg><span>${esc(dateStr)}</span></div>` : ''}
          ${ev.location? `<div class="gg-row"><svg class="gg-mi" viewBox="0 0 24 24"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg><span>${esc(ev.location)}</span></div>` : ''}
          ${!dateStr && !ev.location ? `<div class="gg-row"><svg class="gg-mi" viewBox="0 0 24 24"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg><span>Event detected</span></div>` : ''}
        </div>
        <div class="gg-edit-overlay">
          <svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.9959.9959 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
          Edit
        </div>
      </div>
      ${canCreate  ? `<button class="gg-btn" data-idx="${i}">&#10133; Add to Google Calendar</button>` : ''}
      <div class="gg-status" data-idx="${i}"></div>
    </div>
  `;
}

function showEventCard(events) {
  removeCard();
  const list  = Array.isArray(events) ? events : [events];
  const count = list.length;
  const heading = count === 1
    ? '&#128197; GmailGenie detected an event'
    : `&#128197; GmailGenie detected ${count} events`;

  const card = document.createElement('div');
  card.id = CARD_ID;
  card.innerHTML = `
    <style>
      #gmailgenie-floating-card {
        position: fixed; bottom: 24px; right: 24px; width: 312px;
        background: #fff; border-radius: 16px;
        box-shadow: 0 12px 40px rgba(24,28,40,0.22);
        font-family: 'Google Sans', Roboto, -apple-system, Arial, sans-serif;
        font-size: 14px; color: #1f2430;
        z-index: 2147483647; border: 1px solid #eef0f4; overflow: hidden;
        animation: gg-in 0.28s cubic-bezier(0.22,1,0.36,1);
      }
      @keyframes gg-in {
        from { transform: translateY(16px); opacity: 0; }
        to   { transform: translateY(0);    opacity: 1; }
      }
      @keyframes gg-fill { from { width: 0; } }
      #gmailgenie-floating-card .gg-head {
        display: flex; align-items: center; justify-content: space-between;
        padding: 13px 16px; color: #fff; position: relative; overflow: hidden;
        background: linear-gradient(135deg, #6a11cb 0%, #2575fc 100%);
      }
      #gmailgenie-floating-card .gg-head::after {
        content: ""; position: absolute; top: -70%; right: -10%;
        width: 140px; height: 140px; pointer-events: none;
        background: radial-gradient(circle, rgba(255,255,255,0.22), transparent 60%);
      }
      #gmailgenie-floating-card .gg-head-title {
        font-size: 12.5px; font-weight: 600; letter-spacing: 0.2px; z-index: 1;
      }
      #gmailgenie-floating-card .gg-x {
        background: none; border: none; color: #fff; cursor: pointer;
        font-size: 15px; opacity: 0.85; padding: 0; line-height: 1; z-index: 1;
      }
      #gmailgenie-floating-card .gg-x:hover { opacity: 1; }
      #gmailgenie-floating-card .gg-body { padding: 14px 16px 16px; }
      #gmailgenie-floating-card .gg-title {
        font-weight: 600; font-size: 15px; margin-bottom: 12px; line-height: 1.3;
      }
      #gmailgenie-floating-card .gg-conf { margin-bottom: 14px; }
      #gmailgenie-floating-card .gg-conf-head {
        display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 5px;
      }
      #gmailgenie-floating-card .gg-conf-label {
        font-size: 10px; font-weight: 600; text-transform: uppercase;
        letter-spacing: 0.6px; color: #9aa2b1;
      }
      #gmailgenie-floating-card .gg-conf-pct {
        font-size: 12px; font-weight: 700; color: #1f2430; font-variant-numeric: tabular-nums;
      }
      #gmailgenie-floating-card .gg-track {
        height: 7px; border-radius: 999px; background: #eceef4; overflow: hidden;
      }
      #gmailgenie-floating-card .gg-fill {
        height: 100%; border-radius: 999px; animation: gg-fill 0.7s cubic-bezier(0.22,1,0.36,1);
      }
      #gmailgenie-floating-card .gg-fill.high   { background: linear-gradient(90deg,#12b76a,#34d399); }
      #gmailgenie-floating-card .gg-fill.medium { background: linear-gradient(90deg,#f5a524,#fbbf24); }
      #gmailgenie-floating-card .gg-fill.low    { background: linear-gradient(90deg,#f04438,#fb7185); }
      #gmailgenie-floating-card .gg-card {
        background: #f7f8fc; border: 1px solid #eef0f4; border-radius: 12px;
        padding: 11px 13px; display: flex; flex-direction: column; gap: 9px;
      }
      #gmailgenie-floating-card .gg-editable { position: relative; cursor: pointer; border-radius: 12px; }
      #gmailgenie-floating-card .gg-editable:hover .gg-card { border-color: #cfe0ff; }
      #gmailgenie-floating-card .gg-edit-overlay {
        position: absolute; inset: 0; border-radius: 12px;
        display: flex; align-items: center; justify-content: center; gap: 6px;
        background: rgba(37,117,252,0.12); color: #2575fc;
        font-size: 13px; font-weight: 700; letter-spacing: 0.3px;
        opacity: 0; transition: opacity 0.15s ease;
      }
      #gmailgenie-floating-card .gg-editable:hover .gg-edit-overlay { opacity: 1; }
      #gmailgenie-floating-card .gg-edit-overlay svg { width: 16px; height: 16px; fill: currentColor; }
      #gmailgenie-floating-card .gg-row {
        display: flex; gap: 9px; font-size: 12.5px; color: #4b5160; align-items: center;
      }
      #gmailgenie-floating-card .gg-mi { width: 16px; height: 16px; fill: #6b7280; flex-shrink: 0; }
      #gmailgenie-floating-card .gg-btn {
        display: block; width: 100%; margin-top: 14px; padding: 11px;
        background: linear-gradient(135deg, #6a11cb 0%, #2575fc 100%);
        color: #fff; border: none; border-radius: 11px;
        font-size: 13.5px; font-weight: 600; cursor: pointer;
        font-family: inherit; text-align: center;
        box-shadow: 0 6px 16px rgba(37,117,252,0.28);
        transition: transform 0.12s, box-shadow 0.15s;
      }
      #gmailgenie-floating-card .gg-btn:hover {
        background: linear-gradient(135deg, #0f9d58 0%, #34d399 100%);
        transform: translateY(-2px); box-shadow: 0 10px 24px rgba(15,157,88,0.38);
      }
      #gmailgenie-floating-card .gg-btn:active { transform: translateY(1px); }
      #gmailgenie-floating-card .gg-btn:disabled {
        cursor: default; transform: none; box-shadow: 0 6px 16px rgba(37,117,252,0.20);
      }
      #gmailgenie-floating-card .gg-btn.gg-btn-success,
      #gmailgenie-floating-card .gg-btn.gg-btn-success:hover {
        background: linear-gradient(135deg, #0f9d58 0%, #34d399 100%);
        box-shadow: 0 6px 16px rgba(15,157,88,0.30); transform: none;
      }
      #gmailgenie-floating-card .gg-status {
        margin-top: 9px; font-size: 12px; line-height: 1.4; text-align: center;
      }
      #gmailgenie-floating-card .gg-status:empty { margin-top: 0; }
      #gmailgenie-floating-card .gg-status.ok  { color: #0f9d58; }
      #gmailgenie-floating-card .gg-status.err { color: #d92d20; }
      /* Stacked events: keep the card within the viewport and separate blocks. */
      #gmailgenie-floating-card .gg-body { max-height: 70vh; overflow-y: auto; }
      #gmailgenie-floating-card .gg-event + .gg-event {
        margin-top: 16px; padding-top: 16px; border-top: 1px solid #eef0f4;
      }
    </style>
    <div class="gg-head">
      <span class="gg-head-title">${heading}</span>
      <button class="gg-x" id="gg-close">&#10005;</button>
    </div>
    <div class="gg-body">
      ${list.map((ev, i) => eventBlockHTML(ev, i)).join('')}
    </div>
  `;
  document.body.appendChild(card);
  document.getElementById('gg-close').addEventListener('click', removeCard);

  // Wire each event block's edit zone and Add button by index.
  list.forEach((ev, i) => {
    // Hover the details section to reveal "Edit"; click to open the editor popup.
    card.querySelector(`.gg-editable[data-idx="${i}"]`)?.addEventListener('click', () => {
      safeSendMessage({ type: 'OPEN_EDITOR' });
      removeCard();
    });
    card.querySelector(`.gg-btn[data-idx="${i}"]`)?.addEventListener('click', () => {
      createEventFromCard(ev, i);
    });
  });
}

// Create one event directly on Google Calendar (via background → backend).
// No tab opens; that block's button reflects Creating → Added ✓ / error. The
// card auto-dismisses only once every event block has succeeded.
function createEventFromCard(ev, i) {
  const card   = document.getElementById(CARD_ID);
  const btn    = card?.querySelector(`.gg-btn[data-idx="${i}"]`);
  const status = card?.querySelector(`.gg-status[data-idx="${i}"]`);
  if (!btn) return;

  const event = {
    title:            ev.title || 'Event',
    date:             ev.date || null,
    time:             ev.time || null,
    duration_minutes: ev.duration_minutes || null,
    location:         ev.location || null,
    description:      ev.description || null,
  };

  btn.disabled = true;
  btn.textContent = 'Creating…';
  if (status) { status.textContent = ''; status.className = 'gg-status'; status.setAttribute('data-idx', i); }

  safeSendMessage({ type: 'CREATE_EVENT', event }, (result) => {
    if (result && result.ok) {
      btn.textContent = '✓ Added to Calendar';
      btn.classList.add('gg-btn-success');
      if (status) { status.textContent = 'Event created on your Google Calendar.'; status.classList.add('ok'); }
      // Auto-dismiss only when no block still has a pending Add button.
      const pending = card.querySelectorAll('.gg-btn:not(.gg-btn-success)');
      if (pending.length === 0) setTimeout(removeCard, 2500);
    } else {
      const msg = (result && result.error) || 'Could not create the event.';
      btn.disabled = false;
      btn.textContent = '↺ Try again';
      if (status) { status.textContent = msg; status.classList.add('err'); }
    }
  });
}

// Compact card shown when the email asks for the reader's availability
// ("when can you play tennis?"). The actual day/time wizard lives in the popup
// — this card just surfaces the detection and opens it.
function showAvailabilityCard(availability) {
  removeCard();
  const card = document.createElement('div');
  card.id = CARD_ID;
  card.innerHTML = `
    <style>
      #gmailgenie-floating-card {
        position: fixed; bottom: 24px; right: 24px; width: 312px;
        background: #fff; border-radius: 16px;
        box-shadow: 0 12px 40px rgba(24,28,40,0.22);
        font-family: 'Google Sans', Roboto, -apple-system, Arial, sans-serif;
        font-size: 14px; color: #1f2430;
        z-index: 2147483647; border: 1px solid #eef0f4; overflow: hidden;
        animation: gg-in 0.28s cubic-bezier(0.22,1,0.36,1);
      }
      @keyframes gg-in {
        from { transform: translateY(16px); opacity: 0; }
        to   { transform: translateY(0);    opacity: 1; }
      }
      #gmailgenie-floating-card .gg-head {
        display: flex; align-items: center; justify-content: space-between;
        padding: 13px 16px; color: #fff;
        background: linear-gradient(135deg, #6a11cb 0%, #2575fc 100%);
      }
      #gmailgenie-floating-card .gg-head-title { font-size: 12.5px; font-weight: 600; }
      #gmailgenie-floating-card .gg-x {
        background: none; border: none; color: #fff; cursor: pointer;
        font-size: 15px; opacity: 0.85; padding: 0; line-height: 1;
      }
      #gmailgenie-floating-card .gg-body { padding: 14px 16px 16px; }
      #gmailgenie-floating-card .gg-text { font-size: 13px; color: #4b5160; line-height: 1.5; }
      #gmailgenie-floating-card .gg-btn {
        display: block; width: 100%; margin-top: 12px; padding: 11px;
        background: linear-gradient(135deg, #6a11cb 0%, #2575fc 100%);
        color: #fff; border: none; border-radius: 11px;
        font-size: 13.5px; font-weight: 600; cursor: pointer; font-family: inherit;
        box-shadow: 0 6px 16px rgba(37,117,252,0.28);
      }
    </style>
    <div class="gg-head">
      <span class="gg-head-title">&#128337; Availability request detected</span>
      <button class="gg-x" id="gg-close">&#10005;</button>
    </div>
    <div class="gg-body">
      <div class="gg-text">${esc(availability.requester_name || 'The sender')} asked when you can <b>${esc(availability.activity)}</b>. GmailGenie can check your calendar and suggest a time.</div>
      <button class="gg-btn" id="gg-pick-time">Pick a time</button>
    </div>
  `;
  document.body.appendChild(card);
  document.getElementById('gg-close').addEventListener('click', removeCard);
  document.getElementById('gg-pick-time').addEventListener('click', () => {
    // autoStart: the click already expressed intent — the popup should open
    // straight into the day choices, not show another "Find a time" button.
    safeSendMessage({ type: 'OPEN_EDITOR', autoStart: true });
    removeCard();
  });
}

// Watch storage — show or remove card based on current mode
chrome.storage.onChanged.addListener((_, area) => {
  if (area !== 'local') return;
  chrome.storage.local.get(['status', 'events', 'availability', 'notificationMode', 'availabilityEnabled'], (data) => {
    if (data.status === 'done' && data.notificationMode === 'card') {
      if (data.events?.length) {
        showEventCard(data.events);          // events card wins when both exist
      } else if (data.availability && data.availabilityEnabled !== false) {
        // Availability scheduler can be switched off in Settings.
        showAvailabilityCard(data.availability);
      }
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
