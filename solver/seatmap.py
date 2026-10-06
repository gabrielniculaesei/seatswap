"""Seat geometry.

Python twin of web/lib/seatmap.ts. The two MUST agree on every predicate: the TS
side powers the UI preview, this side powers the solver. tests/test_cross_language.py
runs the same cases through both and compares.

Both sides read the same config file, web/config/seatmaps.json, so a layout can
never drift between them.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

DEFAULT_SEAT_MAP_KEY = "_default"

#: Front-score resolution. Row 1 scores FRONT_SCALE, the last row scores 0.
FRONT_SCALE = 100

_REPO_ROOT = Path(__file__).resolve().parent.parent
_SEATMAPS_PATH = Path(
    os.environ.get("SEATMAPS_PATH", _REPO_ROOT / "web" / "config" / "seatmaps.json")
)

_SEAT_PATTERN = re.compile(r"^([0-9]{1,3})([A-Z])$")


@dataclass(frozen=True)
class SeatMap:
    key: str
    label: str
    rows: int
    columns: tuple[str, ...]
    #: Column letters after which an aisle runs. ('C',) on a 6-across narrow-body.
    aisle_after: tuple[str, ...]
    exit_rows: tuple[int, ...] = ()
    lavatory_rows: tuple[int, ...] = ()
    no_recline_rows: tuple[int, ...] = ()
    #: True when we fell back to `_default` because the aircraft type was unknown.
    estimated: bool = False

    @property
    def aisle_split_indices(self) -> tuple[int, ...]:
        """Indices in `columns` immediately to the left of an aisle."""
        out = []
        for letter in self.aisle_after:
            if letter in self.columns:
                index = self.columns.index(letter)
                # An aisle after the last column is not a split, it is the cabin wall.
                if index < len(self.columns) - 1:
                    out.append(index)
        return tuple(out)

    def all_seats(self) -> list[str]:
        """Every seat on the layout, in cabin order."""
        return [f"{row}{col}" for row in range(1, self.rows + 1) for col in self.columns]


@lru_cache(maxsize=1)
def _raw_seat_maps() -> dict:
    with open(_SEATMAPS_PATH, encoding="utf-8") as handle:
        return json.load(handle)


def _normalise(key: str, raw: dict, estimated: bool) -> SeatMap:
    aisle_after = raw["aisle_after"]
    if isinstance(aisle_after, str):
        aisle_after = [aisle_after]
    return SeatMap(
        key=key,
        label=raw["label"],
        rows=raw["rows"],
        columns=tuple(raw["columns"]),
        aisle_after=tuple(aisle_after),
        exit_rows=tuple(raw.get("exit_rows") or ()),
        lavatory_rows=tuple(raw.get("lavatory_rows") or ()),
        no_recline_rows=tuple(raw.get("no_recline_rows") or ()),
        estimated=estimated,
    )


def load_seat_map(key: str | None) -> SeatMap:
    """Resolve an aircraft type / seat map key to a seat map.

    An unknown key degrades to `_default` with ``estimated=True`` - the UI must say
    "estimated layout" in that case, it must never block the user.
    """
    raw = _raw_seat_maps()
    if key and key in raw and key != DEFAULT_SEAT_MAP_KEY:
        return _normalise(key, raw[key], False)
    return _normalise(DEFAULT_SEAT_MAP_KEY, raw[DEFAULT_SEAT_MAP_KEY], True)


def seat_map_keys() -> list[str]:
    return [k for k in _raw_seat_maps() if k != DEFAULT_SEAT_MAP_KEY]


def parse_seat(seat: str) -> tuple[int, str] | None:
    """Parse '14A' into (14, 'A'). Returns None on anything malformed."""
    match = _SEAT_PATTERN.match(seat.strip().upper())
    if not match:
        return None
    row = int(match.group(1))
    if row < 1:
        return None
    return row, match.group(2)


def seat_exists(seat: str, seat_map: SeatMap) -> bool:
    """True when the seat could physically exist on this layout."""
    parsed = parse_seat(seat)
    if parsed is None:
        return False
    row, column = parsed
    return row <= seat_map.rows and column in seat_map.columns


def _column_index(seat: str, seat_map: SeatMap) -> int:
    parsed = parse_seat(seat)
    if parsed is None:
        return -1
    _, column = parsed
    return seat_map.columns.index(column) if column in seat_map.columns else -1


def is_window(seat: str, seat_map: SeatMap) -> bool:
    index = _column_index(seat, seat_map)
    if index < 0:
        return False
    return index == 0 or index == len(seat_map.columns) - 1


def is_aisle(seat: str, seat_map: SeatMap) -> bool:
    index = _column_index(seat, seat_map)
    if index < 0:
        return False
    return any(index in (split, split + 1) for split in seat_map.aisle_split_indices)


def is_middle(seat: str, seat_map: SeatMap) -> bool:
    """Anything that is neither a window nor an aisle. A 3-across row has exactly one."""
    if _column_index(seat, seat_map) < 0:
        return False
    return not is_window(seat, seat_map) and not is_aisle(seat, seat_map)


def front_score(seat: str, seat_map: SeatMap) -> int:
    """0..FRONT_SCALE, integer. Row 1 -> 100, last row -> 0.

    Floor division, mirrored exactly in TypeScript, so both sides agree bit for bit.
    """
    parsed = parse_seat(seat)
    if parsed is None:
        return 0
    if seat_map.rows <= 1:
        return FRONT_SCALE
    row = min(max(parsed[0], 1), seat_map.rows)
    return ((seat_map.rows - row) * FRONT_SCALE) // (seat_map.rows - 1)


def near_lavatory(seat: str, seat_map: SeatMap) -> bool:
    parsed = parse_seat(seat)
    return parsed is not None and parsed[0] in seat_map.lavatory_rows


def is_exit_row(seat: str, seat_map: SeatMap) -> bool:
    parsed = parse_seat(seat)
    return parsed is not None and parsed[0] in seat_map.exit_rows


def are_adjacent(seats: list[str], seat_map: SeatMap) -> bool:
    """One contiguous block in a single row, without an aisle in between.

    Two seats separated by the aisle are NOT adjacent.
    A single seat is trivially adjacent; an empty set is not.
    """
    if not seats:
        return False
    if len(seats) == 1:
        return parse_seat(seats[0]) is not None

    parsed = [parse_seat(s) for s in seats]
    if any(p is None for p in parsed):
        return False

    row = parsed[0][0]
    if any(p[0] != row for p in parsed):
        return False

    indices = [
        seat_map.columns.index(p[1]) if p[1] in seat_map.columns else -1 for p in parsed
    ]
    if any(i < 0 for i in indices):
        return False
    ordered = sorted(indices)
    if len(set(ordered)) != len(ordered):
        return False

    splits = set(seat_map.aisle_split_indices)
    for previous, current in zip(ordered, ordered[1:]):
        if current != previous + 1:
            return False
        if previous in splits:  # the aisle cuts the block
            return False
    return True


def contiguous_blocks(pool: list[str], size: int, seat_map: SeatMap) -> list[list[str]]:
    """Every set of `size` contiguous, same-row, aisle-respecting seats drawn from `pool`.

    These are the candidate adjacency blocks `B` in the CP-SAT model.
    Each block is sorted by column order; the list itself is deterministic.
    """
    if size < 1:
        return []

    available = set()
    for seat in pool:
        parsed = parse_seat(seat)
        if parsed is not None:
            available.add(f"{parsed[0]}{parsed[1]}")

    if size == 1:
        return [[s] for s in sorted(available, key=lambda s: seat_sort_key(s, seat_map))]

    splits = set(seat_map.aisle_split_indices)
    blocks: list[list[str]] = []
    rows = sorted({parse_seat(s)[0] for s in available})

    for row in rows:
        for start in range(len(seat_map.columns) - size + 1):
            block: list[str] = []
            valid = True
            for offset in range(size):
                index = start + offset
                if offset > 0 and (index - 1) in splits:
                    valid = False
                    break
                seat = f"{row}{seat_map.columns[index]}"
                if seat not in available:
                    valid = False
                    break
                block.append(seat)
            if valid:
                blocks.append(block)
    return blocks


def seat_sort_key(seat: str, seat_map: SeatMap) -> tuple[int, int]:
    """Stable ordering: by row, then by column position in the layout."""
    parsed = parse_seat(seat)
    if parsed is None:
        return (10**6, 10**6)
    row, column = parsed
    index = seat_map.columns.index(column) if column in seat_map.columns else 10**6
    return (row, index)
