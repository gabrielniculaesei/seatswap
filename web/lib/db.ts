/**
 * Database connection for the web tier.
 *
 * postgres.js, hand-written SQL, no ORM. One pooled client
 * per process, cached on globalThis so Next.js hot reloading in development does
 * not open a new pool on every edit and exhaust the server's connection limit.
 *
 * The client is built on first use, not on import. This module used to throw from
 * its top level when DATABASE_URL was unset, which meant that importing anything
 * that imported it — however pure the function you actually wanted — required a
 * database. Twice that was worked around by splitting the pure logic into its own
 * file (flight-id.ts, seat-input.ts); the rule was to fix the cause
 * the third time instead, and verification.ts was the third time. Nothing connects
 * until a query is issued, so a unit test can import the module and never touch a
 * socket, while a missing DATABASE_URL still fails loudly the moment a query runs.
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

let cached: ReturnType<typeof postgres> | undefined;

function client(): ReturnType<typeof postgres> {
  if (!cached) {
    cached = globalThis.__seatswapSql ?? create();
    // Only development needs the global: it is what stops hot reload opening a
    // new pool on every edit. In production this module instance is the cache.
    if (process.env.NODE_ENV !== 'production') globalThis.__seatswapSql = cached;
  }
  return cached;
}

/**
 * Stands in for the postgres.js client until something is actually asked of it.
 *
 * `sql` is both callable (the tagged template) and an object (sql.begin, sql.json),
 * so the proxy needs both traps. Methods are bound to the real client because
 * postgres.js relies on its own `this`.
 */
export const sql: ReturnType<typeof postgres> = new Proxy(
  (() => {}) as unknown as ReturnType<typeof postgres>,
  {
    apply(_target, _thisArg, args: unknown[]) {
      return (client() as (...a: unknown[]) => unknown)(...args);
    },
    get(_target, property) {
      const real = client() as unknown as Record<string | symbol, unknown>;
      const value = real[property];
      return typeof value === 'function' ? value.bind(real) : value;
    },
    has(_target, property) {
      return property in (client() as unknown as object);
    },
  },
);

export default sql;
