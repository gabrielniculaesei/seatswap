"""The job queue (CLAUDE.md §4).

Postgres is the queue. `FOR UPDATE SKIP LOCKED` lets several workers pull from the
same table without blocking each other or handing the same job to two of them, and
it costs one index. No Redis, no Celery, one fewer thing to run and to explain.

A job is claimed inside a transaction: the row is locked, marked running, and the
attempt counter is bumped in the same statement. If the worker dies mid-job the
row stays `running` and is picked up again by the reaper after `STALE_AFTER`.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timedelta

import psycopg

#: Job types, mirroring the CHECK constraint in 0001_init.sql.
JOB_TYPES = (
    "verify_flight",
    "checkin_reminder",
    "match_run",
    "expire_proposals",
    "purge_flight",
)

#: Give up after this many attempts and leave the row as 'failed' for inspection.
MAX_ATTEMPTS = 5

#: A job still 'running' after this long is assumed to belong to a dead worker.
STALE_AFTER = timedelta(minutes=15)


@dataclass(frozen=True)
class Job:
    id: int
    type: str
    payload: dict
    attempts: int

    @property
    def flight_id(self) -> int | None:
        value = self.payload.get("flight_id")
        return int(value) if value is not None else None


def enqueue(
    cursor: psycopg.Cursor,
    job_type: str,
    payload: dict | None = None,
    run_after: datetime | None = None,
) -> int | None:
    """Add a job. Returns None if an identical job is already waiting.

    De-duplication is a partial unique index on (type, payload) for queued rows,
    so two API requests racing to schedule the same flight's match run produce one
    job rather than two. `ON CONFLICT DO NOTHING` makes that silent rather than an
    error, because a duplicate is a non-event, not a failure.
    """
    if job_type not in JOB_TYPES:
        raise ValueError(f"unknown job type {job_type!r}")

    cursor.execute(
        """
        INSERT INTO jobs (type, payload, run_after)
        VALUES (%s, %s, COALESCE(%s, now()))
        ON CONFLICT DO NOTHING
        RETURNING id
        """,
        (job_type, json.dumps(payload or {}), run_after),
    )
    row = cursor.fetchone()
    return row["id"] if row else None


def claim(
    cursor: psycopg.Cursor,
    worker_id: str,
    types: tuple[str, ...] | None = None,
) -> Job | None:
    """Take the next due job, or None if there is nothing to do.

    SKIP LOCKED is the whole trick: a second worker running this statement at the
    same moment steps over the row this one has locked instead of waiting for it.
    """
    cursor.execute(
        """
        WITH next AS (
            SELECT id
              FROM jobs
             WHERE status = 'queued'
               AND run_after <= now()
               AND (%(types)s::text[] IS NULL OR type = ANY(%(types)s::text[]))
             ORDER BY run_after, id
             FOR UPDATE SKIP LOCKED
             LIMIT 1
        )
        UPDATE jobs
           SET status = 'running',
               locked_at = now(),
               locked_by = %(worker)s,
               attempts = jobs.attempts + 1
          FROM next
         WHERE jobs.id = next.id
        RETURNING jobs.id, jobs.type, jobs.payload, jobs.attempts
        """,
        {"types": list(types) if types else None, "worker": worker_id},
    )
    row = cursor.fetchone()
    if row is None:
        return None
    return Job(id=row["id"], type=row["type"], payload=row["payload"], attempts=row["attempts"])


def complete(cursor: psycopg.Cursor, job_id: int) -> None:
    cursor.execute(
        "UPDATE jobs SET status = 'done', last_error = NULL, locked_by = NULL WHERE id = %s",
        (job_id,),
    )


def fail(cursor: psycopg.Cursor, job_id: int, error: str, attempts: int) -> None:
    """Reschedule with exponential backoff, or give up after MAX_ATTEMPTS.

    The backoff is deliberately coarse - 1, 2, 4, 8 minutes. Everything this
    worker talks to is either the database or a third-party API having a bad day,
    and neither is helped by retrying hard.
    """
    if attempts >= MAX_ATTEMPTS:
        cursor.execute(
            "UPDATE jobs SET status = 'failed', last_error = %s, locked_by = NULL WHERE id = %s",
            (error[:2000], job_id),
        )
        return

    delay = timedelta(minutes=2 ** (attempts - 1))
    cursor.execute(
        """
        UPDATE jobs
           SET status = 'queued',
               last_error = %s,
               locked_by = NULL,
               locked_at = NULL,
               run_after = now() + %s
         WHERE id = %s
        """,
        (error[:2000], delay, job_id),
    )


def release_stale(cursor: psycopg.Cursor, stale_after: timedelta = STALE_AFTER) -> int:
    """Requeue jobs left 'running' by a worker that died. Returns how many."""
    cursor.execute(
        """
        UPDATE jobs
           SET status = 'queued', locked_by = NULL, locked_at = NULL
         WHERE status = 'running'
           AND locked_at < now() - %s
        """,
        (stale_after,),
    )
    return cursor.rowcount


def schedule_flight_jobs(
    cursor: psycopg.Cursor,
    flight_id: int,
    checkin_opens_utc: datetime | None,
    scheduled_departure_utc: datetime | None,
) -> list[int]:
    """Queue the whole lifecycle of a flight once its times are known.

    Called by verify_flight. The scheduled match runs are the ones that matter:
    T-20h, T-12h and T-4h, when the pool is deep enough to be worth solving
    (CLAUDE.md §14).
    """
    queued = []
    if checkin_opens_utc is not None:
        job_id = enqueue(
            cursor, "checkin_reminder", {"flight_id": flight_id}, checkin_opens_utc
        )
        if job_id:
            queued.append(job_id)

    if scheduled_departure_utc is not None:
        for hours in (20, 12, 4):
            run_at = scheduled_departure_utc - timedelta(hours=hours)
            job_id = enqueue(
                cursor,
                "match_run",
                {"flight_id": flight_id, "trigger": "scheduled", "hours_before": hours},
                run_at,
            )
            if job_id:
                queued.append(job_id)

        # GDPR: everything personal about this flight goes 24h after departure.
        job_id = enqueue(
            cursor,
            "purge_flight",
            {"flight_id": flight_id},
            scheduled_departure_utc + timedelta(hours=24),
        )
        if job_id:
            queued.append(job_id)

    return queued
