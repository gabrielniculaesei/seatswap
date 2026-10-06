/**
 * Seat geometry. Pure functions, no I/O beyond the static seat map config.
 *
 * This file has a Python twin at solver/seatmap.py. The two MUST agree on every
 * predicate, because the TS side powers the UI preview and the Python side powers
 * the solver. There is a cross-language consistency test in solver/tests/.
 */

import rawSeatMaps from '../config/seatmaps.json' with { type: 'json' };

export const DEFAULT_SEAT_MAP_KEY = '_default';

/** Front-score resolution. Row 1 scores FRONT_SCALE, the last row scores 0. */
export const FRONT_SCALE = 100;

export interface SeatMap {
  key: string;
  label: string;
  rows: number;
  columns: string[];
  /** Column letters after which an aisle runs. 'C' on a 6-across narrow-body. */
  aisleAfter: string[];
  exitRows: number[];
  lavatoryRows: number[];
  noReclineRows: number[];
  /** True when we fell back to `_default` because the aircraft type was unknown. */
  estimated: boolean;
}

export interface Seat {
  row: number;
  column: string;
}

interface RawSeatMap {
  label: string;
  rows: number;
  columns: string[];
  aisle_after: string | string[];
  exit_rows?: number[];
  lavatory_rows?: number[];
  no_recline_rows?: number[];
}

const RAW: Record<string, RawSeatMap> = rawSeatMaps as unknown as Record<string, RawSeatMap>;

function normalise(key: string, raw: RawSeatMap, estimated: boolean): SeatMap {
  return {
    key,
    label: raw.label,
    rows: raw.rows,
    columns: raw.columns,
    aisleAfter: Array.isArray(raw.aisle_after) ? raw.aisle_after : [raw.aisle_after],
    exitRows: raw.exit_rows ?? [],
    lavatoryRows: raw.lavatory_rows ?? [],
    noReclineRows: raw.no_recline_rows ?? [],
    estimated,
  };
}

/**
 * Resolve an aircraft type / seat map key to a seat map.
 * An unknown key degrades to `_default` with `estimated: true` — the UI must say
 * "estimated layout" in that case, it must never block the user.
 */
export function loadSeatMap(key: string | null | undefined): SeatMap {
  if (key && Object.prototype.hasOwnProperty.call(RAW, key) && key !== DEFAULT_SEAT_MAP_KEY) {
    return normalise(key, RAW[key], false);
  }
  return normalise(DEFAULT_SEAT_MAP_KEY, RAW[DEFAULT_SEAT_MAP_KEY], true);
}

export function seatMapKeys(): string[] {
  return Object.keys(RAW).filter((k) => k !== DEFAULT_SEAT_MAP_KEY);
}

const SEAT_PATTERN = /^([0-9]{1,3})([A-Z])$/;

/** Parse '14A' into { row: 14, column: 'A' }. Returns null on anything malformed. */
export function parseSeat(seat: string): Seat | null {
  const match = SEAT_PATTERN.exec(seat.trim().toUpperCase());
  if (!match) return null;
  const row = Number.parseInt(match[1], 10);
  if (row < 1) return null;
  return { row, column: match[2] };
}

export function formatSeat(seat: Seat): string {
  return `${seat.row}${seat.column}`;
}

/** True when the seat could physically exist on this layout. */
export function seatExists(seat: string, map: SeatMap): boolean {
  const parsed = parseSeat(seat);
  if (!parsed) return false;
  return parsed.row <= map.rows && map.columns.includes(parsed.column);
}

function columnIndex(seat: string, map: SeatMap): number {
  const parsed = parseSeat(seat);
  if (!parsed) return -1;
  return map.columns.indexOf(parsed.column);
}

/** Indices in `columns` immediately to the left of an aisle. */
function aisleSplitIndices(map: SeatMap): number[] {
  const indices: number[] = [];
  for (const letter of map.aisleAfter) {
    const index = map.columns.indexOf(letter);
    // An aisle after the last column is not a split, it is the cabin wall.
    if (index >= 0 && index < map.columns.length - 1) indices.push(index);
  }
  return indices;
}

export function isWindow(seat: string, map: SeatMap): boolean {
  const index = columnIndex(seat, map);
  if (index < 0) return false;
  return index === 0 || index === map.columns.length - 1;
}

