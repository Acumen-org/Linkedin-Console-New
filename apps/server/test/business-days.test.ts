import assert from 'node:assert/strict';
import test from 'node:test';
import { addBusinessDays, atLocalTime, isWeekend, localDay } from '../src/lib/business-days.ts';

test('local day and weekday in the account timezone', () => {
  // 2026-10-16 20:00 UTC is already Saturday morning in Bangkok (UTC+7), still Friday in Chicago.
  const at = new Date('2026-10-16T20:00:00Z');
  assert.deepEqual(localDay(at, 'Asia/Bangkok'), { year: 2026, month: 10, day: 17, weekday: 6 });
  assert.equal(isWeekend(at, 'Asia/Bangkok'), true);
  assert.equal(isWeekend(at, 'America/Chicago'), false);
});

test('9:00 local time, daylight saving included', () => {
  assert.equal(atLocalTime(2026, 10, 19, 9, 0, 'Asia/Bangkok').toISOString(), '2026-10-19T02:00:00.000Z');
  assert.equal(atLocalTime(2026, 7, 6, 9, 0, 'America/Chicago').toISOString(), '2026-07-06T14:00:00.000Z'); // CDT, UTC-5
  assert.equal(atLocalTime(2026, 12, 7, 9, 0, 'America/Chicago').toISOString(), '2026-12-07T15:00:00.000Z'); // CST, UTC-6
  // The Monday right after the switch back to standard time (1 Nov 2026).
  assert.equal(atLocalTime(2026, 11, 2, 9, 0, 'America/Chicago').toISOString(), '2026-11-02T15:00:00.000Z');
});

test('business days skip weekends', () => {
  // Friday 16 Oct 2026 (Bangkok) + 1 business day = Monday 19 Oct, 9:00 local.
  const friday = new Date('2026-10-16T05:00:00Z');
  assert.equal(addBusinessDays(friday, 1, 'Asia/Bangkok').toISOString(), '2026-10-19T02:00:00.000Z');
  // + 10 business days = two weeks later, Friday 30 Oct.
  assert.equal(addBusinessDays(friday, 10, 'Asia/Bangkok').toISOString(), '2026-10-30T02:00:00.000Z');
  // Sent on a Saturday: counting starts Monday, so + 1 = Monday.
  const saturday = new Date('2026-10-17T05:00:00Z');
  assert.equal(addBusinessDays(saturday, 1, 'Asia/Bangkok').toISOString(), '2026-10-19T02:00:00.000Z');
  // Never lands on a weekend.
  for (let n = 1; n <= 30; n++) assert.equal(isWeekend(addBusinessDays(friday, n, 'America/Chicago'), 'America/Chicago'), false);
});
