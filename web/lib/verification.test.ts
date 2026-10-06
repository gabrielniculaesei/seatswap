/**
 * The guard on what a browser is allowed to claim it read off a boarding pass.
 *
 * bcbp.ts produces this shape, but the request carrying it is still a request:
 * anybody can POST anything. So sanitisePasses re-checks every field from
 * scratch, and these tests are mostly about the things our own parser would
 * never produce.
 *
 * This file can exist at all because db.ts builds its client lazily — importing
 * verification.ts no longer demands a database.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { parseBoardingPass } from './bcbp.ts';
import { sanitisePasses } from './verification.ts';

const LEG = {
  carrier: 'W6',
  flightNumber: '3234',
  origin: 'OTP',
  destination: 'BGY',
  dayOfYear: 285,
  compartment: 'Y',
  seat: '14A',
  sequenceNumber: 25,
};

describe('sanitisePasses', () => {
  test('accepts what our own parser produces', () => {
    const parsed = parseBoardingPass(
      'M1DESMARAIS/LUC       EABC123 YULFRAAC 0834 226F001A0025 100',
    );
    assert.ok(parsed.ok);

    const clean = sanitisePasses([parsed.pass.legs]);
    assert.ok(clean, 'should accept a pass straight from bcbp.ts');
    assert.equal(clean[0][0].seat, '1A');
    assert.equal(clean[0][0].sequenceNumber, 25);
  });

  test('accepts a pass with no seat on it yet', () => {
    const clean = sanitisePasses([[{ ...LEG, seat: null, sequenceNumber: null }]]);
    assert.ok(clean);
    assert.equal(clean[0][0].seat, null);
    assert.equal(clean[0][0].sequenceNumber, null);
  });

  test('normalises case rather than rejecting it', () => {
    const clean = sanitisePasses([[{ ...LEG, carrier: 'w6', seat: '14a', origin: 'otp' }]]);
    assert.ok(clean);
    assert.equal(clean[0][0].carrier, 'W6');
    assert.equal(clean[0][0].seat, '14A');
    assert.equal(clean[0][0].origin, 'OTP');
  });

  test('drops fields we never asked for', () => {
    const clean = sanitisePasses([[{ ...LEG, passengerName: 'ROSSI/ANNA', pnr: 'ABC123' }]]);
    assert.ok(clean);
    // Whatever else was posted, only the declared fields survive into the object
    // we go on to use.
    assert.deepEqual(Object.keys(clean[0][0]).sort(), [
      'carrier', 'compartment', 'dayOfYear', 'destination',
      'flightNumber', 'origin', 'seat', 'sequenceNumber',
    ]);
  });

  test('rejects a body that is not a list of passes', () => {
    for (const input of [null, undefined, {}, 'M1...', 42, [], [[]], [{}], [[null]]]) {
      assert.equal(sanitisePasses(input), null, `should reject ${JSON.stringify(input)}`);
    }
  });

  test('rejects field values that could not come off a boarding pass', () => {
    const bad: Record<string, unknown>[] = [
      { carrier: '' },
      { carrier: 'WIZZAIR' },
      { flightNumber: '' },
      { flightNumber: '32345' },
      { flightNumber: 'ABCD' },
      { origin: 'OTPX' },
      { destination: '12' },
      { dayOfYear: 0 },
      { dayOfYear: 367 },
      { dayOfYear: 12.5 },
      { dayOfYear: 'tuesday' },
      { seat: '14' },
      { seat: 'A14' },
      { seat: "14A'; DROP TABLE members" },
      { sequenceNumber: -1 },
      { sequenceNumber: 10_000 },
      { sequenceNumber: 1.5 },
    ];
    for (const override of bad) {
      assert.equal(
        sanitisePasses([[{ ...LEG, ...override }]]),
        null,
        `should reject ${JSON.stringify(override)}`,
      );
    }
  });

  test('refuses a body far larger than any real party', () => {
    // A party is at most 8 people, and a barcode holds at most 9 legs.
    const pass = [LEG];
    assert.ok(sanitisePasses(Array.from({ length: 8 }, () => pass)));
    assert.equal(sanitisePasses(Array.from({ length: 9 }, () => pass)), null);
    assert.equal(sanitisePasses([Array.from({ length: 10 }, () => LEG)]), null);
  });
});
