"""The job queue, against a real Postgres.

These tests exist because the interesting behaviour here is entirely in the
database: SKIP LOCKED, the partial unique index, transactional claiming. None of
it can be checked against a mock, and all of it fails in ways that only show up
under concurrency.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

import jobs as job_queue
from conftest import requires_db

pytestmark = requires_db


def _job_ids(cursor) -> list[int]:
    cursor.execute("SELECT id FROM jobs ORDER BY id")
    return [row["id"] for row in cursor.fetchall()]


def _status(cursor, job_id: int) -> dict:
    cursor.execute(
        "SELECT status, attempts, run_after, last_error, locked_by FROM jobs WHERE id = %s",
        (job_id,),
    )
    return cursor.fetchone()


# ------------------------------------------------------------------- enqueueing
def test_enqueue_returns_an_id(cursor):
    job_id = job_queue.enqueue(cursor, "match_run", {"flight_id": 1})
    assert job_id is not None
    assert _job_ids(cursor) == [job_id]


def test_enqueue_rejects_an_unknown_type(cursor):
    with pytest.raises(ValueError, match="unknown job type"):
        job_queue.enqueue(cursor, "launch_missiles", {})


def test_identical_queued_jobs_are_deduplicated(cursor):
    """Two requests racing to schedule the same flight must not queue it twice."""
    first = job_queue.enqueue(cursor, "match_run", {"flight_id": 7})
    second = job_queue.enqueue(cursor, "match_run", {"flight_id": 7})

    assert first is not None
    assert second is None
    assert len(_job_ids(cursor)) == 1


def test_payload_key_order_does_not_defeat_deduplication(cursor):
    """jsonb normalises key order, so these are the same job."""
    first = job_queue.enqueue(cursor, "match_run", {"flight_id": 7, "trigger": "scheduled"})
    second = job_queue.enqueue(cursor, "match_run", {"trigger": "scheduled", "flight_id": 7})
    assert first is not None and second is None


def test_different_payloads_are_different_jobs(cursor):
    assert job_queue.enqueue(cursor, "match_run", {"flight_id": 1}) is not None
    assert job_queue.enqueue(cursor, "match_run", {"flight_id": 2}) is not None
    assert len(_job_ids(cursor)) == 2


def test_deduplication_only_applies_to_queued_jobs(cursor):
    """Once a job has run, the same job later is legitimate new work."""
    first = job_queue.enqueue(cursor, "match_run", {"flight_id": 9})
    job_queue.claim(cursor, "w1")
    job_queue.complete(cursor, first)

    second = job_queue.enqueue(cursor, "match_run", {"flight_id": 9})
    assert second is not None and second != first


# --------------------------------------------------------------------- claiming
def test_claim_marks_the_job_running_and_counts_the_attempt(cursor):
    job_id = job_queue.enqueue(cursor, "match_run", {"flight_id": 1})
    job = job_queue.claim(cursor, "worker-a")

    assert job is not None
    assert job.id == job_id
    assert job.type == "match_run"
    assert job.payload == {"flight_id": 1}
    assert job.attempts == 1

    row = _status(cursor, job_id)
    assert row["status"] == "running"
    assert row["locked_by"] == "worker-a"


def test_claim_returns_none_on_an_empty_queue(cursor):
    assert job_queue.claim(cursor, "worker-a") is None


def test_claim_ignores_jobs_that_are_not_due_yet(cursor):
    later = datetime.now(timezone.utc) + timedelta(hours=1)
    job_queue.enqueue(cursor, "match_run", {"flight_id": 1}, later)
    assert job_queue.claim(cursor, "worker-a") is None


def test_claim_takes_the_oldest_due_job_first(cursor):
    now = datetime.now(timezone.utc)
    job_queue.enqueue(cursor, "match_run", {"flight_id": 2}, now)
    first = job_queue.enqueue(cursor, "match_run", {"flight_id": 1}, now - timedelta(minutes=5))

    claimed = job_queue.claim(cursor, "worker-a")
    assert claimed.id == first


def test_claim_can_be_restricted_to_certain_types(cursor):
    job_queue.enqueue(cursor, "purge_flight", {"flight_id": 1})
    match = job_queue.enqueue(cursor, "match_run", {"flight_id": 1})

    claimed = job_queue.claim(cursor, "solver-only", types=("match_run",))
    assert claimed.id == match

    assert job_queue.claim(cursor, "solver-only", types=("match_run",)) is None


def test_flight_id_helper_reads_the_payload(cursor):
    job_queue.enqueue(cursor, "match_run", {"flight_id": 42})
    job = job_queue.claim(cursor, "w")
    assert job.flight_id == 42


def test_flight_id_is_none_when_absent(cursor):
    job_queue.enqueue(cursor, "expire_proposals", {})
    job = job_queue.claim(cursor, "w")
    assert job.flight_id is None


# ------------------------------------------------------------------ concurrency
def test_two_workers_never_get_the_same_job(migrated):
    """The reason the queue is a table and not a list.

    Two connections claim at the same time, each inside its own transaction. With
    SKIP LOCKED the second steps over the row the first has locked and takes the
    next one; without it, it would block until the first committed and then hand
    out a job that had already been taken.
    """
    import psycopg
    from psycopg.rows import dict_row

    conn_a = psycopg.connect(migrated, row_factory=dict_row)
    conn_b = psycopg.connect(migrated, row_factory=dict_row)
    try:
        with conn_a.cursor() as cursor:
            cursor.execute("TRUNCATE jobs RESTART IDENTITY")
            job_queue.enqueue(cursor, "match_run", {"flight_id": 1})
            job_queue.enqueue(cursor, "match_run", {"flight_id": 2})
        conn_a.commit()

        # Both transactions are open at once; neither has committed.
        cur_a = conn_a.cursor()
        cur_b = conn_b.cursor()
        job_a = job_queue.claim(cur_a, "worker-a")
        job_b = job_queue.claim(cur_b, "worker-b")

        assert job_a is not None and job_b is not None
        assert job_a.id != job_b.id, "two workers were handed the same job"
        assert {job_a.payload["flight_id"], job_b.payload["flight_id"]} == {1, 2}

        conn_a.commit()
        conn_b.commit()
    finally:
        conn_a.close()
        conn_b.close()


def test_a_third_worker_finds_nothing_when_both_jobs_are_taken(migrated):
    import psycopg
    from psycopg.rows import dict_row

    connections = [psycopg.connect(migrated, row_factory=dict_row) for _ in range(3)]
    try:
        with connections[0].cursor() as cursor:
            cursor.execute("TRUNCATE jobs RESTART IDENTITY")
            job_queue.enqueue(cursor, "match_run", {"flight_id": 1})
            job_queue.enqueue(cursor, "match_run", {"flight_id": 2})
        connections[0].commit()

        cursors = [c.cursor() for c in connections]
        claimed = [job_queue.claim(cur, f"w{i}") for i, cur in enumerate(cursors)]

        assert claimed[0] is not None
        assert claimed[1] is not None
        assert claimed[2] is None, "third worker should find the queue empty, not block"
    finally:
        for connection in connections:
            connection.rollback()
            connection.close()


# ---------------------------------------------------------------------- failure
def test_failure_reschedules_with_backoff(cursor):
    job_id = job_queue.enqueue(cursor, "match_run", {"flight_id": 1})
    job = job_queue.claim(cursor, "w")
    job_queue.fail(cursor, job.id, "boom", job.attempts)

    row = _status(cursor, job_id)
    assert row["status"] == "queued"
    assert row["last_error"] == "boom"
    assert row["locked_by"] is None
    assert row["run_after"] > datetime.now(timezone.utc)


def test_backoff_grows_with_each_attempt(cursor):
    job_id = job_queue.enqueue(cursor, "match_run", {"flight_id": 1})
    delays = []
    for _ in range(3):
        cursor.execute("UPDATE jobs SET run_after = now() WHERE id = %s", (job_id,))
        job = job_queue.claim(cursor, "w")
        job_queue.fail(cursor, job.id, "boom", job.attempts)
        row = _status(cursor, job_id)
        delays.append(row["run_after"])
    assert delays[0] < delays[1] < delays[2]


def test_a_job_gives_up_after_max_attempts(cursor):
    job_id = job_queue.enqueue(cursor, "match_run", {"flight_id": 1})
    for _ in range(job_queue.MAX_ATTEMPTS):
        cursor.execute("UPDATE jobs SET run_after = now() WHERE id = %s", (job_id,))
        job = job_queue.claim(cursor, "w")
        job_queue.fail(cursor, job.id, "boom", job.attempts)

    row = _status(cursor, job_id)
    assert row["status"] == "failed"
    assert row["attempts"] == job_queue.MAX_ATTEMPTS


def test_completing_clears_the_error(cursor):
    job_id = job_queue.enqueue(cursor, "match_run", {"flight_id": 1})
    job = job_queue.claim(cursor, "w")
    job_queue.fail(cursor, job.id, "transient", job.attempts)
    cursor.execute("UPDATE jobs SET run_after = now() WHERE id = %s", (job_id,))
    job = job_queue.claim(cursor, "w")
    job_queue.complete(cursor, job.id)

    row = _status(cursor, job_id)
    assert row["status"] == "done"
    assert row["last_error"] is None


# ------------------------------------------------------------------- dead worker
def test_stale_running_jobs_are_requeued(cursor):
    job_id = job_queue.enqueue(cursor, "match_run", {"flight_id": 1})
    job_queue.claim(cursor, "worker-that-died")
    cursor.execute(
        "UPDATE jobs SET locked_at = now() - interval '1 hour' WHERE id = %s", (job_id,)
    )

    released = job_queue.release_stale(cursor)
    assert released == 1
    assert _status(cursor, job_id)["status"] == "queued"


def test_fresh_running_jobs_are_left_alone(cursor):
    job_queue.enqueue(cursor, "match_run", {"flight_id": 1})
    job = job_queue.claim(cursor, "busy-worker")
    assert job_queue.release_stale(cursor) == 0
    assert _status(cursor, job.id)["status"] == "running"


# ------------------------------------------------------- flight lifecycle jobs
def test_schedule_flight_jobs_queues_the_whole_lifecycle(cursor):
    departure = datetime(2026, 10, 12, 5, 40, tzinfo=timezone.utc)
    checkin = departure - timedelta(hours=48)

    queued = job_queue.schedule_flight_jobs(cursor, 1, checkin, departure)

    cursor.execute("SELECT type, run_after FROM jobs ORDER BY run_after")
    rows = cursor.fetchall()
    assert len(queued) == 5  # reminder + three match runs + purge
    assert [r["type"] for r in rows] == [
        "checkin_reminder",
        "match_run",
        "match_run",
        "match_run",
        "purge_flight",
    ]
    assert rows[0]["run_after"] == checkin
    assert rows[-1]["run_after"] == departure + timedelta(hours=24)


def test_scheduled_runs_are_at_t_minus_20_12_and_4(cursor):
    departure = datetime(2026, 10, 12, 12, 0, tzinfo=timezone.utc)
    job_queue.schedule_flight_jobs(cursor, 1, None, departure)

    cursor.execute("SELECT payload, run_after FROM jobs WHERE type = 'match_run' ORDER BY run_after")
    rows = cursor.fetchall()
    assert [r["payload"]["hours_before"] for r in rows] == [20, 12, 4]
    assert [(departure - r["run_after"]).total_seconds() / 3600 for r in rows] == [20, 12, 4]


def test_schedule_flight_jobs_copes_with_unknown_times(cursor):
    """An unverified flight has no times yet; nothing is scheduled and nothing breaks."""
    assert job_queue.schedule_flight_jobs(cursor, 1, None, None) == []
    assert _job_ids(cursor) == []
