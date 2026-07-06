// popup.js — Reads from chrome.storage and renders the appropriate UI state

let currentState = {};

const mainContent    = document.getElementById('main-content');
const settingsPanel  = document.getElementById('settings-panel');
const settingsBtn    = document.getElementById('settings-btn');

// ── Initialise ──────────────────────────────────────────────────────────────

async function init() {
  const data = await chrome.storage.local.get([
    'status', 'events', 'error', 'emailData', 'notificationMode'
  ]);
  currentState = data;
  render(data);

  // Set the saved notification mode radio
  const savedMode = data.notificationMode || 'none';
  const activeRadio = document.querySelector(`input[name="notif-mode"][value="${savedMode}"]`);
  if (activeRadio) activeRadio.checked = true;

  // Clear badge whenever the popup is opened
  chrome.action.setBadgeText({ text: '' });
}

// Live-update while the popup is open (e.g. background finishes processing)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const merged = { ...currentState };
  for (const [key, { newValue }] of Object.entries(changes)) {
    merged[key] = newValue;
  }
  currentState = merged;
  render(merged);
});

// ── Routing ─────────────────────────────────────────────────────────────────

function render(data) {
  const { status, events, error } = data;

  switch (status) {
    case 'processing': renderProcessing(); break;
    case 'done':
      (events && events.length) ? renderEvents(events) : renderNoEvent('done');
      break;
    case 'error':   renderError(error);   break;
    case 'idle':    renderIdle();          break;
    default:        renderIdle();
  }
}

// ── Views ────────────────────────────────────────────────────────────────────

function renderProcessing() {
  mainContent.innerHTML = `
    <div class="processing-view">
      <div class="spinner"></div>
      <p>Analyzing email for scheduling info…</p>
    </div>
  `;
}

// Inline Material Symbols (as SVG) so icons match Gmail/Calendar and need no
// remote font. currentColor lets them inherit the label colour.
const ICON = {
  calendar: '<svg class="mi" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 3h-1V1h-2v2H7V1H5v2H4c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 18H4V8h16v13z"/></svg>',
  clock: '<svg class="mi" viewBox="0 0 24 24" aria-hidden="true"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>',
  location: '<svg class="mi" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>',
  description: '<svg class="mi" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>',
  title: '<svg class="mi" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4v3h5.5v12h3V7H19V4z"/></svg>',
};

// Render every detected event as a stacked list of editable cards, each with its
// own "Add to Calendar" button so the user can add any or all of them.
function renderEvents(events) {
  const count = events.length;
  const heading = count === 1 ? '1 event detected' : `${count} events detected`;

  const cardsHTML = events.map((event, i) => buildEventCard(event, i)).join('');

  mainContent.innerHTML = `
    <div class="event-view">
      <div class="events-header">${heading}</div>
      <div class="events-list">${cardsHTML}</div>
    </div>
  `;

  events.forEach((event, i) => wireEventCard(event, i));
}

// HTML for one event card. All field ids are suffixed with the card index so the
// stacked cards don't collide.
function buildEventCard(event, i) {
  const pct   = confidencePercent(event);
  const level = confidenceLevel(pct);

  // Prefill Ends from start + duration (default 1h); show the resulting duration.
  const startVal   = event.time || '';
  const endVal     = computeEndTime(event.time, event.duration_minutes);
  const initialDur = durationFromTimes(startVal, endVal);
  const durHint    = initialDur ? 'Duration: ' + formatDuration(initialDur) : '';

  return `
    <section class="event-block" data-idx="${i}">
      <div class="confidence">
        <div class="confidence-head">
          <span class="confidence-label">Confidence</span>
          <span class="confidence-pct">${pct}%</span>
        </div>
        <div class="confidence-track">
          <div class="confidence-fill conf-${level}"></div>
        </div>
      </div>

      <form class="event-card" id="event-form-${i}" autocomplete="off">
        <label class="field">
          <span class="field-label">${ICON.title} Title</span>
          <input type="text" id="f-title-${i}" class="field-input" value="${esc(event.title || '')}" placeholder="Event title" />
        </label>

        <label class="field emph">
          <span class="field-label">${ICON.calendar} Date</span>
          <input type="date" id="f-date-${i}" class="field-input" value="${esc(event.date || '')}" />
        </label>

        <div class="field-row">
          <label class="field emph">
            <span class="field-label">${ICON.clock} Starts</span>
            <input type="time" id="f-time-${i}" class="field-input" value="${esc(startVal)}" />
          </label>
          <label class="field emph">
            <span class="field-label">${ICON.clock} Ends</span>
            <input type="time" id="f-endtime-${i}" class="field-input" value="${esc(endVal)}" />
          </label>
        </div>
        <div class="end-hint" id="end-hint-${i}">${durHint}</div>

        <label class="field">
          <span class="field-label">${ICON.location} Location</span>
          <input type="text" id="f-location-${i}" class="field-input" value="${esc(event.location || '')}" placeholder="Add location" />
        </label>

        <label class="field">
          <span class="field-label">${ICON.description} Description</span>
          <textarea id="f-desc-${i}" class="field-input" rows="2" placeholder="Add description">${esc(event.description || '')}</textarea>
        </label>
      </form>

      <button id="add-cal-btn-${i}" class="btn cal full-width">${ICON.calendar} Add to Calendar</button>
      <button id="dismiss-btn-${i}" class="dismiss-link">Not an event? Dismiss</button>
    </section>
  `;
}

