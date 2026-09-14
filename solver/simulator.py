"""Synthetic-flight simulator (CLAUDE.md §15).

Answers the only question that matters before there are users: at what
participation rate does this product start working?

It generates realistic flights, sweeps the share of passengers who take part from
a couple of percent up to nearly half the cabin, runs the real solver, and plots
the success rate against participation density. It also runs a deliberately
weaker baseline - swaps between two people only, the trade you could arrange by
asking the person next to you - so the value added by multi-party chains is a
measured number rather than a claim.

    python simulator.py --flights 200 --participation 0.02:0.40:0.02 \
        --out ../docs/liquidity.png

Three strategies are measured side by side:

  chains     what the product does - capped rounds, several small proposals
  unbounded  one uncapped solve: maximum welfare on paper, one huge rotation
  pairwise   the baseline: two-person swaps only, what you could arrange yourself
"""

from __future__ import annotations

import argparse
import json
import random
import statistics
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

from cycles import decompose
from match_run import DEFAULT_MAX_PARTIES_PER_PROPOSAL, run_match
from model import Member, Party, SolveConfig, solve
from seatmap import SeatMap, are_adjacent, load_seat_map
from utility import PreferenceWeights, party_utility

# ---------------------------------------------------------------------------
# Population model
#
# Party sizes follow the brief: mostly solo travellers, a quarter couples, the
# rest small groups. The solo travellers are the ones who own the seats the
# groups need, and the groups own the currency the solo travellers want.
# ---------------------------------------------------------------------------
PARTY_SIZES = [1, 2, 3, 4, 5]
PARTY_SIZE_WEIGHTS = [60, 25, 8, 5, 2]

#: "Which seat do you prefer?" for a solo traveller.
SEAT_TYPE_CHOICES = ["window", "aisle", "either"]
SEAT_TYPE_WEIGHTS = [40, 35, 25]

#: "How much does sitting together matter?" for a group.
ADJACENCY_CHOICES = [0, 40, 200]
ADJACENCY_WEIGHTS = [10, 25, 65]

#: Probability of each "Anything else?" multi-select answer.
P_AVOID_MIDDLE = 0.50
P_FRONT = 0.25
P_AVOID_LAVATORY = 0.20

#: Share of parties at each verification tier. Tier 2 is out of v1, hence zero.
TIER_CHOICES = [0, 1, 2]
TIER_WEIGHTS = [75, 25, 0]


def sample_weights(rng: random.Random, size: int) -> PreferenceWeights:
    """Draw a preference vector the way the real questionnaire would fill one in."""
    adjacency = 0
    if size >= 2:
        adjacency = rng.choices(ADJACENCY_CHOICES, weights=ADJACENCY_WEIGHTS)[0]

    seat_type = rng.choices(SEAT_TYPE_CHOICES, weights=SEAT_TYPE_WEIGHTS)[0]
    return PreferenceWeights(
        w_window=60 if seat_type == "window" else 0,
        w_aisle=60 if seat_type == "aisle" else 0,
        w_front=30 if rng.random() < P_FRONT else 0,
        w_avoid_middle=40 if rng.random() < P_AVOID_MIDDLE else 0,
        w_avoid_lavatory=25 if rng.random() < P_AVOID_LAVATORY else 0,
        w_adjacency=adjacency,
    )


def generate_flight(
    rng: random.Random, seat_map: SeatMap, participation: float
) -> list[Party]:
    """One synthetic flight at a given participation rate.

    Seats are drawn uniformly at random from the whole cabin, which is the point:
    that scattering is exactly what splits groups up in the first place.
    """
    cabin = seat_map.all_seats()
    target = max(0, min(len(cabin), round(len(cabin) * participation)))
    if target == 0:
        return []

    seats = rng.sample(cabin, target)
    parties: list[Party] = []
    cursor = 0
    party_id = 0
    member_id = 0

    while cursor < target:
        size = rng.choices(PARTY_SIZES, weights=PARTY_SIZE_WEIGHTS)[0]
        size = min(size, target - cursor)
        party_id += 1
        members = []
        for _ in range(size):
            member_id += 1
            members.append(Member(member_id, seats[cursor]))
            cursor += 1
        parties.append(
            Party(
                id=party_id,
                members=tuple(members),
                weights=sample_weights(rng, size),
                verification_tier=rng.choices(TIER_CHOICES, weights=TIER_WEIGHTS)[0],
            )
        )
    return parties


