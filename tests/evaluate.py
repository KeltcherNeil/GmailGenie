"""
evaluate.py — Measures extractor accuracy against the test email dataset.

Usage (from project root):
    python tests/evaluate.py

Each test email is a .txt file. If a matching .json file exists alongside
it, the extracted output is compared against the expected 'date' and 'time'
(exact) and 'location' (case-insensitive substring). 'title' is not graded —
see EXACT_FIELDS / SUBSTRING_FIELDS below.

The expected .json may describe one event or several:
    {"title": ..., "date": ...}                      # single event (legacy)
    {"events": [ {...}, {...} ]}                      # one or more events
An optional top-level "today" field (e.g. "Monday, July 06, 2026") is passed to
the extractor so relative dates like "this Tuesday" resolve deterministically.
Each expected event must be matched by SOME extracted event on every non-null
checked field.

Add new test cases:
    tests/test_emails/has_event/email_003.txt          # raw email body
    tests/test_emails/has_event/email_003_expected.json  # expected extraction
"""

import json
import os
import sys
from pathlib import Path

# Load environment variables from backend/.env
_backend_dir = Path(__file__).parent.parent / 'backend'
sys.path.insert(0, str(_backend_dir))

try:
    from dotenv import load_dotenv
    load_dotenv(_backend_dir / '.env')
except ImportError:
    pass  # python-dotenv not installed yet

from email_cleaner import clean_email
from extractor import extract_event

TEST_DIR = Path(__file__).parent / 'test_emails'

# Fields checked when an expected .json file is present.
#  - EXACT_FIELDS: the hard, verifiable scheduling facts — must match exactly.
#  - SUBSTRING_FIELDS: free-form strings the model may elaborate on — the expected
#    value only has to appear (case-insensitively) within what was extracted, so
#    "Zoom" matches "Zoom: https://…".
# `title` is intentionally NOT graded: it's free-form prose ("Team sync" vs
# "Team Sync" vs "Sync with the team") and exact-matching it measures wording, not
# extraction quality. Pin the facts that matter for a calendar entry instead.
EXACT_FIELDS = ('date', 'time')
SUBSTRING_FIELDS = ('location',)


def _expected_events(expected: dict) -> list[dict]:
    """Normalize an expected .json into a list of expected event dicts."""
    if isinstance(expected.get('events'), list):
        return expected['events']
    # Legacy single-event shape — drop the bookkeeping key.
    return [{k: v for k, v in expected.items() if k not in ('event_found', 'today')}]


def _event_matches(expected_ev: dict, actual_ev: dict) -> bool:
    """True if actual_ev matches every non-null checked field of expected_ev."""
    for field in EXACT_FIELDS:
        exp_val = expected_ev.get(field)
        if exp_val is not None and exp_val != actual_ev.get(field):
            return False
    for field in SUBSTRING_FIELDS:
        exp_val = expected_ev.get(field)
        if exp_val is not None:
            got_val = actual_ev.get(field) or ''
            if str(exp_val).lower() not in str(got_val).lower():
                return False
    return True


def _evaluate_folder(folder: Path, expect_event: bool) -> dict[str, int]:
    stats = {'correct': 0, 'wrong': 0, 'errors': 0, 'total': 0}

    email_files = sorted(folder.glob('*.txt'))
    if not email_files:
        print('  (no .txt files found)')
        return stats

    for email_file in email_files:
        stats['total'] += 1
        expected_file = folder / (email_file.stem + '_expected.json')

        try:
            body    = email_file.read_text(encoding='utf-8')
            subject = email_file.stem.replace('_', ' ').title()
            cleaned = clean_email(body)

            expected = {}
            if expected_file.exists():
                expected = json.loads(expected_file.read_text(encoding='utf-8'))

            # An expected file may pin "today" so relative dates resolve deterministically.
            result = extract_event(
                subject=subject, body=cleaned, today=expected.get('today', '')
            )

            events  = result.get('events', [])
            found   = len(events) > 0
            correct = found == expect_event

            # If we have an expected file, every expected event must be matched
            # by some extracted event on all non-null checked fields.
            if correct and expect_event and expected:
                for exp_ev in _expected_events(expected):
                    if not any(_event_matches(exp_ev, got) for got in events):
                        correct = False
                        print(f'    no extracted event matched expected: {exp_ev!r}')
                        break

            if correct:
                stats['correct'] += 1
                print(f'  [PASS] {email_file.name}  ({len(events)} event(s))')
            else:
                stats['wrong'] += 1
                print(f'  [FAIL] {email_file.name}  found={len(events)} event(s)')

        except Exception as exc:
            stats['errors'] += 1
            print(f'  [ERR]  {email_file.name}  {exc}')

    return stats


def main() -> None:
    sep = '=' * 56
    print(sep)
    print('MailGenie — Extractor Evaluation')
    print(sep)

    totals: dict[str, int] = {'correct': 0, 'wrong': 0, 'errors': 0, 'total': 0}

    sections = [
        (TEST_DIR / 'has_event', True,  'Emails WITH scheduling info'),
        (TEST_DIR / 'no_event',  False, 'Emails WITHOUT scheduling info'),
    ]

    for folder, expect_event, label in sections:
        if not folder.exists():
            continue
        print(f'\n{label} ({folder}):')
        stats = _evaluate_folder(folder, expect_event)
        for key in totals:
            totals[key] += stats[key]

    if totals['total'] == 0:
        print('\nNo test emails found.')
        print('Add .txt files under tests/test_emails/has_event/ and no_event/')
        return

    accuracy = totals['correct'] / totals['total'] * 100
    print(f'\n{sep}')
    print(f"Results : {totals['correct']}/{totals['total']} correct  ({accuracy:.1f}% accuracy)")
    print(f"Errors  : {totals['errors']}")
    print(sep)


if __name__ == '__main__':
    main()
