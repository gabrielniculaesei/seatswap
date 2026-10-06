/**
 * Enqueueing work for the solver worker.
 *
 * The web tier never runs the solver in-request, and never calls AeroDataBox in
 * request either. It writes a row and lets the worker get on with it. This is the
 * Python `solver/jobs.py` seen from the other side — the same table, the same
 * de-duplication index, so the two cannot disagree about what a job is.
 */

import type postgres from 'postgres';

import sql from './db.ts';

/** A job payload has to survive a round trip through jsonb, so it is JSON. */
export type JobPayload = Record<string, postgres.JSONValue>;

export const JOB_TYPES = [
  'verify_flight',
  'checkin_reminder',
  'match_run',
  'expire_proposals',
  'purge_flight',
] as const;

export type JobType = (typeof JOB_TYPES)[number];

/**
 * Add a job. Returns null when an identical one is already queued.
 *
 * De-duplication is the partial unique index from migration 0002, so two users
 * submitting their seats in the same second queue one match run, not two. A
 * duplicate is a non-event, not an error.
 */
export async function enqueue(
  type: JobType,
  payload: JobPayload = {},
  runAfter?: Date,
): Promise<number | null> {
  const rows = await sql<{ id: number }[]>`
    INSERT INTO jobs (type, payload, run_after)
    VALUES (${type}, ${sql.json(payload)}, COALESCE(${runAfter ?? null}, now()))
    ON CONFLICT DO NOTHING
    RETURNING id
  `;
  return rows.length > 0 ? rows[0].id : null;
}

/**
 * Queue verification for a flight we have just created a row for.
 *
 * Called once, when the flight first appears — which is what makes "one API call
 * per flight, never one per user" structural rather than a rule someone has to
 * remember.
 */
export async function requestFlightVerification(flightId: number) {
  return enqueue('verify_flight', { flight_id: flightId });
}

/**
 * Ask for a match run right now, because somebody just submitted their seats.
 *
 * The worker will only actually emit a proposal from an immediate run if every
 * party involved is already at its theoretical best; otherwise it holds the
 * result back and waits for a scheduled run that might find a better chain.
 * So this is cheap to call on every submission.
 */
export async function requestImmediateMatchRun(flightId: number) {
  return enqueue('match_run', { flight_id: flightId, trigger: 'immediate' });
}