# ---------------------------------------------------------------------------
# Baseline: two-party swaps only
# ---------------------------------------------------------------------------
def pairwise_baseline(
    parties: list[Party], seat_map: SeatMap, config: SolveConfig
) -> dict[int, str]:
    """Greedy best-improving single-seat exchanges between two parties.

    This is the honest stand-in for "what you could achieve without us": you can
    ask one other passenger to trade one seat, and you do it only if you both come
    out ahead. It repeats until no improving exchange is left, so it is a strong
    version of the manual alternative, not a strawman.

    Returns member id -> seat, like the solver does.
    """
    assignment = {m.id: m.current_seat for p in parties for m in p.members}
    party_of = {m.id: p for p in parties for m in p.members}

    def utility(party: Party) -> int:
        return party_utility(
            [assignment[m.id] for m in party.members], party.weights, seat_map
        )

    current = {p.id: utility(p) for p in parties}
    member_ids = sorted(assignment)

    while True:
        best = None
        best_delta = 0
        for i, left in enumerate(member_ids):
            for right in member_ids[i + 1 :]:
                p, q = party_of[left], party_of[right]
                if p.id == q.id:
                    continue
                assignment[left], assignment[right] = assignment[right], assignment[left]
                new_p, new_q = utility(p), utility(q)
                assignment[left], assignment[right] = assignment[right], assignment[left]

                gain_p = new_p - current[p.id]
                gain_q = new_q - current[q.id]
                # Same rules the solver plays by: nobody worse off, and anyone who
                # moves has to gain at least MIN_GAIN.
                if gain_p < config.min_gain or gain_q < config.min_gain:
                    continue
                if gain_p + gain_q > best_delta:
                    best_delta = gain_p + gain_q
                    best = (left, right, p.id, q.id, new_p, new_q)
        if best is None:
            break
        left, right, pid, qid, new_p, new_q = best
        assignment[left], assignment[right] = assignment[right], assignment[left]
        current[pid], current[qid] = new_p, new_q

    return assignment


# ---------------------------------------------------------------------------
# Measurement
#
# A proposal is atomic: every party in a cycle has to accept or nothing happens.
# So raw utility overstates what a strategy delivers, and a strategy that returns
# one twenty-party rotation looks best right up until you ask twenty people to
# agree. Everything below is therefore reported twice - as found, and multiplied
# by the probability that the cycle actually closes.
# ---------------------------------------------------------------------------

#: Assumed probability that one party accepts a proposal that improves its
#: position. A guess, and flagged as one - but the comparison between strategies
#: is what matters, and that ranking is stable for any value below 1.
ACCEPTANCE_PROBABILITY = 0.9

STRATEGIES = ("chains", "unbounded", "pairwise")


@dataclass
class StrategyOutcome:
    improved_parties: int = 0
    groups_reunited: int = 0
    total_gain: int = 0
    cycle_lengths: list[int] = field(default_factory=list)
    seconds: float = 0.0
    status: str = ""

    def realisation(self, p_accept: float = ACCEPTANCE_PROBABILITY) -> float:
        """Mean probability that a proposal from this strategy actually closes."""
        if not self.cycle_lengths:
            return 0.0
        return statistics.fmean(p_accept**n for n in self.cycle_lengths)


@dataclass
class FlightOutcome:
    participation: float
    parties: int
    passengers: int
    #: Groups that want to sit together and do not already - the only ones rescuable.
    rescuable_groups: int
    results: dict[str, StrategyOutcome] = field(default_factory=dict)


def _rescuable(parties: list[Party], seat_map: SeatMap) -> list[Party]:
    return [
        p
        for p in parties
        if p.size >= 2
        and p.weights.w_adjacency > 0
        and not are_adjacent(p.current_seats, seat_map)
    ]


def _measure(
    parties: list[Party],
    assignment: dict[int, str],
    cycles_lengths: list[int],
    seat_map: SeatMap,
    rescuable: list[Party],
) -> StrategyOutcome:
    gains = {
        p.id: party_utility([assignment[m.id] for m in p.members], p.weights, seat_map)
        - party_utility(p.current_seats, p.weights, seat_map)
        for p in parties
    }
    reunited = sum(
        1
        for p in rescuable
        if are_adjacent([assignment[m.id] for m in p.members], seat_map)
    )
    return StrategyOutcome(
        improved_parties=sum(1 for g in gains.values() if g > 0),
        groups_reunited=reunited,
        total_gain=sum(gains.values()),
        cycle_lengths=list(cycles_lengths),
    )


