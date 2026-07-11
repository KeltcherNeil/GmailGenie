// popup.js — Reads from chrome.storage and renders the appropriate UI state

let currentState = {};

const mainContent    = document.getElementById('main-content');
const settingsPanel  = document.getElementById('settings-panel');
const settingsBtn    = document.getElementById('settings-btn');

// ── Initialise ──────────────────────────────────────────────────────────────

async function init() {
  const data = await chrome.storage.local.get([
    'status', 'events', 'availability', 'error', 'emailData', 'notificationMode',
    'processingStartedAt', 'availabilityEnabled', 'wizardAutoStart', 'billing'
  ]);
  currentState = data;
  render(data);

  // Refresh premium/quota state in the background on every open — cheap, and
  // it's how the popup notices a just-completed Stripe checkout. The result
  // lands in storage, so onChanged re-renders if anything changed.
  chrome.runtime.sendMessage({ type: 'BILLING_REFRESH' }, () => {
    void chrome.runtime.lastError;
  });

  // Arrived via the floating card's "Pick a time"? Skip the wizard intro and
  // check the calendar right away. The flag is single-use and expires so a
  // stale one can't hijack a later, unrelated popup open.
  if (data.wizardAutoStart) {
    chrome.storage.local.remove('wizardAutoStart');
    const availability = (data.availabilityEnabled !== false) ? data.availability : null;
    if (availability && data.status === 'done' &&
        Date.now() - data.wizardAutoStart < 30000 && wiz.step === 'intro') {
      startWizardSearch(availability);
    }
  }

  // Set the saved notification mode radio
  const savedMode = data.notificationMode || 'none';
  const activeRadio = document.querySelector(`input[name="notif-mode"][value="${savedMode}"]`);
  if (activeRadio) activeRadio.checked = true;

  // Availability scheduler toggle (default: on). Changing it writes storage,
  // which re-renders via storage.onChanged — the wizard appears/disappears
  // immediately, no rescan needed.
  const availToggle = document.getElementById('avail-toggle');
  availToggle.checked = data.availabilityEnabled !== false;
  availToggle.addEventListener('change', (e) => {
    chrome.storage.local.set({ availabilityEnabled: e.target.checked });
  });

  // "Manage subscription" (settings) — premium users only.
  refreshSubscriptionRow(data.billing);
  document.getElementById('manage-sub-btn').addEventListener('click', async () => {
    let result;
    try {
      result = await chrome.runtime.sendMessage({ type: 'BILLING_PORTAL' });
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    if (!result || !result.ok) {
      showActionError(document.getElementById('manage-sub-btn'),
        (result && result.error) || 'Could not open the billing portal.');
    }
  });

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
  if (changes.billing) refreshSubscriptionRow(merged.billing);
});

// Show the settings' "Manage subscription" row only for premium users.
function refreshSubscriptionRow(billing) {
  document.getElementById('subscription-group')
    ?.classList.toggle('hidden', !billing?.premium);
}

// ── Routing ─────────────────────────────────────────────────────────────────

function render(data) {
  const { status, events, error } = data;
  // The availability wizard can be switched off in Settings (default: on).
  const availability = (data.availabilityEnabled !== false) ? data.availability : null;

  switch (status) {
    case 'processing': renderProcessing(); break;
    case 'done':
      if ((events && events.length) || availability) {
        renderResults(events || [], availability || null);
      } else {
        renderNoEvent('done');
      }
      break;
    case 'quota_exceeded': renderQuotaExceeded(data.billing); break;
    case 'auth_required': renderAuthRequired(); break;
    case 'error':   renderError(error);   break;
    case 'idle':    renderIdle();          break;
    default:        renderIdle();
  }
}

// ── Views ────────────────────────────────────────────────────────────────────

// A "processing" state older than this is a dead job: the service worker was
// killed mid-extraction (extension reloaded / files changed on disk) and left
// storage frozen. The popup must recover on its own — nothing else will.
const PROCESSING_STALL_MS = 15000;

let stallTimer = null;

