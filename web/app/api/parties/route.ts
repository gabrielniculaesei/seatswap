import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import {
  type AdjacencyAnswer,
  type ExtraAnswer,
  type SeatTypeAnswer,
  weightsFromAnswers,
  weightsToColumns,
} from '../../../config/preferences.ts';
import { upsertParty } from '../../../lib/flights.ts';
import { COOKIE_NAME, verify } from '../../../lib/session.ts';

/**
 * Phase-one registration: who you are and what you want (CLAUDE.md §7).
 *
 * Validation is strict about the answer *ids* rather than trusting weights from
 * the client. If the browser could post arbitrary weights, anyone could give
 * themselves a w_adjacency of 10000 and monopolise every match run — so the
 * client sends answers and the server decides what they are worth.
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

  const flightId = Number(body.flightId);
  if (!Number.isInteger(flightId) || flightId <= 0) return bad('Unknown flight');

  const size = Number(body.size);
  if (!Number.isInteger(size) || size < 1 || size > MAX_PARTY_SIZE) {
    return bad(`A group has to be between 1 and ${MAX_PARTY_SIZE} people`);
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

  const partyId = await upsertParty({
    flightId,
    telegramUserId: session.uid,
    displayName,
    size,
    weights: weightsToColumns(weights),
  });

  return NextResponse.json({ ok: true, partyId });
}
