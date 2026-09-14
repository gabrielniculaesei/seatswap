/**
 * Collecting seats at check-in (CLAUDE.md §7, phase two).
 *
 * This is the ten-second interaction the whole two-phase design exists to
 * protect. The user signed up weeks ago in a calm moment; inside the 24-hour
 * window all that is left is answering a message they are expecting. So the
 * parser is deliberately forgiving about how people type seats, and the errors
 * say what to do rather than what went wrong.
 */

import sql from './db.ts';
import { type ParsedSeats, parseSeatMessage } from './seat-input.ts';
import { loadSeatMap, parseSeat, seatExists } from './seatmap.ts';

export { parseSeatMessage };
export type { ParsedSeats };

export interface SeatSubmission {
  ok: boolean;
  message: string;
  partyId?: number;
  flightId?: number;
  seats?: string[];
}

export interface CandidateParty {
  party_id: number;
  flight_id: number;
  carrier: string;
  flight_number: string;
  departure_date: string;
  seat_map_key: string | null;
  size: number;
  state: string;
}

/**
 * Which flight is this person telling us about?
 *
 * Someone can be signed up for several flights at once, so a bare '14A' is
 * ambiguous in principle. In practice it almost never is: only flights whose
 * check-in has opened are candidates, and there is normally exactly one.
 */
export async function candidateParties(
  telegramUserId: number,
): Promise<CandidateParty[]> {
  return sql<CandidateParty[]>`
    SELECT p.id AS party_id, p.flight_id, p.size, p.state,
           f.carrier, f.flight_number, f.departure_date, f.seat_map_key
      FROM parties p
      JOIN flights f ON f.id = p.flight_id
     WHERE p.telegram_user_id = ${telegramUserId}
       AND p.state IN ('registered', 'seated')
       AND (f.scheduled_departure_utc IS NULL OR f.scheduled_departure_utc > now())
     ORDER BY f.scheduled_departure_utc NULLS LAST, f.departure_date
  `;
}

function designatorOf(party: CandidateParty): string {
  return `${party.carrier}${party.flight_number}`;
}

/**
 * Record a party's seats and ask for an immediate match run.
 *
 * Every failure here returns a message meant to be sent straight to the user, so
 * the bot never has to invent its own wording for a case it did not anticipate.
 */
export async function submitSeats(
  telegramUserId: number,
  text: string,
): Promise<SeatSubmission> {
  const parsed = parseSeatMessage(text);
  if (parsed.seats.length === 0) {
    return {
      ok: false,
      message:
        'I could not find a seat in that. Send just the seat numbers, like '
        + '14A or 14A, 22F.',
    };
  }

  const candidates = await candidateParties(telegramUserId);
  if (candidates.length === 0) {
    return {
      ok: false,
      message:
        'You are not signed up for any upcoming flight yet. Open your flight page '
        + 'and sign up first.',
    };
  }

  let party: CandidateParty | undefined;
  if (parsed.designator) {
    party = candidates.find((c) => designatorOf(c) === parsed.designator);
    if (!party) {
      return {
        ok: false,
        message: `You are not signed up for ${parsed.designator}.`,
      };
    }
  } else if (candidates.length === 1) {
    party = candidates[0];
  } else {
    const list = candidates.map((c) => `${designatorOf(c)} on ${c.departure_date}`).join(', ');
    return {
      ok: false,
      message:
        `You are signed up for more than one flight (${list}). `
        + 'Send the flight number with the seats, like "W6 3234: 14A, 22F".',
    };
  }

  if (parsed.seats.length !== party.size) {
    return {
      ok: false,
      message:
        `You signed up as ${party.size} ${party.size === 1 ? 'person' : 'people'} on `
        + `${designatorOf(party)}, but sent ${parsed.seats.length} `
        + `${parsed.seats.length === 1 ? 'seat' : 'seats'}. Send all of them together.`,
    };
  }

  const seatMap = loadSeatMap(party.seat_map_key);
  const impossible = parsed.seats.filter((seat) => !seatExists(seat, seatMap));
  if (impossible.length > 0 && !seatMap.estimated) {
    // Only trusted when we actually know the aircraft. On an estimated layout a
    // real seat could easily fall outside our guess, and refusing it would be us
    // being wrong at the user.
    return {
      ok: false,
      message:
        `${impossible.join(', ')} ${impossible.length === 1 ? 'does' : 'do'} not exist on a `
        + `${seatMap.label}. Have another look at your boarding pass.`,
    };
  }

  const unparseable = parsed.seats.filter((seat) => parseSeat(seat) === null);
  if (unparseable.length > 0) {
    return { ok: false, message: `I could not read ${unparseable.join(', ')}.` };
  }

  try {
    await storeSeats(party, parsed.seats);
  } catch (error) {
    // The unique index on (flight_id, current_seat) is our anti-Sybil defence and
    // also a genuine "somebody mistyped" signal (CLAUDE.md §10).
    if (String(error).includes('members_unique_seat_per_flight')) {
      return {
        ok: false,
        message:
          'Somebody on this flight has already claimed one of those seats. '
          + 'If that seat really is yours, check the number and try again.',
      };
    }
    throw error;
  }

  return {
    ok: true,
    partyId: party.party_id,
    flightId: party.flight_id,
    seats: parsed.seats,
    message:
      `Got it — ${parsed.seats.join(', ')} on ${designatorOf(party)}. `
      + 'I will message you if I find a swap where everyone comes out ahead.',
  };
}

/**
 * Write the seats and queue a match run, in one transaction.
 *
 * The match run is queued inside the transaction on purpose: if the seats do not
 * commit, neither does the job that would solve using them.
 */
async function storeSeats(party: CandidateParty, seats: string[]): Promise<void> {
  await sql.begin(async (tx) => {
    const members = await tx<{ id: number }[]>`
      SELECT id FROM members WHERE party_id = ${party.party_id} ORDER BY id
    `;

    // The party's member rows were created at sign-up; top them up if the party
    // grew, and fill them in order.
    for (let i = members.length; i < seats.length; i += 1) {
      const created = await tx<{ id: number }[]>`
        INSERT INTO members (party_id, flight_id, current_seat)
        VALUES (${party.party_id}, ${party.flight_id}, NULL)
        RETURNING id
      `;
      members.push(created[0]);
    }

    for (let i = 0; i < seats.length; i += 1) {
      await tx`UPDATE members SET current_seat = ${seats[i]} WHERE id = ${members[i].id}`;
    }
    // Anyone left over (the party shrank) loses their seat rather than keeping a
    // stale one that would be matched against.
    for (let i = seats.length; i < members.length; i += 1) {
      await tx`UPDATE members SET current_seat = NULL WHERE id = ${members[i].id}`;
    }

    await tx`
      UPDATE parties
         SET state = 'seated', seats_submitted_at = now()
       WHERE id = ${party.party_id} AND state = 'registered'
    `;

    await tx`
      INSERT INTO jobs (type, payload, run_after)
      VALUES ('match_run', ${tx.json({ flight_id: party.flight_id, trigger: 'immediate' })}, now())
      ON CONFLICT DO NOTHING
    `;
  });
}
