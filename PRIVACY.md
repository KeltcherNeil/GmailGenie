# MailGenie — Privacy Policy

**Effective date:** July 16, 2026

MailGenie is a Chrome extension that detects scheduling information in the Gmail
email you are currently viewing, helps you add it to Google Calendar with one
click, and — when an email asks for your availability — suggests times you are
free and drafts a reply for you to review and send. This policy explains what data
the extension handles, where it goes, and how long it is kept.

## What data we access

- **Content of the open email.** When you open an email in Gmail, MailGenie reads
  that message's subject, body text, and sender address from the page so it can look
  for meetings, appointments, and events. It only reads the message you are actively
  viewing — it does not read your inbox, other messages, contacts, or attachments.
- **Your Google account identity and Calendar access.** With your consent, MailGenie
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
  MailGenie backend service (hosted on Google Cloud Run, US region), which forwards
  it to **Anthropic's Claude API** to identify event details (title, date, time,
  location) and, for availability requests, to draft the reply text you review.
  Anthropic processes the text to return that result. See Anthropic's
  privacy policy: https://www.anthropic.com/legal/privacy
- **Availability suggestions.** When you use "Find a time," your upcoming events are
  read **in your browser** via the Google Calendar API. Only **anonymous busy/free
  intervals** (start/end timestamps for the next ~2 weeks) are sent to the MailGenie
  backend to compute which days and times to offer — **never event titles,
  descriptions, locations, or attendees**.
- **Calendar event creation.** When you approve an event, it is sent **directly from
  your browser to the Google Calendar API** using your own OAuth token. It does not
  pass through the MailGenie backend.
- **Sending replies.** MailGenie never sends email on your behalf. The drafted reply
  opens in a Gmail compose window for you to edit and send yourself.
- **We do not** sell your data, use it for advertising, or use it to build user
  profiles. There are no third-party analytics or trackers in the extension.

## Who we share Google user data with

"Google user data" means the information MailGenie obtains through Google Sign-In
and the Google Calendar API — your Google account email address and the start/end
times of your calendar events — together with the content of the Gmail message you
have open. We disclose this data only to the service providers listed below, only
to the extent needed to provide the feature you request, and never for advertising
or resale:

- **Anthropic, PBC (Claude API)** — receives the text of the email you have open
  (to detect event details) and, for an availability request, the activity and
  proposed time (to draft your reply). Anthropic does **not** receive your calendar
  events. Anthropic privacy policy: https://www.anthropic.com/legal/privacy
- **Google Cloud (Cloud Run, US region)** — hosts the MailGenie backend that
  processes those requests. Data is handled transiently to answer a single request
  and is not stored. Google Cloud privacy notice:
  https://cloud.google.com/terms/cloud-privacy-notice
- **Stripe, Inc.** — receives only your email address and subscription identifiers
  to process Premium payments. Stripe does **not** receive your email content or
  calendar data. Stripe privacy policy: https://stripe.com/privacy
- **Google Calendar** — events you approve are written back to your own Google
  Calendar with your OAuth token, directly from your browser.

We do **not** sell, rent, or transfer Google user data to any other party, and we
do not use it for advertising, credit, lending, or to build user profiles.

## Limited Use & AI processing

MailGenie uses **Anthropic's Claude API** (Anthropic's commercial/paid API tier) to
detect events in the email you open and to draft availability replies. Under
Anthropic's Commercial Terms of Service
(https://www.anthropic.com/legal/commercial-terms), Anthropic **does not train its
models** on inputs or outputs submitted through the API.

MailGenie does **not** use Google user data — whether raw, aggregated, or derived —
to train, create, or improve any generalized or foundational machine-learning or
artificial-intelligence model, and does **not** transfer Google user data to any
third party for that purpose.

The use of raw or derived user data received from Google Workspace APIs (including
the Google Calendar API) will adhere to the Google API Services User Data Policy
(https://developers.google.com/terms/api-services-user-data-policy), including the
Limited Use requirements.

## Data retention

- **Server side:** The MailGenie backend processes email text and busy/free
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
  and refreshed automatically; MailGenie does not store it separately.

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

