/**
 * The per-account cap on creating new flights (CLAUDE.md §11).
 *
 * Only the pure half lives here — reading the limit and wording the refusal. The
 * counting is in flight-quota.itest.ts, because a cap that is not checked against
 * a real table is not a cap.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  DEFAULT_MAX_NEW_FLIGHTS_PER_DAY,
  maxNewFlightsPerDay,
  quotaMessage,
} from './flight-quota.ts';

describe('maxNewFlightsPerDay', () => {
  test('defaults to something a real traveller will not hit', () => {
    // A round trip is two, a connection makes it four.
    assert.equal(maxNewFlightsPerDay({}), DEFAULT_MAX_NEW_FLIGHTS_PER_DAY);
    assert.ok(DEFAULT_MAX_NEW_FLIGHTS_PER_DAY >= 4);
  });

  test('is configurable', () => {
    assert.equal(maxNewFlightsPerDay({ MAX_NEW_FLIGHTS_PER_DAY: '20' }), 20);
  });

  test('accepts zero, which switches new-flight creation off entirely', () => {
    // Worth having: it is the lever to pull if the quota is ever actually under
    // attack, and it leaves joining existing flights working.
    assert.equal(maxNewFlightsPerDay({ MAX_NEW_FLIGHTS_PER_DAY: '0' }), 0);
  });

  test('falls back rather than trusting a nonsense value', () => {
    for (const value of ['', 'lots', '-1', '2.5', 'NaN']) {
      assert.equal(
        maxNewFlightsPerDay({ MAX_NEW_FLIGHTS_PER_DAY: value }),
        DEFAULT_MAX_NEW_FLIGHTS_PER_DAY,
        `should ignore '${value}'`,
      );
    }
  });
});

describe('quotaMessage', () => {
  test('says what still works, because most of what people do is unaffected', () => {
    const message = quotaMessage(5);
    assert.match(message, /still sign up for any flight that is already on the site/i);
  });

  test('explains why the limit exists rather than just asserting it', () => {
    assert.match(quotaMessage(5), /paid call|flight data provider/i);
  });

  test('gets the grammar right for a limit of one', () => {
    assert.match(quotaMessage(1), /1 new flight today/);
    assert.match(quotaMessage(5), /5 new flights today/);
  });
});
