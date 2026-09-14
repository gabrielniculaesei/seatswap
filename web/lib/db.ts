/**
 * Database connection for the web tier.
 *
 * postgres.js, hand-written SQL, no ORM (CLAUDE.md §12, §17). One pooled client
 * per process, cached on globalThis so Next.js hot reloading in development does
 * not open a new pool on every edit and exhaust the server's connection limit.
 */

import postgres from 'postgres';

declare global {
  // eslint-disable-next-line no-var
  var __seatswapSql: ReturnType<typeof postgres> | undefined;
}

function create() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  return postgres(url, {
    // Neon sits behind a pooler; a small per-instance pool is plenty, and serverless
    // functions are better off with few connections each than many.
    max: Number(process.env.DATABASE_POOL_MAX ?? 5),
    idle_timeout: 20,
    connect_timeout: 10,
    types: {
      // BIGSERIAL ids come back as strings by default, because int8 can exceed
      // what a JS number holds exactly. Ours cannot: these are row ids on a
      // hobby-scale table, nowhere near 2^53. Parsing them as numbers keeps the
      // TypeScript types honest and, more importantly, keeps job payloads as
      // {"flight_id": 2} rather than {"flight_id": "2"} — the de-duplication
      // index in migration 0002 compares jsonb, and those two are not equal, so
      // a string id would silently defeat it between the web and the worker.
      int8: {
        to: 20,
        from: [20],
        serialize: (value: number | string) => String(value),
        parse: (value: string) => Number(value),
      },
      // A DATE is a calendar date, not an instant. Left to the driver it comes
      // back as a JS Date interpreted in the server's timezone, which silently
      // shifts a departure date by a day either side of midnight. Keep it as the
      // 'YYYY-MM-DD' string it is; TIMESTAMPTZ columns are real instants and are
      // left alone.
      date: {
        to: 1082,
        from: [1082],
        serialize: (value: string) => value,
        parse: (value: string) => value,
      },
    },
    connection: {
      // Flight pages are server-rendered on every request; a query that has not
      // answered in five seconds should fail rather than hold the render open.
      statement_timeout: 5_000,
    },
    onnotice: () => {},
  });
}

export const sql = globalThis.__seatswapSql ?? create();

if (process.env.NODE_ENV !== 'production') {
  globalThis.__seatswapSql = sql;
}

export default sql;
