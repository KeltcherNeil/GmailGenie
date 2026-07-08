"""
billing.py — Freemium quota metering (Firestore) + Stripe subscriptions.

Model:
  - Free tier: FREE_SCANS_PER_WEEK extractions per Google account per ISO week
    (UTC, resets Monday 00:00). The extension shows the counter and free users
    scan manually — auto-scan is a premium perk enforced client-side.
  - Premium:  $/month Stripe subscription → unlimited scans (the global
    RATE_LIMITS still apply as an abuse ceiling).

State lives in Firestore (same GCP project, free tier):
  users/{google_sub}:
      email, premium (bool), stripe_customer_id, stripe_subscription_id,
      week (e.g. "2026-W28"), used (int in that week)
  stripe_customers/{customer_id}: { user_id }   # reverse index for webhooks

Degradation: every dependency is optional and FAILS OPEN —
  - Firestore unreachable / not configured  → scans allowed, not metered
    (a metering outage must never take the product down).
  - Stripe keys unset → quota still enforced, but no upgrade path is offered
    (checkout/portal return 503; the popup hides the Upgrade button).
"""

import logging
import os
from datetime import datetime, timedelta, timezone

logger = logging.getLogger(__name__)

FREE_SCANS_PER_WEEK = int(os.getenv('FREE_SCANS_PER_WEEK', '10'))

STRIPE_SECRET_KEY     = os.getenv('STRIPE_SECRET_KEY', '').strip()
STRIPE_PRICE_ID       = os.getenv('STRIPE_PRICE_ID', '').strip()
STRIPE_WEBHOOK_SECRET = os.getenv('STRIPE_WEBHOOK_SECRET', '').strip()

# Where Stripe sends the user after checkout / managing their subscription.
BILLING_RETURN_URL = os.getenv('BILLING_RETURN_URL', 'https://getgenie-mail.xyz/upgraded.html')

_USERS = 'users'
_CUSTOMERS = 'stripe_customers'

# Firestore client, created lazily so the backend still boots (and dev still
# works) without GCP credentials.
_db = None
_db_failed = False


def _get_db():
    global _db, _db_failed
    if _db is None and not _db_failed:
        try:
            from google.cloud import firestore
            _db = firestore.Client()
        except Exception as exc:
            _db_failed = True
            logger.warning('Firestore unavailable — quota metering disabled: %s', exc)
    return _db


def metering_enabled() -> bool:
    return _get_db() is not None


def stripe_enabled() -> bool:
    return bool(STRIPE_SECRET_KEY and STRIPE_PRICE_ID)


def _get_stripe():
    import stripe
    stripe.api_key = STRIPE_SECRET_KEY
    return stripe


# ── Week bookkeeping ──────────────────────────────────────────────────────────

def week_key(now: datetime = None) -> str:
    """UTC ISO week key, e.g. '2026-W28'. The free counter resets when it changes."""
    now = now or datetime.now(timezone.utc)
    iso = now.isocalendar()
    return f'{iso.year}-W{iso.week:02d}'


def week_resets_at(now: datetime = None) -> str:
    """ISO datetime (UTC) of next Monday 00:00 — when the free counter resets."""
    now = now or datetime.now(timezone.utc)
    days_ahead = 7 - now.weekday()  # Monday=0 → next Monday
    monday = (now + timedelta(days=days_ahead)).replace(
        hour=0, minute=0, second=0, microsecond=0)
    return monday.strftime('%Y-%m-%dT%H:%M:%SZ')


def _status_dict(allowed, premium, used, metered=True):
    return {
        'allowed': allowed,
        'premium': premium,
        'used': used,
        'limit': FREE_SCANS_PER_WEEK,
        'resets_at': week_resets_at(),
        'metered': metered,
        'upgrade_available': stripe_enabled(),
    }


# ── Quota ─────────────────────────────────────────────────────────────────────

def _apply_scan(data: dict, week: str, email: str = ''):
    """
    Pure quota rule: given a user doc and the current week key, return
    (fields_to_write | None, status). None fields = scan denied, write nothing.
    Premium users are always allowed (usage still counted, for visibility);
    free users are allowed while used < FREE_SCANS_PER_WEEK, and the counter
    resets when the stored week key differs from the current one.
    """
    premium = bool(data.get('premium'))
    used = data.get('used', 0) if data.get('week') == week else 0

    if not premium and used >= FREE_SCANS_PER_WEEK:
        return None, _status_dict(False, False, used)

    update = {'week': week, 'used': used + 1}
    if email and data.get('email') != email:
        update['email'] = email
    return update, _status_dict(True, premium, used + 1)


