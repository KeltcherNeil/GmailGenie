"""
email_cleaner.py — Pre-processes raw email text before sending to the AI.

Removes quoted replies, email signatures, and HTML so the extractor
only sees the new, relevant content of the message.
"""

import re

# Lines that mark the start of an email signature — we stop reading here
_SIGNATURE_MARKERS = [
    r'^--\s*$',                          # Standard RFC 3676 signature delimiter
    r'^_{3,}$',                          # Underscores separator
    r'^-{3,}$',                          # Dashes separator
    r'^\*{3,}$',                         # Asterisks separator
    r'^Sent from (my )?(iPhone|Android|iPad|Samsung|Mail|Outlook)',
    r'^Get Outlook for',
    r'^This email (was sent|and any attachments)',
    r'^CONFIDENTIALITY NOTICE',
    r'^DISCLAIMER:',
]

_COMPILED_MARKERS = [re.compile(pat, re.IGNORECASE) for pat in _SIGNATURE_MARKERS]

# Matches the "On Mon, Jan 1 ... wrote:" header that precedes a quoted block
_QUOTE_HEADER = re.compile(
    r'^On\s+.{5,120}\s+wrote:\s*$',
    re.IGNORECASE | re.DOTALL,
)


def _strip_html(text: str) -> str:
    """Remove HTML tags and decode common entities."""
    text = re.sub(r'<style[^>]*>[\s\S]*?</style>', '', text, flags=re.IGNORECASE)
    text = re.sub(r'<script[^>]*>[\s\S]*?</script>', '', text, flags=re.IGNORECASE)
    text = re.sub(r'<br\s*/?>', '\n', text, flags=re.IGNORECASE)
    text = re.sub(r'<p[^>]*>', '\n', text, flags=re.IGNORECASE)
    text = re.sub(r'<[^>]+>', '', text)
    text = (text
            .replace('&nbsp;', ' ')
            .replace('&amp;', '&')
            .replace('&lt;', '<')
            .replace('&gt;', '>')
            .replace('&quot;', '"')
            .replace('&#39;', "'"))
    return text


def clean_email(text: str) -> str:
    """
    Clean raw email text for AI processing.

    Steps:
    1. Strip HTML tags and entities
    2. Remove quoted reply blocks (lines starting with '>')
    3. Remove the 'On ... wrote:' quote header
    4. Truncate at the first signature marker
    5. Normalize whitespace

    Returns the cleaned plain text, max ~3000 chars.
    """
    text = _strip_html(text)

    lines = text.split('\n')
    result = []
    skip_rest = False

    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        # Stop at a signature marker
        if any(pat.match(stripped) for pat in _COMPILED_MARKERS):
            skip_rest = True

        if skip_rest:
            break

        # Skip the "On ... wrote:" header (may span two lines in some clients)
        if _QUOTE_HEADER.match(stripped):
            i += 1
            continue

        # Skip quoted reply lines
        if stripped.startswith('>'):
            i += 1
            continue

        result.append(line)
        i += 1

    cleaned = '\n'.join(result)
    # Collapse runs of blank lines
    cleaned = re.sub(r'\n{3,}', '\n\n', cleaned)
    cleaned = cleaned.strip()

    # Cap length to keep API calls cheap
    return cleaned[:3000]
