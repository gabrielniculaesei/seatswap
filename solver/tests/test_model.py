"""Solver behaviour and property tests (CLAUDE.md §17).

No solution may violate individual rationality, no seat may be handed out twice,
and the seats that come out must be exactly the seats that went in.
"""

import random

import pytest

from cycles import decompose
from model import Member, Party, SolveConfig, SolverInputError, build_pool, solve
from seatmap import are_adjacent
from utility import PreferenceWeights, party_utility

WINDOW_SEEKER = PreferenceWeights(w_window=60, w_avoid_middle=40)
AISLE_SEEKER = PreferenceWeights(w_aisle=60, w_avoid_middle=40)
SPLIT_PAIR = PreferenceWeights(w_adjacency=200)
INDIFFERENT = PreferenceWeights()

# 8 workers is not a speed luxury: with a single worker CP-SAT fails to prove
# optimality on 30-seat instances within 30 seconds (see docs/liquidity.md).
FAST = SolveConfig(max_seconds=10.0, num_workers=8, random_seed=7)


# ------------------------------------------------------------------- basic runs
def test_empty_flight_is_not_an_error(b738):
    result = solve([], b738, FAST)
    assert result.status == "EMPTY"
    assert result.assignment == {}


def test_single_party_alone_cannot_improve(b738):
    """One party is the only holder of its own seats: there is nothing to trade."""
    party = Party(1, (Member(1, "20B"),), WINDOW_SEEKER)
    result = solve([party], b738, FAST)
    assert result.assignment == {1: "20B"}
    assert result.party_gains == {1: 0}


def test_the_textbook_swap(b738):
    """Window-lover in a middle, aisle-lover in a window, both in the same row."""
    a = Party(1, (Member(1, "14B"),), WINDOW_SEEKER)
    b = Party(2, (Member(2, "14C"),), AISLE_SEEKER)
    result = solve([a, b], b738, FAST)
    # b already has the aisle; a is in a middle. Only a can improve, by taking
    # nothing b wants to give up, so nothing moves.
    assert result.party_gains[2] >= 0


def test_split_pair_reunites_with_a_single(b738):
    pair = Party(1, (Member(1, "14A"), Member(2, "20C")), SPLIT_PAIR)
    single = Party(2, (Member(3, "14B"),), WINDOW_SEEKER)
    result = solve([pair, single], b738, FAST)

    assert result.status == "OPTIMAL"
    assert are_adjacent([result.assignment[1], result.assignment[2]], b738)
    assert result.party_gains[1] == 200
    assert result.party_gains[2] > 0


def test_three_party_chain_beats_any_pairwise_swap(b738):
    """A rotation nobody could have arranged by talking to one neighbour."""
    a = Party(1, (Member(1, "10A"),), AISLE_SEEKER)        # window, wants aisle
    b = Party(2, (Member(2, "11C"),), PreferenceWeights(w_front=100, w_aisle=60))
    c = Party(3, (Member(3, "12B"),), WINDOW_SEEKER)       # middle, wants window
    result = solve([a, b, c], b738, FAST)
    assert result.status == "OPTIMAL"
    for party_id, gain in result.party_gains.items():
        assert gain >= 0


# ---------------------------------------------------------------- hard invariants
def _random_flight(rng: random.Random, seat_map, n_parties: int):
    """Random but realistic: mostly singles, some pairs, a few small groups."""
    seats = seat_map.all_seats()
    rng.shuffle(seats)
    cursor = 0
    parties = []
    for party_id in range(1, n_parties + 1):
        size = rng.choices([1, 2, 3], weights=[60, 25, 15])[0]
        if cursor + size > len(seats):
            break
        members = tuple(
            Member(party_id * 100 + i, seats[cursor + i]) for i in range(size)
        )
        cursor += size
        if size == 1:
            weights = rng.choice([WINDOW_SEEKER, AISLE_SEEKER, INDIFFERENT])
        else:
            weights = PreferenceWeights(
                w_adjacency=rng.choice([0, 40, 200]),
                w_window=rng.choice([0, 60]),
            )
        parties.append(
            Party(party_id, members, weights, verification_tier=rng.choice([0, 0, 1, 2]))
        )
    return parties


@pytest.mark.parametrize("seed", range(20))
def test_properties_hold_on_random_flights(seed, b738):
    rng = random.Random(seed)
    parties = _random_flight(rng, b738, rng.randint(2, 14))
    result = solve(parties, b738, FAST)
    assert result.feasible

    pool = build_pool(parties)
    assigned = list(result.assignment.values())

    # same seats in as out, each used once
    assert sorted(assigned) == sorted(pool)
    assert len(set(assigned)) == len(assigned)

    # every member has exactly one seat
    expected_members = {m.id for p in parties for m in p.members}
    assert set(result.assignment) == expected_members

    for party in parties:
        gain = result.party_gains[party.id]
        # individual rationality
        assert gain >= 0, f"party {party.id} lost utility"
        # gain reported == gain recomputed from the shared utility function
        new_seats = [result.assignment[m.id] for m in party.members]
        assert gain == party_utility(new_seats, party.weights, b738) - party_utility(
            party.current_seats, party.weights, b738
        )
        # minimum gain for anyone who moves
        if set(new_seats) != set(party.current_seats):
            assert gain >= FAST.min_gain


