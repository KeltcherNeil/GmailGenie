// popup.js — Reads from chrome.storage and renders the appropriate UI state

let currentState = {};

const mainContent    = document.getElementById('main-content');
const settingsPanel  = document.getElementById('settings-panel');
const settingsBtn    = document.getElementById('settings-btn');
const saveKeyBtn     = document.getElementById('save-key-btn');
const cancelBtn      = document.getElementById('cancel-settings-btn');
const apiKeyInput    = document.getElementById('api-key-input');

// ── Initialise ──────────────────────────────────────────────────────────────

async function init() {
  const data = await chrome.storage.local.get([
    'status', 'event', 'error', 'apiKey', 'emailData', 'notificationMode'
  ]);
  currentState = data;
  render(data);

  // Mask the stored key in the settings input
  if (data.apiKey) {
    apiKeyInput.value = '••••••••••••••••••••••';
    apiKeyInput.placeholder = 'Enter new key to replace';
  }

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
  const { status, event, error, apiKey } = data;

  if (!apiKey || status === 'no_api_key') {
    renderSetup();
    return;
  }

  switch (status) {
    case 'processing': renderProcessing(); break;
    case 'done':
      event && event.event_found ? renderEvent(event) : renderNoEvent('done');
      break;
    case 'error':   renderError(error);   break;
    case 'idle':    renderIdle();          break;
    default:        renderIdle();
  }
}

// ── Views ────────────────────────────────────────────────────────────────────

function renderSetup() {
  mainContent.innerHTML = `
    <div class="setup-view">
      <p>Add your <strong>Anthropic API key</strong> to start detecting scheduling info in Gmail.</p>
      <div class="form-group">
        <label for="setup-key-input">Anthropic API Key</label>
        <input type="password" id="setup-key-input" placeholder="sk-ant-..." autocomplete="off" />
        <p class="hint">Stored locally in your browser. Never sent anywhere except api.anthropic.com.</p>
      </div>
      <button id="setup-save-btn" class="btn primary full-width">Save &amp; Start</button>
    </div>
  `;

  document.getElementById('setup-save-btn').addEventListener('click', async () => {
    const key = document.getElementById('setup-key-input').value.trim();
    if (key) await saveApiKey(key);
  });

  document.getElementById('setup-key-input').addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      const key = e.target.value.trim();
      if (key) await saveApiKey(key);
    }
  });
}

function renderProcessing() {
  mainContent.innerHTML = `
    <div class="processing-view">
      <div class="spinner"></div>
      <p>Analyzing email for scheduling info…</p>
    </div>
  `;
}

function renderEvent(event) {
  const conf   = event.confidence || 'medium';
  const confLabel = conf.charAt(0).toUpperCase() + conf.slice(1) + ' confidence';

  const dateStr     = formatDate(event.date);
  const timeStr     = formatTime(event.time);
  const durationStr = formatDuration(event.duration_minutes);

  const dateTime = [dateStr, timeStr].filter(Boolean).join(' · ');

  mainContent.innerHTML = `
    <div class="event-view">
      <div class="event-title">${esc(event.title || 'Untitled Event')}</div>
      <span class="confidence-badge confidence-${conf}">${confLabel}</span>

      <div class="event-details">
        ${dateTime ? `
          <div class="detail-row">
            <span class="detail-icon">&#128197;</span>
            <span class="detail-value">${esc(dateTime)}</span>
          </div>` : ''}
        ${durationStr ? `
          <div class="detail-row">
            <span class="detail-icon">&#9200;</span>
            <span class="detail-value">${esc(durationStr)}</span>
          </div>` : ''}
        ${event.location ? `
          <div class="detail-row">
            <span class="detail-icon">&#128205;</span>
            <span class="detail-value">${esc(event.location)}</span>
          </div>` : ''}
        ${event.description ? `
          <div class="detail-row">
            <span class="detail-icon">&#128203;</span>
            <span class="detail-value">${esc(event.description)}</span>
          </div>` : ''}
      </div>

      <button id="add-cal-btn" class="btn green full-width">
        &#10133; Add to Google Calendar
      </button>
      <button id="dismiss-btn" class="dismiss-link">Not an event? Dismiss</button>
    </div>
  `;

  document.getElementById('add-cal-btn').addEventListener('click', () => {
    openGoogleCalendar(event);
  });

  document.getElementById('dismiss-btn').addEventListener('click', async () => {
    await chrome.storage.local.set({ status: 'idle', event: null });
    renderIdle();
  });
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

settingsBtn.addEventListener('click', () => {
  settingsPanel.classList.toggle('hidden');
});

cancelBtn.addEventListener('click', () => {
  settingsPanel.classList.add('hidden');
});

saveKeyBtn.addEventListener('click', async () => {
  const val = apiKeyInput.value.trim();
  // Ignore if the user hasn't typed anything (still showing masked dots)
  if (!val || val.startsWith('•')) return;
  await saveApiKey(val);
  settingsPanel.classList.add('hidden');
});

apiKeyInput.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    const val = e.target.value.trim();
    if (!val || val.startsWith('•')) return;
    await saveApiKey(val);
    settingsPanel.classList.add('hidden');
  }
});

async function saveApiKey(key) {
  await chrome.storage.local.set({ apiKey: key });
  apiKeyInput.value = '••••••••••••••••••••••';
  await init();
}

// Save notification mode preference immediately on change
document.querySelectorAll('input[name="notif-mode"]').forEach(radio => {
  radio.addEventListener('change', (e) => {
    chrome.storage.local.set({ notificationMode: e.target.value });
  });
});

// ── Google Calendar deeplink ─────────────────────────────────────────────────

function openGoogleCalendar(event) {
  let dateParam = '';

  if (event.date) {
    const start = toGCalDatetime(event.date, event.time);
    let end;
    if (event.time && event.duration_minutes) {
      end = shiftDatetime(start, event.duration_minutes);
    } else if (event.time) {
      end = shiftDatetime(start, 60); // default 1 hour
    } else {
      // All-day: end = next calendar day
      end = nextDay(event.date);
    }
    dateParam = `${start}/${end}`;
  }

  const params = new URLSearchParams({ action: 'TEMPLATE' });
  params.set('text', event.title || 'Event from GmailGenie');
  if (dateParam)       params.set('dates',    dateParam);
  if (event.location)  params.set('location', event.location);
  if (event.description) params.set('details', event.description);

  chrome.tabs.create({
    url: `https://calendar.google.com/calendar/render?${params.toString()}`
  });
}

// "2024-03-15", "14:00" → "20240315T140000"
function toGCalDatetime(dateStr, timeStr) {
  const d = dateStr.replace(/-/g, '');
  if (!timeStr) return d;
  const t = timeStr.replace(':', '') + '00';
  return `${d}T${t}`;
}

// "20240315T140000" + 90 → "20240315T153000"
function shiftDatetime(dt, minutes) {
  const hasTime = dt.includes('T');
  if (!hasTime) return dt;
  const yr  = +dt.slice(0, 4);
  const mo  = +dt.slice(4, 6) - 1;
  const dy  = +dt.slice(6, 8);
  const hr  = +dt.slice(9, 11);
  const mn  = +dt.slice(11, 13);
  const d   = new Date(yr, mo, dy, hr, mn + minutes);
  const p   = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}00`;
}

// "2024-03-15" → "20240316" (next day, for all-day events)
function nextDay(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + 1);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
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
