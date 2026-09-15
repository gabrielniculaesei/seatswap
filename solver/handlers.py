"""The five job handlers (CLAUDE.md §6).

Each takes an open cursor and a Job and returns a small dict that the worker logs.
Each runs inside one transaction owned by the worker: raise and the whole job is
rolled back and retried, return and it is committed together with the job being
marked done. That is the entire error model, and it is the reason the queue lives
in the same database as the data.

Telegram calls are the one exception. They cannot be rolled back, so they happen
*after* the database work and can never fail a job: an unannounced proposal is
recoverable, a rolled-back match run is wasted work.
"""

from __future__ import annotations

import logging
import os
from datetime import timedelta

import aerodatabox
import jobs as job_queue
import repository
import telegram
from cycles import Cycle
from jobs import Job
from match_run import run_match
from model import SolveConfig
from seatmap import load_seat_map

log = logging.getLogger(__name__)

#: How often the sweeper re-queues itself.
EXPIRE_INTERVAL = timedelta(minutes=10)


def _solve_config() -> SolveConfig:
    return SolveConfig(
        min_gain=int(os.environ.get("MIN_GAIN", "20")),
        max_seconds=float(os.environ.get("SOLVER_MAX_SECONDS", "10")),
    )


def _base_url() -> str:
    return os.environ.get("PUBLIC_BASE_URL", "http://localhost:3000").rstrip("/")


# --------------------------------------------------------------- verify_flight
def verify_flight(cursor, job: Job) -> dict:
    """Fill in route, aircraft and times from AeroDataBox, then schedule the rest.

    One call per flight, ever (CLAUDE.md §11). If the answer is unusable the row
    stays 'unknown' and the flight still works with an estimated seat map — the
    user must never be blocked by a third party having a bad day.
    """
    flight_id = job.flight_id
    flight = repository.load_flight(cursor, flight_id)
    if flight is None:
        return {"skipped": "flight no longer exists", "flight_id": flight_id}

    info = aerodatabox.lookup(flight.carrier, flight.flight_number, flight.departure_date)

    if info.scheduled_departure_utc is not None:
        checkin = aerodatabox.checkin_opens(flight.carrier, info.scheduled_departure_utc)
        anchor = info.scheduled_departure_utc
        purge_at = None  # departure + 24h, the normal rule
    else:
        # No time from the API: estimate from the date, or this flight would
        # never get a reminder, a match run or — worst — a purge.
        estimate = aerodatabox.estimated_schedule(flight.carrier, flight.departure_date)
        checkin = estimate.checkin_opens_utc
        anchor = estimate.anchor_utc
        purge_at = estimate.purge_utc

    cursor.execute(
        """
        UPDATE flights
           SET origin = COALESCE(%s, origin),
               destination = COALESCE(%s, destination),
               aircraft_type = COALESCE(%s, aircraft_type),
               seat_map_key = COALESCE(%s, seat_map_key),
               scheduled_departure_utc = COALESCE(%s, scheduled_departure_utc),
               checkin_opens_utc = COALESCE(%s, checkin_opens_utc),
               api_status = %s,
               api_verified_at = now()
         WHERE id = %s
        """,
        (
            info.origin,
            info.destination,
            info.aircraft_type,
            info.seat_map_key,
            info.scheduled_departure_utc,
            checkin,
            info.status,
            flight_id,
        ),
    )

    # scheduled_departure_utc above stays NULL when estimated: it is shown to
    # users and put in structured data, and a guess must not pass for a fact.
    queued = job_queue.schedule_flight_jobs(cursor, flight_id, checkin, anchor, purge_at=purge_at)
    return {
        "flight_id": flight_id,
        "api_status": info.status,
        "seat_map_key": info.seat_map_key,
        "jobs_scheduled": len(queued),
    }


# ------------------------------------------------------------ checkin_reminder
def checkin_reminder(cursor, job: Job) -> dict:
    """Ask everyone registered on this flight for their seats.

    This message is the hinge of the whole two-phase design (CLAUDE.md §7): the
    user signed up weeks ago in a calm moment, and inside the 24-hour window all
    that is left is ten seconds of typing in answer to a message they expect.
    """
    flight_id = job.flight_id
    flight = repository.load_flight(cursor, flight_id)
    if flight is None:
        return {"skipped": "flight no longer exists", "flight_id": flight_id}

    waiting = repository.parties_awaiting_seats(cursor, flight_id)
    departure_date = flight.departure_date.isoformat()
    text = telegram.format_checkin_reminder(
        flight.designator,
        departure_date,
        f"{_base_url()}/f/{flight.carrier}-{flight.flight_number}/{departure_date}",
        # No departure time means the reminder was scheduled from an estimate.
        estimated=flight.scheduled_departure_utc is None,
    )

    sent = 0
    for party in waiting:
        message = telegram.send_message(party["telegram_user_id"], text)
        sent += 1 if message.delivered or not telegram.enabled() else 0

    return {"flight_id": flight_id, "parties_reminded": len(waiting), "sent": sent}


