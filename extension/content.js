// content.js — Reads Gmail DOM and sends email data to background.js

let lastEmailHash = null;
let debounceTimer = null;

// Gmail URL hash contains the thread/message ID when viewing an email
function getCurrentEmailHash() {
  const hash = window.location.hash;
  // Email view hashes: #inbox/AbCd1234, #all/..., #label/Inbox/...
  const match = hash.match(/#[^/]+\/([A-Za-z0-9]+)(?:\/|$)/);
  return match ? match[1] : null;
}

// Try multiple Gmail selectors — Gmail obfuscates class names and changes them
function getEmailContent() {
  const bodySelectors = ['.a3s.aiL', '.a3s', '.ii.gt .a3s', '.gs .a3s'];
  let bodyEl = null;
  for (const sel of bodySelectors) {
    bodyEl = document.querySelector(sel);
    if (bodyEl && bodyEl.innerText.trim().length > 20) break;
  }

  const subjectEl = document.querySelector('h2.hP');

  if (!bodyEl || !subjectEl) return null;

  const body = bodyEl.innerText.trim();
  const subject = subjectEl.innerText.trim();
  if (!body || !subject) return null;

  // Sender: try the .gD element which has an "email" attribute
  const senderEl = document.querySelector('.gD');
  const sender = senderEl
    ? senderEl.getAttribute('email') || senderEl.innerText.trim()
    : '';

  return {
    subject,
    // Cap body at 3000 chars to keep API calls cheap
    body: body.substring(0, 3000),
    sender
  };
}

function checkForEmailChange() {
  const currentHash = getCurrentEmailHash();

  if (!currentHash) {
    // Not viewing an email — clear any stored event so popup shows idle state
    if (lastEmailHash !== null) {
      lastEmailHash = null;
      chrome.storage.local.set({
        status: 'idle',
        event: null,
        error: null,
        emailData: null
      });
    }
    return;
  }

  if (currentHash === lastEmailHash) return; // Same email, skip

  const emailData = getEmailContent();
  if (!emailData) return; // Content not in DOM yet — observer will retry

  lastEmailHash = currentHash;

  chrome.runtime.sendMessage({ type: 'EMAIL_OPENED', payload: emailData }, () => {
    if (chrome.runtime.lastError) {
      // Background service worker may have been sleeping — Chrome wakes it on
      // the next sendMessage, so this is fine to ignore silently.
    }
  });
}

// Detect Gmail SPA navigation via URL hash changes
window.addEventListener('hashchange', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(checkForEmailChange, 1200);
});

// MutationObserver catches lazy-loaded email content within the same hash
const observer = new MutationObserver(() => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(checkForEmailChange, 1200);
});

observer.observe(document.body, { childList: true, subtree: true });

// Initial check when the content script first loads
setTimeout(checkForEmailChange, 2000);
