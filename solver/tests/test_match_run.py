"""Match-run orchestration: capped rounds, and the immediate-vs-scheduled rule."""

import random

import pytest

from match_run import (
    DEFAULT_MAX_PARTIES_PER_PROPOSAL,
    at_theoretical_best,
    run_match,
)
from model import Member, Party, SolveConfig
from seatmap import are_adjacent
from simulator import generate_flight
from utility import PreferenceWeights, party_utility

CONFIG = SolveConfig(min_gain=20, num_workers=8, random_seed=5)

WINDOW_SEEKER = PreferenceWeights(w_window=60, w_avoid_middle=40)
AISLE_SEEKER = PreferenceWeights(w_aisle=60, w_avoid_middle=40)
SPLIT_PAIR = PreferenceWeights(w_adjacency=200)


def test_empty_flight():
    from seatmap import load_seat_map

    result = run_match([], load_seat_map("B738"), CONFIG)
    assert result.cycles == []
    assert result.emitted is False


def test_single_party_produces_nothing(b738):
    lone = Party(1, (Member(1, "20B"),), WINDOW_SEEKER)
    result = run_match([lone], b738, CONFIG)
    assert result.emitted is False
    assert result.assignment == {1: "20B"}


# ------------------------------------------------------------------- the cap
@pytest.mark.parametrize("cap", [2, 3, 4, 6])
@pytest.mark.parametrize("seed", [1, 2, 3])
def test_no_proposal_ever_exceeds_the_cap(cap, seed, b738):
    """The point of the whole mechanism: a proposal must never need more than
    `cap` people to press Accept."""
    rng = random.Random(seed)
    parties = generate_flight(rng, b738, 0.25)
    result = run_match(parties, b738, CONFIG, max_parties_per_proposal=cap)
    for cycle in result.cycles:
        assert cycle.length <= cap


def test_rounds_produce_several_independent_proposals(b738):
    rng = random.Random(4)
    parties = generate_flight(rng, b738, 0.25)
    result = run_match(parties, b738, CONFIG, max_parties_per_proposal=4)

    assert len(result.cycles) >= 2, "a busy flight should yield more than one proposal"

    # No party may appear in two proposals: they must be independently acceptable.
    seen = set()
    for cycle in result.cycles:
        assert not (seen & set(cycle.party_ids)), "a party appears in two proposals"
        seen.update(cycle.party_ids)


def test_cycle_indices_are_unique_across_rounds(b738):
    rng = random.Random(6)
    parties = generate_flight(rng, b738, 0.3)
    result = run_match(parties, b738, CONFIG)
    indices = [c.index for c in result.cycles]
    assert indices == list(range(len(indices)))


def test_assignment_is_a_permutation_of_the_pool(b738):
    rng = random.Random(8)
    parties = generate_flight(rng, b738, 0.25)
    result = run_match(parties, b738, CONFIG)

    before = sorted(m.current_seat for p in parties for m in p.members)
    after = sorted(result.assignment.values())
    assert before == after


def test_nobody_ends_up_worse_off_across_rounds(b738):
    """Individual rationality has to survive the round structure, not just one
    solve: a party committed in round 1 must not be undone in round 3."""
    rng = random.Random(9)
    parties = generate_flight(rng, b738, 0.28)
    result = run_match(parties, b738, CONFIG)

    for party in parties:
        seats = [result.assignment[m.id] for m in party.members]
        new = party_utility(seats, party.weights, b738)
        old = party_utility(party.current_seats, party.weights, b738)
        assert new >= old
        if set(seats) != set(party.current_seats):
            assert new - old >= CONFIG.min_gain


def test_capped_run_still_reunites_groups(b738):
    """Capping must not break the core feature."""
    pair = Party(1, (Member(1, "14A"), Member(2, "20C")), SPLIT_PAIR)
    single = Party(2, (Member(3, "14B"),), WINDOW_SEEKER)
    result = run_match([pair, single], b738, CONFIG, max_parties_per_proposal=4)

    assert result.emitted
    assert are_adjacent([result.assignment[1], result.assignment[2]], b738)


# ------------------------------------------------------- immediate vs scheduled
def test_at_theoretical_best(b738):
    single = Party(1, (Member(1, "14A"),), PreferenceWeights(w_window=60))
    assert at_theoretical_best(single, {1: "14A"}, b738)
    assert not at_theoretical_best(single, {1: "14B"}, b738)


def test_immediate_run_withholds_a_merely_decent_match(b738):
    """Firing the first acceptable swap burns a seat that a later, better chain
    would have used (CLAUDE.md §14). An immediate run only fires on perfection.

    Here the single wants a window AND the front AND no middle; the swap it is
    offered improves it but leaves it short of its theoretical best, so the run
    holds the result back.
    """
    pair = Party(1, (Member(1, "30A"), Member(2, "30C")), SPLIT_PAIR)
    fussy = Party(
        2,
        (Member(3, "30B"),),
        PreferenceWeights(w_window=60, w_avoid_middle=40, w_front=30),
    )

    scheduled = run_match([pair, fussy], b738, CONFIG, trigger="scheduled")
    assert scheduled.emitted, "a scheduled run emits the best available"

    immediate = run_match([pair, fussy], b738, CONFIG, trigger="immediate")
    assert immediate.withheld is True
    assert immediate.emitted is False


def test_immediate_run_fires_when_everyone_is_maxed(b738):
    """Both sides hit their ceiling, so there is nothing better to wait for.

    The pair only wants to sit together (200 is all it can score) and the single
    only wants an aisle (60 is all it can score). Swapping 20C for 20B gives each
    of them everything they asked for, so the run fires immediately.
    """
    pair = Party(1, (Member(1, "20A"), Member(2, "20C")), SPLIT_PAIR)
    single = Party(2, (Member(3, "20B"),), PreferenceWeights(w_aisle=60))

    immediate = run_match([pair, single], b738, CONFIG, trigger="immediate")

    assert immediate.emitted, "both parties are at their theoretical best"
    assert immediate.withheld is False
    assert are_adjacent([immediate.assignment[1], immediate.assignment[2]], b738)
    assert immediate.assignment[3] == "20C"
    for party in (pair, single):
        assert at_theoretical_best(party, immediate.assignment, b738)


def test_default_cap_is_small_enough_to_close(b738):
    assert 2 <= DEFAULT_MAX_PARTIES_PER_PROPOSAL <= 6


def test_immediate_run_can_fire_for_a_party_that_wants_both(b738):
    """Regression: a party wanting adjacency *and* seat quality must be able to
    reach its own maximum.

    The bound used to be "the best `size` seats in the cabin, plus the adjacency
    bonus" — 60 + 60 + 200 for this pair — which no assignment can reach, because
    two windows are never next to each other. Immediate runs were therefore dead
    code for every party that wanted both things.
    """
    pair = Party(
        1,
        (Member(1, "14B"), Member(2, "20C")),
        PreferenceWeights(w_adjacency=200, w_window=60),
    )
    single = Party(2, (Member(3, "14A"),), AISLE_SEEKER)

    result = run_match([pair, single], b738, CONFIG, trigger="immediate")

    assert result.emitted and not result.withheld
    assert are_adjacent([result.assignment[1], result.assignment[2]], b738)
    for party in (pair, single):
        assert at_theoretical_best(party, result.assignment, b738)
