"""
availability.py — Deterministic free-time computation for availability requests.

When an email asks the reader for their availability ("when can you play
tennis?"), the extension reads the user's calendar client-side and sends only
BUSY BLOCKS (start/end times, no titles) here. This module answers two
questions, with plain datetime math and no AI:

  1. build_options()  — which of the next few days have free time, and in
     which part of the day (morning / midday / evening)?
  2. pick_slot()      — given a chosen day + part of day, what exact slot
     should we recommend?

Everything is computed on the USER'S LOCAL wall-clock: the extension converts
calendar events to naive local "YYYY-MM-DDTHH:MM" strings before sending, so
this module never touches timezones. Being deterministic, it is fully
unit-testable — the "never recommend a time you're busy" guarantee lives here,
not in a prompt.
"""

from datetime import datetime, date, time, timedelta

# Parts of the day offered to the user. A bucket is "available" when it
# contains at least one candidate slot (below) of the requested duration.
BUCKETS = {
    'morning': (time(8, 0),  time(12, 0)),
    'midday':  (time(12, 0), time(17, 0)),
    'evening': (time(17, 0), time(21, 0)),
}
BUCKET_ORDER = ['morning', 'midday', 'evening']

# Candidate slots start on a half-hour grid — humans schedule at :00/:30.
STEP_MINUTES = 30

DEFAULT_DURATION_MINUTES = 60

# How many calendar days ahead we'll scan to find enough free days.
SCAN_LIMIT_DAYS = 14


def _parse_stamp(value: str) -> datetime:
    """Parse a naive local 'YYYY-MM-DDTHH:MM[:SS]' stamp (seconds ignored)."""
    return datetime.fromisoformat(str(value)[:16])


def parse_busy(busy) -> list:
    """
    Coerce the client-sent busy list [{"start": stamp, "end": stamp}, ...]
    into sorted (start, end) datetime pairs, dropping malformed/empty entries.
    """
    intervals = []
    for block in busy or []:
        try:
            start = _parse_stamp(block['start'])
            end   = _parse_stamp(block['end'])
        except (KeyError, TypeError, ValueError):
            continue  # malformed block — safer to ignore than to 400 the whole request
        if end > start:
            intervals.append((start, end))
    return sorted(intervals)


def _is_free(start: datetime, end: datetime, intervals: list) -> bool:
    """True when [start, end) overlaps no busy interval."""
    return all(end <= b_start or b_end <= start for b_start, b_end in intervals)


def slot_starts(intervals: list, day: date, bucket: str,
                duration_minutes: int, now: datetime = None) -> list:
    """
    Every free candidate start (datetime) for a `duration_minutes` slot inside
    `bucket` on `day`, on the half-hour grid. Empty list = bucket is booked.
    Slots that start at or before `now` are excluded.
    """
    if bucket not in BUCKETS:
        raise ValueError(f'Unknown bucket: {bucket!r}')
    open_t, close_t = BUCKETS[bucket]

    duration = timedelta(minutes=duration_minutes)
    cursor   = datetime.combine(day, open_t)
    close    = datetime.combine(day, close_t)

    starts = []
    while cursor + duration <= close:
        if (now is None or cursor > now) and _is_free(cursor, cursor + duration, intervals):
            starts.append(cursor)
        cursor += timedelta(minutes=STEP_MINUTES)
    return starts


def _day_label(day: date) -> str:
    """'Wednesday, Jul 8' — strftime's %-d is platform-specific, so build it."""
    return f"{day.strftime('%A, %b')} {day.day}"


def build_options(busy, now, duration_minutes=DEFAULT_DURATION_MINUTES,
                  days_wanted=3) -> list:
    """
    The day choices to offer the user: the next `days_wanted` days (starting
    tomorrow) that have at least one free bucket. Fully-booked days are simply
    not offered — the UI never shows a day that can't work.

    Args:
        busy:             [{"start": "YYYY-MM-DDTHH:MM", "end": ...}, ...]
        now:              the user's local now, same stamp format.
        duration_minutes: slot length the activity needs.
        days_wanted:      how many candidate days to return.

    Returns:
        [{"date": "2026-07-08", "label": "Wednesday, Jul 8",
          "buckets": {"morning": true, "midday": false, "evening": true}}, ...]
        (possibly fewer than days_wanted if the whole scan window is booked)
    """
    intervals = parse_busy(busy)
    now_dt    = _parse_stamp(now)

    days = []
    for offset in range(1, SCAN_LIMIT_DAYS + 1):
        day = now_dt.date() + timedelta(days=offset)
        buckets = {
            name: bool(slot_starts(intervals, day, name, duration_minutes, now=now_dt))
            for name in BUCKET_ORDER
        }
        if any(buckets.values()):
            days.append({
                'date': day.isoformat(),
                'label': _day_label(day),
                'buckets': buckets,
            })
        if len(days) == days_wanted:
            break
    return days


def pick_slot(busy, day_str: str, bucket: str,
              duration_minutes=DEFAULT_DURATION_MINUTES, now=None):
    """
    The slot to recommend for the chosen day + bucket: the earliest free
    candidate. Returns (start, end) datetimes, or None when the bucket has no
    free slot (e.g. the calendar changed since options were computed).
    """
    intervals = parse_busy(busy)
    day       = date.fromisoformat(day_str)
    now_dt    = _parse_stamp(now) if now else None

    starts = slot_starts(intervals, day, bucket, duration_minutes, now=now_dt)
    if not starts:
        return None
    start = starts[0]
    return start, start + timedelta(minutes=duration_minutes)
