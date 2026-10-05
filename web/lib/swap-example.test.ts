/**
 * The home page's worked example has to be a chain the solver would really
 * propose (see swap-example.ts). These rebuild the solver's rules from the
 * utility function and check the example against them by brute force, which at
 * six seats is 720 re-seatings.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { loadSeatMap, isExitRow, nearLavatory, parseSeat } from './seatmap.ts';
import { EXAMPLE_AIRCRAFT, EXAMPLE_PARTIES, EXAMPLE_ROWS, type ExampleParty } from './swap-example.ts';
import { partyUtility } from './utility.ts';

const map = loadSeatMap(EXAMPLE_AIRCRAFT);
// solver/model.py SolveConfig: min_gain and tie_break.
const MIN_GAIN = 20;
const TIE_BREAK = 1;

const sorted = (seats: string[]) => [...seats].sort();
const sameSeats = (a: string[], b: string[]) => sorted(a).join() === sorted(b).join();
const gainOf = (party: ExampleParty, seats: string[]) =>
  partyUtility(seats, party.weights, map) - partyUtility(party.before, party.weights, map);

function* permutations<T>(items: T[]): Generator<T[]> {
  if (items.length <= 1) {
    yield items;
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) yield [items[i], ...tail];
  }
}

/**
 * Every way these parties could re-seat among the seats they already hold that
 * the solver would accept: nobody worse off, and anyone who moves gains at least
 * MIN_GAIN. Keyed by who ends up with which seats, so the order of seats within
 * a party does not count as a different answer.
 */
function validReseatings(parties: ExampleParty[]) {
  const pool = parties.flatMap((p) => p.before);
  const found = new Map<string, { objective: number; seats: string[][] }>();

  for (const perm of permutations(pool)) {
    let offset = 0;
    let objective = 0;
    let moved = 0;
    let valid = true;
    const seats: string[][] = [];

    for (const party of parties) {
      const mine = perm.slice(offset, offset + party.before.length);
      offset += party.before.length;
      seats.push(mine);
      if (sameSeats(mine, party.before)) continue;
      const gain = gainOf(party, mine);
      if (gain < MIN_GAIN) {
        valid = false;
        break;
      }
      moved += 1;
      objective += gain;
    }
    if (!valid || moved === 0) continue;
    const key = seats.map((s) => sorted(s).join('+')).join('|');
    found.set(key, { objective: objective - TIE_BREAK * moved, seats });
  }
  return [...found.values()];
}

function subsets<T>(items: T[], size: number): T[][] {
  if (size === 0) return [[]];
  if (items.length < size) return [];
  const [first, ...rest] = items;
  return [...subsets(rest, size - 1).map((s) => [first, ...s]), ...subsets(rest, size)];
}

describe('the home page swap chain', () => {
  test('uses only the rows it shows, none of them an exit row or by a toilet', () => {
    for (const party of EXAMPLE_PARTIES) {
      for (const seat of [...party.before, ...party.after]) {
        const parsed = parseSeat(seat);
        assert.ok(parsed, `${seat} is a seat`);
        assert.ok(EXAMPLE_ROWS.includes(parsed.row), `${seat} is on the diagram`);
        assert.ok(!isExitRow(seat, map), `${seat} is not an exit row`);
        assert.ok(!nearLavatory(seat, map), `${seat} is not by a toilet`);
      }
    }
  });

  test('moves seats between the parties and nowhere else', () => {
    const before = EXAMPLE_PARTIES.flatMap((p) => p.before);
    const after = EXAMPLE_PARTIES.flatMap((p) => p.after);
    assert.equal(new Set(before).size, before.length, 'nobody shares a seat');
    assert.deepEqual(sorted(after), sorted(before));
  });

  test('leaves every party better off by at least MIN_GAIN', () => {
    for (const party of EXAMPLE_PARTIES) {
      assert.ok(
        gainOf(party, party.after) >= MIN_GAIN,
        `${party.name} gains ${gainOf(party, party.after)}`,
      );
    }
  });

  test('is the one best answer for these four parties', () => {
    const answers = validReseatings(EXAMPLE_PARTIES).sort((a, b) => b.objective - a.objective);
    const shown = EXAMPLE_PARTIES.map((p) => sorted(p.after));
    assert.deepEqual(answers[0].seats.map(sorted), shown);
    assert.ok(answers[0].objective > answers[1].objective, 'and not tied with another');
  });

  test('cannot be done by any two or three of them alone', () => {
    // The card says so in words, and it is the whole point of a chain.
    for (const size of [2, 3]) {
      for (const group of subsets(EXAMPLE_PARTIES, size)) {
        assert.deepEqual(
          validReseatings(group),
          [],
          `${group.map((p) => p.name).join(', ')} could swap on their own`,
        );
      }
    }
  });
});