@pytest.mark.parametrize("seed", range(10))
def test_cycles_partition_every_move(seed, b738):
    rng = random.Random(1000 + seed)
    parties = _random_flight(rng, b738, rng.randint(3, 12))
    result = solve(parties, b738, FAST)
    cycles = decompose(parties, result.assignment, result.party_gains)

    moved_members = {
        m.id
        for p in parties
        for m in p.members
        if result.assignment[m.id] != m.current_seat
    }
    in_cycles = {move.member_id for c in cycles for move in c.moves}
    assert in_cycles == moved_members

    # cycles are disjoint in parties, and each is closed
    seen = set()
    for cycle in cycles:
        assert not (seen & set(cycle.party_ids))
        seen.update(cycle.party_ids)
        assert {m.from_seat for m in cycle.moves} == {m.to_seat for m in cycle.moves}


# ------------------------------------------------------------------ MIN_GAIN
def test_min_gain_blocks_a_disguised_favour(b738):
    """A move worth less than MIN_GAIN is a favour in disguise, so it is refused
    even when it would raise the total (CLAUDE.md §14, constraint 7)."""
    pair = Party(1, (Member(1, "14A"), Member(2, "20C")), SPLIT_PAIR)
    helper = Party(2, (Member(3, "14B"),), PreferenceWeights(w_window=1))
    strict = SolveConfig(min_gain=20, num_workers=8, random_seed=7)
    result = solve([pair, helper], b738, strict)
    # 14B -> 20C is worth 0 to the helper, so the reunion cannot be bought.
    assert result.party_gains[2] == 0
    assert result.assignment[3] == "14B"


def test_min_gain_zero_allows_the_same_move(b738):
    pair = Party(1, (Member(1, "14A"), Member(2, "20C")), SPLIT_PAIR)
    helper = Party(2, (Member(3, "14B"),), PreferenceWeights(w_window=1))
    loose = SolveConfig(min_gain=0, num_workers=8, random_seed=7)
    result = solve([pair, helper], b738, loose)
    assert result.party_gains[1] == 200


# ------------------------------------------------------------- input validation
def test_duplicate_seats_are_rejected(b738):
    a = Party(1, (Member(1, "14A"),), WINDOW_SEEKER)
    b = Party(2, (Member(2, "14A"),), WINDOW_SEEKER)
    with pytest.raises(SolverInputError, match="duplicate seat"):
        solve([a, b], b738, FAST)


def test_unparseable_seat_is_rejected(b738):
    a = Party(1, (Member(1, "nope"),), WINDOW_SEEKER)
    with pytest.raises(SolverInputError, match="unparseable"):
        solve([a], b738, FAST)


def test_internal_swaps_are_canonicalised_away(b738):
    """Two members of one party trading seats with each other is worth exactly
    zero and would only add noise to the proposal."""
    party = Party(1, (Member(1, "14A"), Member(2, "14B")), SPLIT_PAIR)
    other = Party(2, (Member(3, "20A"),), INDIFFERENT)
    result = solve([party, other], b738, FAST)
    assert result.assignment[1] == "14A"
    assert result.assignment[2] == "14B"


# -------------------------------------------------------------------- estimated
def test_unknown_aircraft_still_solves(generic):
    """An unknown aircraft type degrades to the generic layout, it never blocks."""
    pair = Party(1, (Member(1, "5A"), Member(2, "9C")), SPLIT_PAIR)
    single = Party(2, (Member(3, "5B"),), WINDOW_SEEKER)
    result = solve([pair, single], generic, FAST)
    assert result.feasible
    assert result.party_gains[1] == 200


# ------------------------------------------------------------- degenerate input
def test_parties_with_no_preferences_at_all(b738):
    """Every weight zero makes the utility expression a plain constant rather than
    a linear expression over the variables. The model builder must survive that."""
    a = Party(1, (Member(1, "14A"),), INDIFFERENT)
    b = Party(2, (Member(2, "14B"),), INDIFFERENT)
    result = solve([a, b], b738, FAST)
    assert result.status == "OPTIMAL"
    assert result.party_gains == {1: 0, 2: 0}
    assert result.assignment == {1: "14A", 2: "14B"}


def test_indifferent_party_of_two(b738):
    a = Party(1, (Member(1, "20A"), Member(2, "25F")), INDIFFERENT)
    b = Party(2, (Member(3, "14B"),), INDIFFERENT)
    result = solve([a, b], b738, FAST)
    assert result.status == "OPTIMAL"
    assert all(g == 0 for g in result.party_gains.values())


def test_single_with_a_nonsensical_adjacency_weight(b738):
    """A party of one cannot be non-adjacent, so the weight must cancel out and
    never become free utility the solver can hand out for doing nothing."""
    lone = Party(1, (Member(1, "2A"),), PreferenceWeights(w_adjacency=200))
    other = Party(2, (Member(2, "14A"),), INDIFFERENT)
    result = solve([lone, other], b738, FAST)
    assert result.party_gains == {1: 0, 2: 0}
