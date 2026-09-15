"""Seat geometry, with the edge cases spelled out (CLAUDE.md §17)."""

import pytest

from seatmap import (
    DEFAULT_SEAT_MAP_KEY,
    SeatMap,
    are_adjacent,
    contiguous_blocks,
    front_score,
    is_aisle,
    is_exit_row,
    is_middle,
    is_window,
    load_seat_map,
    near_lavatory,
    parse_seat,
    seat_exists,
    seat_map_keys,
)


# --------------------------------------------------------------------- parsing
@pytest.mark.parametrize(
    "raw,expected",
    [
        ("14A", (14, "A")),
        ("1F", (1, "F")),
        ("  22c  ", (22, "C")),
        ("104B", (104, "B")),
    ],
)
def test_parse_seat_accepts_valid(raw, expected):
    assert parse_seat(raw) == expected


@pytest.mark.parametrize("raw", ["", "A14", "14", "A", "14AA", "0A", "-1A", "14-A", "1234A"])
def test_parse_seat_rejects_junk(raw):
    assert parse_seat(raw) is None


def test_seat_exists_respects_layout(b738):
    assert seat_exists("33F", b738)
    assert not seat_exists("34A", b738)      # past the last row
    assert not seat_exists("14G", b738)      # column not on a 6-across narrow-body


# ------------------------------------------------------------------- categories
def test_window_aisle_middle_partition_every_seat(b738):
    """Every real seat is exactly one of window / aisle / middle."""
    for seat in b738.all_seats():
        flags = [is_window(seat, b738), is_aisle(seat, b738), is_middle(seat, b738)]
        assert sum(flags) == 1, f"{seat} classified as {flags}"


@pytest.mark.parametrize("seat", ["14A", "14F", "1A", "33F"])
def test_window_seats(seat, b738):
    assert is_window(seat, b738)


@pytest.mark.parametrize("seat", ["14C", "14D"])
def test_aisle_seats(seat, b738):
    assert is_aisle(seat, b738)


@pytest.mark.parametrize("seat", ["14B", "14E"])
def test_middle_seats(seat, b738):
    assert is_middle(seat, b738)


def test_unknown_column_is_no_category(b738):
    assert not is_window("14G", b738)
    assert not is_aisle("14G", b738)
    assert not is_middle("14G", b738)


# ------------------------------------------------------------------ front score
def test_front_score_endpoints(b738):
    assert front_score("1A", b738) == 100
    assert front_score(f"{b738.rows}A", b738) == 0


def test_front_score_is_monotonic(b738):
    scores = [front_score(f"{row}A", b738) for row in range(1, b738.rows + 1)]
    assert scores == sorted(scores, reverse=True)
    assert all(0 <= s <= 100 for s in scores)


def test_front_score_clamps_rows_outside_the_cabin(b738):
    assert front_score("99A", b738) == 0
    assert front_score("bogus", b738) == 0


def test_front_score_single_row_layout():
    """rows == 1 would divide by zero; the only row is the front row."""
    one_row = SeatMap(key="X", label="x", rows=1, columns=("A", "B"), aisle_after=("A",))
    assert front_score("1A", one_row) == 100


# -------------------------------------------------------------------- lavatory
def test_near_lavatory(b738):
    assert near_lavatory("1A", b738)
    assert near_lavatory("32D", b738)
    assert not near_lavatory("14A", b738)


def test_exit_rows(b738):
    assert is_exit_row("16C", b738)
    assert not is_exit_row("15C", b738)


# ------------------------------------------------------------------- adjacency
def test_adjacent_same_side_of_aisle(b738):
    assert are_adjacent(["14A", "14B"], b738)
    assert are_adjacent(["14A", "14B", "14C"], b738)
    assert are_adjacent(["14D", "14E", "14F"], b738)


def test_seats_across_the_aisle_are_not_adjacent(b738):
    """The whole point: C and D are next to each other on a map, not on a plane."""
    assert not are_adjacent(["14C", "14D"], b738)
    assert not are_adjacent(["14B", "14C", "14D"], b738)
    assert not are_adjacent(["14A", "14B", "14C", "14D"], b738)


