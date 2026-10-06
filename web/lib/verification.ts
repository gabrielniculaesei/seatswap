/**
 * Tier 1 verification: seats taken off a boarding pass.
 *
 * The barcode itself is parsed in the browser by bcbp.ts and never sent here.
 * What arrives is the handful of fields we cross-check — carrier, flight number,
 * day of the year, route, seat, check-in sequence number. No passenger name, no
 * PNR, no raw payload.
 *
 * Be honest about what this buys. BCBP is not signed, so a field posted to this
 * endpoint is exactly as forgeable as a seat typed into a chat window; nothing
 * here is cryptography. The value is in the cross-checks, which is why they all
 * live on this side of the wire:
 *
 *   1. the flight has to be one this person is actually signed up for, on the
 *      right date;
 *   2. the route has to match what AeroDataBox told us, when it told us anything;
 *   3. the seat has to exist on that aircraft;
 *   4. the seat has to be unclaimed on that flight;
 *   5. the check-in sequence number has to be unclaimed on that flight.
 *
 * 4 and 5 are the ones that matter, and they are database indexes rather than
 * code: seats and sequence numbers are scarce per flight, so a fake party has to
 * burn real ones, and it cannot know which are already taken.
 *
 * The badge is a nudge, never a gate. A tier-0 party competes on equal terms and
 * the solver only gives the tier a 5% thumb on the scale.
 */

import type { BoardingPassLeg } from './bcbp.ts';
import { dayOfYearOf } from './bcbp.ts';
import {
  type CandidateParty,
  candidateParties,
  conflictMessage,
  designatorOf,
  storeSeats,
} from './seats.ts';
import { loadSeatMap, seatExists } from './seatmap.ts';

/** One scanned pass: its legs, in the order the barcode listed them. */
export type ScannedPass = BoardingPassLeg[];

export const VERIFIED_TIER = 1;

export interface VerificationResult {
  ok: boolean;
  message: string;
  partyId?: number;
  flightId?: number;
  seats?: string[];
  /** The tier actually recorded, so the caller never has to assume it. */
  tier?: number;
}

/**
 * Validate whatever the request body claimed to be a list of parsed passes.
 *
 * This is untrusted input that happens to have been produced by our own parser,
 * so it is re-checked from scratch rather than trusted for having the right shape.
 */
export function sanitisePasses(input: unknown): ScannedPass[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > 8) return null;

  const passes: ScannedPass[] = [];
  for (const rawPass of input) {
    if (!Array.isArray(rawPass) || rawPass.length === 0 || rawPass.length > 9) return null;

    const legs: BoardingPassLeg[] = [];
    for (const raw of rawPass) {
      if (typeof raw !== 'object' || raw === null) return null;
      const leg = raw as Record<string, unknown>;

      const carrier = String(leg.carrier ?? '').toUpperCase();
      const flightNumber = String(leg.flightNumber ?? '').toUpperCase();
      const origin = String(leg.origin ?? '').toUpperCase();
      const destination = String(leg.destination ?? '').toUpperCase();
      const dayOfYear = Number(leg.dayOfYear);

      if (!/^[A-Z0-9]{2,3}$/.test(carrier)) return null;
      if (!/^[0-9]{1,4}[A-Z]?$/.test(flightNumber)) return null;
      if (!/^[A-Z]{3}$/.test(origin) || !/^[A-Z]{3}$/.test(destination)) return null;
      if (!Number.isInteger(dayOfYear) || dayOfYear < 1 || dayOfYear > 366) return null;

      const seatValue = leg.seat === null || leg.seat === undefined
        ? null
        : String(leg.seat).toUpperCase();
      if (seatValue !== null && !/^[0-9]{1,3}[A-Z]$/.test(seatValue)) return null;

      const sequence = leg.sequenceNumber === null || leg.sequenceNumber === undefined
        ? null
        : Number(leg.sequenceNumber);
      if (sequence !== null
        && (!Number.isInteger(sequence) || sequence < 0 || sequence > 9999)) return null;

      const compartment = String(leg.compartment ?? '').toUpperCase().slice(0, 1);

      legs.push({
        carrier,
        flightNumber,
        origin,
        destination,
        dayOfYear,
        compartment,
        seat: seatValue,
        sequenceNumber: sequence,
      });
    }
    passes.push(legs);
  }
  return passes;
}

/** The leg of this pass that is the flight `party` is registered for, if any. */
function legFor(pass: ScannedPass, party: CandidateParty, dayOfYear: number): BoardingPassLeg | null {
  return pass.find(
    (leg) => `${leg.carrier}${leg.flightNumber}` === designatorOf(party)
      && leg.dayOfYear === dayOfYear,
  ) ?? null;
}

