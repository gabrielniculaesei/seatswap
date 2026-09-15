/**
 * How many new flights one account may bring into existence per day.
 *
 * Creating a flight row is the only thing a visitor can do that spends a scarce
 * external resource: it queues that flight's one `verify_flight` job, which is
 * one AeroDataBox call out of roughly 600 a month (CLAUDE.md §11).
 *
 * M6 moved creation off the page render and behind the Telegram login, so a
 * crawler cannot reach it. That raised the price of the attack without bounding
 * it — a Telegram account takes half a minute to make, and an authenticated
 * script can still walk carrier / number / date until the month's quota is gone.
 * A per-account cap is what actually bounds it.
 *
 * Two things this deliberately does not do:
 *
 *  - **It does not meter joining an existing flight.** That costs nothing and is
 *    the behaviour we want: ten people converging on one flight is the product
 *    working, not abuse (CLAUDE.md §2.2). Only the first arrival on a flight
 *    nobody has mentioned before is counted.
 *  - **It does not try to be exact.** Two simultaneous requests from one account
 *    can both pass the check and leave it one over. Being occasionally one over a
 *    daily cap costs one API call; the locking needed to prevent that would sit
 *    on the sign-up path forever to save it.
 */

import sql from './db.ts';

export const DEFAULT_MAX_NEW_FLIGHTS_PER_DAY = 5;

/** The window the cap applies over. */
export const WINDOW = '24 hours';

/**
 * A round trip is two flights and a connection makes it four, so five a day
 * leaves an ordinary traveller room and still bounds a script hard.
 */
export function maxNewFlightsPerDay(
  env: Record<string, string | undefined> = process.env,
): number {
  // An empty or missing variable means "not configured", not zero. `MAX_NEW_
  // FLIGHTS_PER_DAY=` with nothing after it is an ordinary thing to find in a
  // .env, and Number('') is 0 — which would quietly stop anyone anywhere from
  // adding a flight, with no error to explain it.
  const configured = (env.MAX_NEW_FLIGHTS_PER_DAY ?? '').trim();
  if (configured === '') return DEFAULT_MAX_NEW_FLIGHTS_PER_DAY;

  const raw = Number(configured);
  if (!Number.isInteger(raw) || raw < 0) return DEFAULT_MAX_NEW_FLIGHTS_PER_DAY;
  return raw;
}

/**
 * What to tell somebody who has hit it.
 *
 * Written for the traveller who genuinely has a lot of flights, because that is
 * who will actually read it — a script does not care. It says what still works,
 * since joining flights is untouched and that is most of what people do.
 */
export function quotaMessage(limit: number): string {
  return (
    `You have added ${limit} new ${limit === 1 ? 'flight' : 'flights'} today, which is `
    + 'the daily limit — looking up a flight costs us a paid call to our flight data '
    + 'provider, so we ration new ones. You can still sign up for any flight that is '
    + 'already on the site. Try again tomorrow, or send us the flight and we will add it.'
  );
}

/** How many new flights this account has created inside the window. */
export async function newFlightsCreatedRecently(telegramUserId: number): Promise<number> {
  const rows = await sql<{ n: string }[]>`
    SELECT count(*) AS n
      FROM flight_creations
     WHERE telegram_user_id = ${telegramUserId}
       AND created_at > now() - ${WINDOW}::interval
  `;
  return Number(rows[0].n);
}

/**
 * Record a creation, and drop every row that has aged out — anybody's, not just
 * this account's.
 *
 * Pruning only the caller's rows left the one-time creator's row behind for good,
 * since they never come back to trigger their own cleanup: a Telegram id kept
 * indefinitely, which is exactly what CLAUDE.md §13 and the privacy policy say
 * does not happen. Pruning here keeps the table about a day deep while flights
 * are being created; the worker's expire_proposals sweep is the backstop for
 * when they are not (solver/repository.py, prune_flight_creations).
 */
export async function recordFlightCreation(telegramUserId: number): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO flight_creations (telegram_user_id) VALUES (${telegramUserId})
    `;
    await tx`
      DELETE FROM flight_creations
       WHERE created_at <= now() - ${WINDOW}::interval
    `;
  });
}
