/**
 * Seat message parsing.
 *
 * This runs against whatever somebody types into a chat window while standing in
 * an airport, so it has to be generous. Everything here is a shape a real person
 * plausibly sends.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { parseSeatMessage } from './seat-input.ts';

describe('parseSeatMessage', () => {
  test('reads a single seat', () => {
    assert.deepEqual(parseSeatMessage('14A').seats, ['14A']);
  });

  test('reads several seats however they are separated', () => {
    for (const text of ['14A, 22F', '14A 22F', '14A and 22F', '14A/22F', '14A;22F']) {
      assert.deepEqual(parseSeatMessage(text).seats, ['14A', '22F'], `failed on ${text}`);
    }
  });

  test('upper-cases and strips stray spacing', () => {
    assert.deepEqual(parseSeatMessage('  14a ,  22 f ').seats, ['14A', '22F']);
  });

  test('reads seats out of a sentence', () => {
    assert.deepEqual(
      parseSeatMessage('hi! we are in 14A and 22F, thanks').seats,
      ['14A', '22F'],
    );
  });

  test('drops leading zeros so 07A and 7A are the same seat', () => {
    assert.deepEqual(parseSeatMessage('07A').seats, ['7A']);
  });

  test('collapses duplicates but keeps order', () => {
    assert.deepEqual(parseSeatMessage('22F, 14A, 22F').seats, ['22F', '14A']);
  });

  test('finds no seats in a message that has none', () => {
    for (const text of ['hello', 'thanks!', 'what do I do now', '', '1 person']) {
      assert.deepEqual(parseSeatMessage(text).seats, [], `should find nothing in ${text}`);
    }
  });

  describe('when a flight number is included', () => {
    test('separates the designator from the seats', () => {
      const parsed = parseSeatMessage('W6 3234: 14A, 22F');
      assert.equal(parsed.designator, 'W63234');
      assert.deepEqual(parsed.seats, ['14A', '22F']);
    });

    test('accepts the hyphenated and compact forms', () => {
      for (const text of ['W6-3234 14A', 'W63234 14A', 'w6 3234 14a']) {
        const parsed = parseSeatMessage(text);
        assert.equal(parsed.designator, 'W63234', `failed on ${text}`);
        assert.deepEqual(parsed.seats, ['14A'], `failed on ${text}`);
      }
    });

    test('does not mistake the flight number for a seat', () => {
      // The killer case: 'W6 3234' has digits next to letters, and a naive parser
      // turns part of it into a seat.
      assert.deepEqual(parseSeatMessage('W6 3234: 14A').seats, ['14A']);
      assert.deepEqual(parseSeatMessage('FR1234 20C').seats, ['20C']);
    });

    test('reports no designator when none was given', () => {
      assert.equal(parseSeatMessage('14A, 22F').designator, null);
    });
  });
});
