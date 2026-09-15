/**
 * Flight URL parsing. This guards the only route a stranger can type, and every
 * accepted value creates a database row and can spend an AeroDataBox call.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  departureDateBounds,
  formatFlightSlug,
  normaliseFlightInput,
  parseDepartureDate,
  parseFlightSlug,
} from './flight-id.ts';

const TODAY = new Date('2026-09-14T10:00:00Z');

describe('parseFlightSlug', () => {
  test('parses the documented shape', () => {
    assert.deepEqual(parseFlightSlug('W6-3234'), { carrier: 'W6', flightNumber: '3234' });
  });

  test('upper-cases and trims', () => {
    assert.deepEqual(parseFlightSlug('  w6-3234 '), { carrier: 'W6', flightNumber: '3234' });
  });

  test('accepts numeric carriers and lettered flight numbers', () => {
    assert.deepEqual(parseFlightSlug('U2-101'), { carrier: 'U2', flightNumber: '101' });
    assert.deepEqual(parseFlightSlug('BA-22A'), { carrier: 'BA', flightNumber: '22A' });
  });

  test('rejects anything that is not a flight designator', () => {
    for (const bad of [
      '', 'W6', '3234', 'W6-', '-3234', 'W63234',
      'WIZZ-3234',        // carrier too long
      'W6-12345',         // flight number too long
      'W6-3234-extra',
      '../../etc/passwd',
      'W6-32 34',
    ]) {
      assert.equal(parseFlightSlug(bad), null, `should reject ${bad}`);
    }
  });
});

describe('formatFlightSlug', () => {
  test('round-trips with the parser', () => {
    const slug = formatFlightSlug('w6', '3234');
    assert.equal(slug, 'W6-3234');
    assert.deepEqual(parseFlightSlug(slug), { carrier: 'W6', flightNumber: '3234' });
  });
});

describe('normaliseFlightInput', () => {
  test('accepts the shapes people actually paste', () => {
    for (const input of ['W6 3234', 'W63234', 'w6-3234', '  W6   3234  ']) {
      assert.equal(normaliseFlightInput(input), 'W6-3234', `failed on ${input}`);
    }
  });
});

describe('parseDepartureDate', () => {
  test('accepts a date in range', () => {
    assert.equal(parseDepartureDate('2026-10-12', TODAY), '2026-10-12');
  });

  test('accepts today', () => {
    assert.equal(parseDepartureDate('2026-09-14', TODAY), '2026-09-14');
  });

  test('accepts yesterday, since the flight may still be in the air', () => {
    assert.equal(parseDepartureDate('2026-09-13', TODAY), '2026-09-13');
  });

  test('rejects the past beyond that', () => {
    assert.equal(parseDepartureDate('2026-09-01', TODAY), null);
    assert.equal(parseDepartureDate('1999-01-01', TODAY), null);
  });

  test('rejects more than a year out', () => {
    assert.equal(parseDepartureDate('2028-01-01', TODAY), null);
  });

  test('accepts the far edge of the window', () => {
    assert.equal(parseDepartureDate('2027-09-01', TODAY), '2027-09-01');
  });

  test('rejects dates that only look real', () => {
    // Date would silently roll these over into March.
    assert.equal(parseDepartureDate('2026-02-31', TODAY), null);
    assert.equal(parseDepartureDate('2026-13-01', TODAY), null);
    assert.equal(parseDepartureDate('2026-00-10', TODAY), null);
  });

  test('rejects wrong formats', () => {
    for (const bad of ['', '2026-10-1', '12-10-2026', '2026/10/12', 'tomorrow', '2026-10-12T00:00:00Z']) {
      assert.equal(parseDepartureDate(bad, TODAY), null, `should reject ${bad}`);
    }
  });
});

describe('departureDateBounds', () => {
  test('is the range parseDepartureDate accepts, to the day', () => {
    // The home page's date picker is limited to exactly this, so a date the
    // picker offers is never one the server then refuses.
    const { min, max } = departureDateBounds(TODAY);
    assert.equal(min, '2026-09-13');
    assert.equal(max, '2027-09-14');

    assert.equal(parseDepartureDate(min, TODAY), min);
    assert.equal(parseDepartureDate(max, TODAY), max);
    assert.equal(parseDepartureDate('2026-09-12', TODAY), null, 'the day before min');
    assert.equal(parseDepartureDate('2027-09-15', TODAY), null, 'the day after max');
  });

  test('works in UTC whatever the time of day', () => {
    const lateEvening = new Date('2026-09-14T23:59:59Z');
    assert.deepEqual(departureDateBounds(lateEvening), departureDateBounds(TODAY));
  });
});