export function isAisle(seat: string, map: SeatMap): boolean {
  const index = columnIndex(seat, map);
  if (index < 0) return false;
  for (const split of aisleSplitIndices(map)) {
    if (index === split || index === split + 1) return true;
  }
  return false;
}

/** Anything that is neither a window nor an aisle. A 3-across row has exactly one. */
export function isMiddle(seat: string, map: SeatMap): boolean {
  const index = columnIndex(seat, map);
  if (index < 0) return false;
  return !isWindow(seat, map) && !isAisle(seat, map);
}

/**
 * 0..FRONT_SCALE, integer. Row 1 -> 100, last row -> 0.
 * Floor division, mirrored exactly in Python, so both sides agree bit for bit.
 */
export function frontScore(seat: string, map: SeatMap): number {
  const parsed = parseSeat(seat);
  if (!parsed) return 0;
  if (map.rows <= 1) return FRONT_SCALE;
  const row = Math.min(Math.max(parsed.row, 1), map.rows);
  return Math.floor(((map.rows - row) * FRONT_SCALE) / (map.rows - 1));
}

export function nearLavatory(seat: string, map: SeatMap): boolean {
  const parsed = parseSeat(seat);
  if (!parsed) return false;
  return map.lavatoryRows.includes(parsed.row);
}

export function isExitRow(seat: string, map: SeatMap): boolean {
  const parsed = parseSeat(seat);
  if (!parsed) return false;
  return map.exitRows.includes(parsed.row);
}

/**
 * Are these seats one contiguous block in a single row, without an aisle in between?
 * Two seats separated by the aisle are NOT adjacent.
 * A single seat is trivially adjacent; an empty set is not.
 */
export function areAdjacent(seats: string[], map: SeatMap): boolean {
  if (seats.length === 0) return false;
  if (seats.length === 1) return parseSeat(seats[0]) !== null;

  const parsed = seats.map((s) => parseSeat(s));
  if (parsed.some((p) => p === null)) return false;
  const ok = parsed as Seat[];

  const row = ok[0].row;
  if (ok.some((p) => p.row !== row)) return false;

  const indices = ok.map((p) => map.columns.indexOf(p.column));
  if (indices.some((i) => i < 0)) return false;
  const sorted = [...indices].sort((a, b) => a - b);
  if (new Set(sorted).size !== sorted.length) return false;

  const splits = aisleSplitIndices(map);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] !== sorted[i - 1] + 1) return false;
    if (splits.includes(sorted[i - 1])) return false; // the aisle cuts the block
  }
  return true;
}

/**
 * Every set of `size` contiguous, same-row, aisle-respecting seats drawn from `pool`.
 * These are the candidate adjacency blocks `B` in the CP-SAT model.
 * Each block is returned sorted by column order; the list itself is deterministic.
 */
export function contiguousBlocks(pool: string[], size: number, map: SeatMap): string[][] {
  if (size < 1) return [];

  const available = new Set<string>();
  for (const seat of pool) {
    const parsed = parseSeat(seat);
    if (parsed) available.add(formatSeat(parsed));
  }
  if (size === 1) {
    return [...available].sort(seatOrder(map)).map((s) => [s]);
  }

  const splits = new Set(aisleSplitIndices(map));
  const blocks: string[][] = [];
  const rows = [...new Set([...available].map((s) => parseSeat(s)!.row))].sort((a, b) => a - b);

  for (const row of rows) {
    for (let start = 0; start + size <= map.columns.length; start += 1) {
      const block: string[] = [];
      let valid = true;
      for (let offset = 0; offset < size; offset += 1) {
        const index = start + offset;
        if (offset > 0 && splits.has(index - 1)) { valid = false; break; }
        const seat = `${row}${map.columns[index]}`;
        if (!available.has(seat)) { valid = false; break; }
        block.push(seat);
      }
      if (valid) blocks.push(block);
    }
  }
  return blocks;
}

/** Stable ordering: by row, then by column position in the layout. */
export function seatOrder(map: SeatMap): (a: string, b: string) => number {
  return (a, b) => {
    const pa = parseSeat(a);
    const pb = parseSeat(b);
    if (!pa || !pb) return a.localeCompare(b);
    if (pa.row !== pb.row) return pa.row - pb.row;
    return map.columns.indexOf(pa.column) - map.columns.indexOf(pb.column);
  };
}
