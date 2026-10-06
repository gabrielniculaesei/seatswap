/**
 * The sitemap query, against a real database.
 *
 * The sitemap and the flight pages' own `robots` metadata have to agree about
 * which pages are worth indexing. This file pins down the query half; seo.test.ts
 * pins down the metadata half.
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

after(async () => {
  if (!skip) await sql.end();
});

beforeEach(async () => {
  if (skip) return;
  await sql`TRUNCATE flights, jobs, flight_stats, flight_creations RESTART IDENTITY CASCADE`;
});

/** `daysAhead` may be negative, for a flight that has already gone. */
async function seedFlight(carrier: string, number: string, daysAhead: number): Promise<number> {
  const [flight] = await sql<{ id: number }[]>`
    INSERT INTO flights (carrier, flight_number, departure_date, api_status)
    VALUES (${carrier}, ${number},
            (current_date + ${daysAhead} * interval '1 day')::date, 'verified')
    RETURNING id
  `;
  return flight.id;
}

async function addParty(flightId: number, uid: number, state = 'registered') {
  await sql`
    INSERT INTO parties (flight_id, telegram_user_id, display_name, size, state)
    VALUES (${flightId}, ${uid}, ${`P${uid}`}, 1, ${state})
  `;
}

const designators = (rows: { carrier: string; flight_number: string }[]) =>
  rows.map((r) => `${r.carrier}${r.flight_number}`);

describe('sitemapFlights', { skip }, () => {
  test('lists a flight somebody has signed up for', async () => {
    const id = await seedFlight('FR', '1234', 10);
    await addParty(id, 111);

    const rows = await flights.sitemapFlights();
    assert.deepEqual(designators(rows), ['FR1234']);
    assert.equal(rows[0].departure_date.length, 10, 'departure_date stays a calendar date');
    assert.ok(rows[0].last_modified instanceof Date);
  });

  test('leaves out a flight with no parties', async () => {
    // These are the millions of thin pages the whole rule exists to keep out.
    await seedFlight('FR', '1234', 10);
    assert.deepEqual(designators(await flights.sitemapFlights()), []);
  });

  test('leaves out a flight that has already departed', async () => {
    const gone = await seedFlight('FR', '1111', -2);
    await addParty(gone, 111);

    const upcoming = await seedFlight('FR', '2222', 2);
    await addParty(upcoming, 222);

    assert.deepEqual(designators(await flights.sitemapFlights()), ['FR2222']);
  });

  test('keeps a flight departing today', async () => {
    const today = await seedFlight('FR', '3333', 0);
    await addParty(today, 111);
    assert.deepEqual(designators(await flights.sitemapFlights()), ['FR3333']);
  });

  test('ignores parties that withdrew or expired', async () => {
    const abandoned = await seedFlight('FR', '4444', 5);
    await addParty(abandoned, 111, 'withdrawn');
    await addParty(abandoned, 222, 'expired');

    assert.deepEqual(designators(await flights.sitemapFlights()), []);

    // One live party is enough to bring it back.
    await addParty(abandoned, 333, 'registered');
    assert.deepEqual(designators(await flights.sitemapFlights()), ['FR4444']);
  });

  test('returns one row per flight, not one per party', async () => {
    const id = await seedFlight('FR', '5555', 5);
    await addParty(id, 111);
    await addParty(id, 222);
    await addParty(id, 333);

    assert.equal((await flights.sitemapFlights()).length, 1);
  });

  test('orders by most recently joined, and honours the limit', async () => {
    const older = await seedFlight('FR', '1111', 5);
    await addParty(older, 111);
    const newer = await seedFlight('FR', '2222', 5);
    await addParty(newer, 222);

    const rows = await flights.sitemapFlights();
    assert.deepEqual(designators(rows), ['FR2222', 'FR1111']);
    assert.deepEqual(designators(await flights.sitemapFlights(1)), ['FR2222']);
  });
});

describe('reading a flight never creates one', { skip }, () => {
  test('a flight nobody signed up for stays absent', async () => {
    // This is what makes the flight page safe to index: it only ever calls
    // findFlight, so a crawler walking the URL space writes nothing and spends
    // no AeroDataBox quota.
    assert.equal(await flights.findFlight('W6', '3234', '2099-10-12'), null);

    const [{ n }] = await sql<{ n: string }[]>`SELECT count(*) AS n FROM flights`;
    assert.equal(Number(n), 0);
    const [{ j }] = await sql<{ j: string }[]>`SELECT count(*) AS j FROM jobs`;
    assert.equal(Number(j), 0, 'and queues no verify_flight job');
  });

  test('findOrCreateFlight is the one that writes, and queues verification once', async () => {
    const first = await flights.findOrCreateFlight('W6', '3234', '2099-10-12');
    assert.equal(first.created, true);

    const again = await flights.findOrCreateFlight('W6', '3234', '2099-10-12');
    assert.equal(again.created, false);
    assert.equal(again.flight.id, first.flight.id);

    const jobs = await sql<{ type: string }[]>`SELECT type FROM jobs`;
    assert.deepEqual(jobs.map((j) => j.type), ['verify_flight'], 'exactly one API call');
  });
});
