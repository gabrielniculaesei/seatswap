"""Cycle decomposition (CLAUDE.md §14).

The property that matters: each cycle is closed, so one can be accepted while
another is rejected without stranding anybody.
"""

import pytest

from cycles import Cycle, Move, decompose, describe, validate
from model import Member, Party
from utility import PreferenceWeights

W = PreferenceWeights(w_window=60)


def _party(pid, *seats):
    return Party(pid, tuple(Member(pid * 10 + i, s) for i, s in enumerate(seats)), W)


def test_nobody_moves_means_no_cycles():
    parties = [_party(1, "14A"), _party(2, "14B")]
    assignment = {10: "14A", 20: "14B"}
    assert decompose(parties, assignment, {1: 0, 2: 0}) == []


def test_simple_two_party_swap():
    parties = [_party(1, "14A"), _party(2, "14B")]
    assignment = {10: "14B", 20: "14A"}
    cycles = decompose(parties, assignment, {1: 60, 2: 40})

    assert len(cycles) == 1
    cycle = cycles[0]
    assert cycle.party_ids == [1, 2]
    assert cycle.length == 2
    assert cycle.total_gain == 100
    assert {(m.from_seat, m.to_seat) for m in cycle.moves} == {("14A", "14B"), ("14B", "14A")}


def test_three_party_rotation_is_one_cycle():
    """1 -> 2 -> 3 -> 1. This is the chain a cabin conversation could never reach."""
    parties = [_party(1, "14A"), _party(2, "14B"), _party(3, "14C")]
    assignment = {10: "14B", 20: "14C", 30: "14A"}
    cycles = decompose(parties, assignment, {1: 30, 2: 30, 3: 30})

    assert len(cycles) == 1
    assert cycles[0].party_ids == [1, 2, 3]
    assert cycles[0].length == 3
    assert cycles[0].total_gain == 90


def test_two_disjoint_swaps_are_two_cycles():
    """Independent trades must stay independent, or one rejection kills both."""
    parties = [_party(1, "14A"), _party(2, "14B"), _party(3, "20A"), _party(4, "20B")]
    assignment = {10: "14B", 20: "14A", 30: "20B", 40: "20A"}
    cycles = decompose(parties, assignment, {1: 10, 2: 10, 3: 50, 4: 50})

    assert len(cycles) == 2
    assert [c.party_ids for c in cycles] == [[3, 4], [1, 2]]  # best trade first
    assert cycles[0].index == 0 and cycles[1].index == 1


def test_multi_member_party_forms_one_component():
    """A pair swapping with two singles is a single atomic proposal: the pair
    cannot get half of what it needs."""
    pair = Party(1, (Member(11, "14A"), Member(12, "20C")), PreferenceWeights(w_adjacency=200))
    single_a = _party(2, "14B")
    single_b = _party(3, "20B")
    assignment = {11: "20B", 12: "20C", 20: "14A", 30: "14B"}
    cycles = decompose([pair, single_a, single_b], assignment, {1: 200, 2: 60, 3: 20})

    assert len(cycles) == 1
    assert cycles[0].party_ids == [1, 2, 3]


def test_parties_that_stay_put_are_excluded():
    parties = [_party(1, "14A"), _party(2, "14B"), _party(3, "20F")]
    assignment = {10: "14B", 20: "14A", 30: "20F"}
    cycles = decompose(parties, assignment, {1: 60, 2: 40, 3: 0})

    assert len(cycles) == 1
    assert 3 not in cycles[0].party_ids


def test_every_cycle_is_closed():
    parties = [_party(1, "14A"), _party(2, "14B"), _party(3, "14C")]
    assignment = {10: "14B", 20: "14C", 30: "14A"}
    for cycle in decompose(parties, assignment, {1: 30, 2: 30, 3: 30}):
        assert {m.from_seat for m in cycle.moves} == {m.to_seat for m in cycle.moves}


def test_validate_rejects_an_open_cycle():
    """Guard against a future refactor producing a cycle that leaks a seat."""
    broken = Cycle(
        index=0,
        party_ids=[1, 2],
        moves=[Move(1, 1, "14A", "14B"), Move(2, 2, "14B", "99Z")],
        party_gains={1: 10, 2: 10},
    )
    with pytest.raises(AssertionError, match="not closed"):
        validate(broken, {})


def test_validate_rejects_a_lone_party():
    lone = Cycle(index=0, party_ids=[1], moves=[], party_gains={1: 10})
    with pytest.raises(AssertionError, match="single party"):
        validate(lone, {})


def test_describe_is_readable():
    parties = [_party(1, "14A"), _party(2, "14B")]
    assignment = {10: "14B", 20: "14A"}
    cycle = decompose(parties, assignment, {1: 60, 2: 40})[0]
    text = describe(cycle, {1: "Anna", 2: "Ben"})
    assert "Anna 14A -> 14B" in text
    assert "Ben 14B -> 14A" in text
    assert "+100" in text
