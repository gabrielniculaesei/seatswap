/**
 * Canonical URLs, indexability and structured data (CLAUDE.md §5).
 *
 * The two rules worth guarding here are the ones with consequences: an empty
 * flight page must never be indexable, and structured data must never be emitted
 * for a flight we have not actually confirmed.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  DEFAULT_SITE_URL,
  absoluteUrl,
  flightJsonLd,
  flightMeta,
  flightPath,
  siteUrl,
} from './seo.ts';

describe('siteUrl', () => {
  test('uses the configured public base URL', () => {
    assert.equal(siteUrl({ PUBLIC_BASE_URL: 'https://example.com' }), 'https://example.com');
  });

  test('drops trailing slashes so joins never double up', () => {
    assert.equal(siteUrl({ PUBLIC_BASE_URL: 'https://example.com/' }), 'https://example.com');
    assert.equal(siteUrl({ PUBLIC_BASE_URL: 'https://example.com///' }), 'https://example.com');
  });

  test('falls back to localhost when unset or blank', () => {
    assert.equal(siteUrl({}), DEFAULT_SITE_URL);
    assert.equal(siteUrl({ PUBLIC_BASE_URL: '   ' }), DEFAULT_SITE_URL);
  });
});

describe('flightPath', () => {
  test('is the shareable link from CLAUDE.md §5', () => {
    assert.equal(flightPath('W6', '3234', '2026-10-12'), '/f/W6-3234/2026-10-12');
  });

  test('normalises case, so pasted variants collapse to one canonical', () => {
    // Every one of these renders; without a canonical they would compete.
    assert.equal(flightPath('w6', '3234', '2026-10-12'), '/f/W6-3234/2026-10-12');
    assert.equal(flightPath('w6', '123a', '2026-10-12'), '/f/W6-123A/2026-10-12');
  });

  test('absoluteUrl joins without doubling the slash', () => {
    const env = { PUBLIC_BASE_URL: 'https://example.com/' };
    assert.equal(absoluteUrl('/f/W6-3234/2026-10-12', env), 'https://example.com/f/W6-3234/2026-10-12');
    assert.equal(absoluteUrl('f/W6-3234/2026-10-12', env), 'https://example.com/f/W6-3234/2026-10-12');
  });
});

describe('flightMeta', () => {
  test('names the route when we know it', () => {
    const meta = flightMeta({
      carrier: 'W6', flightNumber: '3234', departureDate: '2026-10-12',
      origin: 'OTP', destination: 'BGY', parties: 3,
    });
    assert.match(meta.title, /W63234 OTP to BGY on 2026-10-12/);
    assert.match(meta.description, /OTP to BGY/);
  });

  test('stays vague rather than asserting a route we guessed', () => {
    const meta = flightMeta({
      carrier: 'W6', flightNumber: '3234', departureDate: '2026-10-12', parties: 3,
    });
    assert.equal(meta.title, 'W63234 on 2026-10-12 — seat swaps');
    assert.ok(!meta.description.includes(' to '), meta.description);
  });

  test('carries the canonical path', () => {
    const meta = flightMeta({
      carrier: 'w6', flightNumber: '3234', departureDate: '2026-10-12', parties: 1,
    });
    assert.equal(meta.canonical, '/f/W6-3234/2026-10-12');
  });

  describe('indexability', () => {
    test('a flight nobody has signed up for is not indexable', () => {
      // The URL space is tens of millions of addresses that all render. Indexing
      // the empty ones is how a site gets classified as thin-content spam.
      const meta = flightMeta({
        carrier: 'W6', flightNumber: '3234', departureDate: '2026-10-12', parties: 0,
      });
      assert.equal(meta.index, false);
    });

    test('and neither is one we have no count for', () => {
      const meta = flightMeta({
        carrier: 'W6', flightNumber: '3234', departureDate: '2026-10-12',
      });
      assert.equal(meta.index, false);
    });

    test('one signed-up party is enough to make it worth indexing', () => {
      const meta = flightMeta({
        carrier: 'W6', flightNumber: '3234', departureDate: '2026-10-12', parties: 1,
      });
      assert.equal(meta.index, true);
    });
  });
});

describe('flightJsonLd', () => {
  const verified = {
    carrier: 'FR', flightNumber: '1234', departureDate: '2026-10-12',
    origin: 'OTP', destination: 'BGY', aircraftType: 'Boeing 737-800',
    scheduledDepartureUtc: new Date('2026-10-12T06:00:00Z'),
    apiStatus: 'verified',
    url: 'https://example.com/f/FR-1234/2026-10-12',
  };

  test('describes the page as being about the flight, not as the flight', () => {
    const ld = flightJsonLd(verified)!;
    assert.equal(ld['@type'], 'WebPage');
    const about = ld.about as Record<string, unknown>;
    assert.equal(about['@type'], 'Flight');
    assert.equal(about.flightNumber, 'FR1234');
    assert.deepEqual(about.provider, { '@type': 'Airline', iataCode: 'FR' });
  });

  test('includes route, aircraft and departure time when known', () => {
    const about = flightJsonLd(verified)!.about as Record<string, unknown>;
    assert.deepEqual(about.departureAirport, { '@type': 'Airport', iataCode: 'OTP' });
    assert.deepEqual(about.arrivalAirport, { '@type': 'Airport', iataCode: 'BGY' });
    assert.equal(about.aircraft, 'Boeing 737-800');
    assert.equal(about.departureTime, '2026-10-12T06:00:00.000Z');
  });

  test('says nothing at all about an unconfirmed flight', () => {
    // Marking up a route we guessed would be inventing facts about a real flight.
    for (const apiStatus of ['unknown', 'not_found', '']) {
      assert.equal(flightJsonLd({ ...verified, apiStatus }), null, apiStatus);
    }
  });

  test('omits fields we do not hold rather than emitting empty ones', () => {
    const about = flightJsonLd({
      ...verified, origin: null, destination: null,
      aircraftType: null, scheduledDepartureUtc: null,
    })!.about as Record<string, unknown>;

    assert.deepEqual(Object.keys(about).sort(), ['@type', 'flightNumber', 'provider']);
  });

  test('ignores a departure time that is not a real date', () => {
    const about = flightJsonLd({ ...verified, scheduledDepartureUtc: 'not a date' })!
      .about as Record<string, unknown>;
    assert.ok(!('departureTime' in about));
  });

  describe('the departure time has to belong to the day the page is about', () => {
    const departureTimeOf = (scheduledDepartureUtc: Date) =>
      (flightJsonLd({ ...verified, scheduledDepartureUtc })!.about as Record<string, unknown>)
        .departureTime;

    test('keeps an instant on the day itself', () => {
      assert.equal(
        departureTimeOf(new Date('2026-10-12T06:00:00Z')),
        '2026-10-12T06:00:00.000Z',
      );
    });

    test('allows a day of slack for the timezone offset', () => {
      // A flight leaving late local time east of UTC, or early west of it, is a
      // normal disagreement between a calendar date and an instant.
      assert.ok(departureTimeOf(new Date('2026-10-11T22:00:00Z')));
      assert.ok(departureTimeOf(new Date('2026-10-13T08:00:00Z')));
    });

    test('drops an instant that is nowhere near, rather than contradicting the page', () => {
      // A row whose timestamp is a month off the date in the URL is wrong
      // somewhere. Saying nothing beats telling Google two different things.
      const about = flightJsonLd({
        ...verified, scheduledDepartureUtc: new Date('2026-11-20T05:40:00Z'),
      })!.about as Record<string, unknown>;
      assert.ok(!('departureTime' in about), 'should stay quiet');
      // The rest of the markup survives — only the disputed field goes.
      assert.equal(about.flightNumber, 'FR1234');
      assert.deepEqual(about.departureAirport, { '@type': 'Airport', iataCode: 'OTP' });
    });
  });
});
