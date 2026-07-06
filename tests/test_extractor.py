"""
test_extractor.py — Unit tests for the AI extraction pipeline.

Run from the project root:
    python tests/test_extractor.py

These tests mock the Claude API so they run without a real API key
or network connection.
"""

import json
import os
import sys
import unittest
from unittest.mock import MagicMock, patch

# Add backend to path so we can import without installing as a package
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'backend'))

from email_cleaner import clean_email
import extractor


# ── email_cleaner tests ───────────────────────────────────────────────────────

class TestEmailCleaner(unittest.TestCase):

    def test_removes_quoted_reply_lines(self):
        email = "Let's meet Tuesday.\n\n> On Mon, Jan 1 wrote:\n> Previous content here."
        result = clean_email(email)
        self.assertIn("Tuesday", result)
        self.assertNotIn("> On Mon", result)
        self.assertNotIn("Previous content", result)

    def test_removes_on_wrote_header(self):
        email = "See you then.\n\nOn Mon, Jan 6, 2025 at 9:00 AM John <j@ex.com> wrote:\nOld stuff."
        result = clean_email(email)
        self.assertIn("See you then", result)
        self.assertNotIn("wrote:", result)

    def test_truncates_at_signature_dash_marker(self):
        email = "Meeting at 3pm tomorrow.\n\n--\nJohn Smith\njohn@example.com\n+1 555 0100"
        result = clean_email(email)
        self.assertIn("3pm", result)
        self.assertNotIn("John Smith", result)

    def test_truncates_at_sent_from_iphone(self):
        email = "Works for me!\n\nSent from my iPhone"
        result = clean_email(email)
        self.assertIn("Works for me", result)
        self.assertNotIn("iPhone", result)

    def test_strips_html_tags(self):
        email = "<p>Meeting at <strong>2pm</strong> on Friday.</p>"
        result = clean_email(email)
        self.assertIn("2pm", result)
        self.assertIn("Friday", result)
        self.assertNotIn("<p>", result)
        self.assertNotIn("<strong>", result)

    def test_decodes_html_entities(self):
        email = "Let&apos;s meet &amp; discuss the plan."
        result = clean_email(email)
        self.assertIn("discuss", result)

    def test_clean_email_passes_through_unchanged(self):
        email = "Can we sync Thursday at 10am? We'll use Zoom."
        result = clean_email(email)
        self.assertIn("Thursday", result)
        self.assertIn("Zoom", result)

    def test_collapses_blank_lines(self):
        email = "Hi.\n\n\n\n\nSee you soon."
        result = clean_email(email)
        self.assertNotIn("\n\n\n", result)

    def test_respects_max_length(self):
        email = "x" * 9000
        result = clean_email(email)
        self.assertLessEqual(len(result), 6000)

    def test_keeps_trailing_scheduling_info(self):
        # Scheduling details often sit at the very end of a long email. The cap
        # must be generous enough not to truncate them away.
        email = ("recap line\n" * 300) + "Let's meet Tuesday at 6:30pm."
        result = clean_email(email)
        self.assertIn("6:30pm", result)


# ── extractor tests ───────────────────────────────────────────────────────────

def _mock_response(payload: dict) -> MagicMock:
    """Build a fake Anthropic API response object."""
    msg = MagicMock()
    msg.content = [MagicMock(text=json.dumps(payload))]
    return msg


def _patch_claude(payload_or_text):
    """
    Patch extractor._get_client so the Anthropic call returns a canned reply.

    Pass a dict to have it JSON-encoded, or a raw string to simulate arbitrary
    (e.g. non-JSON) model output. Returns the patcher's mock client so tests can
    assert on how messages.create was called.
    """
    mock_client = MagicMock()
    if isinstance(payload_or_text, str):
        resp = MagicMock()
        resp.content = [MagicMock(text=payload_or_text)]
    else:
        resp = _mock_response(payload_or_text)
    mock_client.messages.create.return_value = resp
    return mock_client


