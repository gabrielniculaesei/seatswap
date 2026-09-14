/**
 * Reading seat numbers out of whatever somebody typed.
 *
 * Pure, and kept apart from seats.ts so it can be tested without a database.
 * This runs against messages written in an airport, so it is deliberately
 * generous: the user is doing us a favour by answering at all.
 */

/** Matches a seat anywhere in a line of text: row number then a letter. */
const SEAT_TOKEN = /\b(\d{1,3})\s*([A-Za-z])\b/g;

/** 'W6 3234', 'W6-3234' and 'W63234' are all the same flight. */
const DESIGNATOR = /\b([A-Z]{1,2}[0-9])\s*-?\s*(\d{1,4})\b/i;

export interface ParsedSeats {
  seats: string[];
  /** A flight designator the user mentioned, if any. */
  designator: string | null;
}

/**
 * '14A, 22F', '14a 22f', 'we are in 14A and 22F' and 'W6 3234: 14A, 22F' all mean
 * the same thing. Duplicates collapse; order is preserved.
 */
export function parseSeatMessage(text: string): ParsedSeats {
  const designatorMatch = DESIGNATOR.exec(text);

  // Strip the flight number before hunting for seats. Otherwise 'W6 3234' donates
  // a '6 3' to the seat list and the user is told their seat does not exist.
  const withoutDesignator = designatorMatch ? text.replace(designatorMatch[0], ' ') : text;

  const seats: string[] = [];
  for (const match of withoutDesignator.matchAll(SEAT_TOKEN)) {
    // Number.parseInt drops leading zeros, so 07A and 7A are one seat.
    const seat = `${Number.parseInt(match[1], 10)}${match[2].toUpperCase()}`;
    if (!seats.includes(seat)) seats.push(seat);
  }

  return {
    seats,
    designator: designatorMatch
      ? `${designatorMatch[1].toUpperCase()}${designatorMatch[2]}`
      : null,
  };
}
