/**
 * Flight and party queries for the web tier.
 *
 * The web never calls AeroDataBox in-request. A flight nobody has
 * mentioned before is created as `unknown` and a `verify_flight` job is queued;
 * the page renders immediately with an estimated seat map and fills in when the
 * worker gets to it. That keeps a third-party API out of the render path of the
 * pages that have to be fast and indexable.
 */

import sql from './db.ts';
import {
  type FlightSlug,
  formatFlightSlug,
  parseDepartureDate,
  parseFlightSlug,
} from './flight-id.ts';
import {
  maxNewFlightsPerDay,
  newFlightsCreatedRecently,
  quotaMessage,
  recordFlightCreation,
} from './flight-quota.ts';
import { requestFlightVerification } from './jobs.ts';
import { loadSeatMap } from './seatmap.ts';

export { formatFlightSlug, parseDepartureDate, parseFlightSlug };
export type { FlightSlug };

/**
 * Aggregate state of a flight. Deliberately holds no names and no seats: this is
 * what a stranger who has not signed up is allowed to see.
 */
export interface FlightSummary {
  parties: number;
  travellers: number;
  wantAdjacency: number;
  wantWindow: number;
  wantAisle: number;
  seatsSubmitted: number;
  /** How many of them read their seats off a boarding pass. */
  verified: number;
}

export interface Flight {
  id: number;
  carrier: string;
  flight_number: string;
  departure_date: string;
  origin: string | null;
  destination: string | null;
  aircraft_type: string | null;
  seat_map_key: string | null;
  scheduled_departure_utc: Date | null;
  checkin_opens_utc: Date | null;
  api_status: 'verified' | 'unknown' | 'not_found';
  /** When verify_flight ran, whatever it found. Null means it has not run yet. */
  api_verified_at: Date | null;
}

export async function findFlight(
  carrier: string,
  flightNumber: string,
  departureDate: string,
): Promise<Flight | null> {
  const rows = await sql<Flight[]>`
    SELECT * FROM flights
     WHERE carrier = ${carrier.toUpperCase()}
       AND flight_number = ${flightNumber.toUpperCase()}
       AND departure_date = ${departureDate}
  `;
  return rows[0] ?? null;
}

/**
 * Find the flight, or create it and queue its verification.
 *
 * **Only call this from an authenticated action, never from a page render.**
 *
 * Rendering a flight page used to create the row. That was fine while nothing
 * linked here, and became a liability the moment the flight pages were made
 * indexable: the URL space is every carrier times every flight
 * number times a year of dates, every one of those addresses renders, and each
 * new one would have written a `flights` row and queued a `verify_flight` job. A
 * crawler walking that space would exhaust the AeroDataBox free tier — about 600
 * calls a month, the one genuinely scarce resource here — in an
 * afternoon, and fill the table with flights nobody ever asked about.
 *
 * So the row is created when somebody signs up, which takes a Telegram account.
 * That makes "one API call per flight" stronger than before rather than weaker:
 * a flight nobody has signed up for now costs nothing at all.
 *
 * `ON CONFLICT DO NOTHING` plus a re-read handles two people signing up for the
 * same flight at the same moment: one inserts, both read the same row, and only
 * the insert that won queues a job.
 */
export async function findOrCreateFlight(
  carrier: string,
  flightNumber: string,
  departureDate: string,
): Promise<{ flight: Flight; created: boolean }> {
  const existing = await findFlight(carrier, flightNumber, departureDate);
  if (existing) return { flight: existing, created: false };

  const inserted = await sql<Flight[]>`
    INSERT INTO flights (carrier, flight_number, departure_date, api_status)
    VALUES (${carrier.toUpperCase()}, ${flightNumber.toUpperCase()}, ${departureDate}, 'unknown')
    ON CONFLICT (carrier, flight_number, departure_date) DO NOTHING
    RETURNING *
  `;

  if (inserted.length === 0) {
    const raced = await findFlight(carrier, flightNumber, departureDate);
    if (!raced) throw new Error('flight vanished between insert and read');
    return { flight: raced, created: false };
  }

  await requestFlightVerification(inserted[0].id);
  return { flight: inserted[0], created: true };
}

