"""
test_availability.py — Unit tests for the availability wizard's slot math and
routes. This is the "never recommend a time you're busy" guarantee: the logic
is deterministic Python (backend/availability.py), so it's tested exhaustively
here rather than trusted to a prompt.

Run from the project root:
    python tests/test_availability.py

No API key or network needed — the one Claude call (reply drafting) is mocked.
"""

import json
import os
import sys
import unittest
from datetime import datetime
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'backend'))

import availability
from availability import build_options, parse_busy, pick_slot, slot_starts

# A fixed "now": Tuesday, July 7, 2026, 9:30 AM. Candidate days start Wednesday.
NOW = '2026-07-07T09:30'
WED, THU, FRI, SAT = '2026-07-08', '2026-07-09', '2026-07-10', '2026-07-11'


def block(day, start, end):
    return {'start': f'{day}T{start}', 'end': f'{day}T{end}'}


def busy_all_day(day):
    """One block covering every bucket (8:00–21:00)."""
    return block(day, '08:00', '21:00')


class TestParseBusy(unittest.TestCase):

    def test_parses_and_sorts(self):
        intervals = parse_busy([block(THU, '14:00', '15:00'), block(WED, '09:00', '10:00')])
        self.assertEqual(len(intervals), 2)
        self.assertEqual(intervals[0][0], datetime(2026, 7, 8, 9, 0))

    def test_drops_malformed_blocks(self):
        intervals = parse_busy([
            {'start': 'garbage', 'end': 'also garbage'},
            {'start': f'{WED}T10:00'},                      # missing end
            None,                                            # not a dict
            block(WED, '15:00', '14:00'),                    # end before start
            block(WED, '09:00', '10:00'),                    # the one valid block
        ])
        self.assertEqual(len(intervals), 1)

    def test_empty_and_none(self):
        self.assertEqual(parse_busy(None), [])
        self.assertEqual(parse_busy([]), [])


class TestSlotStarts(unittest.TestCase):

    def test_free_day_offers_whole_bucket_grid(self):
        starts = slot_starts([], datetime(2026, 7, 8).date(), 'morning', 60)
        # 8:00–12:00 with 60-min slots on a 30-min grid → 8:00 ... 11:00
        self.assertEqual(starts[0], datetime(2026, 7, 8, 8, 0))
        self.assertEqual(starts[-1], datetime(2026, 7, 8, 11, 0))
        self.assertEqual(len(starts), 7)

    def test_slot_never_overlaps_busy(self):
        # Busy 9:00–10:30 → only 8:00 (ends 9:00, back-to-back OK), 10:30 and
        # 11:00 fit a 60-min slot in the morning bucket.
        intervals = parse_busy([block(WED, '09:00', '10:30')])
        starts = slot_starts(intervals, datetime(2026, 7, 8).date(), 'morning', 60)
        self.assertEqual([s.strftime('%H:%M') for s in starts], ['08:00', '10:30', '11:00'])

    def test_back_to_back_is_allowed(self):
        # Busy 9:00–10:00 → an 8:00–9:00 slot touching it is fine.
        intervals = parse_busy([block(WED, '09:00', '10:00')])
        starts = slot_starts(intervals, datetime(2026, 7, 8).date(), 'morning', 60)
        self.assertIn(datetime(2026, 7, 8, 8, 0), starts)
        self.assertIn(datetime(2026, 7, 8, 10, 0), starts)

    def test_duration_must_fit_inside_bucket(self):
        # Evening is 17:00–21:00; a 3-hour slot can start at 17:00/17:30/18:00 only.
        starts = slot_starts([], datetime(2026, 7, 8).date(), 'evening', 180)
        self.assertEqual([s.strftime('%H:%M') for s in starts], ['17:00', '17:30', '18:00'])

    def test_excludes_past_slots_today(self):
        now = datetime(2026, 7, 8, 10, 15)
        starts = slot_starts([], datetime(2026, 7, 8).date(), 'morning', 60, now=now)
        # Only slots strictly after 10:15 that still fit before 12:00.
        self.assertEqual([s.strftime('%H:%M') for s in starts], ['10:30', '11:00'])

    def test_unknown_bucket_raises(self):
        with self.assertRaises(ValueError):
            slot_starts([], datetime(2026, 7, 8).date(), 'brunch', 60)


