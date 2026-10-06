/**
 * The new-flight cap against a real database.
 *
 * The distinction this file exists to pin down is the one the whole design turns
 * on: creating a flight is metered, joining one is not. Get that backwards and
 * you have either left the quota hole open or started rationing the behaviour the
 * product wants most.
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
const quota = skip ? (null as never) : await import('./flight-quota.ts');

const ANNA = 111111;
const CLARA = 222222;

after(async () => {
  if (!skip) await sql.end();
});

beforeEach(async () => {
  if (skip) return;
  await sql`TRUNCATE flights, jobs, flight_stats, flight_creations RESTART IDENTITY CASCADE`;
  delete process.env.MAX_NEW_FLIGHTS_PER_DAY;
});

const jobCount = async () => {
  const rows = await sql<{ n: string }[]>`SELECT count(*) AS n FROM jobs`;
  return Number(rows[0].n);
};

/** Sign-up as the route does it: one call per new flight. */
const create = (uid: number, number: string, date = '2099-10-12') =>
  flights.flightForUser('W6', number, date, uid);

describe('flightForUser', { skip }, () => {
  test('creates a flight and charges the account for it', async () => {
    const result = await create(ANNA, '1');
    assert.ok(result.ok);
    assert.equal(result.created, true);
    assert.equal(await quota.newFlightsCreatedRecently(ANNA), 1);
    assert.equal(await jobCount(), 1, 'one AeroDataBox call queued');
  });

  test('joining a flight that already exists is free', async () => {
    await create(ANNA, '1');

    // Nine more people arrive on the same flight. This is the product working
    //, so it must not be metered at all.
    for (let i = 0; i < 9; i += 1) {
      const joined = await create(CLARA, '1');
      assert.ok(joined.ok);
      assert.equal(joined.created, false);
    }

    assert.equal(await quota.newFlightsCreatedRecently(CLARA), 0, 'nobody was charged');
    assert.equal(await jobCount(), 1, 'and no extra API calls');
  });

  test('refuses once the account is at its limit', async () => {
    process.env.MAX_NEW_FLIGHTS_PER_DAY = '3';

    for (const n of ['1', '2', '3']) {
      assert.ok((await create(ANNA, n)).ok, `flight ${n} should be allowed`);
    }

    const refused = await create(ANNA, '4');
    assert.ok(!refused.ok);
    assert.match(refused.message, /daily limit/i);

    // The refusal is total: no row, no job, nothing to clean up.
    const rows = await sql<{ n: string }[]>`
      SELECT count(*) AS n FROM flights WHERE flight_number = '4'
    `;
    assert.equal(Number(rows[0].n), 0);
    assert.equal(await jobCount(), 3);
  });

  test('a capped account can still join flights other people made', async () => {
    process.env.MAX_NEW_FLIGHTS_PER_DAY = '1';
    await create(ANNA, '1');
    assert.ok(!(await create(ANNA, '2')).ok, 'Anna is capped');

    // Clara opens a new flight; Anna can sign up for it even while capped. The
    // cap is on calling flights into existence, not on taking part.
    assert.ok((await create(CLARA, '2')).ok);
    const joined = await create(ANNA, '2');
    assert.ok(joined.ok, 'Anna joins the flight Clara paid for');
    assert.equal(joined.created, false);
  });

  test('the cap is per account, not global', async () => {
    process.env.MAX_NEW_FLIGHTS_PER_DAY = '1';
    assert.ok((await create(ANNA, '1')).ok);
    assert.ok((await create(CLARA, '2')).ok, "Clara's allowance is her own");
    assert.ok(!(await create(ANNA, '3')).ok);
  });

  test('a limit of zero stops new flights and leaves existing ones joinable', async () => {
    await create(ANNA, '1');
    process.env.MAX_NEW_FLIGHTS_PER_DAY = '0';

    assert.ok(!(await create(CLARA, '2')).ok, 'no new flights at all');
    assert.ok((await create(CLARA, '1')).ok, 'but the site still works');
  });

  test('yesterday does not count against today', async () => {
    process.env.MAX_NEW_FLIGHTS_PER_DAY = '2';
    await create(ANNA, '1');
    await create(ANNA, '2');
    assert.ok(!(await create(ANNA, '3')).ok);

    await sql`
      UPDATE flight_creations SET created_at = now() - interval '25 hours'
       WHERE telegram_user_id = ${ANNA}
    `;
    assert.equal(await quota.newFlightsCreatedRecently(ANNA), 0);
    assert.ok((await create(ANNA, '3')).ok, 'the window has rolled');
  });

  test('losing the race to create is not charged to the loser', async () => {
    // Eight accounts open the same new flight at once. One creates it; the other
    // seven joined a flight that already existed by the time they looked.
    const uids = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => 900000 + n);
    const results = await Promise.all(uids.map((uid) => create(uid, '7')));

    assert.ok(results.every((r) => r.ok));
    const charged = await Promise.all(uids.map((uid) => quota.newFlightsCreatedRecently(uid)));
    assert.equal(charged.reduce((a, b) => a + b, 0), 1, 'exactly one account pays');
    assert.equal(await jobCount(), 1);
  });
});

describe('recordFlightCreation', { skip }, () => {
  test('prunes rows that have aged out, so this is not a log', async () => {
    // The table holds who and when, and only for as long as the
    // decision needs it.
    await quota.recordFlightCreation(ANNA);
    await sql`
      UPDATE flight_creations SET created_at = now() - interval '30 hours'
    `;
    await quota.recordFlightCreation(ANNA);

    const rows = await sql<{ n: string }[]>`
      SELECT count(*) AS n FROM flight_creations WHERE telegram_user_id = ${ANNA}
    `;
    assert.equal(Number(rows[0].n), 1, 'the stale row is gone');
  });

  test("prunes other accounts' stale rows too, so a one-time creator is not kept", async () => {
    // Anna adds one flight and never comes back. Her row must not outlive the
    // window just because nothing she does will ever trigger her own cleanup.
    await quota.recordFlightCreation(ANNA);
    await sql`
      UPDATE flight_creations SET created_at = now() - interval '30 hours'
    `;
    await quota.recordFlightCreation(CLARA);

    const rows = await sql<{ id: string }[]>`
      SELECT telegram_user_id AS id FROM flight_creations
    `;
    assert.deepEqual(rows.map((r) => Number(r.id)), [CLARA]);
  });
});
