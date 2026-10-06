/**
 * BCBP parsing (tier 1).
 *
 * The fixtures are built field by field rather than pasted, because the format is
 * fixed-width and a hand-typed literal that is one space out fails for a reason
 * that has nothing to do with the code. One real-shaped literal is checked too,
 * so a builder that drifts from the spec cannot quietly take the tests with it.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { dayOfYearOf, parseBoardingPass, resolveFlightDate } from './bcbp.ts';

/** Left-justified, space-padded to width, the way Res 792 pads every field. */
function pad(value: string, width: number): string {
  assert.ok(value.length <= width, `'${value}' does not fit in ${width}`);
  return value.padEnd(width, ' ');
}

interface LegFields {
  pnr?: string;
  from?: string;
  to?: string;
  carrier?: string;
  flight?: string;
  day?: string;
  compartment?: string;
  seat?: string;
  sequence?: string;
  status?: string;
  conditional?: string;
}

function leg(fields: LegFields = {}): string {
  const conditional = fields.conditional ?? '';
  return [
    pad(fields.pnr ?? 'ABC123', 7),
    pad(fields.from ?? 'OTP', 3),
    pad(fields.to ?? 'BGY', 3),
    pad(fields.carrier ?? 'W6', 3),
    pad(fields.flight ?? '3234', 5),
    pad(fields.day ?? '285', 3),
    pad(fields.compartment ?? 'Y', 1),
    pad(fields.seat ?? '014A', 4),
    pad(fields.sequence ?? '0025', 5),
    pad(fields.status ?? '1', 1),
    conditional.length.toString(16).toUpperCase().padStart(2, '0'),
    conditional,
  ].join('');
}

function boardingPass(legs: string[], name = 'ROSSI/ANNA'): string {
  return `M${legs.length}${pad(name, 20)}E${legs.join('')}`;
}

