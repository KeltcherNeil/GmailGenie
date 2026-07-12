"""
composer.py — Drafts the reply email for an availability request.

Once availability.py has picked a concrete slot, this module asks Claude to
write a short, friendly reply proposing that time ("Thursday at 2 works for
me!"). The draft is shown to the user in a prefilled Gmail compose window —
MailGenie never sends email on its own.

The slot itself is ALWAYS the deterministic one from availability.py; Claude
only writes prose around it. If the API call fails or returns garbage, a plain
template reply is used instead so the flow still completes.
"""

import json
import logging
import re
from datetime import datetime

from extractor import MODEL, _get_client

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """\
You write a short, friendly email reply confirming when the sender is free
for an activity someone asked them about.

Return ONLY valid JSON — no markdown fences, no explanation:
{
  "reply_subject": "subject line for the reply",
  "reply_body": "the reply text"
}

Rules:
- The reply is FROM the person who was asked, TO the person who asked.
- Propose exactly the given date and start time — do not invent a different one.
- 2-4 sentences, warm and casual, matching how people write to friends.
- Ask them to confirm the time works (e.g. "does that work for you?").
- Greet the requester by first name when one is given.
- When the requester asked about specific day(s) or a specific time and the
  proposal differs — different day, or a start time off by more than ~30
  minutes, or they're marked BUSY at the asked time — briefly acknowledge
  theirs doesn't work ("noon's no good for me, but 1 works") before proposing.
  When it matches what they asked, just confirm naturally ("noon works!").
- Do NOT include a signature, sender name, or placeholders like [Your Name].
- Subject: reply to the original subject ("Re: ...") when one is given,
  otherwise write a short natural subject.\
"""


def _fmt_time(dt: datetime) -> str:
    """2:00 PM — %-I is platform-specific, so build it."""
    hour = dt.hour % 12 or 12
    return f"{hour}:{dt.minute:02d} {'PM' if dt.hour >= 12 else 'AM'}"


def _fmt_when(start: datetime) -> str:
    """'Thursday, July 9 at 2:00 PM'"""
    return f"{start.strftime('%A, %B')} {start.day} at {_fmt_time(start)}"


def _fallback_reply(activity: str, requester_name: str, start: datetime,
                    subject: str) -> dict:
    """Deterministic template used when the Claude call fails."""
    greeting = f"Hi {requester_name}!" if requester_name else 'Hi!'
    when = _fmt_when(start)
    return {
        'reply_subject': f'Re: {subject}' if subject else f'{when}?',
        'reply_body': (
            f'{greeting}\n\n'
            f'{when} works for me to {activity} — does that work for you?\n\n'
            f'See you then!'
        ),
    }


def compose_reply(activity: str, requester_name: str, start: datetime,
                  end: datetime, subject: str = '', sender: str = '',
                  asked_when: str = '') -> dict:
    """
    Draft the reply proposing `start` for `activity`.

    `asked_when` is a human description of the day(s) the requester asked about
    (e.g. "Thursday, Jul 9"), so the reply can acknowledge when the proposed
    day differs from what they asked for.

    Returns {"reply_subject": str, "reply_body": str}. Never raises — falls
    back to a plain template on any API/parse failure, so a Claude hiccup
    can't strand the user mid-flow.
    """
    context = (
        f'Activity asked about: {activity}\n'
        f"Requester's first name: {requester_name or 'unknown'}\n"
        f"Requester's email: {sender or 'unknown'}\n"
        f"Original subject: {subject or '(none)'}\n"
        f"Day(s) the requester asked about: {asked_when or 'none in particular'}\n"
        f'Proposed time: {_fmt_when(start)} (until {_fmt_time(end)})'
    )

    try:
        response = _get_client().messages.create(
            model=MODEL,
            max_tokens=400,
            system=SYSTEM_PROMPT,
            messages=[{'role': 'user', 'content': context}],
        )
        raw = response.content[0].text.strip()
        json_match = re.search(r'\{[\s\S]*\}', raw)
        parsed = json.loads(json_match.group()) if json_match else {}
        reply_subject = str(parsed.get('reply_subject') or '').strip()
        reply_body    = str(parsed.get('reply_body') or '').strip()
        if reply_subject and reply_body:
            return {'reply_subject': reply_subject, 'reply_body': reply_body}
        logger.warning('Composer returned incomplete JSON, using template. Raw: %.200s', raw)
    except Exception as exc:  # API down, bad JSON, etc. — template still works
        logger.warning('Composer Claude call failed, using template: %s', exc)

    return _fallback_reply(activity, requester_name, start, subject)
