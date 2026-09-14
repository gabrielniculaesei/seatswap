"""Decompose a solution into independent, atomic swap cycles (CLAUDE.md §14).

The optimum is a permutation of the pool, and every permutation decomposes into
disjoint cycles. Each cycle is self-contained: the seats it releases are exactly
the seats it takes. That is what lets one group accept while another declines
without the whole solution collapsing - and it is the part that is worth showing
in a demo, because a three-party rotation is a trade nobody could have negotiated
in the cabin.
"""

from __future__ import annotations

from dataclasses import dataclass

from model import Party


@dataclass(frozen=True)
class Move:
    member_id: int
    party_id: int
    from_seat: str
    to_seat: str


@dataclass
class Cycle:
    index: int
    party_ids: list[int]
    moves: list[Move]
    party_gains: dict[int, int]
    total_gain: int = 0
    #: Number of parties in the rotation. 2 is a plain swap, 3+ is a chain.
    @property
    def length(self) -> int:
        return len(self.party_ids)


class _DisjointSet:
    def __init__(self) -> None:
        self.parent: dict[int, int] = {}

    def find(self, item: int) -> int:
        self.parent.setdefault(item, item)
        root = item
        while self.parent[root] != root:
            root = self.parent[root]
        while self.parent[item] != root:  # path compression
            self.parent[item], item = root, self.parent[item]
        return root

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[max(ra, rb)] = min(ra, rb)


def decompose(
    parties: list[Party],
    assignment: dict[int, str],
    party_gains: dict[int, int],
) -> list[Cycle]:
    """Split an assignment into one Cycle per weakly connected component.

    Parties that keep every seat they had are left out entirely: they are not part
    of any trade and must never be shown a proposal.
    """
    by_id = {p.id: p for p in parties}
    seat_owner: dict[str, int] = {}
    for party in parties:
        for member in party.members:
            seat_owner[_norm(member.current_seat)] = party.id

    moves_by_party: dict[int, list[Move]] = {}
    groups = _DisjointSet()

    for party in parties:
        for member in party.members:
            source = _norm(member.current_seat)
            target = _norm(assignment[member.id])
            if source == target:
                continue
            moves_by_party.setdefault(party.id, []).append(
                Move(member.id, party.id, source, target)
            )
            # p -> q: a member of p takes a seat q currently holds
            previous_owner = seat_owner[target]
            if previous_owner != party.id:
                groups.union(party.id, previous_owner)

    # A party that gave a seat away but received nothing new cannot exist in a
    # permutation of a fixed pool, so every touched party has at least one move.
    components: dict[int, list[int]] = {}
    for party_id in moves_by_party:
        components.setdefault(groups.find(party_id), []).append(party_id)

    cycles: list[Cycle] = []
    for member_ids in components.values():
        party_ids = sorted(member_ids)
        moves = sorted(
            (m for pid in party_ids for m in moves_by_party[pid]),
            key=lambda m: (m.party_id, m.member_id),
        )
        gains = {pid: party_gains[pid] for pid in party_ids}
        cycles.append(
            Cycle(
                index=0,
                party_ids=party_ids,
                moves=moves,
                party_gains=gains,
                total_gain=sum(gains.values()),
            )
        )

    # Best trade first: if a flight produces several, that is the order to notify in.
    cycles.sort(key=lambda c: (-c.total_gain, c.party_ids))
    for index, cycle in enumerate(cycles):
        cycle.index = index

    for cycle in cycles:
        validate(cycle, by_id)
    return cycles


def validate(cycle: Cycle, by_id: dict[int, Party]) -> None:
    """A cycle must be closed: seats released == seats received.

    If this ever fails, accepting one cycle while rejecting another would strand
    somebody in a seat that no longer exists in their proposal.
    """
    released = {m.from_seat for m in cycle.moves}
    received = {m.to_seat for m in cycle.moves}
    if released != received:
        raise AssertionError(
            f"cycle {cycle.index} is not closed: "
            f"releases {sorted(released)}, receives {sorted(received)}"
        )
    if len(cycle.party_ids) < 2:
        raise AssertionError(
            f"cycle {cycle.index} has a single party; a party cannot trade with itself"
        )
    for party_id in cycle.party_ids:
        if cycle.party_gains[party_id] < 0:
            raise AssertionError(f"cycle {cycle.index} makes party {party_id} worse off")


def describe(cycle: Cycle, names: dict[int, str] | None = None) -> str:
    """One-line human summary, for logs and for the Telegram message."""
    names = names or {}
    parts = [
        f"{names.get(m.party_id, f'party {m.party_id}')} {m.from_seat} -> {m.to_seat}"
        for m in cycle.moves
    ]
    return f"cycle #{cycle.index} (+{cycle.total_gain}): " + ", ".join(parts)


def _norm(seat: str) -> str:
    return seat.strip().upper()
