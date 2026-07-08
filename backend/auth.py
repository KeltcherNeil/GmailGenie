"""
auth.py — Verifies the caller's Google OAuth token.

Purpose: /extract-event spends the operator's Anthropic credits on every call.
Without auth, anyone who learns the URL can drain the key (the Origin header is
spoofable). Requiring a Google token that was minted for THIS extension's OAuth
client ties every call — and its cost — to a real, signed-in user, and lets us
rate-limit per account instead of per IP.

Gated on GOOGLE_CLIENT_ID: if that env var is unset (local dev), verification is
disabled and every request is treated as anonymous — mirrors how ALLOWED_ORIGINS
disables the origin check in dev. NEVER deploy to production with it unset.

The extension already signs the user in with `chrome.identity` for Calendar; with
`openid`/`email` added to its OAuth scopes, that same access token resolves to a
stable user id here.
"""

import json
import os
import time
import urllib.parse
import urllib.request

GOOGLE_CLIENT_ID = os.getenv('GOOGLE_CLIENT_ID', '').strip()

# Google's tokeninfo endpoint validates an access token and returns its audience,
# authorized party, scopes, expiry, and (with openid/email scopes) sub + email.
_TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo'

# In-process cache: token -> (user_id, valid_until_epoch). Chrome reuses the same
# access token for ~1h, so this avoids hitting Google on every extraction. Bounded
# so a burst of distinct tokens can't grow it without limit.
_cache: dict[str, tuple[str, float]] = {}
_CACHE_MAX = 2000

# user_id -> email, learned from tokeninfo. Used to prefill Stripe checkout.
# Same bound rationale as _cache.
_emails: dict[str, str] = {}


def auth_enabled() -> bool:
    """True when a client id is configured and tokens must be verified."""
    return bool(GOOGLE_CLIENT_ID)


def bearer_token(authorization_header: str) -> str:
    """Extract the token from an 'Authorization: Bearer <token>' header."""
    header = (authorization_header or '').strip()
    if header.lower().startswith('bearer '):
        return header[7:].strip()
    return ''


def verify_token(token: str) -> str | None:
    """
    Return a stable per-user id (Google 'sub') for a valid token that was issued
    for THIS extension's OAuth client, or None if the token is missing, expired,
    invalid, or was minted for a different client.
    """
    if not token:
        return None

    now = time.time()
    cached = _cache.get(token)
    if cached and cached[1] > now:
        return cached[0]

    info = _tokeninfo(token)
    if not info:
        return None

    # Confused-deputy guard: the token MUST belong to our OAuth client. Without
    # this, a token any other app obtained for the same user would be accepted.
    if GOOGLE_CLIENT_ID not in (info.get('aud'), info.get('azp')):
        return None

    try:
        exp = float(info.get('exp', 0))
    except (TypeError, ValueError):
        exp = 0.0
    if exp and exp <= now:
        return None

    user_id = info.get('sub')
    if not user_id:
        return None

    if len(_cache) >= _CACHE_MAX:
        _cache.clear()
    # Cache until 60s before the token expires (or 5 min if expiry is unknown).
    _cache[token] = (user_id, (exp - 60) if exp else now + 300)

    email = (info.get('email') or '').strip()
    if email:
        if len(_emails) >= _CACHE_MAX:
            _emails.clear()
        _emails[user_id] = email

    return user_id


def user_email(user_id: str) -> str:
    """Best-effort email for a verified user id ('' if not seen this process)."""
    return _emails.get(user_id, '')


def _tokeninfo(token: str) -> dict | None:
    url = _TOKENINFO_URL + '?' + urllib.parse.urlencode({'access_token': token})
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            if resp.status != 200:
                return None
            return json.loads(resp.read().decode('utf-8'))
    except Exception:
        # Network error, non-200, or bad JSON — treat as unverifiable.
        return None