# ------------------------------------------------------------------- match_run
def match_run(cursor, job: Job) -> dict:
    """Solve one flight and write out the proposals.

    The interesting part is not the solve, it is deciding whether to emit. A
    proposal already on the table is a commitment somebody is thinking about; we
    only replace it with something strictly better for every party it touches, and
    never at all if somebody has already accepted it.
    """
    flight_id = job.flight_id
    trigger = job.payload.get("trigger", "scheduled")

    flight = repository.load_flight(cursor, flight_id)
    if flight is None:
        return {
            "skipped": "flight no longer exists",
            "flight_id": flight_id,
            "cycles_found": 0,
            "proposals_sent": 0,
        }

    parties = repository.load_active_parties(cursor, flight_id)
    run_id = repository.start_match_run(cursor, flight_id, trigger)

    if len(parties) < 2:
        # Nothing to trade with. Still record the run: a flight that keeps coming
        # up empty is the signal that its marketing is not working.
        repository.finish_match_run(cursor, run_id, "done", {"parties": len(parties)})
        return {
            "flight_id": flight_id,
            "match_run_id": run_id,
            "parties": len(parties),
            "cycles_found": 0,
            "proposals_sent": 0,
            "withheld": False,
        }

    seat_map = load_seat_map(flight.seat_map_key)
    result = run_match(parties, seat_map, _solve_config(), trigger=trigger)

    stats = {
        "trigger": trigger,
        "parties": len(parties),
        "rounds": result.rounds,
        "cycles": len(result.cycles),
        "total_gain": result.total_gain,
        "withheld": result.withheld,
        "solver": result.stats,
    }

    emitted = _emit_proposals(cursor, run_id, flight_id, result.cycles)
    repository.finish_match_run(cursor, run_id, "done", stats)

    _announce(cursor, flight, emitted)

    return {
        "flight_id": flight_id,
        "match_run_id": run_id,
        "parties": len(parties),
        "cycles_found": len(result.cycles),
        "proposals_sent": len(emitted),
        "withheld": result.withheld,
    }


def _emit_proposals(cursor, run_id: int, flight_id: int, cycles: list[Cycle]) -> list[int]:
    """Write the cycles worth writing, superseding what they beat."""
    if not cycles:
        return []

    already_offered = repository.pending_gains(cursor, flight_id)
    untouchable = repository.parties_with_an_acceptance(cursor, flight_id)

    emitted = []
    for cycle in cycles:
        # Never pull the rug from under somebody who has already said yes.
        if untouchable & set(cycle.party_ids):
            continue

        # Only replace a live offer if every party it touches does strictly better.
        overlapping = [pid for pid in cycle.party_ids if pid in already_offered]
        if overlapping and not all(
            cycle.party_gains[pid] > already_offered[pid] for pid in overlapping
        ):
            continue

        repository.supersede_proposals_for(cursor, overlapping)
        emitted.append(repository.store_proposal(cursor, run_id, flight_id, cycle))

    return emitted


def _announce(cursor, flight, proposal_ids: list[int]) -> None:
    """Message every party in every new proposal. Outside the database work."""
    for proposal_id in proposal_ids:
        targets = repository.telegram_targets(cursor, proposal_id)
        cursor.execute(
            """
            SELECT pa.member_id, pa.from_seat, pa.to_seat, m.party_id
              FROM proposal_assignments pa
              JOIN members m ON m.id = pa.member_id
             WHERE pa.proposal_id = %s
            """,
            (proposal_id,),
        )
        moves = cursor.fetchall()

        names = {t["party_id"]: t["display_name"] for t in targets}
        for target in targets:
            mine = [
                (row["from_seat"], row["to_seat"])
                for row in moves
                if row["party_id"] == target["party_id"]
            ]
            if not mine:
                continue
            others = [n for pid, n in names.items() if pid != target["party_id"]]
            telegram.send_message(
                target["telegram_user_id"],
                telegram.format_proposal(
                    flight.designator,
                    flight.departure_date.isoformat(),
                    mine,
                    others,
                    target["gain"],
                    len(targets),
                ),
                telegram.accept_reject_keyboard(proposal_id),
            )


# ------------------------------------------------------------ expire_proposals
def expire_proposals(cursor, job: Job) -> dict:
    """Time out stale proposals and put their parties back in the pool.

    Re-queues itself, so the sweeper keeps running without a cron entry. Anything
    freed here gets picked up by the next scheduled match run.

    It is also the one job guaranteed to keep running, so it carries the other
    periodic sweep: aged-out flight_creations rows (CLAUDE.md §13).
    """
    expired = repository.expire_due_proposals(cursor)
    pruned = repository.prune_flight_creations(cursor)
    job_queue.enqueue(
        cursor,
        "expire_proposals",
        {},
        _now(cursor) + EXPIRE_INTERVAL,
    )
    return {"expired": len(expired), "flight_creations_pruned": pruned}


def _now(cursor):
    cursor.execute("SELECT now() AS now")
    return cursor.fetchone()["now"]


# ---------------------------------------------------------------- purge_flight
def purge_flight(cursor, job: Job) -> dict:
    """Delete every personal trace of a flight (CLAUDE.md §13.4).

    Runs 24 hours after departure. What survives is one row in flight_stats with
    no person in it. This is not a feature to be tidied up later; it is the reason
    a stranger can be told it is safe to use this.
    """
    flight_id = job.flight_id
    summary = repository.purge_flight(cursor, flight_id)
    log.info("purged flight %s: %s", flight_id, summary)
    return {"flight_id": flight_id, **summary}


HANDLERS = {
    "verify_flight": verify_flight,
    "checkin_reminder": checkin_reminder,
    "match_run": match_run,
    "expire_proposals": expire_proposals,
    "purge_flight": purge_flight,
}
