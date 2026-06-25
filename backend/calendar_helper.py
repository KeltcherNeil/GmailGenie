"""
calendar_helper.py — Google Calendar API helpers.

NOTE: The Chrome extension currently uses a Google Calendar deeplink URL
as the simpler path to calendar creation (no OAuth required on the
extension side). This module is for future server-side calendar writes —
e.g. creating events on behalf of users via stored OAuth tokens.
"""

import os
from datetime import datetime, timedelta, date

from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request
from googleapiclient.discovery import build

SCOPES = ['https://www.googleapis.com/auth/calendar.events']

# Default timezone — will be replaced once timezone detection is implemented
DEFAULT_TIMEZONE = 'America/New_York'


def get_calendar_service(
    token_path: str = 'token.json',
    credentials_path: str = 'credentials.json',
):
    """
    Build and return an authenticated Google Calendar API service object.

    On first run, opens a browser for OAuth consent and writes token.json.
    On subsequent runs, refreshes the token automatically.

    Args:
        token_path:       Path to store/read the OAuth token file.
        credentials_path: Path to the Google OAuth client secrets JSON
                          (downloaded from Google Cloud Console).
    """
    creds = None

    if os.path.exists(token_path):
        creds = Credentials.from_authorized_user_file(token_path, SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(credentials_path, SCOPES)
            creds = flow.run_local_server(port=0)

        with open(token_path, 'w') as fh:
            fh.write(creds.to_json())

    return build('calendar', 'v3', credentials=creds)


def build_event_body(event_data: dict, timezone: str = DEFAULT_TIMEZONE) -> dict:
    """
    Convert an extracted event dict (from extractor.py) into a Google
    Calendar API event resource body.

    Args:
        event_data: Dict returned by extractor.extract_event().
        timezone:   IANA timezone string for the event.

    Returns:
        A dict ready to pass to service.events().insert(body=...).
    """
    body: dict = {
        'summary': event_data.get('title') or 'Event from GmailGenie',
    }

    # ── Date / time ──────────────────────────────────────────────────────────
    event_date = event_data.get('date')
    event_time = event_data.get('time')
    duration   = event_data.get('duration_minutes') or 60

    if event_date and event_time:
        start_dt = datetime.fromisoformat(f"{event_date}T{event_time}:00")
        end_dt   = start_dt + timedelta(minutes=duration)
        body['start'] = {'dateTime': start_dt.isoformat(), 'timeZone': timezone}
        body['end']   = {'dateTime': end_dt.isoformat(),   'timeZone': timezone}
    elif event_date:
        # All-day event
        next_day = (date.fromisoformat(event_date) + timedelta(days=1)).isoformat()
        body['start'] = {'date': event_date}
        body['end']   = {'date': next_day}

    # ── Optional fields ───────────────────────────────────────────────────────
    if event_data.get('location'):
        body['location'] = event_data['location']

    if event_data.get('description'):
        body['description'] = event_data['description']

    if event_data.get('attendees'):
        body['attendees'] = [{'email': e} for e in event_data['attendees']]

    return body


def create_event(service, event_data: dict, timezone: str = DEFAULT_TIMEZONE) -> dict:
    """
    Insert a new event into the user's primary Google Calendar.

    Args:
        service:    Authenticated Calendar API service (from get_calendar_service).
        event_data: Dict returned by extractor.extract_event().
        timezone:   IANA timezone string.

    Returns:
        The created event resource dict (includes 'id', 'htmlLink', etc.).
    """
    body = build_event_body(event_data, timezone)
    return (
        service.events()
        .insert(calendarId='primary', body=body, sendUpdates='all')
        .execute()
    )
