"""
app.py — Main Flask app and API routes.

All route definitions live here. Business logic lives in helper modules:
  - email_cleaner.py  → cleans raw email text
  - extractor.py      → calls Claude API, returns structured event JSON
  - calendar_helper.py → Google Calendar API (future)
"""

import os

from flask import Flask, request, jsonify
from dotenv import load_dotenv

from email_cleaner import clean_email
from extractor import extract_event
from calendar_helper import get_calendar_service, create_event

load_dotenv()

app = Flask(__name__)


# ── CORS ─────────────────────────────────────────────────────────────────────
# The Chrome extension calls this backend from a background service worker.
# With the matching host permission that request usually bypasses CORS, but we
# answer preflight/OPTIONS and echo the headers so it works regardless of how
# Chrome classifies the request.

@app.after_request
def add_cors_headers(response):
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    return response


# ── Health check ─────────────────────────────────────────────────────────────

@app.route('/health', methods=['GET'])
def health():
    """Simple liveness probe. Returns 200 when the server is running."""
    return jsonify({'status': 'ok'}), 200


# ── Event extraction ─────────────────────────────────────────────────────────

@app.route('/extract-event', methods=['POST'])
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
    data = request.get_json(silent=True)

    if not data:
        return jsonify({'error': 'Request body must be JSON'}), 400

    subject = (data.get('subject') or '').strip()
    body    = (data.get('body')    or '').strip()
    sender  = (data.get('sender')  or '').strip()

    if not body:
        return jsonify({'error': "Missing required field: 'body'"}), 400

    # Clean before sending to AI — removes signatures, quoted replies, HTML
    cleaned_body = clean_email(body)

    try:
        event = extract_event(subject=subject, body=cleaned_body, sender=sender)
        return jsonify(event), 200

    except ValueError as exc:
        # Unparseable AI output
        app.logger.warning('Extraction parse error: %s', exc)
        return jsonify({'error': str(exc)}), 422

    except Exception as exc:
        # Unexpected errors (API down, network issues, etc.)
        app.logger.error('Extraction failed: %s', exc)
        return jsonify({'error': 'Internal server error'}), 500


# ── Event creation ───────────────────────────────────────────────────────────

@app.route('/create-event', methods=['POST', 'OPTIONS'])
def create_event_route():
    """
    Create an event directly on the user's primary Google Calendar.

    This is what powers the extension's "Add to Calendar" button: the event is
    written straight to Google Calendar via the API — no calendar webpage opens
    and there is no manual Save step.

    Request body (JSON) — the (possibly edited) event object:
        {
            "title": "string",
            "date":  "YYYY-MM-DD",         # required
            "time":  "HH:MM" | null,       # omit/null for an all-day event
            "duration_minutes": int | null,
            "location":    "string" | null,
            "description": "string" | null,
            "attendees":   ["a@b.com", ...] | null
        }

    Response (JSON):
        On success — { "ok": true, "id": "...", "htmlLink": "https://..." }
        On error   — { "ok": false, "error": "description" }
    """
    if request.method == 'OPTIONS':
        # CORS preflight — headers are added by add_cors_headers.
        return ('', 204)

    data = request.get_json(silent=True)

    if not data:
        return jsonify({'ok': False, 'error': 'Request body must be JSON'}), 400

    if not (data.get('date') or '').strip():
        return jsonify({'ok': False, 'error': "Missing required field: 'date'"}), 400

    try:
        service = get_calendar_service()
        created = create_event(service, data)
        return jsonify({
            'ok': True,
            'id': created.get('id'),
            'htmlLink': created.get('htmlLink'),
        }), 200

    except FileNotFoundError as exc:
        # credentials.json missing — OAuth client not set up yet
        app.logger.error('Calendar credentials missing: %s', exc)
        return jsonify({
            'ok': False,
            'error': 'Google OAuth not configured. Add backend/credentials.json '
                     '(a Desktop OAuth client from Google Cloud Console).'
        }), 500

    except Exception as exc:
        app.logger.error('Event creation failed: %s', exc)
        return jsonify({'ok': False, 'error': str(exc)}), 500


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == '__main__':
    port  = int(os.getenv('PORT', 5000))
    debug = os.getenv('FLASK_ENV') == 'development'
    app.run(host='0.0.0.0', port=port, debug=debug)