describe('parseBoardingPass', () => {
  test('reads the fields we cross-check off a single-leg pass', () => {
    const result = parseBoardingPass(boardingPass([leg()]));
    assert.ok(result.ok, 'should parse');

    assert.equal(result.pass.legs.length, 1);
    assert.deepEqual(result.pass.legs[0], {
      carrier: 'W6',
      flightNumber: '3234',
      origin: 'OTP',
      destination: 'BGY',
      dayOfYear: 285,
      compartment: 'Y',
      seat: '14A',
      sequenceNumber: 25,
    });
  });

  test('parses the spec\'s own example, typed out in full', () => {
    // 23 chars of header, then 37 of mandatory leg. If this one ever fails, the
    // builder above is wrong and every other test here is worthless.
    const raw = 'M1DESMARAIS/LUC       EABC123 YULFRAAC 0834 226F001A0025 100';
    assert.equal(raw.length, 60);

    const result = parseBoardingPass(raw);
    assert.ok(result.ok, 'should parse');
    assert.deepEqual(result.pass.legs[0], {
      carrier: 'AC',
      flightNumber: '834',
      origin: 'YUL',
      destination: 'FRA',
      dayOfYear: 226,
      compartment: 'F',
      seat: '1A',
      sequenceNumber: 25,
    });
  });

  test('never hands back the passenger name', () => {
    const result = parseBoardingPass(boardingPass([leg()], 'DESMARAIS/LUC'));
    assert.ok(result.ok);
    // Not "we did not read it" but "there is nowhere for it to come out".
    assert.ok(!JSON.stringify(result).includes('DESMARAIS'));
    assert.ok(!JSON.stringify(result).toUpperCase().includes('LUC'));
  });

  test('strips the padding zeros so seats match what we store', () => {
    const result = parseBoardingPass(boardingPass([leg({ flight: '00123', seat: '007F' })]));
    assert.ok(result.ok);
    assert.equal(result.pass.legs[0].flightNumber, '123');
    assert.equal(result.pass.legs[0].seat, '7F');
  });

  test('keeps a flight number suffix', () => {
    const result = parseBoardingPass(boardingPass([leg({ flight: '0123A' })]));
    assert.ok(result.ok);
    assert.equal(result.pass.legs[0].flightNumber, '123A');
  });

  test('accepts a three-letter carrier code', () => {
    const result = parseBoardingPass(boardingPass([leg({ carrier: 'EZY' })]));
    assert.ok(result.ok);
    assert.equal(result.pass.legs[0].carrier, 'EZY');
  });

  test('reports no seat rather than failing when there is none', () => {
    for (const seat of ['INF ', '    ', 'SBY ']) {
      const result = parseBoardingPass(boardingPass([leg({ seat })]));
      assert.ok(result.ok, `should still parse with seat '${seat}'`);
      assert.equal(result.pass.legs[0].seat, null);
    }
  });

  test('tolerates whitespace around the payload', () => {
    const result = parseBoardingPass(`\n  ${boardingPass([leg()])}  \n`);
    assert.ok(result.ok);
    assert.equal(result.pass.legs[0].seat, '14A');
  });

  describe('conditional and security sections', () => {
    test('steps over the conditional section and reads the version', () => {
      const conditional = '>3180      BW6 0000000000000002A00000000000000 1W6 W6 0000000000000    2';
      const result = parseBoardingPass(boardingPass([leg({ conditional })]));
      assert.ok(result.ok, 'should parse');
      assert.equal(result.pass.version, 3);
      assert.equal(result.pass.legs[0].seat, '14A');
    });

    test('reads both legs of a two-leg pass', () => {
      const raw = boardingPass([
        leg({ conditional: '>3180      BW6 00000000000000' }),
        leg({ from: 'BGY', to: 'LTN', carrier: 'FR', flight: '0812', day: '286', seat: '022C', sequence: '0104' }),
      ]);
      const result = parseBoardingPass(raw);
      assert.ok(result.ok, 'should parse');
      assert.equal(result.pass.legs.length, 2);
      assert.equal(result.pass.legs[0].destination, 'BGY');
      assert.equal(result.pass.legs[1].carrier, 'FR');
      assert.equal(result.pass.legs[1].flightNumber, '812');
      assert.equal(result.pass.legs[1].seat, '22C');
      assert.equal(result.pass.legs[1].sequenceNumber, 104);
    });

    test('stops at the security section instead of reading it as a leg', () => {
      const result = parseBoardingPass(`${boardingPass([leg()])}^164GIWVC5EH7JNT684FVNJ9`);
      assert.ok(result.ok, 'should parse');
      assert.equal(result.pass.legs.length, 1);
    });

    test('still yields the first leg when the pass is cut off after it', () => {
      // A truncated scan usually loses the tail. The seat is in the first leg, so
      // there is no reason to throw the whole thing away.
      const raw = `${boardingPass([leg({ conditional: '>3180      BW6' }), leg({ seat: '022C' })])}`;
      const result = parseBoardingPass(raw.slice(0, raw.length - 20));
      assert.ok(result.ok, 'should parse the part that arrived');
      assert.equal(result.pass.legs[0].seat, '14A');
    });
  });

  describe('things that are not a boarding pass', () => {
    test('rejects empty and obvious rubbish', () => {
      for (const raw of ['', '   ', 'hello', '14A', 'https://example.com/boarding-pass']) {
        const result = parseBoardingPass(raw);
        assert.ok(!result.ok, `should reject '${raw}'`);
        assert.match(result.error, /boarding pass/i);
      }
    });

    test('rejects a payload that is long enough but is not format M', () => {
      const raw = boardingPass([leg()]);
      const result = parseBoardingPass(`X${raw.slice(1)}`);
      assert.ok(!result.ok);
    });

    test('rejects a first leg that stops halfway', () => {
      const result = parseBoardingPass(boardingPass([leg()]).slice(0, 40));
      assert.ok(!result.ok);
      assert.match(result.error, /cut off/i);
    });

    test('rejects an impossible day of the year', () => {
      const result = parseBoardingPass(boardingPass([leg({ day: '999' })]));
      assert.ok(!result.ok);
    });

    test('rejects an airport code that is not one', () => {
      const result = parseBoardingPass(boardingPass([leg({ from: '1TP' })]));
      assert.ok(!result.ok);
    });
  });
});

describe('dayOfYearOf', () => {
  test('counts from 1 on the first of January', () => {
    assert.equal(dayOfYearOf('2026-01-01'), 1);
  });

  test('handles a common year and a leap year', () => {
    assert.equal(dayOfYearOf('2026-08-14'), 226);
    assert.equal(dayOfYearOf('2026-12-31'), 365);
    assert.equal(dayOfYearOf('2028-12-31'), 366);
  });

  test('returns null for anything that is not a date', () => {
    for (const value of ['', '2026-13-01x', 'tomorrow']) {
      assert.equal(dayOfYearOf(value), null, `should reject '${value}'`);
    }
  });
});

describe('resolveFlightDate', () => {
  test('resolves against the year of the flight we are checking', () => {
    assert.equal(resolveFlightDate(226, '2026-08-14'), '2026-08-14');
    assert.equal(resolveFlightDate(285, '2026-10-12'), '2026-10-12');
  });

  test('crosses New Year in both directions', () => {
    // A pass read on 31 December for day 2 is next year's flight, not last year's.
    assert.equal(resolveFlightDate(2, '2026-12-31'), '2027-01-02');
    assert.equal(resolveFlightDate(365, '2027-01-01'), '2026-12-31');
  });

  test('accepts day 366 only in a year that has one', () => {
    assert.equal(resolveFlightDate(366, '2028-12-30'), '2028-12-31');
    assert.equal(resolveFlightDate(366, '2026-12-30'), null);
  });

  test('returns null for a day that cannot exist at all', () => {
    assert.equal(resolveFlightDate(0, '2026-10-12'), null);
    assert.equal(resolveFlightDate(367, '2026-10-12'), null);
  });
});
