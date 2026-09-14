/**
 * The party utility function (CLAUDE.md §8).
 *
 * This file has a Python twin at solver/utility.py. They MUST return exactly the
 * same integers for the same input: this one drives the "what you'd gain" preview
 * in the UI, the other one drives the CP-SAT objective. If they disagree, the UI
 * promises something the solver did not optimise for.
 *
 * Everything is integer arithmetic. No floats anywhere near the model.
 *
 * Units: one "point" is one unit of a preference weight, so a window seat is worth
 * exactly w_window and a satisfied adjacency is worth exactly w_adjacency. The
 * front term is the only non-boolean one, so it is scaled back down by FRONT_SCALE
 * with floor division to stay in the same units. MIN_GAIN is expressed in these
 * same points.
 */

import {
  FRONT_SCALE,
  type SeatMap,
  areAdjacent,
  contiguousBlocks,
  frontScore,
  isAisle,
  isMiddle,
  isWindow,
  nearLavatory,
  parseSeat,
} from './seatmap.ts';

export interface PreferenceWeights {
  wWindow: number;
  wAisle: number;
  wFront: number;
  wAvoidMiddle: number;
  wAvoidLavatory: number;
  /** 0 | 40 | 200 — see config/preferences.ts */
  wAdjacency: number;
}

export const ZERO_WEIGHTS: PreferenceWeights = {
  wWindow: 0,
  wAisle: 0,
  wFront: 0,
  wAvoidMiddle: 0,
  wAvoidLavatory: 0,
  wAdjacency: 0,
};

/**
 * Utility of a single seat for a party's preferences.
 *
 *   u_seat(s, p) =  w_window        · is_window(s)
 *                 + w_aisle         · is_aisle(s)
 *                 + w_avoid_middle  · (1 - is_middle(s))
 *                 + ⌊w_front · front_score(s) / FRONT_SCALE⌋
 *                 - w_avoid_lavatory· near_lavatory(s)
 *
 * An unparseable seat scores 0 rather than throwing: bad data must never crash a
 * match run, it just makes that seat unattractive.
 */
export function seatUtility(seat: string, w: PreferenceWeights, map: SeatMap): number {
  if (parseSeat(seat) === null) return 0;
  let u = 0;
  if (isWindow(seat, map)) u += w.wWindow;
  if (isAisle(seat, map)) u += w.wAisle;
  if (!isMiddle(seat, map)) u += w.wAvoidMiddle;
  u += Math.floor((w.wFront * frontScore(seat, map)) / FRONT_SCALE);
  if (nearLavatory(seat, map)) u -= w.wAvoidLavatory;
  return u;
}

/**
 * Utility of a whole assignment for one party.
 *
 *   U_p(A) = Σ_{m ∈ p} u_seat(A[m], p) + w_adjacency(p) · adjacent(A, p)
 *
 * A party of one is trivially "adjacent"; that costs nothing because the
 * questionnaire forces w_adjacency = 0 for parties of one.
 */
export function partyUtility(
  seats: string[],
  w: PreferenceWeights,
  map: SeatMap,
): number {
  let total = 0;
  for (const seat of seats) total += seatUtility(seat, w, map);
  if (w.wAdjacency !== 0 && areAdjacent(seats, map)) total += w.wAdjacency;
  return total;
}

/** Utility delta between a proposed assignment and the current one. */
export function gain(
  fromSeats: string[],
  toSeats: string[],
  w: PreferenceWeights,
  map: SeatMap,
): number {
  return partyUtility(toSeats, w, map) - partyUtility(fromSeats, w, map);
}

/**
 * The best a party could do if it had the run of the whole empty cabin.
 *
 * Used by the "immediate run" rule (CLAUDE.md §14): fire a proposal the moment it
 * appears only if every party in it is already at its theoretical maximum,
 * otherwise discard the result and wait for a scheduled run that might find a
 * better cycle.
 *
 * The bound has to be *reachable*, not merely an upper bound. Taking the best
 * `size` seats in the cabin and then adding the adjacency bonus on top would not
 * be: on a 3+3 narrow-body the two best seats for a window-lover are two windows
 * in different rows, and they are not next to each other. A party wanting both a
 * window and adjacency would then never reach its own maximum and an immediate
 * run could never fire for it. So the two cases are costed separately and the
 * better one wins:
 *
 *   - spread out — the best `size` seats anywhere, no adjacency bonus;
 *   - together   — the best contiguous block of `size` seats, plus the bonus.
 */
export function maxTheoreticalUtility(
  size: number,
  w: PreferenceWeights,
  map: SeatMap,
): number {
  const allSeats = allSeatsOf(map);
  const spread = allSeats
    .map((s) => seatUtility(s, w, map))
    .sort((a, b) => b - a)
    .slice(0, size)
    .reduce((a, b) => a + b, 0);

  // A party of one is trivially "adjacent", so partyUtility() grants it the bonus
  // unconditionally and the bound has to match. In practice the questionnaire
  // forces wAdjacency = 0 for a single, so this is only about the two functions
  // agreeing on every input rather than most of them.
  if (size < 2) return spread + w.wAdjacency;
  if (w.wAdjacency === 0) return spread;

  let bestBlock: number | null = null;
  for (const block of contiguousBlocks(allSeats, size, map)) {
    const value =
      block.reduce((total, seat) => total + seatUtility(seat, w, map), 0) + w.wAdjacency;
    if (bestBlock === null || value > bestBlock) bestBlock = value;
  }

  // No block of this size exists (e.g. four people on a 3+3 layout): they simply
  // cannot sit together, so the spread-out bound is the only one available.
  if (bestBlock === null) return spread;
  return Math.max(spread, bestBlock);
}

function allSeatsOf(map: SeatMap): string[] {
  const seats: string[] = [];
  for (let row = 1; row <= map.rows; row += 1) {
    for (const column of map.columns) seats.push(`${row}${column}`);
  }
  return seats;
}
