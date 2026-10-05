/**
 * The worked example on the home page: one swap chain, four parties.
 *
 * It is the page's proof that the mechanism works, so it has to be something the
 * solver would really propose, and swap-example.test.ts holds it to that: the
 * seats after are a permutation of the seats before, every party gains at least
 * MIN_GAIN, it is the solver's one best answer for these parties, and no two or
 * three of them could have swapped among themselves. The last one is what the
 * card says in words. If you edit anything here, that test says whether it is
 * still true.
 *
 * The first version, from the design handoff, failed it: the window-seeker and
 * the aisle-seeker next to each other could simply trade, and so could the
 * family and the traveller in the middle seat, so the "chain" was two ordinary
 * swaps side by side. With only window and aisle to want, two single travellers
 * in a chain can always shortcut it, which is why this one has two couples.
 *
 * Rows 18-23 of an A320 hold no exit row (12, 13) and no toilet (1, 30, 31), so
 * the example needs no special seat rule to be true.
 */

import type { PreferenceWeights } from './utility.ts';
import { ZERO_WEIGHTS } from './utility.ts';

export const EXAMPLE_AIRCRAFT = 'A320';
export const EXAMPLE_ROWS = [18, 19, 20, 21, 22, 23];

export interface ExampleParty {
  id: string;
  name: string;
  /** What shows in their seats on the diagram. */
  initial: string;
  /** Four hues at matched lightness, each carrying white text at AA. */
  color: string;
  /** "What they want", as they would put it. */
  wants: string;
  weights: PreferenceWeights;
  before: string[];
  after: string[];
}

/**
 * In chain order: the Nagys take 19B from Tom and Ana, who take 21B from Dana,
 * who takes 20F from Priya, who takes 22C from the Nagys.
 */
export const EXAMPLE_PARTIES: ExampleParty[] = [
  {
    id: 'nagys',
    name: 'The Nagys',
    initial: 'N',
    color: '#0f766e',
    wants: 'two of us, split up, would rather sit together near the front',
    // Nearer the front is what makes this answer the only best one: without it,
    // the two couples could just as well end up in each other's rows.
    weights: { ...ZERO_WEIGHTS, wAdjacency: 200, wFront: 30 },
    before: ['19A', '22C'],
    after: ['19A', '19B'],
  },
  {
    id: 'tom-ana',
    name: 'Tom & Ana',
    initial: 'T',
    color: '#8d4a7c',
    wants: 'split up as well, would rather sit together',
    weights: { ...ZERO_WEIGHTS, wAdjacency: 200 },
    before: ['19B', '21A'],
    after: ['21A', '21B'],
  },
  {
    id: 'dana',
    name: 'Dana',
    initial: 'D',
    color: '#4c4fa6',
    wants: 'middle seat, would rather have a window',
    weights: { ...ZERO_WEIGHTS, wWindow: 60 },
    before: ['21B'],
    after: ['20F'],
  },
  {
    id: 'priya',
    name: 'Priya',
    initial: 'P',
    color: '#8a6a1f',
    wants: 'window, would rather have an aisle',
    weights: { ...ZERO_WEIGHTS, wAisle: 60 },
    before: ['20F'],
    after: ['22C'],
  },
];
