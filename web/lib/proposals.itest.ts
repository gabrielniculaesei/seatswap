/**
 * Proposal responses and seat submission, against a real database.
 *
 * Run with a throwaway database — these TRUNCATE:
 *   TEST_DATABASE_URL=postgres://... npm run test:db
 * Without one, every test here skips.
 *
 * Kept in .itest.ts rather than .test.ts so `npm test` stays runnable anywhere.
 */

import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const skip = url ? false : 'set TEST_DATABASE_URL to run the database tests';
if (url) process.env.DATABASE_URL = url;

// Imported dynamically so the module does not demand DATABASE_URL when skipping.
const { default: sql } = skip
  ? { default: null as never }
  : await import('./db.ts');
const proposals = skip ? (null as never) : await import('./proposals.ts');
const seats = skip ? (null as never) : await import('./seats.ts');

after(async () => {
  if (!skip) await sql.end();
});

beforeEach(async () => {
  if (skip) return;
  await sql`TRUNCATE flights, jobs, flight_stats RESTART IDENTITY CASCADE`;
});

/** A flight with a split pair and a single, seated and ready to solve. */
async function seedFlight() {
  const [flight] = await sql<{ id: number }[]>`
    INSERT INTO flights (carrier, flight_number, departure_date, seat_map_key,
                         scheduled_departure_utc, api_status)
    VALUES ('FR', '1234', '2099-10-12', 'B738', now() + interval '10 days', 'verified')
    RETURNING id
  `;

  const [pair] = await sql<{ id: number }[]>`
    INSERT INTO parties (flight_id, telegram_user_id, display_name, size, state, w_adjacency)
    VALUES (${flight.id}, 111, 'Anna B.', 2, 'seated', 200) RETURNING id
  `;
  const [single] = await sql<{ id: number }[]>`
    INSERT INTO parties (flight_id, telegram_user_id, display_name, size, state,
                         w_window, w_avoid_middle)
    VALUES (${flight.id}, 222, 'Clara D.', 1, 'seated', 60, 40) RETURNING id
  `;

  const members: number[] = [];
  for (const [partyId, seat] of [[pair.id, '14A'], [pair.id, '20C'], [single.id, '14B']] as const) {
    const [m] = await sql<{ id: number }[]>`
      INSERT INTO members (party_id, flight_id, current_seat)
      VALUES (${partyId}, ${flight.id}, ${seat}) RETURNING id
    `;
    members.push(m.id);
  }
  return { flightId: flight.id, pairId: pair.id, singleId: single.id, members };
}

/** A pending proposal swapping the pair's 20C with the single's 14B. */
async function seedProposal(seed: Awaited<ReturnType<typeof seedFlight>>, expiresIn = '3 hours') {
  const [run] = await sql<{ id: number }[]>`
    INSERT INTO match_runs (flight_id, trigger) VALUES (${seed.flightId}, 'scheduled') RETURNING id
  `;
  const [proposal] = await sql<{ id: number }[]>`
    INSERT INTO proposals (match_run_id, flight_id, cycle_index, total_gain,
                           expires_at, agreement_token)
    VALUES (${run.id}, ${seed.flightId}, 0, 240,
            now() + ${expiresIn}::interval, ${'a'.repeat(32)})
    RETURNING id
  `;
  await sql`
    INSERT INTO proposal_parties (proposal_id, party_id, gain)
    VALUES (${proposal.id}, ${seed.pairId}, 200), (${proposal.id}, ${seed.singleId}, 40)
  `;
  await sql`
    INSERT INTO proposal_assignments (proposal_id, member_id, from_seat, to_seat)
    VALUES (${proposal.id}, ${seed.members[1]}, '20C', '14B'),
           (${proposal.id}, ${seed.members[2]}, '14B', '20C')
  `;
  await sql`UPDATE parties SET state = 'matched' WHERE flight_id = ${seed.flightId}`;
  return proposal.id;
}

const status = async (id: number) =>
  (await sql<{ status: string }[]>`SELECT status FROM proposals WHERE id = ${id}`)[0].status;

const states = async (flightId: number) =>
  (await sql<{ state: string }[]>`
    SELECT state FROM parties WHERE flight_id = ${flightId} ORDER BY id
  `).map((r) => r.state);