// Attach behaviour to the card at index `i` after it's in the DOM.
function wireEventCard(event, i) {
  const block = mainContent.querySelector(`.event-block[data-idx="${i}"]`);
  if (!block) return;

  const pct = confidencePercent(event);

  // Animate the confidence bar from 0 → pct on the next frame so the CSS
  // width transition plays instead of snapping.
  const fill = block.querySelector('.confidence-fill');
  if (fill) requestAnimationFrame(() => { fill.style.width = pct + '%'; });

  // Live-update the "Duration: …" hint as start/end are edited.
  const startInput = document.getElementById(`f-time-${i}`);
  const endInput   = document.getElementById(`f-endtime-${i}`);
  const endHint    = document.getElementById(`end-hint-${i}`);
  const refreshDurHint = () => {
    const dur = durationFromTimes(startInput.value, endInput.value);
    endHint.textContent = dur ? 'Duration: ' + formatDuration(dur) : '';
  };
  startInput.addEventListener('input', refreshDurHint);
  endInput.addEventListener('input', refreshDurHint);

  // Build the (possibly edited) event from this card's form and create it
  // directly on Google Calendar — no calendar tab, no manual Save.
  const submit = () => {
    const start = valueOf(`f-time-${i}`)    || null;
    const end   = valueOf(`f-endtime-${i}`) || null;
    const edited = {
      title:            valueOf(`f-title-${i}`)    || 'Event',
      date:             valueOf(`f-date-${i}`)     || null,
      time:             start,
      duration_minutes: durationFromTimes(start, end) || event.duration_minutes || null,
      location:         valueOf(`f-location-${i}`) || null,
      description:      valueOf(`f-desc-${i}`)     || null,
    };
    createEvent(edited, document.getElementById(`add-cal-btn-${i}`));
  };

  document.getElementById(`add-cal-btn-${i}`).addEventListener('click', submit);
  document.getElementById(`event-form-${i}`).addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });

  document.getElementById(`dismiss-btn-${i}`).addEventListener('click', () => dismissEvent(i));
}

// Remove one card from the stored list and re-render. When the last card is
// dismissed, fall back to the empty state.
async function dismissEvent(i) {
  const data = await chrome.storage.local.get(['events']);
  const events = Array.isArray(data.events) ? data.events.slice() : [];
  events.splice(i, 1);

  if (events.length) {
    await chrome.storage.local.set({ events });
    currentState.events = events;
    renderEvents(events);
  } else {
    await chrome.storage.local.set({ status: 'idle', events: null });
    renderIdle();
  }
}

function valueOf(id) {
  const el = document.getElementById(id);
  return el ? el.value.trim() : '';
}

// Start time ("HH:MM") + duration → end time ("HH:MM"), defaulting to 1h.
function computeEndTime(time, durationMinutes) {
  if (!time) return '';
  const [h, m] = time.split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return '';
  const end = new Date(2000, 0, 1, h, m + (durationMinutes || 60));
  return `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`;
}

// Minutes between two "HH:MM" times; wraps past midnight so it's always positive.
function durationFromTimes(start, end) {
  if (!start || !end) return null;
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  if ([sh, sm, eh, em].some(isNaN)) return null;
  let d = (eh * 60 + em) - (sh * 60 + sm);
  if (d <= 0) d += 24 * 60;
  return d;
}

// Confidence as a 0–100 number. Prefer a numeric score from the model
// (confidence_score); otherwise map the categorical high/medium/low.
function confidencePercent(event) {
  const raw = event.confidence_score;
  if (typeof raw === 'number' && isFinite(raw)) {
    return Math.max(0, Math.min(100, Math.round(raw)));
  }
  const map = { high: 92, medium: 66, low: 34 };
  return map[event.confidence] ?? 66;
}

// Colour band for the bar fill.
function confidenceLevel(pct) {
  if (pct >= 80) return 'high';
  if (pct >= 50) return 'medium';
  return 'low';
}

