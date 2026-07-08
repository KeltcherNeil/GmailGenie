"""
extractor.py — AI-powered event extraction using the Claude API.

All business logic for calling Claude and parsing the response lives here.
app.py routes call extract_event() and nothing else.
"""

import json
import os
import re
from datetime import date

from anthropic import Anthropic

MODEL = 'claude-haiku-4-5-20251001'

# The Anthropic client is created lazily (on first extraction) rather than at
# import time. Creating it eagerly requires ANTHROPIC_API_KEY to be set, which
# would crash the whole backend on startup. Lazy init lets the backend boot
# (e.g. serve /health) even when no Anthropic key is configured.
_client = None


def _get_client() -> Anthropic:
    global _client
    if _client is None:
        # Reads ANTHROPIC_API_KEY from the environment automatically.
        _client = Anthropic()
    return _client

SYSTEM_PROMPT = """\
You extract scheduling information from email text.

An email may describe ZERO, ONE, or SEVERAL distinct events (e.g. "we meet
Tuesday at 6:30, then again next Tuesday at 8"). Read the WHOLE email and return
every distinct future event you find — not just the first one.

Return ONLY valid JSON — no markdown fences, no explanation, nothing else.
The top-level value is always an object with an "events" array:
{
  "events": [
    {
      "title": "concise event title",
      "date": "YYYY-MM-DD or null",
      "time": "HH:MM in 24-hour format or null",
      "duration_minutes": integer or null,
      "attendees": ["email@example.com", ...] or [],
      "location": "location string or null",
      "description": "one-sentence summary or null",
      "confidence": "high" | "medium" | "low"
    }
  ]
}

Additionally, detect when the email ASKS THE READER for their availability —
the sender wants the READER to propose a time ("when can you play tennis?",
"what times work for you?", "when are you free to grab lunch?"). Report it in
an "availability_request" field next to "events":
{
  "events": [...],
  "availability_request": {
    "activity": "short verb phrase for what is being scheduled, e.g. 'play tennis'",
    "duration_minutes": estimated typical duration as an integer (default 60),
    "requester_name": "sender's first name if evident, else null",
    "preferred_dates": ["YYYY-MM-DD", ...],
    "preferred_time_of_day": "morning" | "midday" | "evening" | null,
    "preferred_time": "HH:MM or null",
    "confidence": "high" | "medium" | "low"
  }
}
preferred_dates: the concrete date(s) the sender constrained the request to,
resolved against today's date to the nearest FUTURE occurrence, in the order
mentioned: "on Thursday" → that Thursday's date; "this weekend" → Saturday and
Sunday; "early next week" → the 2-3 dates it covers. Use [] when the timing is
left open ("this week", "sometime soon").
preferred_time_of_day: set only when the sender constrained the part of day
("Thursday evening" → "evening"; before ~11am → "morning", ~11am-5pm →
"midday", after 5pm → "evening"), else null.
preferred_time: set only when the sender named an approximate or exact clock
time ("around noon" → "12:00", "at 3" → "15:00", "after work" → "17:30"),
24-hour format; also set preferred_time_of_day to the matching part of day.
Null when only a day or part of day was mentioned.

Set "availability_request" to null when the email does not ask the reader for
a time. An email that proposes a SPECIFIC date AND time ("tennis Friday at 3?")
is an event, NOT an availability request. But naming only a day while asking
the reader to pick or confirm ("can you play Thursday?") IS an availability
request with that day in preferred_dates. An email can contain both — concrete
event(s) AND an open "when are you free?" question — return both.

If no event is found, return {"events": []}.

Rules:
- Return ONE array element per distinct event. Two different dates/times, or two
  separately-scheduled meetings, are two events — do NOT merge them.
- Ignore purely narrative or past content that carries no future scheduling:
  recaps, sports scores, results, and "here's how it went" storytelling are NOT
  events. Scores like "5-0", "7-5", "6:30" inside a recap are NOT times. Only
  extract something the reader could actually put on a calendar.
- confidence=high   → you can determine BOTH a specific calendar date and a time
- confidence=medium → only one of date/time can be determined
- confidence=low    → only a vague reference ("sometime next week", "soon")
- Convert 12-hour times to 24-hour (e.g. 2:30 PM → 14:30)
- Resolve relative dates to an actual YYYY-MM-DD using the provided today's date.
  "tomorrow", "this Thursday", "next Monday", "in two weeks", a bare day name like
  "Thursday" → the concrete date, choosing the nearest FUTURE occurrence. When the
  email also states an explicit calendar date (e.g. "next Tuesday, July 14"),
  prefer the explicit date.
  Only set date=null when no date can be inferred at all (e.g. "sometime soon").
- Extract attendee email addresses only — ignore names without addresses\
"""