def evaluate_flight(
    parties: list[Party],
    seat_map: SeatMap,
    config: SolveConfig,
    participation: float,
    max_parties_per_proposal: int = DEFAULT_MAX_PARTIES_PER_PROPOSAL,
) -> FlightOutcome:
    rescuable = _rescuable(parties, seat_map)
    outcome = FlightOutcome(
        participation=participation,
        parties=len(parties),
        passengers=sum(p.size for p in parties),
        rescuable_groups=len(rescuable),
    )

    # --- what the product actually does: capped rounds, small proposals --------
    started = time.perf_counter()
    run = run_match(
        parties,
        seat_map,
        config,
        trigger="scheduled",
        max_parties_per_proposal=max_parties_per_proposal,
    )
    chains = _measure(
        parties, run.assignment, [c.length for c in run.cycles], seat_map, rescuable
    )
    chains.seconds = time.perf_counter() - started
    chains.status = run.stats[0]["status"] if run.stats else "EMPTY"
    outcome.results["chains"] = chains

    # --- one uncapped solve: the welfare ceiling ------------------------------
    started = time.perf_counter()
    solved = solve(parties, seat_map, config)
    if solved.feasible:
        lengths = [
            c.length for c in decompose(parties, solved.assignment, solved.party_gains)
        ]
        unbounded = _measure(parties, solved.assignment, lengths, seat_map, rescuable)
    else:
        unbounded = StrategyOutcome()
    unbounded.seconds = time.perf_counter() - started
    unbounded.status = solved.status
    outcome.results["unbounded"] = unbounded

    # --- the baseline: two-party swaps only -----------------------------------
    started = time.perf_counter()
    baseline_assignment = pairwise_baseline(parties, seat_map, config)
    # Every baseline trade is between exactly two parties by construction.
    baseline_cycles = decompose(
        parties,
        baseline_assignment,
        {
            p.id: party_utility(
                [baseline_assignment[m.id] for m in p.members], p.weights, seat_map
            )
            - party_utility(p.current_seats, p.weights, seat_map)
            for p in parties
        },
    )
    pairwise = _measure(
        parties,
        baseline_assignment,
        [c.length for c in baseline_cycles],
        seat_map,
        rescuable,
    )
    pairwise.seconds = time.perf_counter() - started
    pairwise.status = "GREEDY"
    outcome.results["pairwise"] = pairwise

    return outcome


@dataclass
class StrategySummary:
    improved_share: float
    adjacency_success: float
    realised_adjacency_success: float
    gain_per_party: float
    realised_gain_per_party: float
    mean_cycle_length: float
    max_cycle_length: int
    mean_proposals: float
    mean_realisation: float
    p95_seconds: float


@dataclass
class LevelSummary:
    participation: float
    flights: int
    mean_parties: float
    by_strategy: dict[str, StrategySummary] = field(default_factory=dict)


def summarise(level: float, outcomes: list[FlightOutcome]) -> LevelSummary:
    parties = sum(o.parties for o in outcomes) or 1
    rescuable = sum(o.rescuable_groups for o in outcomes)

    summary = LevelSummary(
        participation=level,
        flights=len(outcomes),
        mean_parties=parties / max(1, len(outcomes)),
    )

    for name in STRATEGIES:
        results = [o.results[name] for o in outcomes]
        lengths = [n for r in results for n in r.cycle_lengths]
        times = sorted(r.seconds for r in results)
        realisations = [r.realisation() for r in results if r.cycle_lengths]
        mean_realisation = statistics.fmean(realisations) if realisations else 0.0

        reunited = sum(r.groups_reunited for r in results)
        gain = sum(r.total_gain for r in results)

        summary.by_strategy[name] = StrategySummary(
            improved_share=sum(r.improved_parties for r in results) / parties,
            adjacency_success=reunited / rescuable if rescuable else 0.0,
            realised_adjacency_success=(
                (reunited / rescuable) * mean_realisation if rescuable else 0.0
            ),
            gain_per_party=gain / parties,
            realised_gain_per_party=(gain / parties) * mean_realisation,
            mean_cycle_length=statistics.fmean(lengths) if lengths else 0.0,
            max_cycle_length=max(lengths) if lengths else 0,
            mean_proposals=statistics.fmean(len(r.cycle_lengths) for r in results),
            mean_realisation=mean_realisation,
            p95_seconds=times[int(0.95 * (len(times) - 1))] if times else 0.0,
        )
    return summary


