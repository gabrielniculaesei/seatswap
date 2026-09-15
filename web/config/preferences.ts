/**
 * Questionnaire -> preference weights (CLAUDE.md §8).
 *
 * Never a slider, never free text. Three or four blunt questions that fill in the
 * weights. The answer IDs are stable and are what the UI stores; the wording lives
 * in the components, so no user-facing copy lives in this file.
 */

import type { PreferenceWeights } from '../lib/utility.ts';

export type AdjacencyAnswer = 'no' | 'prefer' | 'essential';
export type SeatTypeAnswer = 'window' | 'aisle' | 'either';
export type ExtraAnswer = 'avoid_middle' | 'front' | 'avoid_lavatory';

/**
 * "How much does sitting together matter?"
 * 200 is deliberately far above every seat-quality weight: a group that is here
 * *because* it got split must outbid any single traveller's seat preference,
 * which is exactly what makes the trade worth it for both sides.
 */
export const ADJACENCY_WEIGHTS: Record<AdjacencyAnswer, number> = {
  no: 0,
  prefer: 40,
  essential: 200,
};

export const SEAT_TYPE_WEIGHTS: Record<SeatTypeAnswer, Partial<PreferenceWeights>> = {
  window: { wWindow: 60 },
  aisle: { wAisle: 60 },
  either: {},
};

export const EXTRA_WEIGHTS: Record<ExtraAnswer, Partial<PreferenceWeights>> = {
  avoid_middle: { wAvoidMiddle: 40 },
  front: { wFront: 30 },
  avoid_lavatory: { wAvoidLavatory: 25 },
};

export interface QuestionnaireAnswers {
  /** "How many of you are travelling?" 1..8 */
  size: number;
  /** Only asked when size >= 2. */
  adjacency?: AdjacencyAnswer;
  /** "Which seat do you prefer?" */
  seatType?: SeatTypeAnswer;
  /** "Anything else?" — multi-select. */
  extras?: ExtraAnswer[];
}

const ZERO: PreferenceWeights = {
  wWindow: 0,
  wAisle: 0,
  wFront: 0,
  wAvoidMiddle: 0,
  wAvoidLavatory: 0,
  wAdjacency: 0,
};

/**
 * A party of one gets wAdjacency = 0 no matter what it answered: there is nobody
 * to sit next to, and a non-zero weight there would be free utility the solver
 * could hand out for doing nothing.
 */
export function weightsFromAnswers(answers: QuestionnaireAnswers): PreferenceWeights {
  const weights: PreferenceWeights = { ...ZERO };

  if (answers.size >= 2 && answers.adjacency) {
    weights.wAdjacency = ADJACENCY_WEIGHTS[answers.adjacency];
  }
  if (answers.seatType) {
    Object.assign(weights, SEAT_TYPE_WEIGHTS[answers.seatType]);
  }
  for (const extra of answers.extras ?? []) {
    Object.assign(weights, EXTRA_WEIGHTS[extra]);
  }
  return weights;
}

/** Column names in `parties`, for the insert. Keeps the mapping in one place. */
export function weightsToColumns(w: PreferenceWeights): Record<string, number> {
  return {
    w_window: w.wWindow,
    w_aisle: w.wAisle,
    w_front: w.wFront,
    w_avoid_middle: w.wAvoidMiddle,
    w_avoid_lavatory: w.wAvoidLavatory,
    w_adjacency: w.wAdjacency,
  };
}

export function weightsFromColumns(row: Record<string, number>): PreferenceWeights {
  return {
    wWindow: row.w_window ?? 0,
    wAisle: row.w_aisle ?? 0,
    wFront: row.w_front ?? 0,
    wAvoidMiddle: row.w_avoid_middle ?? 0,
    wAvoidLavatory: row.w_avoid_lavatory ?? 0,
    wAdjacency: row.w_adjacency ?? 0,
  };
}
