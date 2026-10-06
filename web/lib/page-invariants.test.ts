/**
 * Rules about the pages that a crawler is invited into.
 *
 * These read source rather than behaviour, which is unusual and is the point.
 * The rule they protect has no symptom: if the flight page starts writing again,
 * every page still renders correctly and every other test still passes — the only
 * evidence is a `flights` table filling with flights nobody asked about and an
 * AeroDataBox quota that is gone by the middle of the month. A rule with no
 * failure mode you can observe is exactly the one worth pinning to the source.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');
const read = (path: string) => readFileSync(join(APP, path), 'utf8');

describe('the flight page is read-only', () => {
  const source = read('f/[flight]/[date]/page.tsx');

  test('reads the flight rather than creating it', () => {
    assert.ok(
      source.includes('findFlight'),
      'the page should look the flight up',
    );
  });

  test('never calls findOrCreateFlight', () => {
    // Any carrier, number and date in range renders, so this page answers at tens
    // of millions of addresses. Creating a row per address visited would hand a
    // crawler an unbounded way to spend the one scarce resource we have.
    assert.ok(
      !source.includes('findOrCreateFlight'),
      'flight rows are created on sign-up, in /api/parties — not on render',
    );
  });

  test('queues no jobs', () => {
    for (const writer of ['enqueue(', 'requestFlightVerification', 'requestImmediateMatchRun']) {
      assert.ok(!source.includes(writer), `the page should not call ${writer}`);
    }
  });
});

describe('sign-up is where a flight row is born', () => {
  const source = read('api/parties/route.ts');

  test('the parties route creates the flight', () => {
    assert.ok(source.includes('flightForUser'));
  });

  test('through the metered entry point, never around it', () => {
    // flightForUser is findOrCreateFlight plus the per-account daily cap. Calling
    // the inner one directly from a request handler would restore the hole the
    // cap exists to close: a Telegram account costs half a minute, so a login
    // alone raises the price of walking the flight URL space without bounding it.
    assert.ok(
      !source.includes('findOrCreateFlight'),
      'sign-up must go through flightForUser so the daily cap applies',
    );
  });

  test('behind a session check, so a crawler cannot reach it', () => {
    assert.ok(source.includes('COOKIE_NAME'));
    assert.ok(source.includes('401'), 'an anonymous POST is rejected');
  });

  test('and refuses with 429 when the account is capped', () => {
    assert.ok(source.includes('429'), 'a rate limit should read as a rate limit');
  });
});

describe('agreement pages stay out of the index', () => {
  test('the page marks itself noindex', () => {
    const source = read('a/[token]/page.tsx');
    assert.match(source, /robots:\s*\{\s*index:\s*false/);
  });

  test('and robots.txt disallows the whole prefix', () => {
    const source = read('robots.ts');
    assert.match(source, /'\/a\/'/);
    assert.match(source, /'\/api\/'/);
  });
});

describe('pages built from PUBLIC_BASE_URL read it at request time', () => {
  // A static page is prerendered with whatever PUBLIC_BASE_URL the build saw.
  // robots.txt was, and pointed the sitemap at localhost on a server whose
  // environment was set only at runtime — no error, just a crawler sent nowhere.
  for (const path of ['robots.ts', 'privacy/page.tsx', 'terms/page.tsx']) {
    test(path, () => {
      assert.match(read(path), /export const dynamic = 'force-dynamic'/);
    });
  }
});

describe("the flight page's preview image touches no data", () => {
  // Every link unfurler fetches this for every flight link that is shared, at the
  // same tens of millions of addresses the page answers on. Drawn from the URL
  // it costs nothing and caches forever; one query in it and it is a second,
  // unauthenticated path into the database — and one more place a write could
  // creep in (the rule above).
  const source = read('f/[flight]/[date]/opengraph-image.tsx');

  test('imports nothing that can reach the database', () => {
    for (const module of ['/db.ts', '/flights.ts', '/jobs.ts', '/proposals.ts', '/seats.ts']) {
      assert.ok(!source.includes(module), `opengraph-image should not import ${module}`);
    }
  });
});

describe('the legal pages are reachable', () => {
  test('the footer links to both', () => {
    const source = readFileSync(join(APP, '..', 'components', 'Chrome.tsx'), 'utf8');
    assert.ok(source.includes('href="/privacy"'));
    assert.ok(source.includes('href="/terms"'));
  });

  test('and every page has that footer', () => {
    // Pages draw their own header and footer through PageShell (the legal pages
    // through LegalPage, which wraps it), so a page that skips it has no footer.
    const pages = readdirSync(APP, { recursive: true, encoding: 'utf8' })
      .filter((path) => /(^|\/)(page|not-found)\.tsx$/.test(path));
    assert.ok(pages.length >= 6, `found ${pages.length} pages`);
    for (const path of pages) {
      const source = read(path);
      assert.ok(
        source.includes('<PageShell') || source.includes('<LegalPage'),
        `${path} renders no footer`,
      );
    }
  });

  test('and sign-up points at them before anyone agrees to anything', () => {
    const source = read('f/[flight]/[date]/RegistrationForm.tsx');
    assert.ok(source.includes('href="/privacy"'));
    assert.ok(source.includes('href="/terms"'));
  });
});