def test_adjacency_is_order_independent(b738):
    assert are_adjacent(["14C", "14A", "14B"], b738)


def test_different_rows_are_never_adjacent(b738):
    assert not are_adjacent(["14A", "15A"], b738)
    assert not are_adjacent(["14A", "15B"], b738)


def test_gap_in_a_row_is_not_adjacent(b738):
    assert not are_adjacent(["14A", "14C"], b738)


def test_single_seat_is_trivially_adjacent(b738):
    assert are_adjacent(["14A"], b738)


def test_empty_set_is_not_adjacent(b738):
    assert not are_adjacent([], b738)


def test_duplicate_seats_are_not_adjacent(b738):
    assert not are_adjacent(["14A", "14A"], b738)


def test_unparseable_seat_is_not_adjacent(b738):
    assert not are_adjacent(["14A", "nonsense"], b738)


def test_party_of_three_fits_one_side_of_the_aisle(b738):
    """A party of 3 fits a 3-seat bank; a party of 4 cannot sit together at all."""
    assert are_adjacent(["14A", "14B", "14C"], b738)
    assert not are_adjacent(["14C", "14D", "14E"], b738)


# ----------------------------------------------------------------- block search
def test_contiguous_blocks_of_two(b738):
    pool = ["14A", "14B", "14C", "14D"]
    assert contiguous_blocks(pool, 2, b738) == [["14A", "14B"], ["14B", "14C"]]


def test_contiguous_blocks_never_straddle_the_aisle(b738):
    pool = b738.all_seats()
    for block in contiguous_blocks(pool, 2, b738):
        assert are_adjacent(block, b738)


def test_contiguous_blocks_of_four_are_impossible_on_a_narrow_body(b738):
    assert contiguous_blocks(b738.all_seats(), 4, b738) == []


def test_contiguous_blocks_of_one_is_every_seat(b738):
    pool = ["20C", "14A", "14B"]
    assert contiguous_blocks(pool, 1, b738) == [["14A"], ["14B"], ["20C"]]


def test_contiguous_blocks_needs_the_whole_block_in_the_pool(b738):
    """A block half of which belongs to nobody in the pool is not available."""
    assert contiguous_blocks(["14A", "14C"], 2, b738) == []


def test_contiguous_blocks_rejects_zero_size(b738):
    assert contiguous_blocks(["14A"], 0, b738) == []


# --------------------------------------------------------------- map resolution
def test_unknown_aircraft_type_degrades_to_default(b738):
    """Unknown type must never block a user; it flags the layout as estimated."""
    fallback = load_seat_map("Concorde")
    assert fallback.key == DEFAULT_SEAT_MAP_KEY
    assert fallback.estimated is True


def test_known_aircraft_type_is_not_estimated():
    assert load_seat_map("A320").estimated is False


def test_none_degrades_to_default():
    assert load_seat_map(None).estimated is True


def test_unknown_aircraft_treats_every_known_exit_row_as_one():
    """Exit rows feed exactly one thing, the rule that keeps children out of them
    (model.py, constraint 8). On an aircraft we could not identify the only safe
    guess is "any row that is an exit on any layout we know", or that rule stops
    protecting anyone the moment the API has no answer. Adding a layout with new
    exit rows means adding them to `_default` too; this is the reminder."""
    default_exits = set(load_seat_map(None).exit_rows)
    for key in seat_map_keys():
        missing = set(load_seat_map(key).exit_rows) - default_exits
        assert not missing, f"_default is missing {key}'s exit rows {sorted(missing)}"


def test_all_configured_maps_are_well_formed():
    for key in seat_map_keys() + [DEFAULT_SEAT_MAP_KEY]:
        seat_map = load_seat_map(key) if key != DEFAULT_SEAT_MAP_KEY else load_seat_map(None)
        assert seat_map.rows > 0
        assert len(seat_map.columns) >= 2
        assert len(set(seat_map.columns)) == len(seat_map.columns)
        for letter in seat_map.aisle_after:
            assert letter in seat_map.columns, f"{key}: aisle_after {letter} not a column"
        for row in seat_map.lavatory_rows + seat_map.exit_rows:
            assert 1 <= row <= seat_map.rows, f"{key}: row {row} outside the cabin"