class TestExtractor(unittest.TestCase):

    @patch('extractor._get_client')
    def test_single_event_full_details(self, mock_get_client):
        mock_get_client.return_value = _patch_claude({'events': [{
            'title': 'Team sync',
            'date': '2024-03-15',
            'time': '14:00',
            'duration_minutes': 60,
            'attendees': ['alice@example.com'],
            'location': 'Zoom',
            'description': 'Weekly team sync',
            'confidence': 'high',
        }]})

        result = extractor.extract_event(
            subject='Team sync Friday',
            body="Let's meet Friday March 15 at 2pm on Zoom. Alice will join too."
        )

        self.assertEqual(len(result['events']), 1)
        event = result['events'][0]
        self.assertEqual(event['title'], 'Team sync')
        self.assertEqual(event['time'], '14:00')
        self.assertEqual(event['location'], 'Zoom')
        self.assertIn('alice@example.com', event['attendees'])

    @patch('extractor._get_client')
    def test_multiple_events(self, mock_get_client):
        """An email with two scheduled events returns both, in order."""
        mock_get_client.return_value = _patch_claude({'events': [
            {'title': 'vs Winchester', 'date': '2026-07-07', 'time': '18:30',
             'location': 'Home', 'confidence': 'high'},
            {'title': 'vs Waltham', 'date': '2026-07-14', 'time': '20:00',
             'location': 'Home', 'confidence': 'high'},
        ]})

        result = extractor.extract_event(
            subject='Season recap',
            body='This Tuesday vs Winchester at 6:30. Next Tuesday July 14 vs Waltham at 8.'
        )

        self.assertEqual(len(result['events']), 2)
        self.assertEqual(result['events'][0]['title'], 'vs Winchester')
        self.assertEqual(result['events'][1]['time'], '20:00')

    @patch('extractor._get_client')
    def test_no_event_returns_empty_list(self, mock_get_client):
        mock_get_client.return_value = _patch_claude({'events': []})

        result = extractor.extract_event(
            subject='Newsletter',
            body='Here are this week\'s top articles about machine learning...'
        )

        self.assertEqual(result['events'], [])

    @patch('extractor._get_client')
    def test_normalizes_legacy_single_event_shape(self, mock_get_client):
        """A model that still emits the old {event_found:true,...} shape is coerced."""
        mock_get_client.return_value = _patch_claude({
            'event_found': True, 'title': 'Lunch', 'date': '2024-06-01',
            'time': '12:00', 'confidence': 'high',
        })

        result = extractor.extract_event(subject='Lunch', body='Lunch at noon.')
        self.assertEqual(len(result['events']), 1)
        self.assertEqual(result['events'][0]['title'], 'Lunch')
        self.assertNotIn('event_found', result['events'][0])

    @patch('extractor._get_client')
    def test_normalizes_legacy_no_event_shape(self, mock_get_client):
        mock_get_client.return_value = _patch_claude({'event_found': False})
        result = extractor.extract_event(subject='x', body='no events here')
        self.assertEqual(result['events'], [])

    @patch('extractor._get_client')
    def test_raises_on_no_json(self, mock_get_client):
        mock_get_client.return_value = _patch_claude('Sorry, I cannot help with that.')

        with self.assertRaises(ValueError):
            extractor.extract_event(subject='Test', body='Some email body.')

    @patch('extractor._get_client')
    def test_strips_markdown_fences(self, mock_get_client):
        """Claude sometimes wraps JSON in ```json ... ``` — we should handle it."""
        payload = {'events': [{'title': 'Lunch', 'date': '2024-06-01',
                   'time': '12:00', 'duration_minutes': 60, 'attendees': [],
                   'location': None, 'description': None, 'confidence': 'high'}]}
        mock_get_client.return_value = _patch_claude(f"```json\n{json.dumps(payload)}\n```")

        result = extractor.extract_event(subject='Lunch', body='Lunch at noon.')
        self.assertEqual(len(result['events']), 1)
        self.assertEqual(result['events'][0]['title'], 'Lunch')

    @patch('extractor._get_client')
    def test_sender_included_in_prompt(self, mock_get_client):
        mock_client = _patch_claude({'events': []})
        mock_get_client.return_value = mock_client

        extractor.extract_event(
            subject='Quick call?',
            body='Are you free tomorrow?',
            sender='boss@company.com'
        )

        call_args = mock_client.messages.create.call_args
        user_content = call_args.kwargs['messages'][0]['content']
        self.assertIn('boss@company.com', user_content)


# ── Run ───────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    unittest.main(verbosity=2)
