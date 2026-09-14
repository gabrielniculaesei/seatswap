"""The party utility function (CLAUDE.md §8).

Python twin of web/lib/utility.ts. They MUST return exactly the same integers for
the same input: the TS one drives the "what you'd gain" preview in the UI, this one
drives the CP-SAT objective. If they disagree, the UI promises something the solver
did not optimise for. tests/test_cross_language.py enforces it.

Everything is integer arithmetic. No floats anywhere near the model.

Units: one "point" is one unit of a preference weight, so a window seat is worth
exactly w_window and a satisfied adjacency is worth exactly w_adjacency. The front
term is the only non-boolean one, so it is scaled back down by FRONT_SCALE with
floor division to stay in the same units. MIN_GAIN is expressed in these same points.
"""

from __future__ import annotations

from dataclasses import dataclass

from seatmap import (
    FRONT_SCALE,
    SeatMap,
    are_adjacent,
    contiguous_blocks,
    front_score,
    is_aisle,
    is_middle,
    is_window,
    near_lavatory,
    parse_seat,
)


@dataclass(frozen=True)
class PreferenceWeights:
    w_window: int = 0
    w_aisle: int = 0
    w_front: int = 0
    w_avoid_middle: int = 0
    w_avoid_lavatory: int = 0
    #: 0 | 40 | 200 - see web/config/preferences.ts
    w_adjacency: int = 0


ZERO_WEIGHTS = PreferenceWeights()


def seat_utility(seat: str, w: PreferenceWeights, seat_map: SeatMap) -> int:
    """Utility of a single seat for a party's preferences.

        u_seat(s, p) =  w_window         * is_window(s)
                      + w_aisle          * is_aisle(s)
                      + w_avoid_middle   * (1 - is_middle(s))
                      + floor(w_front * front_score(s) / FRONT_SCALE)
                      - w_avoid_lavatory * near_lavatory(s)

    An unparseable seat scores 0 rather than raising: bad data must never crash a
    match run, it just makes that seat unattractive.
    """
    if parse_seat(seat) is None:
        return 0
    u = 0
    if is_window(seat, seat_map):
        u += w.w_window
    if is_aisle(seat, seat_map):
        u += w.w_aisle
    if not is_middle(seat, seat_map):
        u += w.w_avoid_middle
    u += (w.w_front * front_score(seat, seat_map)) // FRONT_SCALE
    if near_lavatory(seat, seat_map):
        u -= w.w_avoid_lavatory
    return u


def party_utility(seats: list[str], w: PreferenceWeights, seat_map: SeatMap) -> int:
    """Utility of a whole assignment for one party.

        U_p(A) = sum_{m in p} u_seat(A[m], p) + w_adjacency(p) * adjacent(A, p)

    A party of one is trivially "adjacent"; that costs nothing because the
    questionnaire forces w_adjacency = 0 for parties of one.
    """
    total = sum(seat_utility(seat, w, seat_map) for seat in seats)
    if w.w_adjacency != 0 and are_adjacent(seats, seat_map):
        total += w.w_adjacency
    return total


def gain(
    from_seats: list[str],
    to_seats: list[str],
    w: PreferenceWeights,
    seat_map: SeatMap,
) -> int:
    """Utility delta between a proposed assignment and the current one."""
    return party_utility(to_seats, w, seat_map) - party_utility(from_seats, w, seat_map)


def max_theoretical_utility(size: int, w: PreferenceWeights, seat_map: SeatMap) -> int:
    """The best a party could do if it had the run of the whole empty cabin.

    Used by the "immediate run" rule (CLAUDE.md §14): fire a proposal the moment it
    appears only if every party in it is already at its theoretical maximum,
    otherwise discard the result and wait for a scheduled run that might find a
    better cycle.

    The bound has to be *reachable*, not merely an upper bound. Taking the best
    `size` seats in the cabin and then adding the adjacency bonus on top would not
    be: on a 3+3 narrow-body the two best seats for a window-lover are two windows
    in different rows, and they are not next to each other. A party wanting both a
    window and adjacency would then never reach its own maximum and an immediate
    run could never fire for it. So the two cases are costed separately and the
    better one wins:

      * spread out  - the best `size` seats anywhere, no adjacency bonus;
      * together    - the best contiguous block of `size` seats, plus the bonus.
    """
    all_seats = seat_map.all_seats()
    scores = sorted((seat_utility(s, w, seat_map) for s in all_seats), reverse=True)
    spread = sum(scores[:size])

    if size < 2:
        # A party of one is trivially "adjacent", so party_utility() grants it the
        # bonus unconditionally and the bound has to match. In practice the
        # questionnaire forces w_adjacency = 0 for a single, so this is only about
        # the two functions agreeing on every input rather than most of them.
        return spread + w.w_adjacency
    if w.w_adjacency == 0:
        return spread

    best_block = None
    for block in contiguous_blocks(all_seats, size, seat_map):
        value = sum(seat_utility(s, w, seat_map) for s in block) + w.w_adjacency
        if best_block is None or value > best_block:
            best_block = value

    # No block of this size exists (e.g. four people on a 3+3 layout): they simply
    # cannot sit together, so the spread-out bound is the only one available.
    if best_block is None:
        return spread
    return max(spread, best_block)
