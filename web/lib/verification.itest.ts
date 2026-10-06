/**
 * Boarding-pass verification against a real database (tier 1).
 *
 * The interesting half of tier 1 is not the parsing — that is covered in
 * bcbp.test.ts — but the cross-checks, and every one of those needs rows to check
 * against. Two of them are database indexes rather than code, so they cannot be
 * tested any other way.
 *
 * Run with a throwaway database — these TRUNCATE:
 *   TEST_DATABASE_URL=postgres://... npm run test:db
 */

import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const skip = url ? false : 'set TEST_DATABASE_URL to run the database tests';
if (url) process.env.DATABASE_URL = url;

const { default: sql } = skip ? { default: null as never } : await import('./db.ts');
const verification = skip ? (null as never) : await import('./verification.ts');
const seats = skip ? (null as never) : await import('./seats.ts');
const { dayOfYearOf } = await import('./bcbp.ts');

const DEPARTURE = '2099-10-12';
const DAY = dayOfYearOf(DEPARTURE)!;

after(async () => {
  if (!skip) await sql.end();
});

beforeEach(async () => {
  if (skip) return;
  await sql`TRUNCATE flights, jobs, flight_stats, flight_creations RESTART IDENTITY CASCADE`;
});

/** A verified B738 with a pair (uid 111) and a single (uid 222) signed up. */
async function seedFlight() {
  const [flight] = await sql<{ id: number }[]>`
    INSERT INTO flights (carrier, flight_number, departure_date, origin, destination,
                         seat_map_key, scheduled_departure_utc, api_status)
    VALUES ('FR', '1234', ${DEPARTURE}, 'OTP', 'BGY', 'B738',
            ${`${DEPARTURE}T06:00:00Z`}, 'verified')
    RETURNING id
  `;
  const [pair] = await sql<{ id: number }[]>`
    INSERT INTO parties (flight_id, telegram_user_id, display_name, size, state, w_adjacency)
    VALUES (${flight.id}, 111, 'Anna B.', 2, 'registered', 200) RETURNING id
  `;
  const [single] = await sql<{ id: number }[]>`
    INSERT INTO parties (flight_id, telegram_user_id, display_name, size, state, w_window)
    VALUES (${flight.id}, 222, 'Clara D.', 1, 'registered', 60) RETURNING id
  `;
  for (const partyId of [pair.id, pair.id, single.id]) {
    await sql`
      INSERT INTO members (party_id, flight_id, current_seat)
      VALUES (${partyId}, ${flight.id}, NULL)
    `;
  }
  return { flightId: flight.id, pairId: pair.id, singleId: single.id };
}

/** One leg, defaulting to the flight everyone in seedFlight is signed up for. */
function leg(overrides: Record<string, unknown> = {}) {
  return {
    carrier: 'FR',
    flightNumber: '1234',
    origin: 'OTP',
    destination: 'BGY',
    dayOfYear: DAY,
    compartment: 'Y',
    seat: '14A',
    sequenceNumber: 25,
    ...overrides,
  } as never;
}

const partyRow = async (id: number) =>
  (await sql<{ verification_tier: number; state: string }[]>`
    SELECT verification_tier, state FROM parties WHERE id = ${id}
  `)[0];

/** Mapped into plain objects: postgres.js returns an Array subclass, and
 *  assert.deepEqual compares prototypes. */
const memberRows = async (partyId: number) => {
  const rows = await sql<{ current_seat: string | null; checkin_sequence: number | null }[]>`
    SELECT current_seat, checkin_sequence FROM members WHERE party_id = ${partyId} ORDER BY id
  `;
  return rows.map((row) => ({
    current_seat: row.current_seat,
    checkin_sequence: row.checkin_sequence,
  }));
};