/**
 * Record seats read from boarding passes and mark the party verified.
 *
 * One pass per traveller. A connecting itinerary carries several legs per pass, so
 * the leg is chosen by matching the flight the party signed up for rather than by
 * assuming the first one — somebody flying OTP-BGY-LTN holds one barcode that
 * covers both flights, and only one of them is ours.
 */
export async function submitBoardingPasses(
  telegramUserId: number,
  passes: ScannedPass[],
): Promise<VerificationResult> {
  if (passes.length === 0) {
    return { ok: false, message: 'No boarding pass came through. Try scanning it again.' };
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

  // A flight is unique on (carrier, number, date) and a party is unique per
  // flight, so at most one candidate can match — there is nothing to disambiguate.
  let party: CandidateParty | undefined;
  let legs: BoardingPassLeg[] = [];
  for (const candidate of candidates) {
    const dayOfYear = dayOfYearOf(candidate.departure_date);
    if (dayOfYear === null) continue;

    const matched = passes.map((pass) => legFor(pass, candidate, dayOfYear));
    if (matched.every((leg): leg is BoardingPassLeg => leg !== null)) {
      party = candidate;
      legs = matched;
      break;
    }
  }

  if (!party) return { ok: false, message: mismatchMessage(passes, candidates) };

  const seats: string[] = [];
  for (const leg of legs) {
    if (leg.seat === null) {
      return {
        ok: false,
        message:
          'One of those passes has no seat number on it yet. Check in with the '
          + 'airline first, then scan it again.',
      };
    }
    seats.push(leg.seat);
  }

  if (new Set(seats).size !== seats.length) {
    return {
      ok: false,
      message: 'Two of those passes have the same seat on them. Scan each traveller once.',
    };
  }

  if (seats.length !== party.size) {
    return {
      ok: false,
      message:
        `You signed up as ${party.size} ${party.size === 1 ? 'person' : 'people'} on `
        + `${designatorOf(party)}, but scanned ${seats.length} `
        + `${seats.length === 1 ? 'pass' : 'passes'}. Scan one for each of you.`,
    };
  }

  // Only checked once the flight is actually verified: before that our own route
  // is the guess, not theirs (degrade, never block).
  if (party.origin && party.destination) {
    const wrongRoute = legs.find(
      (leg) => leg.origin !== party.origin || leg.destination !== party.destination,
    );
    if (wrongRoute) {
      return {
        ok: false,
        message:
          `That pass is for ${wrongRoute.origin} to ${wrongRoute.destination}, but `
          + `${designatorOf(party)} flies ${party.origin} to ${party.destination}.`,
      };
    }
  }

  const seatMap = loadSeatMap(party.seat_map_key);
  const impossible = seats.filter((seat) => !seatExists(seat, seatMap));
  if (impossible.length > 0 && !seatMap.estimated) {
    return {
      ok: false,
      message:
        `${impossible.join(', ')} ${impossible.length === 1 ? 'does' : 'do'} not exist on a `
        + `${seatMap.label}, so we could not read that pass properly. You can send your `
        + 'seat numbers instead.',
    };
  }

  const sequences = legs.map((leg) => leg.sequenceNumber);
  const present = sequences.filter((n): n is number => n !== null);
  if (new Set(present).size !== present.length) {
    return {
      ok: false,
      message: 'Those passes share a check-in number, so they are the same pass twice.',
    };
  }

  try {
    await storeSeats(party, seats, { sequences, verificationTier: VERIFIED_TIER });
  } catch (error) {
    const conflict = conflictMessage(error);
    if (conflict) return { ok: false, message: conflict };
    throw error;
  }

  return {
    ok: true,
    partyId: party.party_id,
    flightId: party.flight_id,
    seats,
    tier: VERIFIED_TIER,
    message:
      `Verified: ${seats.join(', ')} on ${designatorOf(party)}. `
      + 'I will message you if I find a swap where everyone comes out ahead.',
  };
}

/**
 * Say what actually went wrong, using the first pass as the example.
 *
 * "That did not match" is useless to somebody standing at a gate; the three things
 * that realistically differ are the flight, the date and being signed up at all.
 */
function mismatchMessage(passes: ScannedPass[], candidates: CandidateParty[]): string {
  const first = passes[0]?.[0];
  const list = candidates
    .map((c) => `${designatorOf(c)} on ${c.departure_date}`)
    .join(', ');

  if (!first) return 'We could not read that boarding pass.';

  const designator = `${first.carrier}${first.flightNumber}`;
  const sameFlight = candidates.find((c) => designatorOf(c) === designator);
  if (sameFlight) {
    return `That pass is for a different date. You are signed up for ${designator} `
      + `on ${sameFlight.departure_date}.`;
  }

  return `That pass is for ${designator}, and you are signed up for ${list}. `
    + 'Open the flight page for the flight you are on and sign up there first.';
}