def _normalize(parsed: dict) -> dict:
    """
    Coerce whatever the model returned into the canonical
    {"events": [...], "availability_request": {...}|None} shape.

    Accepts:
      - the current shape: {"events": [ {...}, ... ]}
      - a legacy single-event object: {"event_found": true, "title": ...}
      - a legacy "no event" object:   {"event_found": false}
      - a bare event object with no wrapper
    so a prompt hiccup can't drop otherwise-valid events on the floor.
    """
    # availability_request must be a dict with at least an activity to be usable.
    availability = parsed.get('availability_request')
    if not (isinstance(availability, dict) and availability.get('activity')):
        availability = None

    events = parsed.get('events')
    if isinstance(events, list):
        events = [e for e in events if isinstance(e, dict)]
    elif parsed.get('event_found') is True:
        # Legacy single-event shape.
        events = [{k: v for k, v in parsed.items() if k != 'event_found'}]
    elif parsed.get('event_found') is not False and any(
            k in parsed for k in ('title', 'date', 'time')):
        # A bare event object (has a title/date/time but no wrapper) → wrap it.
        events = [parsed]
    else:
        events = []

    return {'events': events, 'availability_request': availability}


def extract_event(subject: str, body: str, sender: str = '', today: str = '') -> dict:
    """
    Send cleaned email text to Claude and return the extracted events as a dict.

    Args:
        subject: Email subject line.
        body:    Cleaned email body (run through email_cleaner first).
        sender:  Sender email address (optional, helps with attendee detection).
        today:   The requester's LOCAL date as a human string
                 (e.g. "Wednesday, June 25, 2026"), used to resolve relative dates
                 like "this Thursday". Falls back to the server's UTC date if empty
                 — but the server runs in UTC, so prefer sending the client's date.

    Returns:
        Dict of the form {"events": [...], "availability_request": {...}|None}.
        "events" is empty when no scheduling information is found;
        "availability_request" is set when the email asks the READER for a
        time (e.g. "when can you play tennis?"). Schemas are in CLAUDE.md.

    Raises:
        ValueError: If Claude returns output that cannot be parsed as JSON.
        anthropic.APIError: On API-level failures (propagated to caller).
    """
    # Prefer the client-supplied local date; fall back to the server's (UTC) date.
    today = today.strip() or date.today().strftime('%A, %B %d, %Y')

    email_text = f"Subject: {subject}\n"
    if sender:
        email_text += f"From: {sender}\n"
    email_text += f"\n{body}"

    response = _get_client().messages.create(
        model=MODEL,
        # Room for several events; a single event is ~120 tokens, so this covers
        # roughly a dozen before truncation.
        max_tokens=1500,
        system=SYSTEM_PROMPT,
        messages=[
            {'role': 'user', 'content': f"Today's date: {today}\n\nEMAIL:\n{email_text}"}
        ]
    )

    raw = response.content[0].text.strip()

    # Grab the outermost JSON object, tolerating accidental markdown fences
    # (```json ... ```) or stray prose around it.
    json_match = re.search(r'\{[\s\S]*\}', raw)
    if not json_match:
        raise ValueError(f'Claude returned no JSON. Raw output: {raw[:300]}')

    try:
        parsed = json.loads(json_match.group())
    except json.JSONDecodeError as e:
        raise ValueError(f'Claude returned invalid JSON: {e}. Raw: {raw[:300]}')

    return _normalize(parsed)
