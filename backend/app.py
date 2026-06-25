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

load_dotenv()

app = Flask(__name__)


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


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == '__main__':
    port  = int(os.getenv('PORT', 5000))
    debug = os.getenv('FLASK_ENV') == 'development'
    app.run(host='0.0.0.0', port=port, debug=debug)