export type FlightForUser =
  | { ok: true; flight: Flight; created: boolean }
  | { ok: false; message: string };

/**
 * Get the flight a signed-in person is signing up for, creating it if new.
 *
 * The one entry point sign-up should use. It separates the two cases that look
 * identical from the outside and are not: joining a flight that already exists is
 * free and unmetered, while calling a flight into existence spends this account's
 * daily allowance because it spends an AeroDataBox call.
 */
export async function flightForUser(
  carrier: string,
  flightNumber: string,
  departureDate: string,
  telegramUserId: number,
): Promise<FlightForUser> {
  const existing = await findFlight(carrier, flightNumber, departureDate);
  if (existing) return { ok: true, flight: existing, created: false };

  const limit = maxNewFlightsPerDay();
  if (await newFlightsCreatedRecently(telegramUserId) >= limit) {
    return { ok: false, message: quotaMessage(limit) };
  }

  const { flight, created } = await findOrCreateFlight(carrier, flightNumber, departureDate);
  // Only a genuine creation is charged. Losing the race to create a flight means
  // somebody else paid for it, so this account is not billed for it.
  if (created) await recordFlightCreation(telegramUserId);

  return { ok: true, flight, created };
}

/** Counts only. No names, no seats, nothing that identifies anybody. */
export async function flightSummary(flightId: number): Promise<FlightSummary> {
  const rows = await sql<
    {
      parties: string;
      travellers: string;
      want_adjacency: string;
      want_window: string;
      want_aisle: string;
      seats_submitted: string;
      verified: string;
    }[]
  >`
    SELECT count(*)                                             AS parties,
           COALESCE(sum(size), 0)                               AS travellers,
           count(*) FILTER (WHERE w_adjacency > 0)              AS want_adjacency,
           count(*) FILTER (WHERE w_window > 0)                 AS want_window,
           count(*) FILTER (WHERE w_aisle > 0)                  AS want_aisle,
           count(*) FILTER (WHERE seats_submitted_at IS NOT NULL) AS seats_submitted,
           count(*) FILTER (WHERE verification_tier > 0)          AS verified
      FROM parties
     WHERE flight_id = ${flightId}
       AND state NOT IN ('withdrawn', 'expired')
  `;
  const row = rows[0];
  return {
    parties: Number(row.parties),
    travellers: Number(row.travellers),
    wantAdjacency: Number(row.want_adjacency),
    wantWindow: Number(row.want_window),
    wantAisle: Number(row.want_aisle),
    seatsSubmitted: Number(row.seats_submitted),
    verified: Number(row.verified),
  };
}

export interface SitemapFlight {
  carrier: string;
  flight_number: string;
  departure_date: string;
  last_modified: Date;
}

/**
 * The flight pages worth putting in the sitemap.
 *
 * Exactly the pages that are indexable: a flight somebody has signed up for, that
 * has not departed. Offering a crawler anything else would contradict the
 * `noindex` those pages carry, and mismatched signals are worse than no sitemap.
 * `last_modified` is when the page's content last actually changed, which for a
 * flight page means when somebody last joined it.
 */
export async function sitemapFlights(limit = 5_000): Promise<SitemapFlight[]> {
  return sql<SitemapFlight[]>`
    SELECT f.carrier, f.flight_number, f.departure_date,
           max(p.created_at) AS last_modified
      FROM flights f
      JOIN parties p ON p.flight_id = f.id
     WHERE p.state NOT IN ('withdrawn', 'expired')
       AND f.departure_date >= current_date
     GROUP BY f.id, f.carrier, f.flight_number, f.departure_date
     ORDER BY max(p.created_at) DESC
     LIMIT ${limit}
  `;
}

