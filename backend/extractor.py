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

Return ONLY valid JSON — no markdown fences, no explanation, nothing else.

If a meeting, appointment, call, or event is found, return:
{
  "event_found": true,
  "title": "concise event title",
  "date": "YYYY-MM-DD or null",
  "time": "HH:MM in 24-hour format or null",
  "duration_minutes": integer or null,
  "attendees": ["email@example.com", ...] or [],
  "location": "location string or null",
  "description": "one-sentence summary or null",
  "confidence": "high" | "medium" | "low"
}

If no scheduling information is found, return:
{"event_found": false}

Rules:
- confidence=high   → explicit date AND time are stated
- confidence=medium → date or time stated, but not both
- confidence=low    → vague reference ("sometime next week", "soon")
- Convert 12-hour times to 24-hour (e.g. 2:30 PM → 14:30)
- If only a day name is given (e.g. "Thursday"), set date=null and note the day in description
- Extract attendee email addresses only — ignore names without addresses\
"""


def extract_event(subject: str, body: str, sender: str = '') -> dict:
    """
    Send cleaned email text to Claude and return the extracted event as a dict.

    Args:
        subject: Email subject line.
        body:    Cleaned email body (run through email_cleaner first).
        sender:  Sender email address (optional, helps with attendee detection).

    Returns:
        Dict matching the response schema defined in CLAUDE.md.

    Raises:
        ValueError: If Claude returns output that cannot be parsed as JSON.
        anthropic.APIError: On API-level failures (propagated to caller).
    """
    today = date.today().strftime('%A, %B %d, %Y')  # e.g. "Wednesday, June 25, 2026"

    email_text = f"Subject: {subject}\n"
    if sender:
        email_text += f"From: {sender}\n"
    email_text += f"\n{body}"

    response = _get_client().messages.create(
        model=MODEL,
        max_tokens=512,
        system=SYSTEM_PROMPT,
        messages=[
            {'role': 'user', 'content': f"Today's date: {today}\n\nEMAIL:\n{email_text}"}
        ]
    )

    raw = response.content[0].text.strip()

    # Strip any accidental markdown code fences (```json ... ```)
    json_match = re.search(r'\{[\s\S]*\}', raw)
    if not json_match:
        raise ValueError(f'Claude returned no JSON. Raw output: {raw[:300]}')

    try:
        return json.loads(json_match.group())
    except json.JSONDecodeError as e:
        raise ValueError(f'Claude returned invalid JSON: {e}. Raw: {raw[:300]}')
