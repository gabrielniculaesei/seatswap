/**
 * Reading an IATA Resolution 792 barcoded boarding pass (tier 1).
 *
 * Pure string work, no dependencies, no I/O — so it runs in the browser, which is
 * where it is meant to run. The raw barcode never reaches our server: the page
 * decodes it, this parser pulls out the handful of fields we cross-check, and only
 * those fields are posted.
 *
 * Two things this file deliberately does NOT do:
 *
 *  1. It never returns the passenger name. The name sits at a known offset and we
 *     skip straight over it. A parser that returned it would sooner or later have
 *     a caller that sent it somewhere, and §13.1 says we do not hold it — so the
 *     cheapest way to keep that promise is to make the name unobtainable here.
 *  2. It does not pretend to authenticate anything. BCBP's security section is
 *     optional, almost nobody populates it, and the signing keys are not public.
 *     We can *read* a boarding pass; we cannot *prove* one is real. What raises
 *     the cost of a fake is the cross-checking in verification.ts — the flight has
 *     to exist, the seat has to exist on that aircraft, and both the seat and the
 *     check-in sequence number have to be unclaimed on that flight.
 *
 * Layout (Res 792, format 'M'):
 *
 *   unique mandatory      1  format code 'M'
 *                         1  number of legs
 *                        20  passenger name        <- skipped, never returned
 *                         1  electronic ticket indicator
 *   per leg               7  operating carrier PNR <- skipped, we have no use for it
 *                         3  from / 3 to / 3 operating carrier
 *                         5  flight number
 *                         3  date of flight, day of year
 *                         1  compartment
 *                         4  seat number
 *                         5  check-in sequence number
 *                         1  passenger status
 *                         2  size of this leg's conditional section, hex
 *                        ..  conditional section, skipped wholesale
 */

export interface BoardingPassLeg {
  /** Operating carrier, IATA. 'W6'. */
  carrier: string;
  /** Without the carrier and without leading zeros. '3234', or '123A' with a suffix. */
  flightNumber: string;
  origin: string;
  destination: string;
  /** Day of the year, 1..366. BCBP carries no year; see resolveFlightDate. */
  dayOfYear: number;
  /** 'Y', 'J'… Kept only to show the traveller what we read. */
  compartment: string;
  /** '14A', or null for a passenger with no seat yet (an infant, or standby). */
  seat: string | null;
  /** Unique per flight, which is what makes it worth checking. */
  sequenceNumber: number | null;
}

export interface BoardingPass {
  legs: BoardingPassLeg[];
  /** From the conditional section's version marker, when there is one. */
  version: number | null;
}

export type BcbpResult =
  | { ok: true; pass: BoardingPass }
  | { ok: false; error: string };

/** What every failure says. Written to be shown to a person, not logged. */
const NOT_A_BOARDING_PASS =
  'That does not look like a boarding pass barcode. Scan the barcode itself, '
  + 'not the text printed around it.';

const TRUNCATED =
  'That boarding pass barcode is cut off. Try scanning it again, or send your '
  + 'seat number instead.';

