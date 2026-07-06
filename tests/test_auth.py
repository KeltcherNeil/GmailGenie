"""
test_auth.py — Unit tests for backend/auth.py.

Mocks Google's tokeninfo endpoint so tests run offline. Run from project root:
    python tests/test_auth.py
"""

import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'backend'))

import auth

CLIENT_ID = '262145028639-abc.apps.googleusercontent.com'


class TestBearerToken(unittest.TestCase):
    def test_parses_bearer(self):
        self.assertEqual(auth.bearer_token('Bearer abc123'), 'abc123')

    def test_case_insensitive_scheme(self):
        self.assertEqual(auth.bearer_token('bearer xyz'), 'xyz')

    def test_empty_or_wrong_scheme(self):
        self.assertEqual(auth.bearer_token(''), '')
        self.assertEqual(auth.bearer_token('Basic abc'), '')


class TestVerifyToken(unittest.TestCase):
    def setUp(self):
        # Configure a client id and start from a clean cache each test.
        self._cid = patch.object(auth, 'GOOGLE_CLIENT_ID', CLIENT_ID)
        self._cid.start()
        auth._cache.clear()

    def tearDown(self):
        self._cid.stop()
        auth._cache.clear()

    def test_auth_enabled_reflects_client_id(self):
        self.assertTrue(auth.auth_enabled())
        with patch.object(auth, 'GOOGLE_CLIENT_ID', ''):
            self.assertFalse(auth.auth_enabled())

    def test_empty_token_returns_none(self):
        self.assertIsNone(auth.verify_token(''))

    @patch('auth._tokeninfo')
    def test_valid_token_returns_sub(self, mock_ti):
        mock_ti.return_value = {'aud': CLIENT_ID, 'sub': 'user-1', 'exp': '9999999999'}
        self.assertEqual(auth.verify_token('tok'), 'user-1')

    @patch('auth._tokeninfo')
    def test_accepts_azp_match(self, mock_ti):
        # Google returns azp (authorized party) for access tokens.
        mock_ti.return_value = {'azp': CLIENT_ID, 'sub': 'user-2', 'exp': '9999999999'}
        self.assertEqual(auth.verify_token('tok2'), 'user-2')

    @patch('auth._tokeninfo')
    def test_rejects_wrong_audience(self, mock_ti):
        # Confused-deputy: token for a DIFFERENT client must be rejected.
        mock_ti.return_value = {'aud': 'someone-else.apps.googleusercontent.com',
                                'sub': 'user-3', 'exp': '9999999999'}
        self.assertIsNone(auth.verify_token('tok3'))

    @patch('auth._tokeninfo')
    def test_rejects_expired(self, mock_ti):
        mock_ti.return_value = {'aud': CLIENT_ID, 'sub': 'user-4', 'exp': '1'}
        self.assertIsNone(auth.verify_token('tok4'))

    @patch('auth._tokeninfo')
    def test_rejects_missing_sub(self, mock_ti):
        mock_ti.return_value = {'aud': CLIENT_ID, 'exp': '9999999999'}
        self.assertIsNone(auth.verify_token('tok5'))

    @patch('auth._tokeninfo')
    def test_unverifiable_token_returns_none(self, mock_ti):
        mock_ti.return_value = None  # network error / non-200
        self.assertIsNone(auth.verify_token('tok6'))

    @patch('auth._tokeninfo')
    def test_caches_result(self, mock_ti):
        mock_ti.return_value = {'aud': CLIENT_ID, 'sub': 'user-7', 'exp': '9999999999'}
        self.assertEqual(auth.verify_token('tok7'), 'user-7')
        self.assertEqual(auth.verify_token('tok7'), 'user-7')
        # Second call served from cache — Google hit only once.
        self.assertEqual(mock_ti.call_count, 1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
