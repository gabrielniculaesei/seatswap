"""One match run over one flight (CLAUDE.md §14).

This is the entry point the worker will call for a `match_run` job, and it is
where the two scheduling rules from the spec live:

* an **immediate** run fires only if every party involved reaches its theoretical
  best, otherwise the result is thrown away and we wait - proposing the first
  decent two-way swap burns a seat that ten minutes later could have made a much
  better three-way chain;
* a **scheduled** run (T-20h, T-12h, T-4h) emits the best it has.

It also solves in rounds rather than once. A single uncapped solve maximises total
welfare, but on a busy flight it returns one rotation involving twenty parties -
and a proposal is atomic, so all twenty have to accept. Capping the movers per
round and re-solving over the parties left untouched turns that into several
genuinely independent proposals, each small enough to actually close. The cost in
total utility is real and is measured in docs/liquidity.md.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace

from cycles import Cycle, decompose
from model import Party, SolveConfig, SolveResult, solve
from seatmap import SeatMap
from utility import max_theoretical_utility, party_utility

#: Parties per proposal. Four is already a chain no cabin conversation could reach,
#: while still only needing four people to say yes.
DEFAULT_MAX_PARTIES_PER_PROPOSAL = 4

#: Stop after this many rounds even if gains remain; a match run is a background
#: job, not a search for the last point of utility.
DEFAULT_MAX_ROUNDS = 6


@dataclass
class MatchRunResult:
    trigger: str
    cycles: list[Cycle] = field(default_factory=list)
    #: member id -> seat, across every round. Unmoved members map to their own seat.
    assignment: dict[int, str] = field(default_factory=dict)
    party_gains: dict[int, int] = field(default_factory=dict)
    total_gain: int = 0
    rounds: int = 0
    #: Per-round solver stats, stored as-is in match_runs.solver_stats.
    stats: list[dict] = field(default_factory=list)
    #: Set when an immediate run found something but held it back.
    withheld: bool = False

    @property
    def emitted(self) -> bool:
        return bool(self.cycles)


def at_theoretical_best(
    party: Party, assignment: dict[int, str], seat_map: SeatMap
) -> bool:
    """Is this party doing as well as it possibly could on this aircraft?

    Used by the immediate-run rule. The bound ignores what other people hold, so
    it is genuinely "the best seat(s) this party could ever want", not "the best
    currently available".
    """
    seats = [assignment[m.id] for m in party.members]
    achieved = party_utility(seats, party.weights, seat_map)
    return achieved >= max_theoretical_utility(party.size, party.weights, seat_map)


def run_match(
    parties: list[Party],
    seat_map: SeatMap,
    config: SolveConfig | None = None,
    trigger: str = "scheduled",
    max_parties_per_proposal: int = DEFAULT_MAX_PARTIES_PER_PROPOSAL,
    max_rounds: int = DEFAULT_MAX_ROUNDS,
) -> MatchRunResult:
    """Solve a flight in capped rounds and return the proposals to send.

    `trigger` is 'immediate', 'scheduled' or 'manual', matching match_runs.trigger.
    """
    config = config or SolveConfig()
    result = MatchRunResult(trigger=trigger)
    if not parties:
        return result

    by_id = {p.id: p for p in parties}
    assignment = {m.id: m.current_seat.strip().upper() for p in parties for m in p.members}
    remaining = list(parties)
    round_config = replace(config, max_moved_parties=max_parties_per_proposal)

    for _ in range(max_rounds):
        if len(remaining) < 2:
            break

        solved: SolveResult = solve(remaining, seat_map, round_config)
        result.stats.append(solved.stats)
        result.rounds += 1
        if not solved.feasible or solved.total_gain <= 0:
            break

        cycles = decompose(remaining, solved.assignment, solved.party_gains)
        if not cycles:
            break

        moved_party_ids = set()
        for cycle in cycles:
            result.cycles.append(cycle)
            moved_party_ids.update(cycle.party_ids)
            for move in cycle.moves:
                assignment[move.member_id] = move.to_seat
            for party_id, gain in cycle.party_gains.items():
                result.party_gains[party_id] = gain

        # Parties committed to a cycle are out of the pool; their seats went with
        # them. Everyone untouched keeps the seat they had and plays the next round.
        remaining = [p for p in remaining if p.id not in moved_party_ids]

    # Re-index cycles across rounds so proposal.cycle_index is unique per run.
    result.cycles.sort(key=lambda c: (-c.total_gain, c.party_ids))
    for index, cycle in enumerate(result.cycles):
        cycle.index = index

    result.assignment = assignment
    result.total_gain = sum(result.party_gains.values())

    # ---- the immediate-run rule ---------------------------------------------
    # Do not spend a seat on a mediocre match minutes before a better chain could
    # have formed. Only fire straight away if nobody involved could do better.
    if trigger == "immediate" and result.cycles:
        everyone_maxed = all(
            at_theoretical_best(by_id[party_id], assignment, seat_map)
            for cycle in result.cycles
            for party_id in cycle.party_ids
        )
        if not everyone_maxed:
            return MatchRunResult(
                trigger=trigger,
                rounds=result.rounds,
                stats=result.stats,
                withheld=True,
            )

    return result
