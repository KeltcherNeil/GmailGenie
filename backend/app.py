"""
app.py — Main Flask app and API routes.

All route definitions live here. Business logic lives in helper modules:
  - email_cleaner.py  → cleans raw email text
  - extractor.py      → calls Claude API, returns structured event JSON

Note: calendar creation is handled entirely client-side in the Chrome extension
(chrome.identity + the Google Calendar API). This backend no longer writes events.

Deployment: this service is meant to run hosted (Google Cloud Run) so end users
never paste an Anthropic key or run a shell. ANTHROPIC_API_KEY lives in the host's
environment and never ships in the extension. See DEPLOY.md.

Abuse protection: because /extract-event spends the operator's Anthropic credits on
every call, it is guarded by three layers:
  1. Origin allowlist (ALLOWED_ORIGINS) — rejects non-extension origins.
  2. Per-user Google-identity auth (auth.py, gated on GOOGLE_CLIENT_ID) — the caller
     must present a Google token minted for THIS extension's OAuth client, so spend
     is tied to a real signed-in account. This is the primary gate.
  3. Rate limiting — per Google account when authed, else per IP.
Both ALLOWED_ORIGINS and GOOGLE_CLIENT_ID are disabled when unset (local dev); NEVER
deploy to production without both set. See DEPLOY.md.
"""

import os
from datetime import date

from flask import Flask, request, jsonify, g
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from dotenv import load_dotenv

import auth
import availability
import composer
from email_cleaner import clean_email
from extractor import extract_event

load_dotenv()

app = Flask(__name__)

# ── Config ─────────────────────────────────────────────────────────────────────
# ALLOWED_ORIGINS: comma-separated list of origins permitted to call /extract-event,
# e.g. "chrome-extension://mhcloobbehmmanfjdcejglmndcogejjp". Chrome sends the
# extension's origin on service-worker fetches. If unset (local dev), the origin
# check is disabled and any origin is allowed — DO NOT deploy without setting it.
ALLOWED_ORIGINS = {
    o.strip() for o in os.getenv('ALLOWED_ORIGINS', '').split(',') if o.strip()
}

# RATE_LIMITS: per-IP limits applied to /extract-event. Override via env if needed.
RATE_LIMITS = os.getenv('RATE_LIMITS', '30 per minute;300 per day')


def _origin_allowed(origin: str) -> bool:
    """True when the origin check is disabled (dev) or the origin is allowlisted."""
    return not ALLOWED_ORIGINS or origin in ALLOWED_ORIGINS


# ── Rate limiting ────────────────────────────────────────────────────────────
# In-memory storage: fine for a single Cloud Run instance. Cloud Run can scale to
# several instances, each with its own counter, so the effective limit is
# (limit × instances) — acceptable as a floor for Phase 1. Phase 2's per-user auth
# is the real quota. For strict global limits, point storage_uri at Redis/Memorystore.
limiter = Limiter(
    key_func=get_remote_address,
    app=app,
    default_limits=[],  # only /extract-event is limited, via the decorator below
)


def _rate_key() -> str:
    """
    Rate-limit key for /extract-event. When auth is enabled, authenticate the
    caller once here (result cached on flask.g for the view to reuse) and limit
    per Google account; otherwise fall back to per-IP (dev / auth disabled).
    """
    if not auth.auth_enabled():
        return get_remote_address()
    token = auth.bearer_token(request.headers.get('Authorization', ''))
    user_id = auth.verify_token(token) if token else None
    g.gg_user = user_id  # None → the view returns 401
    return f'user:{user_id}' if user_id else f'anon:{get_remote_address()}'


def _is_preflight() -> bool:
    return request.method == 'OPTIONS'


def _request_gate():
    """
    Shared guard for every Claude/credit-spending route: CORS preflight,
    origin allowlist, and per-user Google auth (verified by _rate_key, which
    the rate limiter runs before the view — the result is cached on flask.g).

    Returns a (response, status) pair to short-circuit with, or None to proceed.
    """
    if request.method == 'OPTIONS':
        # CORS preflight — headers are added by add_cors_headers.
        return ('', 204)

    origin = request.headers.get('Origin', '')
    if not _origin_allowed(origin):
        app.logger.warning('Rejected request from disallowed origin: %r', origin)
        return jsonify({'error': 'Origin not allowed'}), 403

    # A 401 tells the extension to prompt the user to connect their Google account.
    if auth.auth_enabled() and not getattr(g, 'gg_user', None):
        return jsonify({'error': 'Google sign-in required'}), 401

    return None


