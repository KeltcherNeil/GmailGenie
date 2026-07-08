# GmailGenie — Privacy Policy

**Effective date:** July 8, 2026

GmailGenie is a Chrome extension that detects scheduling information in the Gmail
email you are currently viewing, helps you add it to Google Calendar with one
click, and — when an email asks for your availability — suggests times you are
free and drafts a reply for you to review and send. This policy explains what data
the extension handles, where it goes, and how long it is kept.

## What data we access

- **Content of the open email.** When you open an email in Gmail, GmailGenie reads
  that message's subject, body text, and sender address from the page so it can look
  for meetings, appointments, and events. It only reads the message you are actively
  viewing — it does not read your inbox, other messages, contacts, or attachments.
- **Your Google account identity and Calendar access.** With your consent, GmailGenie
  uses Google Sign-In (OAuth) to (a) confirm you are a signed-in user of this
  extension, (b) create events on your Google Calendar when you click "Add to
  Calendar," and (c) read the **start and end times** of your upcoming calendar
  events — in your browser — so the availability feature only suggests times you
  are actually free. The requested scopes are `openid`, `email`, and
  `https://www.googleapis.com/auth/calendar.events` (create/edit and view calendar
  events).
- **Usage and subscription records.** To operate the free tier and Premium
  subscriptions, we store per-account: your email address, a weekly count of how
  many scans you have used, whether you have an active Premium subscription, and
  (for subscribers) your Stripe customer/subscription identifiers. We never see
  or store your payment card details — payments are processed entirely by
  **Stripe** (see Stripe's privacy policy: https://stripe.com/privacy).

## How your data is used and shared

- **Event detection.** The text of the open email is sent over HTTPS to the
  GmailGenie backend service (hosted on Google Cloud Run, US region), which forwards
  it to **Anthropic's Claude API** to identify event details (title, date, time,
  location) and, for availability requests, to draft the reply text you review.
  Anthropic processes the text to return that result. See Anthropic's
  privacy policy: https://www.anthropic.com/legal/privacy
- **Availability suggestions.** When you use "Find a time," your upcoming events are
  read **in your browser** via the Google Calendar API. Only **anonymous busy/free
  intervals** (start/end timestamps for the next ~2 weeks) are sent to the GmailGenie
  backend to compute which days and times to offer — **never event titles,
  descriptions, locations, or attendees**.
- **Calendar event creation.** When you approve an event, it is sent **directly from
  your browser to the Google Calendar API** using your own OAuth token. It does not
  pass through the GmailGenie backend.
- **Sending replies.** GmailGenie never sends email on your behalf. The drafted reply
  opens in a Gmail compose window for you to edit and send yourself.
- **We do not** sell your data, use it for advertising, or use it to build user
  profiles. There are no third-party analytics or trackers in the extension.

## Data retention

- **Server side:** The GmailGenie backend processes email text and busy/free
  intervals in memory to fulfill a single request and **does not store or log the
  content of your emails or your calendar data**. Nothing about the message or your
  schedule is persisted after the response is returned. The only per-account data
  kept is the usage/subscription record above (email, weekly scan count,
  subscription status), which is deleted on request.
- **On your device:** Detected events and your extension settings are stored locally
  in the browser (`chrome.storage.local`) so the popup can display them. This data
  stays on your device and is cleared when you navigate away, dismiss it, or remove
  the extension.
- **Google token:** Your OAuth token is managed and cached by Chrome (`chrome.identity`)
  and refreshed automatically; GmailGenie does not store it separately.

## Your choices

- You can decline or revoke Google access at any time at
  https://myaccount.google.com/permissions — extraction and calendar creation stop
  working until you reconnect.
- Uninstalling the extension removes all locally stored data.

## Data we do NOT collect

Passwords, other Gmail messages, contacts, browsing history, or payment information.

## Changes to this policy

We may update this policy; the "Effective date" above will change accordingly.
Material changes will be reflected in the extension's store listing.

