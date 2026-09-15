/**
 * What happens when two people do the same thing at the same instant.
 *
 * Every other integration file here runs one caller at a time, which is exactly
 * the condition under which a race never shows up. These run real concurrent
 * requests against a real database, because the failure being checked for — two
 * rows where there should be one, or a unique violation surfacing as a 500 in
 * somebody's face — cannot be reproduced any other way.
 *
 * The most likely race in the system is two people opening the same brand-new
 * flight and signing up in the same second. That is not a hypothetical: a link
 * pasted into a WhatsApp group is precisely how this product expects to spread
 * (CLAUDE.md §5), so simultaneous first arrivals on one flight are the normal
 * case rather than the exotic one.
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
const flights = skip ? (null as never) : await import('./flights.ts');
const seats = skip ? (null as never) : await import('./seats.ts');

after(async () => {
  if (!skip) await sql.end();
});

beforeEach(async () => {
  if (skip) return;
  await sql`TRUNCATE flights, jobs, flight_stats, flight_creations RESTART IDENTITY CASCADE`;
});

const countOf = async (table: 'flights' | 'jobs' | 'parties' | 'members') => {
  const rows = await sql<{ n: string }[]>`
    SELECT count(*) AS n FROM ${sql(table)}
  `;
  return Number(rows[0].n);
};

describe('two people opening the same new flight at once', { skip }, () => {
  test('eight simultaneous creations produce one row and one API call', async () => {
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () => flights.findOrCreateFlight('W6', '3234', '2099-10-12')),
    );

    assert.equal(await countOf('flights'), 1, 'exactly one flight row');

    // Exactly one caller may claim to have created it. That flag is what decides
    // who queues the AeroDataBox call, so two winners would mean two calls
    // against a quota of about 600 a month (CLAUDE.md §11).
    assert.equal(attempts.filter((a) => a.created).length, 1, 'exactly one winner');

    const jobs = await sql<{ type: string }[]>`SELECT type FROM jobs`;
    assert.deepEqual(jobs.map((j) => j.type), ['verify_flight']);

    // And everybody got the same row back, winner and losers alike.
    const ids = new Set(attempts.map((a) => a.flight.id));
    assert.equal(ids.size, 1, 'every caller sees the same flight');
  });

  test('nobody is handed an error for losing the race', async () => {
    // The loser re-reads after ON CONFLICT DO NOTHING. If that read could miss a
    // row the winner had not committed yet, one of two simultaneous users would
    // get a 500 while the other signed up fine.
    const results = await Promise.allSettled(
      Array.from({ length: 16 }, () => flights.findOrCreateFlight('FR', '999', '2099-12-01')),
    );

    const rejected = results.filter((r) => r.status === 'rejected');
    assert.deepEqual(rejected.map((r) => String((r as PromiseRejectedResult).reason)), []);
  });

  test('a second wave finds the flight instead of creating it', async () => {
    await flights.findOrCreateFlight('W6', '3234', '2099-10-12');
    const later = await Promise.all(
      Array.from({ length: 4 }, () => flights.findOrCreateFlight('W6', '3234', '2099-10-12')),
    );

    assert.equal(later.filter((a) => a.created).length, 0, 'no second winner');
    assert.equal(await countOf('flights'), 1);
    assert.equal(await countOf('jobs'), 1, 'and no second API call');
  });

  test('different flights created at once do not collide with each other', async () => {
    const wanted = [['W6', '1'], ['W6', '2'], ['FR', '1'], ['U2', '7']] as const;
    const made = await Promise.all(
      wanted.map(([carrier, number]) =>
        flights.findOrCreateFlight(carrier, number, '2099-10-12')),
    );

    assert.equal(made.filter((a) => a.created).length, 4);
    assert.equal(await countOf('flights'), 4);
    assert.equal(await countOf('jobs'), 4, 'one verification each');
  });
});

describe('two people claiming seats at once', { skip }, () => {
  async function seedFlight() {
    const [flight] = await sql<{ id: number }[]>`
      INSERT INTO flights (carrier, flight_number, departure_date, seat_map_key,
                           scheduled_departure_utc, api_status)
      VALUES ('FR', '1234', '2099-10-12', 'B738', now() + interval '10 days', 'verified')
      RETURNING id
    `;
    for (const uid of [111, 222, 333]) {
      const [party] = await sql<{ id: number }[]>`
        INSERT INTO parties (flight_id, telegram_user_id, display_name, size, w_window)
        VALUES (${flight.id}, ${uid}, ${`P${uid}`}, 1, 60) RETURNING id
      `;
      await sql`
        INSERT INTO members (party_id, flight_id, current_seat)
        VALUES (${party.id}, ${flight.id}, NULL)
      `;
    }
    return flight.id;
  }

  test('only one of them gets the seat, and the others are told why', async () => {
    // The unique index is the anti-Sybil defence (CLAUDE.md §10). Under
    // concurrency it has to read as a message, not as a crash.
    await seedFlight();

    const results = await Promise.all(
      [111, 222, 333].map((uid) => seats.submitSeats(uid, '14A')),
    );

    assert.equal(results.filter((r) => r.ok).length, 1, 'one winner');
    for (const loser of results.filter((r) => !r.ok)) {
      assert.match(loser.message, /already claimed/i, 'a sentence, not a stack trace');
    }

    const taken = await sql<{ n: string }[]>`
      SELECT count(*) AS n FROM members WHERE current_seat = '14A'
    `;
    assert.equal(Number(taken[0].n), 1);
  });

  test('different seats submitted at once all go through', async () => {
    await seedFlight();

    const results = await Promise.all([
      seats.submitSeats(111, '14A'),
      seats.submitSeats(222, '14B'),
      seats.submitSeats(333, '14C'),
    ]);

    assert.deepEqual(results.map((r) => r.ok), [true, true, true]);
    assert.equal(await countOf('jobs'), 1, 'and the match runs de-duplicate to one');
  });
});