describe('submitBoardingPasses', { skip }, () => {
  test('records the seats, the sequence numbers and the badge', async () => {
    const seed = await seedFlight();

    const result = await verification.submitBoardingPasses(111, [
      [leg({ seat: '14A', sequenceNumber: 25 })],
      [leg({ seat: '14B', sequenceNumber: 26 })],
    ]);

    assert.ok(result.ok, result.message);
    assert.deepEqual(result.seats, ['14A', '14B']);
    assert.equal(result.tier, 1);

    const party = await partyRow(seed.pairId);
    assert.equal(party.verification_tier, 1);
    assert.equal(party.state, 'seated');

    assert.deepEqual(await memberRows(seed.pairId), [
      { current_seat: '14A', checkin_sequence: 25 },
      { current_seat: '14B', checkin_sequence: 26 },
    ]);
  });

  test('queues an immediate match run, like a typed submission does', async () => {
    await seedFlight();
    await verification.submitBoardingPasses(222, [[leg({ seat: '20F' })]]);

    const jobs = await sql<{ type: string; payload: { trigger: string } }[]>`
      SELECT type, payload FROM jobs WHERE type = 'match_run'
    `;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].payload.trigger, 'immediate');
  });

  test('picks the right leg out of a connecting itinerary', async () => {
    const seed = await seedFlight();

    // One barcode covering OTP-BGY-LTN. Only the first leg is ours.
    const result = await verification.submitBoardingPasses(222, [[
      leg({ seat: '20F', sequenceNumber: 31 }),
      leg({
        carrier: 'FR', flightNumber: '812', origin: 'BGY', destination: 'LTN',
        dayOfYear: DAY, seat: '3C', sequenceNumber: 77,
      }),
    ]]);

    assert.ok(result.ok, result.message);
    assert.deepEqual(await memberRows(seed.singleId), [
      { current_seat: '20F', checkin_sequence: 31 },
    ]);
  });

  describe('cross-checks', () => {
    test('refuses a pass for another date', async () => {
      await seedFlight();
      const result = await verification.submitBoardingPasses(222, [[leg({ dayOfYear: DAY - 1 })]]);
      assert.ok(!result.ok);
      assert.match(result.message, /different date/i);
    });

    test('refuses a pass for a flight this person has not signed up for', async () => {
      await seedFlight();
      const result = await verification.submitBoardingPasses(222, [[
        leg({ carrier: 'W6', flightNumber: '3234' }),
      ]]);
      assert.ok(!result.ok);
      assert.match(result.message, /W63234/);
    });

    test('refuses a route that is not the one the API gave us', async () => {
      await seedFlight();
      const result = await verification.submitBoardingPasses(222, [[
        leg({ origin: 'OTP', destination: 'CIA' }),
      ]]);
      assert.ok(!result.ok);
      assert.match(result.message, /OTP to CIA/);
    });

    test('refuses a seat that does not exist on the aircraft', async () => {
      await seedFlight();
      const result = await verification.submitBoardingPasses(222, [[leg({ seat: '99Z' })]]);
      assert.ok(!result.ok);
      assert.match(result.message, /does not exist/i);
    });

    test('refuses a pass with no seat on it yet', async () => {
      await seedFlight();
      const result = await verification.submitBoardingPasses(222, [[leg({ seat: null })]]);
      assert.ok(!result.ok);
      assert.match(result.message, /check in with the airline/i);
    });

    test('refuses the wrong number of passes for the party', async () => {
      await seedFlight();
      const result = await verification.submitBoardingPasses(111, [[leg()]]);
      assert.ok(!result.ok);
      assert.match(result.message, /2 people/);
    });

    test('refuses a seat somebody else on the flight already claimed', async () => {
      const seed = await seedFlight();
      await verification.submitBoardingPasses(222, [[leg({ seat: '14A', sequenceNumber: 25 })]]);

      const result = await verification.submitBoardingPasses(111, [
        [leg({ seat: '14A', sequenceNumber: 40 })],
        [leg({ seat: '14B', sequenceNumber: 41 })],
      ]);
      assert.ok(!result.ok);
      assert.match(result.message, /already claimed/i);
      // The failed attempt left nothing behind.
      assert.deepEqual(
        (await memberRows(seed.pairId)).map((m) => m.current_seat),
        [null, null],
      );
    });

    test('refuses a check-in sequence number already used on the flight', async () => {
      await seedFlight();
      await verification.submitBoardingPasses(222, [[leg({ seat: '20F', sequenceNumber: 25 })]]);

      const result = await verification.submitBoardingPasses(111, [
        [leg({ seat: '14A', sequenceNumber: 25 })],
        [leg({ seat: '14B', sequenceNumber: 26 })],
      ]);
      assert.ok(!result.ok);
      assert.match(result.message, /check-in number/i);
    });

    test('refuses the same pass scanned twice for a pair', async () => {
      await seedFlight();
      const result = await verification.submitBoardingPasses(111, [
        [leg({ seat: '14A', sequenceNumber: 25 })],
        [leg({ seat: '14A', sequenceNumber: 25 })],
      ]);
      assert.ok(!result.ok);
      assert.match(result.message, /same seat/i);
    });
  });

  describe('alongside typed seats', () => {
    test('typing seats afterwards drops the badge back to nothing', async () => {
      const seed = await seedFlight();
      await verification.submitBoardingPasses(222, [[leg({ seat: '20F' })]]);
      assert.equal((await partyRow(seed.singleId)).verification_tier, 1);

      // The badge describes the seats we hold, not something the party earned
      // once and keeps. New seats we did not read mean no badge.
      const typed = await seats.submitSeats(222, '21C');
      assert.ok(typed.ok, typed.message);

      assert.equal((await partyRow(seed.singleId)).verification_tier, 0);
      assert.deepEqual(await memberRows(seed.singleId), [
        { current_seat: '21C', checkin_sequence: null },
      ]);
    });

    test('lets a pair swap seats with each other on a re-submission', async () => {
      const seed = await seedFlight();
      await verification.submitBoardingPasses(111, [
        [leg({ seat: '14A', sequenceNumber: 25 })],
        [leg({ seat: '14B', sequenceNumber: 26 })],
      ]);

      // Same seats, other way round. The per-flight unique index is checked per
      // statement, so this only works because the party is cleared first.
      const result = await verification.submitBoardingPasses(111, [
        [leg({ seat: '14B', sequenceNumber: 26 })],
        [leg({ seat: '14A', sequenceNumber: 25 })],
      ]);
      assert.ok(result.ok, result.message);
      assert.deepEqual(
        (await memberRows(seed.pairId)).map((m) => m.current_seat),
        ['14B', '14A'],
      );
    });
  });
});
