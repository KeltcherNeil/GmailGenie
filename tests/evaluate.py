"""
evaluate.py — Measures extractor accuracy against the test email dataset.

Usage (from project root):
    python tests/evaluate.py

Each test email is a .txt file. If a matching .json file exists alongside
it, the extracted output is compared against the expected values for
'title', 'date', 'time', and 'location'.

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

# Fields checked when an expected .json file is present
CHECKED_FIELDS = ('title', 'date', 'time', 'location')


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
            result  = extract_event(subject=subject, body=cleaned)

            found   = bool(result.get('event_found'))
            correct = found == expect_event

            # If we have an expected file, check field values too
            if correct and expect_event and expected_file.exists():
                expected = json.loads(expected_file.read_text(encoding='utf-8'))
                for field in CHECKED_FIELDS:
                    exp_val = expected.get(field)
                    got_val = result.get(field)
                    if exp_val is not None and exp_val != got_val:
                        correct = False
                        print(f'    field mismatch — {field}: expected={exp_val!r}, got={got_val!r}')
                        break

            if correct:
                stats['correct'] += 1
                print(f'  [PASS] {email_file.name}')
            else:
                stats['wrong'] += 1
                print(f'  [FAIL] {email_file.name}  event_found={found}')

        except Exception as exc:
            stats['errors'] += 1
            print(f'  [ERR]  {email_file.name}  {exc}')

    return stats


def main() -> None:
    sep = '=' * 56
    print(sep)
    print('GmailGenie — Extractor Evaluation')
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