function renderProcessing() {
  resetWizard(); // a new email is being scanned — drop any half-finished wizard

  // If this job already stalled (popup opened long after the worker died),
  // don't show a hopeless spinner — retry immediately with the stored email.
  const startedAt = currentState.processingStartedAt;
  const age = startedAt ? Date.now() - startedAt : 0;
  if (age > PROCESSING_STALL_MS && currentState.emailData) {
    retryExtraction();
    // fall through and render the spinner while the retried job runs
  }

  mainContent.innerHTML = `
    <div class="processing-view">
      <div class="spinner"></div>
      <p>Analyzing email for scheduling info…</p>
      <button id="stall-rescan-btn" class="btn secondary hidden">&#8635; Taking too long — rescan</button>
      <p id="stall-hint" class="sub hidden">If you just reloaded the extension, also refresh the Gmail tab.</p>
    </div>
  `;

  // Reveal a manual escape hatch if this job is still running when it hits
  // the stall threshold (re-rendering resets the timer, so a fresh job that
  // replaces this one starts its own countdown).
  clearTimeout(stallTimer);
  const wait = Math.max(1000, PROCESSING_STALL_MS - age);
  stallTimer = setTimeout(() => {
    document.getElementById('stall-rescan-btn')?.classList.remove('hidden');
    document.getElementById('stall-hint')?.classList.remove('hidden');
    document.getElementById('stall-rescan-btn')?.addEventListener('click', retryExtraction);
  }, wait);
}

