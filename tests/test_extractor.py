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
        email = "x" * 5000
        result = clean_email(email)
        self.assertLessEqual(len(result), 3000)


# ── extractor tests ───────────────────────────────────────────────────────────

def _mock_response(payload: dict) -> MagicMock:
    """Build a fake Anthropic API response object."""
    msg = MagicMock()
    msg.content = [MagicMock(text=json.dumps(payload))]
    return msg


class TestExtractor(unittest.TestCase):

    @patch('extractor.client')
    def test_event_found_full_details(self, mock_client):
        mock_client.messages.create.return_value = _mock_response({
            'event_found': True,
            'title': 'Team sync',
            'date': '2024-03-15',
            'time': '14:00',
            'duration_minutes': 60,
            'attendees': ['alice@example.com'],
            'location': 'Zoom',
            'description': 'Weekly team sync',
            'confidence': 'high',
        })

        result = extractor.extract_event(
            subject='Team sync Friday',
            body="Let's meet Friday March 15 at 2pm on Zoom. Alice will join too."
        )

        self.assertTrue(result['event_found'])
        self.assertEqual(result['title'], 'Team sync')
        self.assertEqual(result['time'], '14:00')
        self.assertEqual(result['location'], 'Zoom')
        self.assertIn('alice@example.com', result['attendees'])

    @patch('extractor.client')
    def test_no_event_returns_false(self, mock_client):
        mock_client.messages.create.return_value = _mock_response({'event_found': False})

        result = extractor.extract_event(
            subject='Newsletter',
            body='Here are this week\'s top articles about machine learning...'
        )

        self.assertFalse(result['event_found'])

    @patch('extractor.client')
    def test_raises_on_no_json(self, mock_client):
        bad = MagicMock()
        bad.content = [MagicMock(text='Sorry, I cannot help with that.')]
        mock_client.messages.create.return_value = bad

        with self.assertRaises(ValueError):
            extractor.extract_event(subject='Test', body='Some email body.')

    @patch('extractor.client')
    def test_strips_markdown_fences(self, mock_client):
        """Claude sometimes wraps JSON in ```json ... ``` — we should handle it."""
        payload = {'event_found': True, 'title': 'Lunch', 'date': '2024-06-01',
                   'time': '12:00', 'duration_minutes': 60, 'attendees': [],
                   'location': None, 'description': None, 'confidence': 'high'}
        fenced = f"```json\n{json.dumps(payload)}\n```"
        resp = MagicMock()
        resp.content = [MagicMock(text=fenced)]
        mock_client.messages.create.return_value = resp

        result = extractor.extract_event(subject='Lunch', body='Lunch at noon.')
        self.assertTrue(result['event_found'])
        self.assertEqual(result['title'], 'Lunch')

    @patch('extractor.client')
    def test_sender_included_in_prompt(self, mock_client):
        mock_client.messages.create.return_value = _mock_response({'event_found': False})

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