function renderNoEvent(reason) {
  mainContent.innerHTML = `
    <div class="empty-view">
      <div class="empty-icon">&#128203;</div>
      <p>No scheduling information found in this email.</p>
      <p class="sub">Open an email that mentions a meeting, appointment, or event.</p>
    </div>
  `;
}

function renderIdle() {
  mainContent.innerHTML = `
    <div class="empty-view">
      <div class="empty-icon">&#128140;</div>
      <p>Open an email in Gmail to detect scheduling information.</p>
      <button id="scan-now-btn" class="btn secondary scan-btn">&#128269; Scan current email</button>
    </div>
  `;

  document.getElementById('scan-now-btn').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    chrome.tabs.sendMessage(tab.id, { type: 'SCAN_NOW' }, () => {
      void chrome.runtime.lastError; // silently ignore if content script not ready
    });
    renderProcessing();
  });
}

function renderError(msg) {
  mainContent.innerHTML = `
    <div class="error-view">
      <div class="error-icon">&#9888;&#65039;</div>
      <p class="error-message">${esc(msg || 'An unknown error occurred.')}</p>
      <button id="retry-btn" class="btn secondary">Retry</button>
    </div>
  `;

  document.getElementById('retry-btn').addEventListener('click', () => {
    if (currentState.emailData) {
      chrome.runtime.sendMessage({
        type: 'EMAIL_OPENED',
        payload: currentState.emailData
      });
      renderProcessing();
    } else {
      renderIdle();
    }
  });
}

// ── Settings panel ───────────────────────────────────────────────────────────

// The settings panel replaces the main view rather than stacking below it —
// otherwise the taller event form pushes it past the popup's max height, so it
// opens off-screen and looks like nothing happened.
function setSettingsOpen(open) {
  settingsPanel.classList.toggle('hidden', !open);
  mainContent.classList.toggle('hidden', open);
}

// The ⚙ button toggles the panel open/closed (it also serves as the "close"
// action now that the Cancel button is gone).
settingsBtn.addEventListener('click', () => {
  setSettingsOpen(settingsPanel.classList.contains('hidden'));
});

// Save notification mode preference immediately on change
document.querySelectorAll('input[name="notif-mode"]').forEach(radio => {
  radio.addEventListener('change', (e) => {
    chrome.storage.local.set({ notificationMode: e.target.value });
  });
});

// ── Direct calendar creation ─────────────────────────────────────────────────
// Ask the background worker to create the event on Google Calendar via the
// backend. No calendar tab opens; the button shows Creating → Added ✓ / error
// right here in the popup.

async function createEvent(event, btn) {
  if (!btn) return;

  if (!event.date) {
    setButtonState(btn, 'error', 'No date detected — edit the event first');
    return;
  }

  setButtonState(btn, 'loading', 'Creating…');

  let result;
  try {
    result = await chrome.runtime.sendMessage({ type: 'CREATE_EVENT', event });
  } catch (err) {
    result = { ok: false, error: err.message };
  }

  if (result && result.ok) {
    setButtonState(btn, 'success', 'Added to Calendar ✓');
  } else {
    const msg = (result && result.error) || 'Could not create the event.';
    setButtonState(btn, 'error', 'Failed — try again');
    showActionError(btn, msg);
  }
}

// Reflect the create request's progress on the Add-to-Calendar button.
function setButtonState(btn, state, label) {
  btn.classList.remove('is-loading', 'is-success', 'is-error');
  btn.disabled = (state === 'loading' || state === 'success');
  if (state === 'loading')  btn.classList.add('is-loading');
  if (state === 'success')  btn.classList.add('is-success');
  if (state === 'error')    btn.classList.add('is-error');
  // Keep the calendar icon only in the default/idle state.
  btn.innerHTML = (state === 'success' || state === 'loading' || state === 'error')
    ? esc(label)
    : `${ICON.calendar} ${esc(label)}`;
}

// Show a small inline error directly under the given button (e.g. backend not
// running). Scoped per-button so each card shows its own error.
function showActionError(btn, msg) {
  let box = btn.nextElementSibling;
  if (!box || !box.classList.contains('action-error')) {
    box = document.createElement('p');
    box.className = 'action-error';
    btn.insertAdjacentElement('afterend', box);
  }
  box.textContent = msg;
}

// ── Formatting helpers ───────────────────────────────────────────────────────

function formatDate(dateStr) {
  if (!dateStr) return null;
  try {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
    });
  } catch { return dateStr; }
}

function formatTime(timeStr) {
  if (!timeStr) return null;
  try {
    const [h, m] = timeStr.split(':').map(Number);
    const period = h >= 12 ? 'PM' : 'AM';
    return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${period}`;
  } catch { return timeStr; }
}

function formatDuration(mins) {
  if (!mins) return null;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Boot ─────────────────────────────────────────────────────────────────────
init();
