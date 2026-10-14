// Business days in an account's own timezone (Monday to Friday; weekends don't count). Used for automatic
// follow-ups: "no reply for 10 business days" comes due at 9:00 on a weekday, local time of the account.

/** The local calendar day and weekday (0 = Sunday) of an instant in a timezone. */
export function localDay(at: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), weekday };
}

export const isWeekend = (at: Date, timeZone: string) => [0, 6].includes(localDay(at, timeZone).weekday);

/** How far the timezone is ahead of UTC at that instant, in milliseconds. */
function offsetMs(at: Date, timeZone: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
      .formatToParts(at)
      .map((x) => [x.type, Number(x.value)]),
  );
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at.getTime() / 1000) * 1000;
}

/** The instant of a local wall-clock time in a timezone (daylight saving included). */
export function atLocalTime(year: number, month: number, day: number, hour: number, minute: number, timeZone: string) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - offsetMs(new Date(guess), timeZone);
  // Around a daylight-saving change the offset at the guess differs from the one at the result: correct once.
  return new Date(guess - offsetMs(new Date(first), timeZone));
}

/** `hour`:00 local time on the `days`-th business day after the local day of `from`. */
export function addBusinessDays(from: Date, days: number, timeZone: string, hour = 9) {
  const d = localDay(from, timeZone);
  // Walk calendar days at noon UTC (no daylight-saving edge) and count only Monday to Friday.
  const cursor = new Date(Date.UTC(d.year, d.month - 1, d.day, 12));
  let left = days;
  while (left > 0) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const wd = cursor.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return atLocalTime(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, cursor.getUTCDate(), hour, 0, timeZone);
}
