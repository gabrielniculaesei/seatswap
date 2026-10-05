/**
 * Dates as the pages print them. Fixed English month names rather than
 * Intl/toLocaleString, so the server's locale and time zone can never change
 * what a page says, and the output is the same in a test as in production.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-10-12' -> '12 Oct 2026'. A calendar date, so no time zone is involved. */
export function formatDay(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

/** A moment, to the day, in UTC: '11 Oct 2026'. */
export function formatUtcDay(moment: Date): string {
  return formatDay(moment.toISOString().slice(0, 10));
}

/** A moment, to the minute, in UTC: '11 Oct 2026, 08:40 UTC'. */
export function formatUtcMinute(moment: Date): string {
  return `${formatUtcDay(moment)}, ${moment.toISOString().slice(11, 16)} UTC`;
}