// Re-run extraction on the email stored by the last scan. Talks straight to
// the service worker, so it works even when the Gmail tab's content script is
// dead (the usual cause of a stuck spinner).
function retryExtraction() {
  if (currentState.emailData) {
    chrome.runtime.sendMessage({ type: 'EMAIL_OPENED', payload: currentState.emailData });
  } else {
    renderIdle(); // nothing stored to retry — offer the manual scan button
  }
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

// Render everything the scan found: the availability wizard (when the email
// asks "when are you free?") above the stacked list of editable event cards,
// each with its own "Add to Calendar" button.
function renderResults(events, availability) {
  const count = events.length;
  const heading = count === 1 ? '1 event detected' : `${count} events detected`;

  const wizardHTML = availability ? buildWizard(availability) : '';
  const eventsHTML = count ? `
      <div class="events-header">${heading}</div>
      <div class="events-list">${events.map((event, i) => buildEventCard(event, i)).join('')}</div>
  ` : '';

  mainContent.innerHTML = `<div class="event-view">${wizardHTML}${eventsHTML}${quotaFooterHTML(currentState.billing)}</div>`;

  if (availability) wireWizard(availability);
  events.forEach((event, i) => wireEventCard(event, i));
  wireUpgradeButton(document.getElementById('quota-upgrade-link'));
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
  const data = await chrome.storage.local.get(['events', 'availability']);
  const events = Array.isArray(data.events) ? data.events.slice() : [];
  events.splice(i, 1);

  if (events.length || data.availability) {
    await chrome.storage.local.set({ events });
    currentState.events = events;
    renderResults(events, data.availability || null);
  } else {
    await chrome.storage.local.set({ status: 'idle', events: null });
    renderIdle();
  }
}

// ── Availability wizard ──────────────────────────────────────────────────────
// Shown when the email asks the READER for a time ("when can you play
// tennis?"). Three steps, all driven by the user's real calendar so a booked
// day/part-of-day is never offered:
//   1. pick a day  (next 3 days with free time — fully booked days not shown)
//   2. pick a part of day (morning / midday / evening; booked ones disabled)
//   3. recommendation — exact slot + drafted reply. "Add to Calendar" creates
//      the event; "Reply in Gmail" opens a prefilled compose (user hits Send).
//
// Wizard state lives here (not in chrome.storage) so storage-driven re-renders
// don't lose the user's place. It resets when a new email is scanned.

let wiz = { step: 'intro' };

function resetWizard() {
  wiz = { step: 'intro' };
}

const BUCKET_META = {
  morning: { label: 'Morning', hours: '8–12',  icon: '&#127749;' },
  midday:  { label: 'Midday',  hours: '12–5',  icon: '&#9728;&#65039;' },
  evening: { label: 'Evening', hours: '5–9',   icon: '&#127769;' },
};

function activityLabel(availability) {
  return availability.activity || 'meet up';
}

// Which slot to star on the time-picker step: the one closest to the time the
// email asked for (ties → earlier), else the earliest. Mirrors the backend's
// pick_slot rule so the star matches what auto-pick would have chosen.
function suggestedSlot(slots, preferredTime) {
  if (!slots.length) return null;
  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  if (!preferredTime || isNaN(toMin(preferredTime))) return slots[0];
  const target = toMin(preferredTime);
  return slots.reduce((best, s) =>
    Math.abs(toMin(s) - target) < Math.abs(toMin(best) - target) ? s : best, slots[0]);
}

// "play tennis" (+ requester) → calendar event title "Play tennis with Sam".
function wizardEventTitle(availability) {
  const activity = activityLabel(availability);
  const title = activity.charAt(0).toUpperCase() + activity.slice(1);
  return availability.requester_name ? `${title} with ${availability.requester_name}` : title;
}

function buildWizard(availability) {
  const who = availability.requester_name || 'The sender';
  let body;

  switch (wiz.step) {
    case 'loading':
      body = `
        <div class="wiz-loading"><div class="spinner spinner-sm"></div><span>${esc(wiz.loadingText || 'Working…')}</span></div>
      `;
      break;

    case 'day': {
      // Days the email asked for lead the list with an "asked for" badge; when
      // an asked-for day is fully booked, say so instead of silently hiding it.
      const chips = wiz.days.map((d, i) =>
        `<button class="chip" data-day="${i}">
           <span>${esc(d.label)}</span>
           ${d.preferred ? '<span class="chip-pref">They asked</span>' : ''}
         </button>`).join('');
      const booked = (wiz.unavailablePreferred || []).map((d) => esc(d.label)).join(' and ');
      const notice = booked
        ? `<p class="wiz-notice">&#9888;&#65039; You're fully booked on ${booked} — here are alternatives.</p>`
        : '';
      body = `
        <p class="wiz-question">Which day works for you?</p>
        ${notice}
        <div class="chip-col">${chips}</div>
        <p class="wiz-hint">Only days with free time on your calendar are shown.</p>
      `;
      break;
    }

    case 'bucket': {
      const day = wiz.days[wiz.dayIdx];
      const askedBucket = availability.preferred_time_of_day || null;
      const chips = Object.keys(BUCKET_META).map((key) => {
        const meta = BUCKET_META[key];
        const free = day.buckets[key];
        const badge = !free ? '<span class="chip-booked">Booked</span>'
          : (key === askedBucket ? '<span class="chip-pref">They asked</span>' : '');
        return `<button class="chip chip-bucket" data-bucket="${key}" ${free ? '' : 'disabled'}>
                  <span>${meta.icon} ${meta.label} <span class="chip-sub">${meta.hours}</span></span>
                  ${badge}
                </button>`;
      }).join('');
      // The email asked for a specific time and the calendar has a conflict
      // there — say so up front, before the user even picks a bucket.
      const conflict = (day.asked_time_free === false && availability.preferred_time)
        ? `<p class="wiz-notice">&#9888;&#65039; They asked for ${esc(formatTime(availability.preferred_time))},
             but you have a conflict then — GmailGenie will suggest the closest free time.</p>`
        : '';
      body = `
        <p class="wiz-question">What time of day on ${esc(day.label)}?</p>
        ${conflict}
        <div class="chip-col">${chips}</div>
        <button class="wiz-back" data-back="day">&#8592; Different day</button>
      `;
      break;
    }

    case 'time': {
      // The bucket's WHOLE time grid: free slots are green and pickable, busy
      // slots are red and disabled, the suggested free slot (closest to the
      // asked time, else earliest) is starred.
      const day = wiz.days[wiz.dayIdx];
      const slots = ((day.slots && day.slots[wiz.bucket]) || [])
        // Tolerate an older backend that sent only the free times as strings.
        .map((s) => (typeof s === 'string' ? { time: s, free: true } : s));
      const freeTimes = slots.filter((s) => s.free).map((s) => s.time);
      const suggested = suggestedSlot(freeTimes, availability.preferred_time);
      const chips = slots.map((s) => {
        if (!s.free) {
          return `<button class="chip chip-time chip-conflict" disabled title="You have a conflict">
                    ${esc(formatTime(s.time))}
                  </button>`;
        }
        return `<button class="chip chip-time chip-free ${s.time === suggested ? 'chip-suggested' : ''}" data-time="${s.time}">
                  ${s.time === suggested ? '&#9733; ' : ''}${esc(formatTime(s.time))}
                </button>`;
      }).join('');
      body = `
        <p class="wiz-question">Pick a time — ${esc(day.label)}, ${esc(BUCKET_META[wiz.bucket].label.toLowerCase())}</p>
        <div class="chip-grid">${chips}</div>
        <p class="wiz-hint"><span class="dot dot-free"></span> free &middot;
          <span class="dot dot-conflict"></span> conflict &middot;
          &#9733; = suggested</p>
        <button class="wiz-back" data-back="bucket">&#8592; Different time of day</button>
      `;
      break;
    }

    case 'rec': {
      const rec = wiz.rec;
      const when = `${formatDate(rec.date)} · ${formatTime(rec.start_time)}–${formatTime(rec.end_time)}`;
      // The asked-for time was busy → explain why the proposal differs.
      // Worded differently when the user hand-picked the time themselves.
      const shifted = (rec.asked_time_free === false && rec.asked_time)
        ? (wiz.chosenTime
            ? `<p class="wiz-notice">&#9888;&#65039; Heads up: they asked for ${esc(formatTime(rec.asked_time))},
                 but you're busy then.</p>`
            : `<p class="wiz-notice">&#9888;&#65039; You're busy at ${esc(formatTime(rec.asked_time))},
                 so this is the closest time you're free.</p>`)
        : '';
      body = `
        ${shifted}
        <div class="wiz-rec">
          <div class="wiz-rec-when">${ICON.clock} ${esc(when)}</div>
          <div class="wiz-rec-title">${esc(wizardEventTitle(wiz.availability))}</div>
        </div>
        <label class="field">
          <span class="field-label">${ICON.description} Reply draft</span>
          <textarea id="wiz-reply" class="field-input" rows="5">${esc(rec.reply_body)}</textarea>
        </label>
        <button id="wiz-add-cal" class="btn cal full-width">${ICON.calendar} Add to Calendar</button>
        <button id="wiz-reply-btn" class="btn secondary full-width wiz-reply-btn">&#9993;&#65039; Reply in Gmail</button>
        <button class="wiz-back" data-back="${wiz.days?.[wiz.dayIdx]?.slots ? 'time' : 'bucket'}">&#8592; Different time</button>
      `;
      break;
    }

    case 'error':
      body = `
        <p class="wiz-error">${esc(wiz.error)}</p>
        <button class="wiz-back" data-back="intro">&#8592; Start over</button>
      `;
      break;

    case 'nodays':
      body = `
        <p class="wiz-error">Your calendar looks fully booked for the next two weeks — no free times to suggest.</p>
      `;
      break;

    case 'intro':
    default:
      body = `
        <p class="wiz-text"><b>${esc(who)}</b> asked when you can <b>${esc(activityLabel(availability))}</b>.</p>
        <button id="wiz-start" class="btn primary full-width">&#128197; Find a time</button>
        <p class="wiz-hint">GmailGenie checks your calendar and only suggests times you're actually free.</p>
      `;
  }

  return `
    <section class="wiz-block">
      <div class="events-header">Availability request</div>
      ${body}
    </section>
  `;
}

function rerenderWizard() {
  const availability = (currentState.availabilityEnabled !== false)
    ? currentState.availability : null;
  renderResults(currentState.events || [], availability || null);
}

function wizardFail(msg) {
  wiz.step = 'error';
  wiz.error = msg || 'Something went wrong. Please try again.';
  rerenderWizard();
}

// Read the calendar and show the day choices. Triggered by the intro's
// "Find a time" button, or immediately on popup open when the user arrived
// via the floating card's "Pick a time" (wizardAutoStart flag).
async function startWizardSearch(availability) {
  wiz.availability = availability;
  wiz.step = 'loading';
  wiz.loadingText = 'Checking your calendar…';
  rerenderWizard();
  let result;
  try {
    result = await chrome.runtime.sendMessage({
      type: 'AVAILABILITY_OPTIONS',
      durationMinutes: availability.duration_minutes || 60,
      preferredDates: availability.preferred_dates || [],
      preferredTime: availability.preferred_time || '',
    });
  } catch (err) {
    result = { ok: false, error: err.message };
  }
  if (!result || !result.ok) return wizardFail(result && result.error);
  if (!result.days.length) { wiz.step = 'nodays'; return rerenderWizard(); }
  wiz.days = result.days;
  wiz.busy = result.busy;
  wiz.unavailablePreferred = result.unavailablePreferred || [];
  wiz.step = 'day';
  rerenderWizard();
}

function wireWizard(availability) {
  wiz.availability = availability;
  const block = mainContent.querySelector('.wiz-block');
  if (!block) return;

  // Step 0 → fetch day options (reads the calendar; may show Google consent once).
  block.querySelector('#wiz-start')?.addEventListener('click', () => startWizardSearch(availability));

  // Step 1 → day chosen.
  block.querySelectorAll('.chip[data-day]').forEach((chip) => {
    chip.addEventListener('click', () => {
      wiz.dayIdx = Number(chip.dataset.day);
      wiz.step = 'bucket';
      rerenderWizard();
    });
  });

  // Fetch the slot confirmation + drafted reply for the chosen day/bucket/time.
  const requestRecommendation = async (chosenTime) => {
    wiz.chosenTime = chosenTime || null;
    wiz.step = 'loading';
    wiz.loadingText = 'Drafting your reply…';
    rerenderWizard();
    let result;
    try {
      result = await chrome.runtime.sendMessage({
        type: 'AVAILABILITY_RECOMMEND',
        payload: {
          busy: wiz.busy,
          date: wiz.days[wiz.dayIdx].date,
          bucket: wiz.bucket,
          chosen_time: chosenTime || '',
          duration_minutes: availability.duration_minutes || 60,
          activity: activityLabel(availability),
          requester_name: availability.requester_name || '',
          sender: currentState.emailData?.sender || '',
          subject: currentState.emailData?.subject || '',
          // What the email asked about — lets the recommendation stick
          // close to the asked time and the drafted reply acknowledge
          // when the proposal differs from it.
          preferred_dates: availability.preferred_dates || [],
          preferred_time: availability.preferred_time || '',
        },
      });
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    if (!result || !result.ok) return wizardFail(result && result.error);
    wiz.rec = result;
    wiz.step = 'rec';
    rerenderWizard();
  };

  // Step 2 → part of day chosen → show that bucket's individual free times.
  // (Older options responses have no slots list — recommend directly then.)
  block.querySelectorAll('.chip[data-bucket]').forEach((chip) => {
    chip.addEventListener('click', () => {
      wiz.bucket = chip.dataset.bucket;
      if (wiz.days[wiz.dayIdx].slots) {
        wiz.step = 'time';
        rerenderWizard();
      } else {
        requestRecommendation(null);
      }
    });
  });

  // Step 3 → exact time chosen.
  block.querySelectorAll('.chip[data-time]').forEach((chip) => {
    chip.addEventListener('click', () => requestRecommendation(chip.dataset.time));
  });

  // Step 3 → create the calendar event for the recommended slot.
  block.querySelector('#wiz-add-cal')?.addEventListener('click', () => {
    const rec = wiz.rec;
    createEvent({
      title: wizardEventTitle(availability),
      date: rec.date,
      time: rec.start_time,
      duration_minutes: rec.duration_minutes,
      location: null,
      description: null,
    }, block.querySelector('#wiz-add-cal'));
  });

  // Step 3 → open a prefilled Gmail compose with the (possibly edited) draft.
  // Nothing is sent until the user hits Send themselves.
  block.querySelector('#wiz-reply-btn')?.addEventListener('click', () => {
    const rec = wiz.rec;
    const body = block.querySelector('#wiz-reply')?.value || rec.reply_body;
    const params = new URLSearchParams({
      view: 'cm', fs: '1',
      to: currentState.emailData?.sender || '',
      su: rec.reply_subject,
      body,
    });
    chrome.tabs.create({ url: `https://mail.google.com/mail/?${params}` });
  });

  // Back links.
  block.querySelectorAll('.wiz-back').forEach((btn) => {
    btn.addEventListener('click', () => {
      wiz.step = btn.dataset.back;
      rerenderWizard();
    });
  });
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

// ── Freemium views ────────────────────────────────────────────────────────────

function scansLeft(billing) {
  if (!billing) return null;
  return Math.max(0, (billing.limit || 0) - (billing.used || 0));
}

// "Resets Monday"-style label from the backend's resets_at ISO stamp.
function resetsLabel(billing) {
  try {
    const d = new Date(billing.resets_at);
    return d.toLocaleDateString('en-US', { weekday: 'long' });
  } catch { return 'Monday'; }
}

function wireUpgradeButton(el) {
  el?.addEventListener('click', async () => {
    el.disabled = true;
    let result;
    try {
      result = await chrome.runtime.sendMessage({ type: 'BILLING_CHECKOUT' });
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    el.disabled = false;
    if (!result || !result.ok) {
      showActionError(el, (result && result.error) || 'Could not start checkout.');
    }
  });
}

// Weekly free quota exhausted — scanning resumes Monday (or with Premium).
function renderQuotaExceeded(billing) {
  mainContent.innerHTML = `
    <div class="empty-view">
      <div class="empty-icon">&#9203;</div>
      <p>You've used all ${billing?.limit ?? 10} free scans for this week.</p>
      <p class="sub">Free scans reset ${resetsLabel(billing)}.</p>
      ${billing?.upgrade_available ? `
        <button id="upgrade-btn" class="btn primary scan-btn">&#11088; Upgrade — $2.99/mo &middot; unlimited scans</button>
        <p class="sub">Unlimited scans, cancel anytime.</p>
      ` : ''}
    </div>
  `;
  wireUpgradeButton(document.getElementById('upgrade-btn'));
}

// Small footer meter under results for free users ("7 of 10 left · Upgrade").
function quotaFooterHTML(billing) {
  if (!billing || billing.premium || !billing.metered) return '';
  const left = scansLeft(billing);
  const upgrade = billing.upgrade_available
    ? ' &middot; <button id="quota-upgrade-link" class="linklike">Upgrade</button>' : '';
  return `<p class="quota-footer">${left} of ${billing.limit} free scans left this week${upgrade}</p>`;
}

function renderNoEvent(reason) {
  mainContent.innerHTML = `
    <div class="empty-view">
      <div class="empty-icon">&#128203;</div>
      <p>No scheduling information found in this email.</p>
      <p class="sub">Open an email that mentions a meeting, appointment, or event.</p>
      <button id="copy-debug-btn" class="dismiss-link">Missed something? Copy scan details</button>
      ${quotaFooterHTML(currentState.billing)}
    </div>
  `;
  wireUpgradeButton(document.getElementById('quota-upgrade-link'));

  // Copies exactly what was scanned (subject/sender/body as sent to the
  // backend) so a missed detection can be reproduced instead of guessed at.
  document.getElementById('copy-debug-btn').addEventListener('click', async (e) => {
    const { subject = '', sender = '', body = '' } = currentState.emailData || {};
    try {
      await navigator.clipboard.writeText(JSON.stringify({ subject, sender, body }, null, 2));
      e.target.textContent = 'Copied ✓ — paste it when reporting the miss';
    } catch {
      e.target.textContent = 'Could not copy';
    }
  });
}

// Shown when the backend requires a signed-in Google user (production) and the
// user hasn't connected yet. Connecting also grants the Calendar scope used later.
function renderAuthRequired() {
  mainContent.innerHTML = `
    <div class="empty-view">
      <div class="empty-icon">&#128273;</div>
      <p>Connect your Google account to let GmailGenie scan this email and add events to your calendar.</p>
      <button id="connect-google-btn" class="btn primary">Connect Google Account</button>
      <p class="sub">You only need to do this once. GmailGenie uses your account solely to read the open email and create events you approve.</p>
    </div>
  `;

  document.getElementById('connect-google-btn').addEventListener('click', async () => {
    renderProcessing();
    let result;
    try {
      result = await chrome.runtime.sendMessage({ type: 'CONNECT_GOOGLE' });
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    // On success the background re-scans and updates status → storage.onChanged
    // re-renders. On failure, fall back to the connect prompt.
    if (!result || !result.ok) {
      renderAuthRequired();
      if (result && result.error) showActionError(document.getElementById('connect-google-btn'), result.error);
    }
  });
}

function renderIdle() {
  resetWizard();
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
    chrome.tabs.sendMessage(tab.id, { type: 'SCAN_NOW' }, async () => {
      if (!chrome.runtime.lastError) return;
      // No content script in the tab (e.g. Gmail was already open when the
      // extension was installed). Inject it now and ask again, instead of
      // leaving the user staring at a spinner that can never finish.
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js']
        });
        chrome.tabs.sendMessage(tab.id, { type: 'SCAN_NOW' }, () => {
          void chrome.runtime.lastError;
        });
      } catch {
        renderError('Open a Gmail tab (mail.google.com), then try scanning again.');
      }
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