export interface PartyRow {
  id: number;
  display_name: string;
  size: number;
  state: string;
  verification_tier: number;
  /** Members under 16, who may not be swapped into an exit row (migration 0005). */
  children: number;
  w_window: number;
  w_aisle: number;
  w_front: number;
  w_avoid_middle: number;
  w_avoid_lavatory: number;
  w_adjacency: number;
}

export async function partyFor(
  flightId: number,
  telegramUserId: number,
): Promise<PartyRow | null> {
  const rows = await sql<PartyRow[]>`
    SELECT id, display_name, size, state, verification_tier, children,
           w_window, w_aisle, w_front, w_avoid_middle, w_avoid_lavatory, w_adjacency
      FROM parties
     WHERE flight_id = ${flightId} AND telegram_user_id = ${telegramUserId}
  `;
  return rows[0] ?? null;
}

/**
 * Register or update a party, phase one: who you are and what you want.
 *
 * No seat is involved. At sign-up time — typically weeks out — the seat does not
 * exist yet; it arrives when check-in opens and the bot asks for it.
 */
export async function upsertParty(input: {
  flightId: number;
  telegramUserId: number;
  displayName: string;
  size: number;
  /** How many of `size` are under 16. Omitted means none. */
  children?: number;
  weights: Record<string, number>;
}): Promise<number> {
  const { flightId, telegramUserId, displayName, size, weights } = input;
  const children = input.children ?? 0;

  const rows = await sql<{ id: number }[]>`
    INSERT INTO parties (
      flight_id, telegram_user_id, display_name, size, children,
      w_window, w_aisle, w_front, w_avoid_middle, w_avoid_lavatory, w_adjacency
    ) VALUES (
      ${flightId}, ${telegramUserId}, ${displayName}, ${size}, ${children},
      ${weights.w_window}, ${weights.w_aisle}, ${weights.w_front},
      ${weights.w_avoid_middle}, ${weights.w_avoid_lavatory}, ${weights.w_adjacency}
    )
    ON CONFLICT (flight_id, telegram_user_id) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      size = EXCLUDED.size,
      children = EXCLUDED.children,
      w_window = EXCLUDED.w_window,
      w_aisle = EXCLUDED.w_aisle,
      w_front = EXCLUDED.w_front,
      w_avoid_middle = EXCLUDED.w_avoid_middle,
      w_avoid_lavatory = EXCLUDED.w_avoid_lavatory,
      w_adjacency = EXCLUDED.w_adjacency
    RETURNING id
  `;
  const partyId = rows[0].id;

  // A party's member rows are created up front so the bot has something to fill
  // in when the seats arrive. They carry the flight_id the unique seat index needs.
  await sql`DELETE FROM members WHERE party_id = ${partyId} AND current_seat IS NULL`;
  const existing = await sql<{ n: string }[]>`
    SELECT count(*) AS n FROM members WHERE party_id = ${partyId}
  `;
  const missing = size - Number(existing[0].n);
  for (let i = 0; i < missing; i += 1) {
    await sql`
      INSERT INTO members (party_id, flight_id, current_seat) VALUES (${partyId}, ${flightId}, NULL)
    `;
  }

  return partyId;
}

/** The seats a party has submitted so far, in member order. */
export async function seatsFor(partyId: number): Promise<string[]> {
  const rows = await sql<{ current_seat: string | null }[]>`
    SELECT current_seat FROM members WHERE party_id = ${partyId} ORDER BY id
  `;
  return rows.map((r) => r.current_seat).filter((s): s is string => s !== null);
}

/**
 * Human label for the aircraft, or a note that the layout is a guess.
 *
 * Takes the two columns it needs rather than a whole Flight, because the flight
 * page also renders for a flight that has no row yet.
 */
export function aircraftLabel(
  flight: Pick<Flight, 'aircraft_type' | 'seat_map_key'>,
): { label: string; estimated: boolean } {
  const map = loadSeatMap(flight.seat_map_key);
  return {
    label: flight.aircraft_type ?? map.label,
    estimated: map.estimated,
  };
}
