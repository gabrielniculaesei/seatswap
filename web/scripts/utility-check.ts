/**
 * Cross-language consistency harness.
 *
 * Reads a JSON batch of cases on stdin, writes the TypeScript answers on stdout.
 * solver/tests/test_cross_language.py runs the same batch through the Python twin
 * and asserts the integers match exactly. It is not a dev tool you run by hand;
 * it exists so the two implementations can never silently drift.
 *
 *   echo '{"seatCases":[...],"partyCases":[...]}' | node web/scripts/utility-check.ts
 */

import {
  areAdjacent,
  contiguousBlocks,
  frontScore,
  isAisle,
  isMiddle,
  isWindow,
  loadSeatMap,
  nearLavatory,
  seatExists,
} from '../lib/seatmap.ts';
import {
  maxTheoreticalUtility,
  partyUtility,
  seatUtility,
  type PreferenceWeights,
} from '../lib/utility.ts';

interface SeatCase {
  mapKey: string | null;
  seat: string;
  weights: PreferenceWeights;
}

interface PartyCase {
  mapKey: string | null;
  seats: string[];
  weights: PreferenceWeights;
}

interface BlockCase {
  mapKey: string | null;
  pool: string[];
  size: number;
}

interface BoundCase {
  mapKey: string | null;
  size: number;
  weights: PreferenceWeights;
}

interface Batch {
  seatCases?: SeatCase[];
  partyCases?: PartyCase[];
  blockCases?: BlockCase[];
  boundCases?: BoundCase[];
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const batch: Batch = JSON.parse(await readStdin());

const seatResults = (batch.seatCases ?? []).map((c) => {
  const map = loadSeatMap(c.mapKey);
  return {
    utility: seatUtility(c.seat, c.weights, map),
    isWindow: isWindow(c.seat, map),
    isAisle: isAisle(c.seat, map),
    isMiddle: isMiddle(c.seat, map),
    frontScore: frontScore(c.seat, map),
    nearLavatory: nearLavatory(c.seat, map),
    seatExists: seatExists(c.seat, map),
  };
});

const partyResults = (batch.partyCases ?? []).map((c) => {
  const map = loadSeatMap(c.mapKey);
  return {
    utility: partyUtility(c.seats, c.weights, map),
    adjacent: areAdjacent(c.seats, map),
  };
});

const blockResults = (batch.blockCases ?? []).map((c) =>
  contiguousBlocks(c.pool, c.size, loadSeatMap(c.mapKey)),
);

const boundResults = (batch.boundCases ?? []).map((c) =>
  maxTheoreticalUtility(c.size, c.weights, loadSeatMap(c.mapKey)),
);

process.stdout.write(
  JSON.stringify({ seatResults, partyResults, blockResults, boundResults }),
);
