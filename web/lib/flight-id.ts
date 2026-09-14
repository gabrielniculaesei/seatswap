/**
 * Parsing and formatting the pieces of a flight URL.
 *
 * Kept apart from flights.ts so it can be tested without a database: these are
 * pure functions, and they guard the one route anybody can type by hand.
 */

export interface FlightSlug {
  carrier: string;
  flightNumber: string;
}

const SLUG_PATTERN = /^([A-Z0-9]{2})-([0-9]{1,4}[A-Z]?)$/i;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse `W6-3234` from the shareable URL. Returns null if it is not one. */
export function parseFlightSlug(slug: string): FlightSlug | null {
  const match = SLUG_PATTERN.exec(slug.trim());
  if (!match) return null;
  return { carrier: match[1].toUpperCase(), flightNumber: match[2].toUpperCase() };
}

export function formatFlightSlug(carrier: string, flightNumber: string): string {
  return `${carrier.toUpperCase()}-${flightNumber.toUpperCase()}`;
}

/**
 * Validate a `YYYY-MM-DD` departure date.
 *
 * Bounded on both sides on purpose. A date in the past cannot be swapped, and a
 * date years out is somebody walking the URL space — either would otherwise
 * create a junk flight row and spend an AeroDataBox call on it, and that quota is
 * the one genuinely scarce resource here (CLAUDE.md §11).
 */
export function parseDepartureDate(value: string, today: Date = new Date()): string | null {
  const trimmed = value.trim();
  if (!DATE_PATTERN.test(trimmed)) return null;

  const parsed = new Date(`${trimmed}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  // Rejects real-looking nonsense like 2026-02-31, which Date rolls over.
  if (parsed.toISOString().slice(0, 10) !== trimmed) return null;

  const startOfToday = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
  );
  const dayMs = 24 * 60 * 60 * 1000;
  // One day of slack behind: a flight departing "yesterday" in UTC may still be
  // in the air, or boarding somewhere west of here.
  if (parsed.getTime() < startOfToday - dayMs) return null;
  if (parsed.getTime() > startOfToday + 365 * dayMs) return null;

  return trimmed;
}

/**
 * Normalise whatever someone pasted into the search box.
 * People copy flight numbers from boarding passes, emails and screenshots, so
 * 'W6 3234', 'w63234' and 'W6-3234' all have to mean the same thing.
 */
export function normaliseFlightInput(raw: string): string {
  const compact = raw.trim().replace(/\s+/g, '');
  if (compact.includes('-')) return compact.toUpperCase();
  return compact.replace(/^([A-Za-z0-9]{2})/, '$1-').toUpperCase();
}
