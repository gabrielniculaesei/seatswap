"""The utility function: units, monotonicity, and the orthogonality it exists for."""

import pytest

from utility import (
    PreferenceWeights,
    ZERO_WEIGHTS,
    gain,
    max_theoretical_utility,
    party_utility,
    seat_utility,
)

WINDOW_SEEKER = PreferenceWeights(w_window=60, w_avoid_middle=40)
AISLE_SEEKER = PreferenceWeights(w_aisle=60, w_avoid_middle=40)
SPLIT_GROUP = PreferenceWeights(w_adjacency=200)


def test_no_preferences_means_no_utility(b738):
    for seat in b738.all_seats():
        assert seat_utility(seat, ZERO_WEIGHTS, b738) == 0


def test_weights_are_in_point_units(b738):
    """A window is worth exactly w_window. Units matter: MIN_GAIN is in them."""
    assert seat_utility("14A", PreferenceWeights(w_window=60), b738) == 60
    assert seat_utility("14C", PreferenceWeights(w_aisle=60), b738) == 60
    assert seat_utility("14B", PreferenceWeights(w_window=60, w_aisle=60), b738) == 0


def test_avoid_middle_pays_for_anything_that_is_not_a_middle(b738):
    w = PreferenceWeights(w_avoid_middle=40)
    assert seat_utility("14A", w, b738) == 40
    assert seat_utility("14C", w, b738) == 40
    assert seat_utility("14B", w, b738) == 0


def test_front_term_is_scaled_back_into_point_units(b738):
    """front_score is 0..100, so w_front * score is divided back down by 100."""
    w = PreferenceWeights(w_front=30)
    assert seat_utility("1B", w, b738) == 30                      # front row, full weight
    assert seat_utility(f"{b738.rows}B", w, b738) == 0            # last row, nothing
    assert 0 < seat_utility("17B", w, b738) < 30                  # somewhere in between


def test_lavatory_penalty_subtracts(b738):
    w = PreferenceWeights(w_window=60, w_avoid_lavatory=25)
    assert seat_utility("14A", w, b738) == 60
    assert seat_utility("32A", w, b738) == 35


def test_unparseable_seat_scores_zero_instead_of_raising(b738):
    """Bad data must never crash a match run."""
    assert seat_utility("", WINDOW_SEEKER, b738) == 0
    assert seat_utility("banana", WINDOW_SEEKER, b738) == 0


# ------------------------------------------------------------------ party level
def test_adjacency_bonus_applies_only_when_together(b738):
    assert party_utility(["14A", "14B"], SPLIT_GROUP, b738) == 200
    assert party_utility(["14A", "20C"], SPLIT_GROUP, b738) == 0
    assert party_utility(["14C", "14D"], SPLIT_GROUP, b738) == 0  # across the aisle


def test_party_of_one_is_unaffected_by_the_adjacency_weight(b738):
    """The questionnaire forces w_adjacency = 0 for a single, but even if it did
    not, adjacency would be constant for them and cancel out of every gain."""
    w = PreferenceWeights(w_window=60, w_adjacency=200)
    assert gain(["14B"], ["14A"], w, b738) == 60


def test_party_utility_sums_over_members(b738):
    seats = ["14A", "14B", "14C"]
    w = PreferenceWeights(w_window=60, w_adjacency=200)
    expected = sum(seat_utility(s, w, b738) for s in seats) + 200
    assert party_utility(seats, w, b738) == expected


def test_gain_is_a_difference(b738):
    assert gain(["14B"], ["14A"], WINDOW_SEEKER, b738) == 100
    assert gain(["14A"], ["14B"], WINDOW_SEEKER, b738) == -100
    assert gain(["14A"], ["14A"], WINDOW_SEEKER, b738) == 0


def test_the_two_sides_of_the_market_are_orthogonal(b738):
    """The economic core of the product.

    Moving a split pair from a good-but-separated pair of seats into a bad-but-
    adjacent one costs them nothing and hands the single traveller a real gain.
    Both sides come out ahead; no favour is exchanged.
    """
    group_before, group_after = ["14A", "20C"], ["20B", "20C"]
    single_before, single_after = ["20B"], ["14A"]

    assert gain(group_before, group_after, SPLIT_GROUP, b738) == 200
    assert gain(single_before, single_after, WINDOW_SEEKER, b738) == 100


# ------------------------------------------------------------------ upper bound
def test_max_theoretical_utility_is_an_upper_bound(b738):
    w = PreferenceWeights(w_window=60, w_avoid_middle=40, w_front=30, w_avoid_lavatory=25)
    bound = max_theoretical_utility(1, w, b738)
    for seat in b738.all_seats():
        assert party_utility([seat], w, b738) <= bound


def test_max_theoretical_utility_includes_adjacency_when_the_party_fits(b738):
    assert max_theoretical_utility(2, SPLIT_GROUP, b738) == 200
    assert max_theoretical_utility(3, SPLIT_GROUP, b738) == 200


def test_max_theoretical_utility_drops_adjacency_when_the_party_cannot_fit(b738):
    """Four people cannot sit together on a 3+3 narrow-body, so promising the
    adjacency bonus in the bound would make it unreachable forever."""
    assert max_theoretical_utility(4, SPLIT_GROUP, b738) == 0


def test_max_theoretical_bound_is_reachable_not_just_an_upper_bound(b738):
    """A pair that wants a window AND to sit together cannot have two windows.

    Adding the adjacency bonus on top of the two best seats in the cabin would
    give 60 + 60 + 200 = 320, which no assignment can reach — and a party that can
    never reach its own maximum would block immediate runs forever.
    """
    w = PreferenceWeights(w_adjacency=200, w_window=60)
    bound = max_theoretical_utility(2, w, b738)

    assert bound == 260, "one window plus the adjacency bonus"
    assert party_utility(["14A", "14B"], w, b738) == bound, "and it is achievable"


def test_max_theoretical_bound_prefers_spreading_out_when_adjacency_is_cheap(b738):
    """With only a weak preference for sitting together, two windows in different
    rows beat one window side by side."""
    w = PreferenceWeights(w_adjacency=40, w_window=60)
    assert max_theoretical_utility(2, w, b738) == 120
    assert party_utility(["14A", "20F"], w, b738) == 120


@pytest.mark.parametrize("size", [1, 2, 3, 4, 5])
def test_max_theoretical_bound_is_never_exceeded(size, b738):
    """Property: no real assignment may score above the bound, for any weights."""
    import random

    rng = random.Random(size)
    seats = b738.all_seats()
    for _ in range(60):
        w = PreferenceWeights(
            w_window=rng.choice([0, 60]),
            w_aisle=rng.choice([0, 60]),
            w_front=rng.choice([0, 30]),
            w_avoid_middle=rng.choice([0, 40]),
            w_avoid_lavatory=rng.choice([0, 25]),
            w_adjacency=rng.choice([0, 40, 200]),
        )
        bound = max_theoretical_utility(size, w, b738)
        for _ in range(20):
            chosen = rng.sample(seats, size)
            assert party_utility(chosen, w, b738) <= bound