# ---------------------------------------------------------------------------
# Plot
# ---------------------------------------------------------------------------
STYLE = {
    "chains": ("chains, capped (the product)", "o", "-"),
    "unbounded": ("one uncapped solve", "^", ":"),
    "pairwise": ("two-party swaps only", "s", "--"),
}


def plot(summaries: list[LevelSummary], out_path: Path, aircraft: str, cap: int) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    x = [s.participation * 100 for s in summaries]
    figure, axes = plt.subplots(2, 2, figsize=(13, 9))

    panels = [
        (axes[0][0], "adjacency_success", "Split groups reunited",
         "% of groups that wanted it", 100),
        (axes[0][1], "realised_adjacency_success",
         f"Reunited x P(everyone accepts), p={ACCEPTANCE_PROBABILITY}",
         "% of groups that wanted it", 100),
        (axes[1][0], "gain_per_party", "Mean utility gain per party", "points", 1),
        (axes[1][1], "realised_gain_per_party",
         f"Gain x P(everyone accepts), p={ACCEPTANCE_PROBABILITY}", "points", 1),
    ]

    for axis, attribute, title, ylabel, scale in panels:
        for name in STRATEGIES:
            label, marker, linestyle = STYLE[name]
            axis.plot(
                x,
                [getattr(s.by_strategy[name], attribute) * scale for s in summaries],
                marker=marker,
                linestyle=linestyle,
                markersize=4,
                label=label,
            )
        axis.set_title(title, fontsize=11)
        axis.set_ylabel(ylabel)
        axis.set_xlabel("participation (% of cabin)")
        axis.grid(alpha=0.3)
        axis.legend(loc="upper left", fontsize=8)
        axis.set_ylim(bottom=0)

    figure.suptitle(
        f"Seat-swap liquidity on a {aircraft}: success rate vs participation density "
        f"(cap {cap} parties per proposal)",
        fontsize=13,
    )
    figure.tight_layout()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    figure.savefig(out_path, dpi=150)
    print(f"chart written to {out_path}")


