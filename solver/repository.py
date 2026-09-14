"""Domain queries for the worker.

Everything that turns database rows into solver objects and back. Kept apart from
jobs.py so the queue stays a queue and does not learn about seats.
"""

from __future__ import annotations

import json
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta

import psycopg

from cycles import Cycle
from model import Member, Party
from utility import PreferenceWeights

#: How long a party has to answer a proposal before it expires.
PROPOSAL_TTL = timedelta(hours=3)

#: States whose parties take part in a match run. 'matched' is included on purpose:
#: a party sitting on a pending proposal can still be offered a better one
#: (CLAUDE.md §14, superseded proposals).
ACTIVE_STATES = ("seated", "matched")


@dataclass(frozen=True)
class FlightRow:
    id: int
    carrier: str
    flight_number: str
    departure_date: object
    seat_map_key: str | None
    scheduled_departure_utc: datetime | None
    checkin_opens_utc: datetime | None

    @property
    def designator(self) -> str:
        return f"{self.carrier}{self.flight_number}"


def load_flight(cursor: psycopg.Cursor, flight_id: int) -> FlightRow | None:
    cursor.execute(
        """
        SELECT id, carrier, flight_number, departure_date, seat_map_key,
               scheduled_departure_utc, checkin_opens_utc
          FROM flights
         WHERE id = %s
        """,
        (flight_id,),
    )
    row = cursor.fetchone()
    if row is None:
        return None
    return FlightRow(**row)


def load_active_parties(cursor: psycopg.Cursor, flight_id: int) -> list[Party]:
    """Parties eligible for matching, with their members' current seats.

    A party is only eligible once every member has a seat: before check-in there is
    nothing to trade. The HAVING clause enforces that in one query rather than
    filtering in Python and pretending the partial ones do not exist.
    """
    cursor.execute(
        """
        SELECT p.id,
               p.w_window, p.w_aisle, p.w_front,
               p.w_avoid_middle, p.w_avoid_lavatory, p.w_adjacency,
               p.verification_tier,
               array_agg(m.id ORDER BY m.id)           AS member_ids,
               array_agg(m.current_seat ORDER BY m.id) AS seats
          FROM parties p
          JOIN members m ON m.party_id = p.id
         WHERE p.flight_id = %s
           AND p.state = ANY(%s)
         GROUP BY p.id
        HAVING count(*) FILTER (WHERE m.current_seat IS NULL) = 0
           AND count(*) = p.size
         ORDER BY p.id
        """,
        (flight_id, list(ACTIVE_STATES)),
    )

    parties = []
    for row in cursor.fetchall():
        members = tuple(
            Member(id=member_id, current_seat=seat)
            for member_id, seat in zip(row["member_ids"], row["seats"])
        )
        parties.append(
            Party(
                id=row["id"],
                members=members,
                weights=PreferenceWeights(
                    w_window=row["w_window"],
                    w_aisle=row["w_aisle"],
                    w_front=row["w_front"],
                    w_avoid_middle=row["w_avoid_middle"],
                    w_avoid_lavatory=row["w_avoid_lavatory"],
                    w_adjacency=row["w_adjacency"],
                ),
                verification_tier=row["verification_tier"],
            )
        )
    return parties


def start_match_run(cursor: psycopg.Cursor, flight_id: int, trigger: str) -> int:
    cursor.execute(
        "INSERT INTO match_runs (flight_id, trigger) VALUES (%s, %s) RETURNING id",
        (flight_id, trigger),
    )
    return cursor.fetchone()["id"]


def finish_match_run(
    cursor: psycopg.Cursor, run_id: int, status: str, stats: dict
) -> None:
    cursor.execute(
        """
        UPDATE match_runs
           SET status = %s, finished_at = now(), solver_stats = %s
         WHERE id = %s
        """,
        (status, json.dumps(stats), run_id),
    )


def pending_gains(cursor: psycopg.Cursor, flight_id: int) -> dict[int, int]:
    """party id -> gain it is already being offered by a live proposal.

    Used to decide whether a new run actually improves on what is on the table.
    """
    cursor.execute(
        """
        SELECT pp.party_id, pp.gain
          FROM proposal_parties pp
          JOIN proposals pr ON pr.id = pp.proposal_id
         WHERE pr.flight_id = %s
           AND pr.status = 'pending'
           AND pr.expires_at > now()
        """,
        (flight_id,),
    )
    return {row["party_id"]: row["gain"] for row in cursor.fetchall()}


def parties_with_an_acceptance(cursor: psycopg.Cursor, flight_id: int) -> set[int]:
    """Parties inside a pending proposal that somebody has already accepted.

    Those proposals are left alone. Superseding a trade a person has already said
    yes to would be the one genuinely rude thing this system could do.
    """
    cursor.execute(
        """
        SELECT DISTINCT pp.party_id
          FROM proposal_parties pp
         WHERE pp.proposal_id IN (
                   SELECT pr.id
                     FROM proposals pr
                     JOIN proposal_parties x ON x.proposal_id = pr.id
                    WHERE pr.flight_id = %s
                      AND pr.status = 'pending'
                      AND x.response = 'accept'
               )
        """,
        (flight_id,),
    )
    return {row["party_id"] for row in cursor.fetchall()}


def supersede_proposals_for(cursor: psycopg.Cursor, party_ids: list[int]) -> list[int]:
    """Mark live proposals involving any of these parties as superseded."""
    if not party_ids:
        return []
    cursor.execute(
        """
        UPDATE proposals
           SET status = 'superseded'
         WHERE status = 'pending'
           AND id IN (SELECT proposal_id FROM proposal_parties WHERE party_id = ANY(%s))
        RETURNING id
        """,
        (party_ids,),
    )
    return [row["id"] for row in cursor.fetchall()]


