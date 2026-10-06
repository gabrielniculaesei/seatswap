import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import {
  type AdjacencyAnswer,
  type ExtraAnswer,
  type SeatTypeAnswer,
  weightsFromAnswers,
  weightsToColumns,
} from '../../../config/preferences.ts';
import {
  findFlight,
  flightForUser,
  parseDepartureDate,
  parseFlightSlug,
  upsertParty,
} from '../../../lib/flights.ts';
import { leaveFlight } from '../../../lib/proposals.ts';
import { COOKIE_NAME, verify } from '../../../lib/session.ts';
import { sendMessage } from '../../../lib/telegram.ts';

/**
 * Phase-one registration: who you are and what you want.
 *
 * Validation is strict about the answer *ids* rather than trusting weights from
 * the client. If the browser could post arbitrary weights, anyone could give
 * themselves a w_adjacency of 10000 and monopolise every match run — so the
 * client sends answers and the server decides what they are worth.
 *
 * This is also where a `flights` row is born. The flight page only reads, so that
 * a crawler walking the flight URL space cannot create rows or spend AeroDataBox
 * calls; creation happens here instead, behind a Telegram login,
 * which means a real person asked for it — and metered per account, because a
 * login raises the price of walking that space without bounding it. Joining a
 * flight that already exists is free and unmetered. See lib/flight-quota.ts.
 */

export const dynamic = 'force-dynamic';

const ADJACENCY: readonly AdjacencyAnswer[] = ['no', 'prefer', 'essential'];
const SEAT_TYPES: readonly SeatTypeAnswer[] = ['window', 'aisle', 'either'];
const EXTRAS: readonly ExtraAnswer[] = ['avoid_middle', 'front', 'avoid_lavatory'];

const MAX_PARTY_SIZE = 8;

function bad(error: string, status = 400) {
  return NextResponse.json({ error }, { status });
}

export async function POST(request: Request) {
  const session = verify((await cookies()).get(COOKIE_NAME)?.value);
  if (!session) return bad('Please sign in with Telegram first', 401);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return bad('Expected JSON');
  }

  // Re-parsed here rather than trusted: these come from a form, and they are
  // about to create a row.
  const slug = parseFlightSlug(
    `${String(body.carrier ?? '')}-${String(body.flightNumber ?? '')}`,
  );
  const departureDate = parseDepartureDate(String(body.departureDate ?? ''));
  if (!slug || !departureDate) return bad('That is not a flight we can use');

  const size = Number(body.size);
  if (!Number.isInteger(size) || size < 1 || size > MAX_PARTY_SIZE) {
    return bad(`A group has to be between 1 and ${MAX_PARTY_SIZE} people`);
  }

  // Not a preference but a rule of the air: nobody under 16 in an exit row, and
  // the solver needs to know (constraint 8). Absent means none, so
  // an older page still posting without it keeps working.
  const children = body.children === undefined ? 0 : Number(body.children);
  if (!Number.isInteger(children) || children < 0) {
    return bad('Unknown answer for how many are under 16');
  }
  if (children >= size) {
    return bad('At least one of the group has to be 16 or over, and it is the one signing up');
  }

  const displayName = String(body.displayName ?? '').trim();
  if (displayName.length === 0) return bad('Please choose a name to show');
  if (displayName.length > 40) return bad('That name is too long (40 characters max)');

  const adjacency = body.adjacency as AdjacencyAnswer | undefined;
  if (size >= 2 && adjacency !== undefined && !ADJACENCY.includes(adjacency)) {
    return bad('Unknown answer for sitting together');
  }

  const seatType = body.seatType as SeatTypeAnswer | undefined;
  if (seatType !== undefined && !SEAT_TYPES.includes(seatType)) {
    return bad('Unknown seat preference');
  }

  const rawExtras = Array.isArray(body.extras) ? body.extras : [];
  const extras = rawExtras.filter((e): e is ExtraAnswer => EXTRAS.includes(e as ExtraAnswer));
  if (extras.length !== rawExtras.length) return bad('Unknown extra preference');

  // The server decides what an answer is worth, not the browser.
  const weights = weightsFromAnswers({ size, adjacency, seatType, extras });

  // Everything above this line is validation, so a rejected sign-up never leaves
  // a flight row behind.
  const resolved = await flightForUser(
    slug.carrier,
    slug.flightNumber,
    departureDate,
    session.uid,
  );
  // 429: this is a rate limit, and saying so lets a client tell "try later" apart
  // from "you got it wrong".
  if (!resolved.ok) return bad(resolved.message, 429);
  const { flight } = resolved;

  const partyId = await upsertParty({
    flightId: flight.id,
    telegramUserId: session.uid,
    displayName,
    size,
    children,
    weights: weightsToColumns(weights),
  });

  return NextResponse.json({ ok: true, partyId, flightId: flight.id });
}

/**
 * Leave a flight, deleting the sign-up and everything attached to it now rather
 * than 24 hours after departure (GDPR Art. 17).
 *
 * Looks the flight up and never creates it: there is nothing to leave on a flight
 * that has no row, and this must not become a second way to spend an AeroDataBox
 * call.
 */
export async function DELETE(request: Request) {
  const session = verify((await cookies()).get(COOKIE_NAME)?.value);
  if (!session) return bad('Please sign in with Telegram first', 401);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return bad('Expected JSON');
  }

  const slug = parseFlightSlug(
    `${String(body.carrier ?? '')}-${String(body.flightNumber ?? '')}`,
  );
  const departureDate = parseDepartureDate(String(body.departureDate ?? ''));
  if (!slug || !departureDate) return bad('That is not a flight we can use');

  const flight = await findFlight(slug.carrier, slug.flightNumber, departureDate);
  const result = flight ? await leaveFlight(flight.id, session.uid) : null;
  if (!result?.left) return bad('You are not signed up for this flight', 404);

  // After the commit, and never allowed to fail the request: the deletion has
  // happened whether or not Telegram delivers the news.
  for (const other of result.affected) {
    await sendMessage(
      other.telegram_user_id,
      other.agreed
        ? 'The swap you agreed is off: one of the people in it has left the flight. '
          + 'Keep the seat the airline gave you. I am already looking for another swap.'
        : 'That swap is off. Someone in it has left the flight, so you keep the seat '
          + 'you have. I am already looking for another one.',
    );
  }

  return NextResponse.json({ ok: true });
}
