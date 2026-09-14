"""The utility function exists twice, in TypeScript and in Python. This proves
they agree (CLAUDE.md §12).

If they ever drift, the UI shows a user a gain the solver did not optimise for,
which is the one bug in this project that would be invisible until somebody is
standing in an aisle arguing about it.
"""

from __future__ import annotations

import json
import random
import shutil
import subprocess
from pathlib import Path

import pytest

from seatmap import load_seat_map, seat_map_keys
from utility import (
    PreferenceWeights,
    max_theoretical_utility,
    party_utility,
    seat_utility,
)
from seatmap import (
    are_adjacent,
    contiguous_blocks,
    front_score,
    is_aisle,
    is_middle,
    is_window,
    near_lavatory,
    seat_exists,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
HARNESS = REPO_ROOT / "web" / "scripts" / "utility-check.ts"

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None or not HARNESS.exists(),
    reason="node is required to run the TypeScript side of the comparison",
)


def _run_harness(batch: dict) -> dict:
    process = subprocess.run(
        ["node", str(HARNESS)],
        input=json.dumps(batch),
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
        timeout=120,
    )
    if process.returncode != 0:
        pytest.fail(f"TypeScript harness failed:\n{process.stderr}")
    return json.loads(process.stdout)


def _weights_to_ts(w: PreferenceWeights) -> dict:
    return {
        "wWindow": w.w_window,
        "wAisle": w.w_aisle,
        "wFront": w.w_front,
        "wAvoidMiddle": w.w_avoid_middle,
        "wAvoidLavatory": w.w_avoid_lavatory,
        "wAdjacency": w.w_adjacency,
    }


def _sample_weights(rng: random.Random) -> PreferenceWeights:
    return PreferenceWeights(
        w_window=rng.choice([0, 60]),
        w_aisle=rng.choice([0, 60]),
        w_front=rng.choice([0, 30]),
        w_avoid_middle=rng.choice([0, 40]),
        w_avoid_lavatory=rng.choice([0, 25]),
        w_adjacency=rng.choice([0, 40, 200]),
    )


def _map_keys() -> list[str | None]:
    return [*seat_map_keys(), None, "UnknownType"]


def test_seat_level_agreement():
    """Every seat of every configured layout, against a spread of weight vectors."""
    rng = random.Random(4242)
    cases = []
    for map_key in _map_keys():
        seat_map = load_seat_map(map_key)
        weight_sets = [_sample_weights(rng) for _ in range(4)]
        for seat in seat_map.all_seats():
            for weights in weight_sets:
                cases.append({"mapKey": map_key, "seat": seat, "weights": weights})

    # Plus deliberately malformed input: both sides must score it 0, not crash.
    for junk in ["", "A14", "14", "999Z", "  ", "14a "]:
        cases.append({"mapKey": "B738", "seat": junk, "weights": _sample_weights(rng)})

    payload = [
        {"mapKey": c["mapKey"], "seat": c["seat"], "weights": _weights_to_ts(c["weights"])}
        for c in cases
    ]
    ts = _run_harness({"seatCases": payload})["seatResults"]
    assert len(ts) == len(cases)

    for case, ts_result in zip(cases, ts):
        seat_map = load_seat_map(case["mapKey"])
        seat, weights = case["seat"], case["weights"]
        label = f"{case['mapKey']} {seat!r} {weights}"
        assert seat_utility(seat, weights, seat_map) == ts_result["utility"], label
        assert is_window(seat, seat_map) == ts_result["isWindow"], label
        assert is_aisle(seat, seat_map) == ts_result["isAisle"], label
        assert is_middle(seat, seat_map) == ts_result["isMiddle"], label
        assert front_score(seat, seat_map) == ts_result["frontScore"], label
        assert near_lavatory(seat, seat_map) == ts_result["nearLavatory"], label
        assert seat_exists(seat, seat_map) == ts_result["seatExists"], label


def test_party_level_agreement():
    """Whole assignments, including the adjacency bonus and aisle-straddling sets."""
    rng = random.Random(99)
    cases = []
    for map_key in _map_keys():
        seat_map = load_seat_map(map_key)
        seats = seat_map.all_seats()
        for _ in range(200):
            size = rng.randint(1, 4)
            chosen = rng.sample(seats, size)
            cases.append(
                {"mapKey": map_key, "seats": chosen, "weights": _sample_weights(rng)}
            )
        # Hand-picked shapes that the random sampler would rarely produce.
        for chosen in (
            ["14A", "14B"],
            ["14C", "14D"],      # straddles the aisle: must NOT count as adjacent
            ["14A", "14B", "14C"],
            ["14B", "14C", "14D"],
            ["14A", "14A"],      # duplicate
            ["14A", "junk"],     # unparseable
            [],                  # empty
        ):
            cases.append(
                {"mapKey": map_key, "seats": chosen, "weights": _sample_weights(rng)}
            )

    payload = [
        {"mapKey": c["mapKey"], "seats": c["seats"], "weights": _weights_to_ts(c["weights"])}
        for c in cases
    ]
    ts = _run_harness({"partyCases": payload})["partyResults"]
    assert len(ts) == len(cases)

    for case, ts_result in zip(cases, ts):
        seat_map = load_seat_map(case["mapKey"])
        seats, weights = case["seats"], case["weights"]
        label = f"{case['mapKey']} {seats} {weights}"
        assert party_utility(seats, weights, seat_map) == ts_result["utility"], label
        assert are_adjacent(seats, seat_map) == ts_result["adjacent"], label


def test_block_enumeration_agreement():
    """The candidate adjacency blocks feed the CP-SAT constraints directly, so the
    two sides must enumerate them identically, in the same order."""
    rng = random.Random(7)
    cases = []
    for map_key in _map_keys():
        seat_map = load_seat_map(map_key)
        seats = seat_map.all_seats()
        for size in (1, 2, 3, 4):
            for _ in range(10):
                pool = rng.sample(seats, rng.randint(1, min(40, len(seats))))
                cases.append({"mapKey": map_key, "pool": pool, "size": size})
            cases.append({"mapKey": map_key, "pool": seats, "size": size})

    ts = _run_harness({"blockCases": cases})["blockResults"]
    assert len(ts) == len(cases)

    for case, ts_blocks in zip(cases, ts):
        seat_map = load_seat_map(case["mapKey"])
        python_blocks = contiguous_blocks(case["pool"], case["size"], seat_map)
        assert python_blocks == ts_blocks, f"{case['mapKey']} size={case['size']}"


def test_theoretical_bound_agreement():
    """The bound gates whether an immediate run fires, so a mismatch would make
    the UI and the worker disagree about whether a match is good enough to send."""
    rng = random.Random(1234)
    cases = []
    for map_key in _map_keys():
        for size in range(1, 7):
            for _ in range(12):
                cases.append(
                    {"mapKey": map_key, "size": size, "weights": _sample_weights(rng)}
                )

    payload = [
        {"mapKey": c["mapKey"], "size": c["size"], "weights": _weights_to_ts(c["weights"])}
        for c in cases
    ]
    ts = _run_harness({"boundCases": payload})["boundResults"]
    assert len(ts) == len(cases)

    for case, ts_value in zip(cases, ts):
        seat_map = load_seat_map(case["mapKey"])
        python_value = max_theoretical_utility(case["size"], case["weights"], seat_map)
        assert python_value == ts_value, f"{case['mapKey']} size={case['size']}"