def check_and_increment(user_id: str, email: str = '') -> dict:
    """
    Record one scan for `user_id` and say whether it is allowed (see
    _apply_scan for the rule). Runs in a Firestore transaction so concurrent
    scans can't slip past the limit. Fails OPEN: any Firestore error allows
    the scan un-metered.
    """
    db = _get_db()
    if db is None:
        return _status_dict(True, False, 0, metered=False)

    try:
        from google.cloud import firestore

        ref = db.collection(_USERS).document(user_id)
        week = week_key()

        @firestore.transactional
        def _txn(txn):
            snap = ref.get(transaction=txn)
            update, status = _apply_scan(snap.to_dict() if snap.exists else {},
                                         week, email=email)
            if update is not None:
                txn.set(ref, update, merge=True)
            return status

        return _txn(db.transaction())
    except Exception as exc:
        logger.warning('Quota check failed (allowing scan): %s', exc)
        return _status_dict(True, False, 0, metered=False)


def quota_status(user_id: str) -> dict:
    """Current quota state WITHOUT consuming a scan (popup 'x of 10 left' meter)."""
    db = _get_db()
    if db is None:
        return _status_dict(True, False, 0, metered=False)
    try:
        data = (db.collection(_USERS).document(user_id).get().to_dict()) or {}
        premium = bool(data.get('premium'))
        used = data.get('used', 0) if data.get('week') == week_key() else 0
        return _status_dict(premium or used < FREE_SCANS_PER_WEEK, premium, used)
    except Exception as exc:
        logger.warning('Quota status failed (reporting un-metered): %s', exc)
        return _status_dict(True, False, 0, metered=False)


# ── Stripe ────────────────────────────────────────────────────────────────────

def create_checkout_url(user_id: str, email: str = '') -> str:
    """A Stripe Checkout URL for the monthly subscription, tagged with user_id."""
    stripe = _get_stripe()
    session = stripe.checkout.Session.create(
        mode='subscription',
        line_items=[{'price': STRIPE_PRICE_ID, 'quantity': 1}],
        client_reference_id=user_id,
        customer_email=email or None,
        # Tag the subscription too, so subscription webhooks can find the user
        # even if the checkout event were ever missed.
        subscription_data={'metadata': {'user_id': user_id}},
        success_url=BILLING_RETURN_URL,
        cancel_url=BILLING_RETURN_URL,
        allow_promotion_codes=True,
    )
    return session.url


def create_portal_url(user_id: str) -> str | None:
    """Stripe customer-portal URL (manage/cancel), or None if never subscribed."""
    db = _get_db()
    if db is None:
        return None
    data = (db.collection(_USERS).document(user_id).get().to_dict()) or {}
    customer_id = data.get('stripe_customer_id')
    if not customer_id:
        return None
    stripe = _get_stripe()
    session = stripe.billing_portal.Session.create(
        customer=customer_id, return_url=BILLING_RETURN_URL)
    return session.url


def _set_premium(user_id: str, premium: bool, customer_id: str = None,
                 subscription_id: str = None):
    db = _get_db()
    if db is None:
        logger.error('Webhook for %s but Firestore unavailable — premium not stored!', user_id)
        return
    update = {'premium': premium}
    if customer_id:
        update['stripe_customer_id'] = customer_id
        db.collection(_CUSTOMERS).document(customer_id).set({'user_id': user_id})
    if subscription_id:
        update['stripe_subscription_id'] = subscription_id
    db.collection(_USERS).document(user_id).set(update, merge=True)
    logger.info('User %s premium=%s', user_id, premium)


def _user_for_customer(customer_id: str, metadata: dict) -> str | None:
    """Resolve a Stripe customer to our user id (metadata first, then index)."""
    user_id = (metadata or {}).get('user_id')
    if user_id:
        return user_id
    db = _get_db()
    if db is None or not customer_id:
        return None
    doc = db.collection(_CUSTOMERS).document(customer_id).get().to_dict() or {}
    return doc.get('user_id')


def handle_webhook(payload: bytes, signature: str) -> bool:
    """
    Process a Stripe webhook. Returns False for an invalid signature (→ 400,
    Stripe retries); True once handled (unrecognized events are ignored).

    Events wired in the Stripe dashboard:
      checkout.session.completed        → premium on
      customer.subscription.updated     → premium tracks status
      customer.subscription.deleted     → premium off
    """
    stripe = _get_stripe()
    try:
        event = stripe.Webhook.construct_event(payload, signature, STRIPE_WEBHOOK_SECRET)
    except Exception as exc:
        logger.warning('Stripe webhook signature verification failed: %s', exc)
        return False

    kind = event['type']
    obj = event['data']['object']

    if kind == 'checkout.session.completed':
        user_id = obj.get('client_reference_id')
        if user_id:
            _set_premium(user_id, True,
                         customer_id=obj.get('customer'),
                         subscription_id=obj.get('subscription'))
    elif kind in ('customer.subscription.updated', 'customer.subscription.deleted'):
        user_id = _user_for_customer(obj.get('customer'), obj.get('metadata'))
        if user_id:
            active = kind != 'customer.subscription.deleted' and \
                obj.get('status') in ('active', 'trialing')
            _set_premium(user_id, active, customer_id=obj.get('customer'))
        else:
            logger.warning('Stripe webhook %s: could not resolve user for customer %s',
                           kind, obj.get('customer'))

    return True
