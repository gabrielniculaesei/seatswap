"""The simulator produces the numbers that go in the README, so it gets tested too.

In particular the baseline has to be a fair comparison: if it were accidentally
crippled, the charts would flatter the solver.
"""

import random

import pytest

from cycles import decompose
from model import Member, Party, SolveConfig, solve
from seatmap import are_adjacent
from simulator import (
    ACCEPTANCE_PROBABILITY,
    STRATEGIES,
    StrategyOutcome,
    evaluate_flight,
    generate_flight,
    pairwise_baseline,
    parse_participation,
    sample_weights,
    summarise,
)
from utility import PreferenceWeights, party_utility

CONFIG = SolveConfig(min_gain=20, num_workers=8, random_seed=3)


# ------------------------------------------------------------------- CLI parsing
def test_parse_participation_range():
    levels = parse_participation("0.02:0.10:0.02")
    assert levels == [0.02, 0.04, 0.06, 0.08, 0.10]


def test_parse_participation_single_value():
    assert parse_participation("0.15") == [0.15]


def test_parse_participation_rejects_zero_step():
    with pytest.raises(ValueError, match="step must be positive"):
        parse_participation("0.1:0.2:0")


# --------------------------------------------------------------- flight generation
@pytest.mark.parametrize("participation", [0.0, 0.02, 0.1, 0.4, 1.0])
def test_generated_flights_are_well_formed(participation, b738):
    rng = random.Random(11)
    parties = generate_flight(rng, b738, participation)

    seats = [m.current_seat for p in parties for m in p.members]
    assert len(set(seats)) == len(seats), "a seat was handed to two people"
    assert all(seat in b738.all_seats() for seat in seats)

    expected = round(len(b738.all_seats()) * participation)
    assert len(seats) == expected

    assert len({p.id for p in parties}) == len(parties)
    assert len({m.id for p in parties for m in p.members}) == len(seats)


def test_zero_participation_produces_no_parties(b738):
    assert generate_flight(random.Random(1), b738, 0.0) == []


def test_full_participation_fills_the_cabin(b738):
    parties = generate_flight(random.Random(1), b738, 1.0)
    seats = {m.current_seat for p in parties for m in p.members}
    assert seats == set(b738.all_seats())


def test_solo_travellers_never_get_an_adjacency_weight():
    rng = random.Random(5)
    for _ in range(200):
        assert sample_weights(rng, 1).w_adjacency == 0


def test_group_weights_stay_in_the_configured_set():
    rng = random.Random(5)
    for _ in range(200):
        weights = sample_weights(rng, 3)
        assert weights.w_adjacency in (0, 40, 200)
        assert weights.w_window in (0, 60)
        assert weights.w_aisle in (0, 60)


# ------------------------------------------------------------------- the baseline
def test_baseline_returns_a_permutation_of_the_pool(b738):
    rng = random.Random(21)
    parties = generate_flight(rng, b738, 0.12)
    before = sorted(m.current_seat for p in parties for m in p.members)
    after = sorted(pairwise_baseline(parties, b738, CONFIG).values())
    assert before == after


def test_baseline_never_makes_a_party_worse_off(b738):
    """It plays by the same rules as the solver, which is what makes it fair."""
    rng = random.Random(22)
    parties = generate_flight(rng, b738, 0.15)
    assignment = pairwise_baseline(parties, b738, CONFIG)
    for party in parties:
        new = party_utility([assignment[m.id] for m in party.members], party.weights, b738)
        old = party_utility(party.current_seats, party.weights, b738)
        assert new >= old


def test_baseline_finds_the_obvious_swap(b738):
    """Sanity check that it is not crippled: a straight mutually-good trade."""
    a = Party(1, (Member(1, "14A"),), PreferenceWeights(w_aisle=60, w_avoid_middle=40))
    b = Party(2, (Member(2, "14C"),), PreferenceWeights(w_window=60, w_avoid_middle=40))
    assignment = pairwise_baseline([a, b], b738, CONFIG)
    assert assignment == {1: "14C", 2: "14A"}