# ── CORS + origin allowlist ────────────────────────────────────────────────────
# The Chrome extension calls this backend from a background service worker. We echo
# CORS headers so the request works regardless of how Chrome classifies it, but we
# reflect ONLY an allowlisted origin (never a blanket "*") once ALLOWED_ORIGINS is set.

@app.after_request
def add_cors_headers(response):
    origin = request.headers.get('Origin', '')
    if not ALLOWED_ORIGINS:
        # Dev mode — no allowlist configured.
        response.headers['Access-Control-Allow-Origin'] = origin or '*'
    elif origin in ALLOWED_ORIGINS:
        response.headers['Access-Control-Allow-Origin'] = origin
        response.headers['Vary'] = 'Origin'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
    return response


# ── Health check ─────────────────────────────────────────────────────────────

@app.route('/health', methods=['GET'])
@limiter.exempt
def health():
    """Simple liveness probe. Returns 200 when the server is running.

    Open and unlimited — Cloud Run and uptime monitors hit this.
    """
    return jsonify({'status': 'ok'}), 200


# ── Event extraction ─────────────────────────────────────────────────────────

@app.route('/extract-event', methods=['POST', 'OPTIONS'])
@limiter.limit(RATE_LIMITS, key_func=_rate_key, exempt_when=_is_preflight)
def extract_event_route():
    """
    Extract scheduling information from a raw email.

    Request body (JSON):
        {
            "subject": "string",   # email subject (required)
            "body":    "string",   # raw email body (required)
            "sender":  "string"    # sender address (optional)
        }

    Response (JSON):
        On success — the event object from extractor.py (event_found: true/false)
        On error   — { "error": "description" }
    """
    denied = _request_gate()
    if denied:
        return denied

    data = request.get_json(silent=True)

    if not data:
        return jsonify({'error': 'Request body must be JSON'}), 400

    subject = (data.get('subject') or '').strip()
    body    = (data.get('body')    or '').strip()
    sender  = (data.get('sender')  or '').strip()
    today   = (data.get('today')   or '').strip()  # requester's local date (for relative dates)

    if not body:
        return jsonify({'error': "Missing required field: 'body'"}), 400

    # Clean before sending to AI — removes signatures, quoted replies, HTML
    cleaned_body = clean_email(body)

    try:
        event = extract_event(subject=subject, body=cleaned_body, sender=sender, today=today)
        return jsonify(event), 200

    except ValueError as exc:
        # Unparseable AI output
        app.logger.warning('Extraction parse error: %s', exc)
        return jsonify({'error': str(exc)}), 422

    except Exception as exc:
        # Unexpected errors (API down, network issues, etc.)
        app.logger.error('Extraction failed: %s', exc)
        return jsonify({'error': 'Internal server error'}), 500


# ── Availability scheduling ──────────────────────────────────────────────────
# When an email asks the reader for a time ("when can you play tennis?"), the
# extension walks the user through day → part-of-day → recommended slot. The
# calendar is read CLIENT-SIDE; only anonymous busy blocks (start/end stamps in
# the user's local wall-clock, no titles) are sent here. Slot math is
# deterministic (availability.py); Claude only drafts the reply email.

def _parse_availability_request(data):
    """Shared body validation: returns (busy, now, duration) or raises ValueError."""
    if not data:
        raise ValueError('Request body must be JSON')
    now = (data.get('now') or '').strip()
    if not now:
        raise ValueError("Missing required field: 'now'")
    busy = data.get('busy')
    if busy is not None and not isinstance(busy, list):
        raise ValueError("'busy' must be a list")
    try:
        duration = int(data.get('duration_minutes') or availability.DEFAULT_DURATION_MINUTES)
    except (TypeError, ValueError):
        raise ValueError("'duration_minutes' must be an integer")
    duration = max(15, min(duration, 8 * 60))  # sane bounds
    preferred = data.get('preferred_dates')
    if preferred is not None and not isinstance(preferred, list):
        raise ValueError("'preferred_dates' must be a list")
    preferred = [str(d) for d in (preferred or [])][:10]  # cap — it's day names from one email
    # The clock time the email asked for ("around noon" → "12:00"); '' when
    # absent or malformed — availability treats an unparseable time as absent.
    preferred_time = str(data.get('preferred_time') or '').strip()
    return busy or [], now, duration, preferred, preferred_time