class TestBuildOptions(unittest.TestCase):

    def test_free_calendar_offers_next_three_days(self):
        days = build_options([], NOW)
        self.assertEqual([d['date'] for d in days], [WED, THU, FRI])
        for d in days:
            self.assertEqual(d['buckets'], {'morning': True, 'midday': True, 'evening': True})

    def test_days_start_tomorrow_not_today(self):
        days = build_options([], NOW)
        self.assertNotIn('2026-07-07', [d['date'] for d in days])

    def test_fully_booked_day_is_not_offered(self):
        # Friday fully booked → the wizard must NOT offer Friday; Saturday takes its place.
        days = build_options([busy_all_day(FRI)], NOW)
        self.assertEqual([d['date'] for d in days], [WED, THU, SAT])

    def test_booked_bucket_is_marked_unavailable(self):
        # Thursday morning fully booked → Thursday still offered, morning disabled.
        days = build_options([block(THU, '08:00', '12:00')], NOW)
        thu = next(d for d in days if d['date'] == THU)
        self.assertEqual(thu['buckets'], {'morning': False, 'midday': True, 'evening': True})

    def test_bucket_with_gap_too_small_is_unavailable(self):
        # Morning busy except 8:00–8:45: no room for a 60-min slot on the grid.
        days = build_options([block(WED, '08:45', '12:00')], NOW, duration_minutes=60)
        wed = next(d for d in days if d['date'] == WED)
        self.assertFalse(wed['buckets']['morning'])
        # ...but a 30-min activity fits at 8:00.
        days = build_options([block(WED, '08:45', '12:00')], NOW, duration_minutes=30)
        wed = next(d for d in days if d['date'] == WED)
        self.assertTrue(wed['buckets']['morning'])

    def test_multi_day_event_blocks_every_covered_day(self):
        days = build_options([{'start': f'{WED}T00:00', 'end': f'{SAT}T00:00'}], NOW)
        self.assertEqual([d['date'] for d in days], [SAT, '2026-07-12', '2026-07-13'])

    def test_everything_booked_returns_empty(self):
        blocks = [busy_all_day(f'2026-07-{day:02d}') for day in range(8, 22)]
        self.assertEqual(build_options(blocks, NOW), [])

    def test_labels_are_human(self):
        days = build_options([], NOW)
        self.assertEqual(days[0]['label'], 'Wednesday, Jul 8')


class TestPickSlot(unittest.TestCase):

    def test_earliest_free_slot_wins(self):
        start, end = pick_slot([], THU, 'midday', 60)
        self.assertEqual(start, datetime(2026, 7, 9, 12, 0))
        self.assertEqual(end, datetime(2026, 7, 9, 13, 0))

    def test_slot_dodges_busy_blocks(self):
        busy = [block(THU, '12:00', '13:00'), block(THU, '13:30', '15:00')]
        start, _ = pick_slot(busy, THU, 'midday', 60)
        self.assertEqual(start, datetime(2026, 7, 9, 15, 0))

    def test_returns_none_when_bucket_full(self):
        self.assertIsNone(pick_slot([block(THU, '08:00', '12:00')], THU, 'morning', 60))

    def test_respects_now_for_same_day(self):
        start, _ = pick_slot([], '2026-07-07', 'morning', 60, now='2026-07-07T09:10')
        self.assertEqual(start, datetime(2026, 7, 7, 9, 30))


# ── Route tests (Flask test client, auth disabled, composer mocked) ───────────

class TestAvailabilityRoutes(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        # Auth/origin checks are disabled when their env vars are unset.
        os.environ.pop('GOOGLE_CLIENT_ID', None)
        os.environ.pop('ALLOWED_ORIGINS', None)
        import app as app_module
        cls.app_module = app_module
        cls.client = app_module.app.test_client()

    def post(self, path, payload):
        return self.client.post(path, data=json.dumps(payload),
                                content_type='application/json')

    def test_options_route(self):
        res = self.post('/availability/options',
                        {'busy': [busy_all_day(FRI)], 'now': NOW})
        self.assertEqual(res.status_code, 200)
        days = res.get_json()['days']
        self.assertEqual([d['date'] for d in days], [WED, THU, SAT])

    def test_options_requires_now(self):
        res = self.post('/availability/options', {'busy': []})
        self.assertEqual(res.status_code, 400)

    def test_recommend_route(self):
        canned = {'reply_subject': 'Re: Tennis?', 'reply_body': 'Thursday works!'}
        with patch.object(self.app_module.composer, 'compose_reply',
                          return_value=canned) as mock_compose:
            res = self.post('/availability/recommend', {
                'busy': [block(THU, '12:00', '13:00')],
                'now': NOW, 'date': THU, 'bucket': 'midday',
                'activity': 'play tennis', 'requester_name': 'Sam',
                'sender': 'sam@example.com', 'subject': 'Tennis?',
            })
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertEqual(data['start_time'], '13:00')   # dodged the 12:00 block
        self.assertEqual(data['end_time'], '14:00')
        self.assertEqual(data['reply_body'], 'Thursday works!')
        # The deterministic slot is what gets composed — not a model invention.
        self.assertEqual(mock_compose.call_args.kwargs['start'],
                         datetime(2026, 7, 9, 13, 0))

    def test_recommend_conflict_when_bucket_full(self):
        res = self.post('/availability/recommend', {
            'busy': [block(THU, '08:00', '12:00')],
            'now': NOW, 'date': THU, 'bucket': 'morning', 'activity': 'run',
        })
        self.assertEqual(res.status_code, 409)

    def test_recommend_rejects_unknown_bucket(self):
        res = self.post('/availability/recommend',
                        {'busy': [], 'now': NOW, 'date': THU, 'bucket': 'brunch'})
        self.assertEqual(res.status_code, 400)


if __name__ == '__main__':
    unittest.main(verbosity=2)
