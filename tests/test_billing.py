"""
test_billing.py — Unit tests for the freemium quota + billing routes.

Run from the project root:
    python tests/test_billing.py

No Firestore, Stripe, or network needed — the quota rule is pure
(billing._apply_scan) and everything stateful is mocked.
"""

import json
import os
import sys
import unittest
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'backend'))

import billing
from billing import _apply_scan, week_key, week_resets_at

LIMIT = billing.FREE_SCANS_PER_WEEK
WEEK = '2026-W28'


class TestWeekKeys(unittest.TestCase):

    def test_week_key_is_iso(self):
        # Wednesday July 8 2026 is ISO week 28.
        self.assertEqual(week_key(datetime(2026, 7, 8, tzinfo=timezone.utc)), '2026-W28')

    def test_week_changes_on_monday(self):
        sunday = datetime(2026, 7, 12, 23, 59, tzinfo=timezone.utc)
        monday = datetime(2026, 7, 13, 0, 0, tzinfo=timezone.utc)
        self.assertNotEqual(week_key(sunday), week_key(monday))

    def test_resets_at_is_next_monday_midnight(self):
        now = datetime(2026, 7, 8, 15, 30, tzinfo=timezone.utc)  # Wednesday
        self.assertEqual(week_resets_at(now), '2026-07-13T00:00:00Z')


class TestApplyScan(unittest.TestCase):
    """The pure quota rule — this is the paywall's correctness guarantee."""

    def test_new_user_first_scan_allowed(self):
        update, status = _apply_scan({}, WEEK)
        self.assertEqual(update, {'week': WEEK, 'used': 1})
        self.assertTrue(status['allowed'])
        self.assertEqual(status['used'], 1)

    def test_free_user_blocked_at_limit(self):
        update, status = _apply_scan({'week': WEEK, 'used': LIMIT}, WEEK)
        self.assertIsNone(update)                  # nothing written on a denial
        self.assertFalse(status['allowed'])
        self.assertEqual(status['used'], LIMIT)

    def test_free_user_allowed_just_under_limit(self):
        update, status = _apply_scan({'week': WEEK, 'used': LIMIT - 1}, WEEK)
        self.assertTrue(status['allowed'])
        self.assertEqual(update['used'], LIMIT)

    def test_counter_resets_on_new_week(self):
        # Maxed out last week → new week starts fresh.
        update, status = _apply_scan({'week': '2026-W27', 'used': LIMIT}, WEEK)
        self.assertTrue(status['allowed'])
        self.assertEqual(update, {'week': WEEK, 'used': 1})

    def test_premium_user_never_blocked(self):
        update, status = _apply_scan(
            {'week': WEEK, 'used': LIMIT + 500, 'premium': True}, WEEK)
        self.assertTrue(status['allowed'])
        self.assertTrue(status['premium'])
        self.assertEqual(update['used'], LIMIT + 501)  # still counted

    def test_email_recorded_when_new(self):
        update, _ = _apply_scan({}, WEEK, email='a@b.com')
        self.assertEqual(update['email'], 'a@b.com')
        update, _ = _apply_scan({'email': 'a@b.com', 'week': WEEK, 'used': 1},
                                WEEK, email='a@b.com')
        self.assertNotIn('email', update)          # unchanged → no rewrite


class TestFailOpen(unittest.TestCase):
    """A metering outage must never take scanning down."""

    def test_no_firestore_allows_unmetered(self):
        with patch.object(billing, '_get_db', return_value=None):
            status = billing.check_and_increment('user1')
        self.assertTrue(status['allowed'])
        self.assertFalse(status['metered'])

    def test_firestore_error_allows_unmetered(self):
        broken = MagicMock()
        broken.collection.side_effect = RuntimeError('firestore down')
        with patch.object(billing, '_get_db', return_value=broken):
            status = billing.check_and_increment('user1')
        self.assertTrue(status['allowed'])
        self.assertFalse(status['metered'])

    def test_quota_status_fail_open(self):
        with patch.object(billing, '_get_db', return_value=None):
            status = billing.quota_status('user1')
        self.assertTrue(status['allowed'])


# ── Route tests ───────────────────────────────────────────────────────────────

class TestBillingRoutes(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        os.environ.pop('GOOGLE_CLIENT_ID', None)
        os.environ.pop('ALLOWED_ORIGINS', None)
        import app as app_module
        cls.app_module = app_module
        cls.client = app_module.app.test_client()

    def post(self, path, payload=None):
        return self.client.post(path, data=json.dumps(payload or {}),
                                content_type='application/json',
                                headers={'Authorization': 'Bearer test-token'})

    def _as_user(self, user_id='user1'):
        """Fake the Google-auth layer so the request runs as a signed-in user
        (flask.g is request-local, so we make _rate_key set it for real)."""
        return patch.multiple(self.app_module.auth,
                              auth_enabled=lambda: True,
                              verify_token=lambda tok: user_id,
                              user_email=lambda uid: 'user1@example.com')

    def _denied(self):
        return billing._status_dict(False, False, LIMIT)

    def _allowed(self, used=3):
        return billing._status_dict(True, False, used)

    def test_extract_returns_402_when_over_quota(self):
        with self._as_user(), \
             patch.object(self.app_module.billing, 'check_and_increment',
                          return_value=self._denied()):
            res = self.post('/extract-event', {'body': 'lunch tomorrow at noon'})
        self.assertEqual(res.status_code, 402)
        self.assertEqual(res.get_json()['quota']['used'], LIMIT)

    def test_extract_attaches_quota_when_allowed(self):
        with self._as_user(), \
             patch.object(self.app_module.billing, 'check_and_increment',
                          return_value=self._allowed(used=4)), \
             patch.object(self.app_module, 'extract_event',
                          return_value={'events': [], 'availability_request': None}):
            res = self.post('/extract-event', {'body': 'hello'})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.get_json()['quota']['used'], 4)

    def test_extract_unmetered_without_auth(self):
        """Dev mode (no auth) — no quota key, no metering calls."""
        with patch.object(self.app_module.billing, 'check_and_increment') as mock_check, \
             patch.object(self.app_module, 'extract_event',
                          return_value={'events': [], 'availability_request': None}):
            res = self.post('/extract-event', {'body': 'hello'})
        self.assertEqual(res.status_code, 200)
        self.assertNotIn('quota', res.get_json())
        mock_check.assert_not_called()

    def test_status_route_dev_mode_reports_unlimited(self):
        res = self.post('/billing/status')
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.get_json()['premium'])

    def test_checkout_503_when_stripe_unconfigured(self):
        with self._as_user():
            res = self.post('/billing/checkout')
        self.assertEqual(res.status_code, 503)

    def test_webhook_rejects_bad_signature(self):
        with patch.object(self.app_module.billing, 'stripe_enabled', return_value=True), \
             patch.object(self.app_module.billing, 'handle_webhook', return_value=False):
            res = self.client.post('/billing/webhook', data=b'{}')
        self.assertEqual(res.status_code, 400)

    def test_webhook_accepts_valid_event(self):
        with patch.object(self.app_module.billing, 'stripe_enabled', return_value=True), \
             patch.object(self.app_module.billing, 'handle_webhook', return_value=True):
            res = self.client.post('/billing/webhook', data=b'{}')
        self.assertEqual(res.status_code, 200)


if __name__ == '__main__':
    unittest.main(verbosity=2)
