"""CP-SAT model for seat reassignment.

The optimal solution is a permutation of the seats the participating parties
already occupy. We never assign an empty seat: we do not own it and we cannot
stop the airline from selling it between now and boarding.

Two constraints carry the whole social design of the product:

  (6) individual rationality - no party is ever asked to end up worse off, which is
      why nobody is ever asking anyone for a favour;
  (7) a minimum gain for any party that actually moves - so we never shuffle
      somebody for nothing just to unlock somebody else, which would be a favour
      wearing a disguise.

And one that carries a rule of the air rather than of the product:

  (8) no child in an exit row - a party with k members under 16 holds at most
      size - k exit-row seats. A swap cabin crew would refuse at the door is not
      a swap.

All arithmetic is integer. CP-SAT does not take floats, and the "x1.05 per
verification tier" bonus from the spec is expressed as x(20 + tier)/20 by scaling
the whole objective by 20.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from ortools.sat.python import cp_model

from seatmap import SeatMap, contiguous_blocks, is_exit_row, parse_seat, seat_sort_key
from utility import PreferenceWeights, party_utility, seat_utility

#: The objective is scaled by this so the 5%-per-tier bonus stays integral.
TIER_SCALE = 20


@dataclass(frozen=True)
class Member:
    id: int
    current_seat: str


@dataclass(frozen=True)
class Party:
    id: int
    members: tuple[Member, ...]
    weights: PreferenceWeights
    verification_tier: int = 0
    #: Members under 16, who may not sit in an exit row. A count rather than a
    #: per-member flag: nobody tells us whose seat is whose, and it does not
    #: matter, because a party decides among itself who takes which seat.
    children: int = 0

    @property
    def size(self) -> int:
        return len(self.members)

    @property
    def current_seats(self) -> list[str]:
        return [m.current_seat for m in self.members]


def exit_row_allowance(party: Party, seat_map: SeatMap) -> int | None:
    """How many exit-row seats this party may end up holding; None if unlimited.

    size - children, so every child can take one of the party's other seats. But
    never less than the party holds right now: if the airline has already put a
    family in an exit row (or the seats were typed wrong), the identity
    assignment must stay feasible, or the whole flight's solve would fail over one
    party. Constraint (8) forbids making it worse, which is all we can promise.
    """
    if party.children <= 0 or not seat_map.exit_rows:
        return None
    already = sum(1 for seat in party.current_seats if is_exit_row(seat, seat_map))
    return max(party.size - party.children, already)


@dataclass(frozen=True)
class SolveConfig:
    #: Minimum utility a party must gain to be worth moving at all.
    min_gain: int = 20
    #: Small penalty per moving party: fewer people in a cycle, fewer ways it falls apart.
    tie_break: int = 1
    #: Hard cap on how many parties may move in one solve. Because every party in
    #: a cycle moves, this bounds the size of the largest cycle the solve can
    #: produce. None means uncapped, which maximises total welfare but tends to
    #: return a single flight-wide rotation that needs twenty people to all say
    #: yes - see match_run.run_match() and docs/liquidity.md.
    max_moved_parties: int | None = None
    max_seconds: float = 10.0
    num_workers: int = 8
    random_seed: int = 0
    log: bool = False


@dataclass
class SolveResult:
    status: str
    #: member id -> seat. Always a permutation of the input seats.
    assignment: dict[int, str] = field(default_factory=dict)
    #: party id -> utility delta. Zero for parties that stay put.
    party_gains: dict[int, int] = field(default_factory=dict)
    total_gain: int = 0
    stats: dict = field(default_factory=dict)

    @property
    def feasible(self) -> bool:
        return self.status in ("OPTIMAL", "FEASIBLE")

    @property
    def moved_party_ids(self) -> list[int]:
        return sorted(pid for pid, g in self.party_gains.items() if g != 0)


class SolverInputError(ValueError):
    """The pool is not a valid permutation problem. Caller has a data bug."""


def build_pool(parties: list[Party]) -> list[str]:
    """The reassignable pool: exactly the seats these parties occupy right now."""
    seats: list[str] = []
    for party in parties:
        for member in party.members:
            if parse_seat(member.current_seat) is None:
                raise SolverInputError(
                    f"member {member.id} has unparseable seat {member.current_seat!r}"
                )
            seats.append(member.current_seat.strip().upper())
    if len(set(seats)) != len(seats):
        raise SolverInputError("duplicate seat in pool; the flight-unique index should prevent this")
    return seats


def solve(
    parties: list[Party],
    seat_map: SeatMap,
    config: SolveConfig | None = None,
) -> SolveResult:
    """Find the utility-maximising permutation of the occupied seats."""
    config = config or SolveConfig()
    parties = sorted(parties, key=lambda p: p.id)

    if not parties:
        return SolveResult(status="EMPTY", stats={"parties": 0, "seats": 0})

    pool = build_pool(parties)
    seats = sorted(pool, key=lambda s: seat_sort_key(s, seat_map))
    members = [m for p in parties for m in sorted(p.members, key=lambda m: m.id)]
    seat_index = {s: i for i, s in enumerate(seats)}

    model = cp_model.CpModel()

    # ---- variables -----------------------------------------------------------
    # x[m][s] = member m gets seat s
    x: dict[int, list[cp_model.IntVar]] = {}
    for member in members:
        x[member.id] = [
            model.NewBoolVar(f"x_m{member.id}_s{seat}") for seat in seats
        ]

    # ---- (1) every member gets exactly one seat ------------------------------
    for member in members:
        model.AddExactlyOne(x[member.id])

    # ---- (2) every seat goes to at most one member ---------------------------
    for j in range(len(seats)):
        model.AddAtMostOne(x[m.id][j] for m in members)

    moved: dict[int, cp_model.IntVar] = {}
    objective_terms = []
    block_count = 0

    for party in parties:
        member_ids = [m.id for m in party.members]

        # ---- seat-quality part of U_p(new) -----------------------------------
        utility_terms = []
        for member_id in member_ids:
            for j, seat in enumerate(seats):
                coefficient = seat_utility(seat, party.weights, seat_map)
                if coefficient:
                    utility_terms.append(coefficient * x[member_id][j])

        # ---- adjacency part of U_p(new) --------------------------------------
        if party.size == 1:
            # Trivially adjacent. It cancels out of the gain, but it has to be
            # counted on both sides to stay consistent with party_utility().
            adjacency_term = party.weights.w_adjacency
        elif party.weights.w_adjacency == 0:
            # No candidate blocks needed: adjacency is worth nothing to this party.
            adjacency_term = 0
        else:
            adj = model.NewBoolVar(f"adj_p{party.id}")
            blocks = contiguous_blocks(seats, party.size, seat_map)
            block_count += len(blocks)
            block_vars = []
            for b, block in enumerate(blocks):
                y = model.NewBoolVar(f"y_p{party.id}_b{b}")
                block_vars.append(y)
                # (3) selecting a block means this party occupies every seat in it
                for seat in block:
                    j = seat_index[seat]
                    model.Add(sum(x[mid][j] for mid in member_ids) >= y)
            # (4) at most one block, and adj tracks whether one was selected
            if block_vars:
                model.Add(sum(block_vars) == adj)
            else:
                model.Add(adj == 0)
            adjacency_term = party.weights.w_adjacency * adj

        new_utility = sum(utility_terms) + adjacency_term
        current_utility = party_utility(party.current_seats, party.weights, seat_map)
        party_gain = new_utility - current_utility

        # ---- (5) moved[p] ----------------------------------------------------
        moved[party.id] = model.NewBoolVar(f"moved_p{party.id}")
        for member in party.members:
            j = seat_index[member.current_seat.strip().upper()]
            model.Add(moved[party.id] >= 1 - x[member.id][j])

        # ---- (6) individual rationality: never worse off ---------------------
        model.Add(party_gain >= 0)

        # ---- (7) if you move, you gain something worth the trouble ------------
        model.Add(party_gain >= config.min_gain * moved[party.id])

        # ---- (8) no child in an exit row -------------------------------------
        allowance = exit_row_allowance(party, seat_map)
        if allowance is not None:
            exit_seats = [j for j, seat in enumerate(seats) if is_exit_row(seat, seat_map)]
            if exit_seats:
                model.Add(
                    sum(x[mid][j] for mid in member_ids for j in exit_seats) <= allowance
                )

        tier_factor = TIER_SCALE + max(0, min(2, party.verification_tier))
        objective_terms.append(tier_factor * party_gain)

    # ---- cap on how many parties may move ------------------------------------
    # Every party in a cycle has to move, so bounding the movers bounds the length
    # of the longest cycle, which is what makes a proposal small enough to close.
    if config.max_moved_parties is not None:
        model.Add(sum(moved.values()) <= config.max_moved_parties)

    # ---- objective -----------------------------------------------------------
    model.Maximize(
        sum(objective_terms)
        - TIER_SCALE * config.tie_break * sum(moved.values())
    )

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = config.max_seconds
    solver.parameters.num_search_workers = config.num_workers
    solver.parameters.random_seed = config.random_seed
    solver.parameters.log_search_progress = config.log

    started = time.perf_counter()
    status = solver.Solve(model)
    wall_seconds = time.perf_counter() - started

    status_name = solver.StatusName(status)
    stats = {
        "status": status_name,
        "wall_seconds": round(wall_seconds, 4),
        "parties": len(parties),
        "members": len(members),
        "seats": len(seats),
        "adjacency_blocks": block_count,
        "max_moved_parties": config.max_moved_parties,
        "booleans": len(members) * len(seats) + len(moved) + block_count,
        "branches": solver.NumBranches(),
        "conflicts": solver.NumConflicts(),
    }

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        # INFEASIBLE cannot normally happen: the identity permutation always
        # satisfies (1)-(8). Treat it as "no swap today" and move on.
        return SolveResult(status=status_name, stats=stats)

    stats["objective"] = int(solver.ObjectiveValue())

    assignment: dict[int, str] = {}
    for member in members:
        for j, seat in enumerate(seats):
            if solver.Value(x[member.id][j]):
                assignment[member.id] = seat
                break

    assignment = _canonicalise_internal_swaps(parties, assignment)
    party_gains = _recompute_gains(parties, assignment, seat_map)

    _assert_sound(parties, assignment, party_gains, seats, config, seat_map)

    return SolveResult(
        status=status_name,
        assignment=assignment,
        party_gains=party_gains,
        total_gain=sum(party_gains.values()),
        stats=stats,
    )


def _canonicalise_internal_swaps(
    parties: list[Party], assignment: dict[int, str]
) -> dict[int, str]:
    """Undo permutations that only shuffle members inside their own party.

    Utility depends on the party, not on which member of it sits where, so such a
    swap is worth exactly zero and would only add confusing lines to a proposal
    ("you and your brother swap with each other"). CP-SAT is free to emit one; we
    take it back out.
    """
    canonical = dict(assignment)
    for party in parties:
        member_ids = [m.id for m in party.members]
        got = {canonical[mid] for mid in member_ids}
        if got == set(party.current_seats):
            for member in party.members:
                canonical[member.id] = member.current_seat.strip().upper()
    return canonical


def _recompute_gains(
    parties: list[Party], assignment: dict[int, str], seat_map: SeatMap
) -> dict[int, int]:
    """Gains from the final assignment via the shared utility function.

    Deliberately not read off the model: the number we show the user and store in
    the database must come from the same function the TypeScript preview uses.
    """
    gains = {}
    for party in parties:
        new_seats = [assignment[m.id] for m in party.members]
        gains[party.id] = party_utility(new_seats, party.weights, seat_map) - party_utility(
            party.current_seats, party.weights, seat_map
        )
    return gains


def _assert_sound(
    parties: list[Party],
    assignment: dict[int, str],
    party_gains: dict[int, int],
    seats: list[str],
    config: SolveConfig,
    seat_map: SeatMap,
) -> None:
    """Cheap invariants, checked on every run rather than only in tests."""
    assigned = list(assignment.values())
    if sorted(assigned) != sorted(seats):
        raise AssertionError("solution is not a permutation of the input seats")
    if len(set(assigned)) != len(assigned):
        raise AssertionError("a seat was assigned twice")
    for party in parties:
        gain = party_gains[party.id]
        if gain < 0:
            raise AssertionError(f"party {party.id} would end up worse off ({gain})")
        moved = [assignment[m.id] for m in party.members] != [
            m.current_seat.strip().upper() for m in party.members
        ]
        if moved and gain < config.min_gain:
            raise AssertionError(
                f"party {party.id} moves for only {gain} (< MIN_GAIN {config.min_gain})"
            )
        allowance = exit_row_allowance(party, seat_map)
        if allowance is not None:
            in_exit = sum(1 for m in party.members if is_exit_row(assignment[m.id], seat_map))
            if in_exit > allowance:
                raise AssertionError(
                    f"party {party.id} has {party.children} children and would hold "
                    f"{in_exit} exit-row seats (allowed {allowance})"
                )