def markdown_table(summaries: list[LevelSummary], cap: int) -> str:
    """The results table as it appears in docs/liquidity.md.

    Generated rather than typed, so the documented numbers cannot drift from the
    ones the simulator last produced.
    """
    lines = [
        f"| participation | parties | reunited (chains, cap {cap}) | × P(accept) "
        f"| reunited (uncapped) | × P(accept) | reunited (pairwise) "
        f"| mean cycle | proposals/flight |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for s in summaries:
        c = s.by_strategy["chains"]
        u = s.by_strategy["unbounded"]
        w = s.by_strategy["pairwise"]
        lines.append(
            f"| {s.participation * 100:.0f} % | {s.mean_parties:.0f} "
            f"| {c.adjacency_success * 100:.1f} % | **{c.realised_adjacency_success * 100:.1f} %** "
            f"| {u.adjacency_success * 100:.1f} % | {u.realised_adjacency_success * 100:.1f} % "
            f"| {w.adjacency_success * 100:.1f} % "
            f"| {c.mean_cycle_length:.1f} | {c.mean_proposals:.1f} |"
        )
    return "\n".join(lines)


def timing_table(summaries: list[LevelSummary], cabin_seats: int) -> str:
    """Solver cost and worst-case cycle length. Seats in the pool are exact:
    generate_flight() seats round(cabin * participation) passengers."""
    lines = [
        "| participation | seats in the pool | p95 solve time (capped rounds) "
        "| longest cycle seen, uncapped |",
        "|---|---|---|---|",
    ]
    for s in summaries:
        c = s.by_strategy["chains"]
        u = s.by_strategy["unbounded"]
        lines.append(
            f"| {s.participation * 100:.0f} % | {round(cabin_seats * s.participation)} "
            f"| {c.p95_seconds:.3f} s | {u.max_cycle_length} parties |"
        )
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def parse_participation(spec: str) -> list[float]:
    """'0.02:0.40:0.02' -> [0.02, 0.04, ... 0.40]. A bare number is a single level."""
    if ":" not in spec:
        return [float(spec)]
    start, stop, step = (float(part) for part in spec.split(":"))
    if step <= 0:
        raise ValueError("participation step must be positive")
    levels = []
    value = start
    while value <= stop + 1e-9:
        levels.append(round(value, 6))
        value += step
    return levels


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--flights", type=int, default=50,
                        help="synthetic flights per participation level")
    parser.add_argument("--participation", default="0.02:0.40:0.02",
                        help="start:stop:step as a fraction of the cabin")
    parser.add_argument("--aircraft", default="B738")
    parser.add_argument("--min-gain", type=int, default=20)
    parser.add_argument("--cap", type=int, default=DEFAULT_MAX_PARTIES_PER_PROPOSAL,
                        help="max parties per proposal for the 'chains' strategy")
    parser.add_argument("--max-seconds", type=float, default=10.0)
    parser.add_argument("--seed", type=int, default=1)
    # CP-SAT's parallel portfolio matters enormously here: at 30+ seats a single
    # worker can spend 30s failing to prove optimality on an instance that the
    # 8-worker portfolio closes in 60ms. Do not lower this to chase determinism.
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--out", type=Path, default=None, help="path for the PNG chart")
    parser.add_argument("--json", type=Path, default=None, help="path for the raw summary")
    parser.add_argument("--markdown", type=Path, default=None,
                        help="path for the results tables as markdown")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv)

    seat_map = load_seat_map(args.aircraft)
    config = SolveConfig(
        min_gain=args.min_gain,
        max_seconds=args.max_seconds,
        num_workers=args.workers,
        random_seed=args.seed,
    )
    levels = parse_participation(args.participation)

    header = (
        f"{'part.':>6} {'parties':>8} | "
        f"{'reunited':>8} {'realised':>8} {'gain/p':>7} {'len':>5} {'props':>6} | "
        f"{'unbnd re.':>9} {'realised':>8} {'len':>5} | {'pair re.':>8} {'p95 s':>7}"
    )
    if not args.quiet:
        print(f"aircraft {seat_map.label}, {len(seat_map.all_seats())} seats, "
              f"{args.flights} flights/level, MIN_GAIN={args.min_gain}, cap={args.cap}, "
              f"P(accept)={ACCEPTANCE_PROBABILITY}")
        print(header)
        print("-" * len(header))

    summaries = []
    started = time.perf_counter()
    for level in levels:
        rng = random.Random(hash((args.seed, level)) & 0xFFFFFFFF)
        outcomes = []
        for _ in range(args.flights):
            parties = generate_flight(rng, seat_map, level)
            if not parties:
                continue
            outcomes.append(
                evaluate_flight(parties, seat_map, config, level, args.cap)
            )
        if not outcomes:
            continue
        summary = summarise(level, outcomes)
        summaries.append(summary)
        if not args.quiet:
            c = summary.by_strategy["chains"]
            u = summary.by_strategy["unbounded"]
            w = summary.by_strategy["pairwise"]
            print(
                f"{level*100:5.1f}% {summary.mean_parties:8.1f} | "
                f"{c.adjacency_success*100:7.1f}% {c.realised_adjacency_success*100:7.1f}% "
                f"{c.gain_per_party:7.1f} {c.mean_cycle_length:5.1f} {c.mean_proposals:6.1f} | "
                f"{u.adjacency_success*100:8.1f}% {u.realised_adjacency_success*100:7.1f}% "
                f"{u.mean_cycle_length:5.1f} | {w.adjacency_success*100:7.1f}% "
                f"{c.p95_seconds:7.3f}"
            )

    if not args.quiet:
        print(f"\ntotal wall time {time.perf_counter() - started:.1f}s")

    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps([asdict(s) for s in summaries], indent=2))
        print(f"summary written to {args.json}")
    if args.markdown:
        args.markdown.parent.mkdir(parents=True, exist_ok=True)
        args.markdown.write_text(
            markdown_table(summaries, args.cap)
            + "\n\n"
            + timing_table(summaries, len(seat_map.all_seats()))
            + "\n"
        )
        print(f"tables written to {args.markdown}")
    if args.out:
        plot(summaries, args.out, seat_map.label, args.cap)
    return 0


if __name__ == "__main__":
    sys.exit(main())
