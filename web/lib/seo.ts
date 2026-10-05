/**
 * Metadata, canonical URLs and structured data for the pages that get indexed.
 *
 * Flight pages are the only acquisition channel with the right granularity:
 * somebody searching their own flight number is exactly the person this is for
 * (CLAUDE.md §5). That makes SEO a product feature rather than a chore, and it
 * makes two things matter more than the usual tag-filling:
 *
 *  1. **Only pages with something on them get indexed.** The flight URL space is
 *     every carrier times every flight number times a year of dates — tens of
 *     millions of addresses, all of which render. Letting a crawler index the
 *     empty ones would offer Google millions of near-identical thin pages, which
 *     is how a site gets classified as spam and loses the rankings it does
 *     deserve. So a flight page is `noindex, follow` until somebody signs up for
 *     it, and enters the sitemap at the same moment. `follow` matters: the links
 *     still get crawled, so a shared link to an empty flight is not a dead end.
 *
 *  2. **We only claim what we know.** Structured data is only emitted once
 *     AeroDataBox has actually confirmed the flight. Marking up a route we
 *     guessed would be inventing facts about a real flight, which is worse than
 *     having no structured data at all.
 *
 * Pure functions, so they can be tested without a database or a request.
 */

export const DEFAULT_SITE_URL = 'http://localhost:3000';

/** The public origin, without a trailing slash. */
export function siteUrl(env: Record<string, string | undefined> = process.env): string {
  const raw = (env.PUBLIC_BASE_URL ?? '').trim();
  if (!raw) return DEFAULT_SITE_URL;
  return raw.replace(/\/+$/, '');
}

/**
 * The canonical path for a flight page.
 *
 * One spelling, always: `/f/W6-3234/2026-10-12`. Case and padding vary in the
 * wild — people paste `w6-3234` out of an email — and every variant renders, so
 * without a canonical they would compete with each other in the index.
 */
export function flightPath(carrier: string, flightNumber: string, departureDate: string): string {
  return `/f/${carrier.toUpperCase()}-${flightNumber.toUpperCase()}/${departureDate}`;
}

export function absoluteUrl(path: string, env?: Record<string, string | undefined>): string {
  return `${siteUrl(env)}${path.startsWith('/') ? path : `/${path}`}`;
}

export interface FlightMetaInput {
  carrier: string;
  flightNumber: string;
  departureDate: string;
  origin?: string | null;
  destination?: string | null;
  /** Signed-up parties. Zero means the page has nothing on it yet. */
  parties?: number;
}

export interface FlightMeta {
  title: string;
  description: string;
  canonical: string;
  index: boolean;
}

/**
 * Title and description for a flight page.
 *
 * The description names the route when we know it, because "OTP to BGY" is what
 * somebody recognises as their own flight, and stays vague when we do not rather
 * than asserting a route we guessed.
 */
export function flightMeta(input: FlightMetaInput): FlightMeta {
  const designator = `${input.carrier.toUpperCase()}${input.flightNumber.toUpperCase()}`;
  const route = input.origin && input.destination
    ? `${input.origin.toUpperCase()} to ${input.destination.toUpperCase()}`
    : null;

  const title = route
    ? `${designator} ${route} on ${input.departureDate}: seat swaps`
    : `${designator} on ${input.departureDate}: seat swaps`;

  const description =
    `Swap into a better seat on ${designator}${route ? `, ${route}` : ''}, departing `
    + `${input.departureDate}. Say which seat you have and which one you want; if there `
    + 'is a trade where everyone gains, we find it. Free, no negotiating.';

  return {
    title,
    description,
    canonical: flightPath(input.carrier, input.flightNumber, input.departureDate),
    index: (input.parties ?? 0) > 0,
  };
}

export interface FlightJsonLdInput {
  carrier: string;
  flightNumber: string;
  departureDate: string;
  origin: string | null;
  destination: string | null;
  aircraftType: string | null;
  scheduledDepartureUtc: Date | string | null;
  /** Only 'verified' flights get structured data at all. */
  apiStatus: string;
  url: string;
}

/**
 * schema.org markup for a flight page, or null when we should stay quiet.
 *
 * Shaped as a WebPage *about* a Flight rather than as a bare Flight: we are not
 * the airline and this page is not the flight, it is a page about it. Every field
 * is omitted unless we actually hold it, so nothing here is ever a guess.
 */
/** Is this instant within a day of that calendar date? */
function agreesWithDate(instant: Date, isoDate: string): boolean {
  if (Number.isNaN(instant.getTime())) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
  if (!match) return false;

  const midnight = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Math.abs(instant.getTime() - midnight) <= 36 * 60 * 60 * 1000;
}

export function flightJsonLd(input: FlightJsonLdInput): Record<string, unknown> | null {
  if (input.apiStatus !== 'verified') return null;

  const designator = `${input.carrier.toUpperCase()}${input.flightNumber.toUpperCase()}`;
  const flight: Record<string, unknown> = {
    '@type': 'Flight',
    flightNumber: designator,
    provider: { '@type': 'Airline', iataCode: input.carrier.toUpperCase() },
  };

  if (input.origin) {
    flight.departureAirport = { '@type': 'Airport', iataCode: input.origin.toUpperCase() };
  }
  if (input.destination) {
    flight.arrivalAirport = { '@type': 'Airport', iataCode: input.destination.toUpperCase() };
  }
  if (input.scheduledDepartureUtc) {
    const departure = input.scheduledDepartureUtc instanceof Date
      ? input.scheduledDepartureUtc
      : new Date(input.scheduledDepartureUtc);
    // Only if the instant actually belongs to the day this page is about. A local
    // departure date and a UTC instant can legitimately sit a day apart, so a
    // day of slack either side is normal; more than that means the row and the
    // page disagree, and structured data that contradicts the page it sits on is
    // worse than none at all.
    if (agreesWithDate(departure, input.departureDate)) {
      flight.departureTime = departure.toISOString();
    }
  }
  if (input.aircraftType) flight.aircraft = input.aircraftType;

  return {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    url: input.url,
    name: `${designator} on ${input.departureDate}: seat swaps`,
    about: flight,
  };
}