@app.route('/availability/options', methods=['POST', 'OPTIONS'])
@limiter.limit(RATE_LIMITS, key_func=_rate_key, exempt_when=_is_preflight)
def availability_options_route():
    """
    Day/bucket choices for the availability wizard. No Claude call.

    Request body (JSON):
        {
            "busy": [{"start": "YYYY-MM-DDTHH:MM", "end": "..."}, ...],
            "now": "YYYY-MM-DDTHH:MM",      # user's local now
            "duration_minutes": 60,          # optional
            "preferred_dates": ["YYYY-MM-DD"] # optional — days the EMAIL asked for
        }

    Response: {"days": [{"date", "label", "buckets", "preferred"}],
               "unavailable_preferred": [{"date", "label"}]}
    Fully-booked days are omitted — the UI never offers a day that can't work.
    Asked-for days lead the list; booked ones are reported in
    unavailable_preferred so the UI can explain why they're missing.
    """
    denied = _request_gate()
    if denied:
        return denied

    try:
        busy, now, duration, preferred, preferred_time = \
            _parse_availability_request(request.get_json(silent=True))
        options = availability.build_options(
            busy, now, duration_minutes=duration, preferred_dates=preferred,
            preferred_time=preferred_time)
        return jsonify(options), 200
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    except Exception as exc:
        app.logger.error('Availability options failed: %s', exc)
        return jsonify({'error': 'Internal server error'}), 500


@app.route('/availability/recommend', methods=['POST', 'OPTIONS'])
@limiter.limit(RATE_LIMITS, key_func=_rate_key, exempt_when=_is_preflight)
def availability_recommend_route():
    """
    Recommend an exact slot for the chosen day + bucket and draft the reply.

    Request body (JSON): the options fields above, plus
        {
            "date": "YYYY-MM-DD",           # chosen day
            "bucket": "morning" | "midday" | "evening",
            "activity": "play tennis",
            "requester_name": "Sam",        # optional
            "sender": "sam@example.com",    # optional
            "subject": "Tennis?"            # optional, for the Re: subject
        }

    Response:
        {"date", "start_time", "end_time", "duration_minutes",
         "reply_subject", "reply_body"}
    409 when the bucket has no free slot (calendar changed since options).
    """
    denied = _request_gate()
    if denied:
        return denied

    data = request.get_json(silent=True)
    try:
        busy, now, duration, preferred, preferred_time = _parse_availability_request(data)
        day    = (data.get('date') or '').strip()
        bucket = (data.get('bucket') or '').strip()
        if not day or not bucket:
            raise ValueError("Missing required field: 'date' and 'bucket' are required")
        slot = availability.pick_slot(busy, day, bucket, duration_minutes=duration,
                                      now=now, preferred_time=preferred_time)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    except Exception as exc:
        app.logger.error('Availability recommend failed: %s', exc)
        return jsonify({'error': 'Internal server error'}), 500

    if slot is None:
        return jsonify({'error': 'No free slot in that time of day — pick another'}), 409

    start, end = slot

    # Was the exact time the email asked for free? (None when no time asked.)
    # Lets the popup explain "you're busy at noon, so here's the closest slot"
    # and the reply acknowledge the shift.
    asked_free = availability.asked_time_free(busy, day, preferred_time, duration)

    # Human description of what the email asked about, so the reply can
    # acknowledge when the proposal differs ("noon's no good, but 1 works").
    asked_labels = []
    for date_str in preferred:
        try:
            asked_labels.append(availability._day_label(date.fromisoformat(date_str)))
        except ValueError:
            continue
    asked_when = ', '.join(asked_labels)
    if preferred_time and asked_free is not None:
        asked_when = f"{asked_when or 'any day'} around {preferred_time}"
        if asked_free is False:
            asked_when += ' (the sender is BUSY at that exact time)'

    reply = composer.compose_reply(
        activity=(data.get('activity') or 'meet up').strip(),
        requester_name=(data.get('requester_name') or '').strip(),
        start=start,
        end=end,
        subject=(data.get('subject') or '').strip(),
        sender=(data.get('sender') or '').strip(),
        asked_when=asked_when,
    )

    return jsonify({
        'date': start.date().isoformat(),
        'start_time': start.strftime('%H:%M'),
        'end_time': end.strftime('%H:%M'),
        'duration_minutes': duration,
        'asked_time': preferred_time or None,
        'asked_time_free': asked_free,
        'reply_subject': reply['reply_subject'],
        'reply_body': reply['reply_body'],
    }), 200


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == '__main__':
    # Local dev only. In production, gunicorn imports `app:app` directly and this
    # block is not executed (see Dockerfile).
    #
    # Port: Cloud Run injects PORT (default 8080). Locally we default to 5001, not
    # 5000 — macOS AirPlay Receiver squats on 5000 and 403s every request.
    port  = int(os.getenv('PORT', 5001))
    debug = os.getenv('FLASK_ENV') == 'development'
    app.run(host='0.0.0.0', port=port, debug=debug)