class Scanner {
  private pos = 0;
  // Written out longhand rather than as a constructor parameter property: Node
  // strips types, it does not compile them, and a parameter property is syntax
  // that has to be compiled.
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  /** Returns null rather than a short string, so every caller has to handle it. */
  take(n: number): string | null {
    if (this.pos + n > this.text.length) return null;
    const slice = this.text.slice(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }

  /** Skips up to `n`, stopping at the end. Used for sections we throw away. */
  skip(n: number): void {
    this.pos = Math.min(this.pos + n, this.text.length);
  }

  peek(n: number): string {
    return this.text.slice(this.pos, this.pos + n);
  }

  get done(): boolean {
    return this.pos >= this.text.length;
  }
}

/** '03234' -> '3234', '0123A' -> '123A', '     ' -> null. */
function normaliseFlightNumber(raw: string): string | null {
  const match = /^0*(\d{1,4})([A-Z]?)$/.exec(raw.trim().toUpperCase());
  if (!match) return null;
  return `${match[1]}${match[2]}`;
}

/** '014A' -> '14A'. Anything else — 'INF', blanks, 'SBY' — is no seat at all. */
function normaliseSeat(raw: string): string | null {
  const match = /^0*(\d{1,3})([A-Z])$/.exec(raw.trim().toUpperCase());
  if (!match) return null;
  return `${match[1]}${match[2]}`;
}

/** '0031 ' -> 31. The trailing character is a check-in source indicator. */
function normaliseSequence(raw: string): number | null {
  const match = /^\s*(\d{1,4})\s*[A-Z0-9]?\s*$/.exec(raw.toUpperCase());
  if (!match) return null;
  return Number.parseInt(match[1], 10);
}

function isAirport(code: string): boolean {
  return /^[A-Z]{3}$/.test(code);
}

/**
 * Parse a raw BCBP string.
 *
 * Lenient about the parts we do not use and strict about the parts we do: a
 * boarding pass whose conditional section is truncated is still a perfectly good
 * source of a seat number, and refusing it would only make us wrong at somebody
 * holding a real ticket.
 */
export function parseBoardingPass(raw: string): BcbpResult {
  // Barcode readers and copy-paste both add whitespace at the ends; the payload
  // itself is fixed-width, so only the ends can safely be touched.
  const text = raw.replace(/\r/g, '').trim().toUpperCase();
  if (text.length === 0) return { ok: false, error: NOT_A_BOARDING_PASS };

  const scanner = new Scanner(text);

  // 1 format code + 1 leg count + 20 of passenger name + 1 electronic ticket
  // indicator. The name is inside this span and is never sliced back out.
  const header = scanner.take(23);
  if (header === null) return { ok: false, error: NOT_A_BOARDING_PASS };
  if (header[0] !== 'M') return { ok: false, error: NOT_A_BOARDING_PASS };

  const legCount = Number.parseInt(header[1], 10);
  if (!Number.isInteger(legCount) || legCount < 1 || legCount > 9) {
    return { ok: false, error: NOT_A_BOARDING_PASS };
  }

  const legs: BoardingPassLeg[] = [];
  let version: number | null = null;

  for (let leg = 0; leg < legCount; leg += 1) {
    scanner.skip(7); // operating carrier PNR: a booking reference we have no use for

    const origin = scanner.take(3);
    const destination = scanner.take(3);
    const carrierRaw = scanner.take(3);
    const flightRaw = scanner.take(5);
    const dateRaw = scanner.take(3);
    const compartmentRaw = scanner.take(1);
    const seatRaw = scanner.take(4);
    const sequenceRaw = scanner.take(5);
    const statusRaw = scanner.take(1);

    if (
      origin === null || destination === null || carrierRaw === null
      || flightRaw === null || dateRaw === null || compartmentRaw === null
      || seatRaw === null || sequenceRaw === null || statusRaw === null
    ) {
      // A first leg we cannot finish is not a boarding pass we can use at all.
      // A later one only costs us that leg, and the flight we care about is
      // almost always the first.
      if (leg === 0) return { ok: false, error: TRUNCATED };
      break;
    }

    const carrier = carrierRaw.trim();
    const flightNumber = normaliseFlightNumber(flightRaw);
    const dayOfYear = Number.parseInt(dateRaw.trim(), 10);

    if (
      !isAirport(origin) || !isAirport(destination)
      || !/^[A-Z0-9]{2,3}$/.test(carrier)
      || flightNumber === null
      || !Number.isInteger(dayOfYear) || dayOfYear < 1 || dayOfYear > 366
    ) {
      if (leg === 0) return { ok: false, error: NOT_A_BOARDING_PASS };
      break;
    }

    legs.push({
      carrier,
      flightNumber,
      origin,
      destination,
      dayOfYear,
      compartment: compartmentRaw.trim(),
      seat: normaliseSeat(seatRaw),
      sequenceNumber: normaliseSequence(sequenceRaw),
    });

    // The conditional section. We read its length only to step over it — it holds
    // the frequent flyer number, the bag tags and the issuing agent, none of which
    // we have any business keeping.
    const sizeRaw = scanner.take(2);
    if (sizeRaw === null) break;
    const size = Number.parseInt(sizeRaw.trim() || '0', 16);
    if (!Number.isInteger(size)) break;

    if (leg === 0 && scanner.peek(2)[0] === '>') {
      const marker = scanner.peek(2);
      const parsed = Number.parseInt(marker[1], 10);
      version = Number.isInteger(parsed) ? parsed : null;
    }

    scanner.skip(size);
    if (scanner.done) break;
    // '^' opens the optional security section, which is always last.
    if (scanner.peek(1) === '^') break;
  }

  if (legs.length === 0) return { ok: false, error: NOT_A_BOARDING_PASS };
  return { ok: true, pass: { legs, version } };
}

/** Day of the year, 1..366, for a 'YYYY-MM-DD' date. */
export function dayOfYearOf(isoDate: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
  if (!match) return null;
  const date = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(date)) return null;
  const startOfYear = Date.UTC(Number(match[1]), 0, 1);
  return Math.round((date - startOfYear) / 86_400_000) + 1;
}

/**
 * Turn a BCBP day-of-year into a real date, using the date we already expect.
 *
 * BCBP stores no year, which is only a problem within a few days of New Year: a
 * pass reading day 002 held against a flight on 31 December is next year's. So we
 * try the year before, the year itself and the year after, and keep whichever
 * lands closest to the flight we are checking against.
 */
export function resolveFlightDate(dayOfYear: number, near: string): string | null {
  if (!Number.isInteger(dayOfYear) || dayOfYear < 1 || dayOfYear > 366) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(near.trim());
  if (!match) return null;

  const reference = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  let best: { iso: string; distance: number } | null = null;

  for (const year of [Number(match[1]) - 1, Number(match[1]), Number(match[1]) + 1]) {
    const stamp = Date.UTC(year, 0, 1) + (dayOfYear - 1) * 86_400_000;
    const iso = new Date(stamp).toISOString().slice(0, 10);
    // Day 366 of a common year does not exist; Date rolls it into January, and a
    // pass claiming it is wrong rather than a year out.
    if (Number(iso.slice(0, 4)) !== year) continue;

    const distance = Math.abs(stamp - reference);
    if (best === null || distance < best.distance) best = { iso, distance };
  }

  return best?.iso ?? null;
}