describe('respond', { skip }, () => {
  test('refuses somebody who is not in the proposal', async () => {
    const seed = await seedFlight();
    const id = await seedProposal(seed);

    const result = await proposals.respond(id, 999, 'accept');
    assert.equal(result.ok, false);
    assert.match(result.message, /not yours/);
    assert.equal(await status(id), 'pending');
  });

  test('one acceptance is not enough', async () => {
    const seed = await seedFlight();
    const id = await seedProposal(seed);

    const result = await proposals.respond(id, 111, 'accept');
    assert.equal(result.ok, true);
    assert.equal(result.settled, false);
    assert.match(result.message, /Waiting for 1 other person/);
    assert.equal(await status(id), 'pending');
  });

  test('the cycle settles only when everyone accepts', async () => {
    const seed = await seedFlight();
    const id = await seedProposal(seed);

    await proposals.respond(id, 111, 'accept');
    const result = await proposals.respond(id, 222, 'accept');

    assert.equal(result.settled, true);
    assert.equal(result.agreementToken, 'a'.repeat(32));
    assert.equal(await status(id), 'accepted');
    assert.deepEqual(await states(seed.flightId), ['settled', 'settled']);
  });

  test('accepting twice does not settle a cycle on its own', async () => {
    const seed = await seedFlight();
    const id = await seedProposal(seed);

    await proposals.respond(id, 111, 'accept');
    const again = await proposals.respond(id, 111, 'accept');

    assert.equal(again.settled, false);
    assert.equal(await status(id), 'pending');
  });

  test('one decline ends it for everyone', async () => {
    const seed = await seedFlight();
    const id = await seedProposal(seed);

    await proposals.respond(id, 111, 'accept');
    const result = await proposals.respond(id, 222, 'reject');

    assert.equal(result.ok, true);
    assert.equal(result.settled, false);
    assert.equal(await status(id), 'rejected');
  });

  test('a decline puts everyone back in the pool', async () => {
    const seed = await seedFlight();
    const id = await seedProposal(seed);

    await proposals.respond(id, 222, 'reject');
    assert.deepEqual(await states(seed.flightId), ['seated', 'seated']);
  });

  test('a decline asks for another match run', async () => {
    const seed = await seedFlight();
    const id = await seedProposal(seed);
    await proposals.respond(id, 222, 'reject');

    const jobs = await sql<{ type: string }[]>`SELECT type FROM jobs WHERE type = 'match_run'`;
    assert.equal(jobs.length, 1, 'declining should trigger a fresh search');
  });

  test('refuses an expired proposal', async () => {
    const seed = await seedFlight();
    const id = await seedProposal(seed, '-1 minute');

    const result = await proposals.respond(id, 111, 'accept');
    assert.equal(result.ok, false);
    assert.match(result.message, /expired/);
  });

  test('refuses a proposal that is already settled', async () => {
    const seed = await seedFlight();
    const id = await seedProposal(seed);
    await proposals.respond(id, 111, 'accept');
    await proposals.respond(id, 222, 'accept');

    const late = await proposals.respond(id, 111, 'reject');
    assert.equal(late.ok, false);
    assert.match(late.message, /already agreed/);
    assert.equal(await status(id), 'accepted');
  });

  test('refuses a proposal that does not exist', async () => {
    const result = await proposals.respond(999999, 111, 'accept');
    assert.equal(result.ok, false);
  });
});

describe('the agreement page lookup', { skip }, () => {
  test('finds an accepted proposal by its token', async () => {
    const seed = await seedFlight();
    const id = await seedProposal(seed);
    await proposals.respond(id, 111, 'accept');
    await proposals.respond(id, 222, 'accept');

    const found = await proposals.loadProposalByToken('a'.repeat(32));
    assert.equal(found?.id, id);
    assert.equal(found?.status, 'accepted');

    const moves = await proposals.movesFor(id);
    assert.equal(moves.length, 2);
    assert.deepEqual(
      moves.map((m) => `${m.from_seat}->${m.to_seat}`).sort(),
      ['14B->20C', '20C->14B'],
    );
  });

  test('rejects a token of the wrong shape without touching the database', async () => {
    assert.equal(await proposals.loadProposalByToken('short'), null);
    assert.equal(await proposals.loadProposalByToken('../../etc/passwd'), null);
    assert.equal(await proposals.loadProposalByToken('Z'.repeat(32)), null);
  });
});

