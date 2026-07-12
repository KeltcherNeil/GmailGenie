# MailGenie extraction service — container for Google Cloud Run.
#
# Cloud Run injects the PORT env var (default 8080) and expects the process to
# listen on it. gunicorn imports `app:app` directly, so app.py's __main__ block
# (local dev) is never used here.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8080

WORKDIR /app

# Install deps first so the layer caches when only source changes.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Shell form so $PORT expands at runtime. 2 workers × 4 threads is plenty for an
# I/O-bound service (each request is mostly waiting on the Anthropic API).
CMD exec gunicorn --bind ":$PORT" --workers 2 --threads 4 --timeout 60 app:app