def store_proposal(
    cursor: psycopg.Cursor,
    run_id: int,
    flight_id: int,
    cycle: Cycle,
    ttl: timedelta = PROPOSAL_TTL,
) -> int:
    """Write one cycle as a proposal, atomically with its parties and moves."""
    cursor.execute(
        """
        INSERT INTO proposals
            (match_run_id, flight_id, cycle_index, total_gain, expires_at, agreement_token)
        VALUES (%s, %s, %s, %s, now() + %s, %s)
        RETURNING id
        """,
        (
            run_id,
            flight_id,
            cycle.index,
            cycle.total_gain,
            ttl,
            # 128 random bits, hex. Not derived from anything about the flight or
            # the people in it (CLAUDE.md §13.6).
            secrets.token_hex(16),
        ),
    )
    proposal_id = cursor.fetchone()["id"]

    cursor.executemany(
        "INSERT INTO proposal_parties (proposal_id, party_id, gain) VALUES (%s, %s, %s)",
        [(proposal_id, pid, cycle.party_gains[pid]) for pid in cycle.party_ids],
    )
    cursor.executemany(
        """
        INSERT INTO proposal_assignments (proposal_id, member_id, from_seat, to_seat)
        VALUES (%s, %s, %s, %s)
        """,
        [(proposal_id, m.member_id, m.from_seat, m.to_seat) for m in cycle.moves],
    )

    cursor.execute(
        "UPDATE parties SET state = 'matched' WHERE id = ANY(%s) AND state = 'seated'",
        (cycle.party_ids,),
    )
    return proposal_id


def expire_due_proposals(cursor: psycopg.Cursor) -> list[int]:
    """Expire proposals past their deadline and free their parties."""
    cursor.execute(
        """
        UPDATE proposals
           SET status = 'expired'
         WHERE status = 'pending'
           AND expires_at <= now()
        RETURNING id
        """
    )
    expired = [row["id"] for row in cursor.fetchall()]
    if expired:
        _release_parties(cursor, expired)
    return expired


def _release_parties(cursor: psycopg.Cursor, proposal_ids: list[int]) -> None:
    """Send parties back to 'seated' unless they are held by another live proposal."""
    cursor.execute(
        """
        UPDATE parties
           SET state = 'seated'
         WHERE state = 'matched'
           AND id IN (SELECT party_id FROM proposal_parties WHERE proposal_id = ANY(%s))
           AND NOT EXISTS (
                 SELECT 1
                   FROM proposal_parties pp
                   JOIN proposals pr ON pr.id = pp.proposal_id
                  WHERE pp.party_id = parties.id
                    AND pr.status = 'pending'
               )
        """,
        (proposal_ids,),
    )


def telegram_targets(cursor: psycopg.Cursor, proposal_id: int) -> list[dict]:
    """Who to notify about a proposal, and what each of them is being offered."""
    cursor.execute(
        """
        SELECT p.telegram_user_id, p.display_name, pp.party_id, pp.gain
          FROM proposal_parties pp
          JOIN parties p ON p.id = pp.party_id
         WHERE pp.proposal_id = %s
         ORDER BY pp.party_id
        """,
        (proposal_id,),
    )
    return cursor.fetchall()


def parties_awaiting_seats(cursor: psycopg.Cursor, flight_id: int) -> list[dict]:
    """Registered parties that have not sent their seats yet."""
    cursor.execute(
        """
        SELECT id, telegram_user_id, display_name
          FROM parties
         WHERE flight_id = %s
           AND state = 'registered'
         ORDER BY id
        """,
        (flight_id,),
    )
    return cursor.fetchall()


def purge_flight(cursor: psycopg.Cursor, flight_id: int) -> dict:
    """Delete every personal trace of a flight, keeping one anonymous row.

    CLAUDE.md §13.4. The aggregate has no party, no member, no telegram id and no
    seat in it - just how many people took part and how well it went, which is
    what the README's statistics are made of.
    """
    cursor.execute(
        """
        SELECT count(*)::int                                   AS party_count,
               count(*) FILTER (WHERE state = 'settled')::int   AS matched_party_count
          FROM parties
         WHERE flight_id = %s
        """,
        (flight_id,),
    )
    counts = cursor.fetchone()

    cursor.execute(
        """
        SELECT COALESCE(avg(pp.gain), 0)::int AS avg_gain
          FROM proposal_parties pp
          JOIN proposals pr ON pr.id = pp.proposal_id
         WHERE pr.flight_id = %s
           AND pr.status = 'accepted'
        """,
        (flight_id,),
    )
    avg_gain = cursor.fetchone()["avg_gain"]

    cursor.execute(
        """
        INSERT INTO flight_stats (flight_id, party_count, matched_party_count, avg_gain)
        VALUES (%s, %s, %s, %s)
        ON CONFLICT (flight_id) DO UPDATE
           SET party_count = EXCLUDED.party_count,
               matched_party_count = EXCLUDED.matched_party_count,
               avg_gain = EXCLUDED.avg_gain,
               purged_at = now()
        """,
        (flight_id, counts["party_count"], counts["matched_party_count"], avg_gain),
    )

    # parties cascade to members, proposal_parties and proposal_assignments;
    # proposals cascade from the flight. One delete each, no orphans.
    cursor.execute("DELETE FROM parties WHERE flight_id = %s", (flight_id,))
    deleted_parties = cursor.rowcount
    cursor.execute("DELETE FROM proposals WHERE flight_id = %s", (flight_id,))
    deleted_proposals = cursor.rowcount

    return {
        "parties_deleted": deleted_parties,
        "proposals_deleted": deleted_proposals,
        "party_count": counts["party_count"],
        "avg_gain": avg_gain,
    }
