/* Dates as spreadsheets keep them: a serial number of days since 1899-12-30, the time of day as its
 * fraction. All the arithmetic is UTC so a serial means the same day everywhere; only "today" and "now"
 * read the clock, and they read the local calendar of the machine the formula runs on, as a person
 * looking at their sheet expects. */

const DAY_MS = 86400000;
const EPOCH = Date.UTC(1899, 11, 30);

/** The serial of a calendar date and time; months and days out of range roll over as DATE() does. */
export function toSerial(y, m, d, h = 0, mi = 0, s = 0) {
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  t.setUTCHours(0, 0, 0, 0);
  return Math.round((t.getTime() - EPOCH) / DAY_MS) + (h * 3600 + mi * 60 + s) / 86400;
}

/** The calendar parts of a serial, rounded to the second: `{ y, m, d, h, mi, s, weekday }` (weekday 0 is Sunday). */
export function fromSerial(n) {
  let days = Math.floor(n);
  let secs = Math.round((n - days) * 86400);
  if (secs >= 86400) {
    days += 1;
    secs -= 86400;
  }
  const t = new Date(EPOCH + days * DAY_MS);
  return {
    y: t.getUTCFullYear(),
    m: t.getUTCMonth() + 1,
    d: t.getUTCDate(),
    h: Math.floor(secs / 3600),
    mi: Math.floor((secs % 3600) / 60),
    s: secs % 60,
    weekday: t.getUTCDay(),
  };
}

/** Today's serial (a whole number) on the local calendar of `now`. */
export const todaySerial = (now = new Date()) => toSerial(now.getFullYear(), now.getMonth() + 1, now.getDate());

/** This moment's serial on the local calendar and clock of `now`. */
export const nowSerial = (now = new Date()) =>
  toSerial(now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds() + now.getMilliseconds() / 1000);

/** The number of days in a month (1-based). */
export function daysInMonth(y, m) {
  const t = new Date(0);
  t.setUTCFullYear(y, m, 0);
  return t.getUTCDate();
}

/** Whether the date exists on the calendar. */
export const validDate = (y, m, d) => m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