describe('submitSeats', { skip }, () => {
  async function seedRegistered() {
    const [flight] = await sql<{ id: number }[]>`
      INSERT INTO flights (carrier, flight_number, departure_date, seat_map_key,
                           scheduled_departure_utc, api_status)
      VALUES ('FR', '1234', '2099-10-12', 'B738', now() + interval '10 days', 'verified')
      RETURNING id
    `;
    const [party] = await sql<{ id: number }[]>`
      INSERT INTO parties (flight_id, telegram_user_id, display_name, size, state, w_adjacency)
      VALUES (${flight.id}, 111, 'Anna B.', 2, 'registered', 200) RETURNING id
    `;
    await sql`
      INSERT INTO members (party_id, flight_id, current_seat)
      VALUES (${party.id}, ${flight.id}, NULL), (${party.id}, ${flight.id}, NULL)
    `;
    return { flightId: flight.id, partyId: party.id };
  }

  test('records the seats and seats the party', async () => {
    const seed = await seedRegistered();
    const result = await seats.submitSeats(111, '14A, 20C');

    assert.equal(result.ok, true);
    assert.deepEqual(result.seats, ['14A', '20C']);

    const rows = await sql<{ current_seat: string; state: string }[]>`
      SELECT m.current_seat, p.state FROM members m JOIN parties p ON p.id = m.party_id
       WHERE p.id = ${seed.partyId} ORDER BY m.id
    `;
    assert.deepEqual(rows.map((r) => r.current_seat), ['14A', '20C']);
    assert.equal(rows[0].state, 'seated');
  });

  test('asks for an immediate match run', async () => {
    await seedRegistered();
    await seats.submitSeats(111, '14A, 20C');

    const jobs = await sql<{ payload: { trigger: string } }[]>`
      SELECT payload FROM jobs WHERE type = 'match_run'
    `;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].payload.trigger, 'immediate');
  });

  test('refuses the wrong number of seats', async () => {
    await seedRegistered();
    const result = await seats.submitSeats(111, '14A');
    assert.equal(result.ok, false);
    assert.match(result.message, /signed up as 2 people/);
  });

  test('refuses a seat that cannot exist on the aircraft', async () => {
    await seedRegistered();
    const result = await seats.submitSeats(111, '99Z, 14A');
    assert.equal(result.ok, false);
    assert.match(result.message, /do(es)? not exist/);
  });

  test('refuses a seat somebody else already claimed', async () => {
    const seed = await seedRegistered();
    const [other] = await sql<{ id: number }[]>`
      INSERT INTO parties (flight_id, telegram_user_id, display_name, size, state)
      VALUES (${seed.flightId}, 222, 'Clara D.', 1, 'seated') RETURNING id
    `;
    await sql`
      INSERT INTO members (party_id, flight_id, current_seat)
      VALUES (${other.id}, ${seed.flightId}, '14A')
    `;

    const result = await seats.submitSeats(111, '14A, 20C');
    assert.equal(result.ok, false);
    assert.match(result.message, /already claimed/);
  });

  test('tells someone with no flight what to do', async () => {
    const result = await seats.submitSeats(111, '14A');
    assert.equal(result.ok, false);
    assert.match(result.message, /not signed up/);
  });

  test('asks which flight when there is more than one', async () => {
    await seedRegistered();
    const [second] = await sql<{ id: number }[]>`
      INSERT INTO flights (carrier, flight_number, departure_date, seat_map_key,
                           scheduled_departure_utc, api_status)
      VALUES ('W6', '3234', '2099-11-01', 'A321', now() + interval '20 days', 'verified')
      RETURNING id
    `;
    const [party] = await sql<{ id: number }[]>`
      INSERT INTO parties (flight_id, telegram_user_id, display_name, size, state)
      VALUES (${second.id}, 111, 'Anna B.', 2, 'registered') RETURNING id
    `;
    await sql`
      INSERT INTO members (party_id, flight_id, current_seat)
      VALUES (${party.id}, ${second.id}, NULL), (${party.id}, ${second.id}, NULL)
    `;

    const ambiguous = await seats.submitSeats(111, '14A, 20C');
    assert.equal(ambiguous.ok, false);
    assert.match(ambiguous.message, /more than one flight/);

    // Naming the flight resolves it.
    const resolved = await seats.submitSeats(111, 'W6 3234: 14A, 20C');
    assert.equal(resolved.ok, true, resolved.message);
  });
});