def test_baseline_cannot_close_a_three_party_chain(b738):
    """The reason this product needs a solver rather than a swap board.

    Three people in a rotation where every *pairwise* trade is refused, because in
    each one the second party gains nothing. Only moving all three at once works.
    Note that greedy pairwise swapping is not as weak as it sounds - it can walk
    its way round a rotation whenever the intermediate steps happen to be mutually
    improving, so the case has to be built deliberately.

        P1  20A  window, wants an aisle
        P2  20C  aisle,  wants to be at the front
        P3   2B  middle at the front, wants a window
    """
    a = Party(1, (Member(1, "20A"),), PreferenceWeights(w_aisle=60))
    b = Party(2, (Member(2, "20C"),), PreferenceWeights(w_front=100))
    c = Party(3, (Member(3, "2B"),), PreferenceWeights(w_window=60))
    parties = [a, b, c]

    # Every two-party exchange leaves somebody at +0, below MIN_GAIN.
    baseline = pairwise_baseline(parties, b738, CONFIG)
    assert baseline == {1: "20A", 2: "20C", 3: "2B"}, "no pairwise swap should exist"

    # The solver closes the loop and all three improve.
    result = solve(parties, b738, CONFIG)
    assert result.assignment == {1: "20C", 2: "2B", 3: "20A"}
    assert all(g >= CONFIG.min_gain for g in result.party_gains.values())

    cycles = decompose(parties, result.assignment, result.party_gains)
    assert len(cycles) == 1
    assert cycles[0].length == 3


# --------------------------------------------------------------------- evaluation
def test_evaluate_flight_reports_consistent_counts(b738):
    rng = random.Random(31)
    parties = generate_flight(rng, b738, 0.14)
    outcome = evaluate_flight(parties, b738, CONFIG, 0.14, max_parties_per_proposal=4)

    assert outcome.parties == len(parties)
    assert outcome.passengers == sum(p.size for p in parties)
    assert set(outcome.results) == set(STRATEGIES)

    for name, result in outcome.results.items():
        assert 0 <= result.improved_parties <= outcome.parties, name
        assert result.groups_reunited <= outcome.rescuable_groups, name
        # a cycle always involves at least two parties
        assert all(length >= 2 for length in result.cycle_lengths), name


def test_the_cap_is_respected_end_to_end(b738):
    """The whole reason for capped rounds: no proposal may need more than `cap`
    people to say yes."""
    rng = random.Random(37)
    parties = generate_flight(rng, b738, 0.25)
    outcome = evaluate_flight(parties, b738, CONFIG, 0.25, max_parties_per_proposal=4)

    assert max(outcome.results["chains"].cycle_lengths, default=0) <= 4
    # The uncapped solve is what we are protecting against; on a flight this busy
    # it should produce something much longer.
    assert max(outcome.results["unbounded"].cycle_lengths, default=0) > 4


def test_pairwise_baseline_only_ever_produces_two_party_cycles(b738):
    rng = random.Random(38)
    parties = generate_flight(rng, b738, 0.2)
    outcome = evaluate_flight(parties, b738, CONFIG, 0.2)
    assert all(n == 2 for n in outcome.results["pairwise"].cycle_lengths)


def test_realisation_falls_off_with_cycle_length():
    """The number that makes a long rotation look worse than it scores."""
    short = StrategyOutcome(cycle_lengths=[2, 2, 3])
    long = StrategyOutcome(cycle_lengths=[18])
    assert short.realisation() > long.realisation()
    assert StrategyOutcome(cycle_lengths=[]).realisation() == 0.0
    assert StrategyOutcome(cycle_lengths=[2]).realisation() == pytest.approx(
        ACCEPTANCE_PROBABILITY**2
    )


def test_reunited_groups_are_actually_adjacent(b738):
    """Guards the headline metric against an off-by-one in the counting."""
    rng = random.Random(32)
    parties = generate_flight(rng, b738, 0.2)
    result = solve(parties, b738, CONFIG)
    seekers = [p for p in parties if p.size >= 2 and p.weights.w_adjacency > 0]
    for party in seekers:
        seats = [result.assignment[m.id] for m in party.members]
        if are_adjacent(seats, b738):
            assert party_utility(seats, party.weights, b738) >= party.weights.w_adjacency


def test_summarise_handles_a_level_with_nothing_to_rescue(b738):
    """Division by zero when no group wanted adjacency on any flight."""
    parties = [
        Party(i, (Member(i, f"{i}A"),), PreferenceWeights(w_window=60))
        for i in range(1, 5)
    ]
    outcome = evaluate_flight(parties, b738, CONFIG, 0.05)
    summary = summarise(0.05, [outcome])
    assert summary.flights == 1
    for name in STRATEGIES:
        assert summary.by_strategy[name].adjacency_success == 0.0
