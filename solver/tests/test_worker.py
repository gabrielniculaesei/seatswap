"""The worker loop: claiming, dispatching, committing, and surviving failures."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import pytest

import jobs as job_queue
import worker as worker_module
from conftest import requires_db
from tests.test_handlers import make_flight, make_party

pytestmark = requires_db


@pytest.fixture
def worker():
    return worker_module.Worker("test-worker")


def _enqueue(connection, job_type, payload=None):
    with connection.cursor() as cursor:
        job_id = job_queue.enqueue(cursor, job_type, payload or {})
    connection.commit()
    return job_id


def _row(connection, job_id):
    with connection.cursor() as cursor:
        cursor.execute("SELECT status, attempts, last_error FROM jobs WHERE id = %s", (job_id,))
        return cursor.fetchone()


def test_run_once_on_an_empty_queue_returns_false(connection, worker):
    assert worker.run_once(connection) is False


def test_a_job_is_run_and_marked_done(connection, worker):
    with connection.cursor() as cursor:
        flight_id = make_flight(cursor, "W6", "3234", date(2026, 10, 12))
    connection.commit()
    job_id = _enqueue(connection, "verify_flight", {"flight_id": flight_id})

    assert worker.run_once(connection) is True
    assert _row(connection, job_id)["status"] == "done"
    assert worker.processed == 1 and worker.failed == 0

    with connection.cursor() as cursor:
        cursor.execute("SELECT api_status FROM flights WHERE id = %s", (flight_id,))
        assert cursor.fetchone()["api_status"] == "verified"


def test_a_failing_job_is_requeued_not_lost(connection, worker, monkeypatch):
    """A handler that raises must roll back its own work and leave the job to retry."""
    def explode(cursor, job):
        raise RuntimeError("the solver caught fire")

    monkeypatch.setitem(worker_module.HANDLERS, "match_run", explode)
    job_id = _enqueue(connection, "match_run", {"flight_id": 1})

    assert worker.run_once(connection) is True
    row = _row(connection, job_id)
    assert row["status"] == "queued"
    assert row["attempts"] == 1
    assert "the solver caught fire" in row["last_error"]
    assert worker.failed == 1


def test_a_failing_handler_rolls_back_its_own_writes(connection, worker, monkeypatch):
    """The transaction boundary is the point: a half-written match run must not
    survive the exception that interrupted it."""
    def write_then_explode(cursor, job):
        cursor.execute(
            "INSERT INTO flights (carrier, flight_number, departure_date) "
            "VALUES ('ZZ', '1', '2026-01-01')"
        )
        raise RuntimeError("boom")

    monkeypatch.setitem(worker_module.HANDLERS, "match_run", write_then_explode)
    _enqueue(connection, "match_run", {"flight_id": 1})
    worker.run_once(connection)

    with connection.cursor() as cursor:
        cursor.execute("SELECT count(*) AS n FROM flights WHERE carrier = 'ZZ'")
        assert cursor.fetchone()["n"] == 0, "a failed job left data behind"


def test_the_attempt_count_survives_a_rollback(connection, worker, monkeypatch):
    """If the attempt counter were rolled back with the handler's work, the
    backoff would never terminate and a poisoned job would retry forever."""
    monkeypatch.setitem(
        worker_module.HANDLERS, "match_run",
        lambda cursor, job: (_ for _ in ()).throw(RuntimeError("nope")),
    )
    job_id = _enqueue(connection, "match_run", {"flight_id": 1})

    for expected in (1, 2, 3):
        with connection.cursor() as cursor:
            cursor.execute("UPDATE jobs SET run_after = now() WHERE id = %s", (job_id,))
        connection.commit()
        worker.run_once(connection)
        assert _row(connection, job_id)["attempts"] == expected


def test_an_unknown_job_type_fails_cleanly(connection, worker):
    """A type with no handler is a deployment mistake, not a crash."""
    with connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO jobs (type, payload) VALUES ('match_run', '{}') RETURNING id"
        )
        job_id = cursor.fetchone()["id"]
    connection.commit()

    original = worker_module.HANDLERS.pop("match_run")
    try:
        assert worker.run_once(connection) is True
        assert "no handler" in _row(connection, job_id)["last_error"]
    finally:
        worker_module.HANDLERS["match_run"] = original


def test_drain_runs_everything_due(connection, worker):
    with connection.cursor() as cursor:
        first = make_flight(cursor, "W6", "3234", date(2026, 10, 12))
        second = make_flight(cursor, "FR", "1234", date(2026, 10, 12))
    connection.commit()
    _enqueue(connection, "verify_flight", {"flight_id": first})
    _enqueue(connection, "verify_flight", {"flight_id": second})

    done = worker.drain(connection)
    assert done == 2
    assert worker.processed == 2

    with connection.cursor() as cursor:
        cursor.execute("SELECT count(*) AS n FROM jobs WHERE status = 'done'")
        assert cursor.fetchone()["n"] == 2


def test_drain_stops_at_jobs_that_are_not_due(connection, worker):
    later = datetime.now(timezone.utc) + timedelta(days=1)
    with connection.cursor() as cursor:
        job_queue.enqueue(cursor, "match_run", {"flight_id": 1}, later)
    connection.commit()

    assert worker.drain(connection) == 0


def test_a_type_restricted_worker_leaves_other_work_alone(connection):
    solver_only = worker_module.Worker("solver", types=("match_run",))
    with connection.cursor() as cursor:
        flight_id = make_flight(cursor, "W6", "3234", date(2026, 10, 12))
    connection.commit()
    verify = _enqueue(connection, "verify_flight", {"flight_id": flight_id})

    assert solver_only.run_once(connection) is False
    assert _row(connection, verify)["status"] == "queued"


def test_bootstrap_queues_the_sweeper_once(connection):
    worker_module.bootstrap(connection)
    worker_module.bootstrap(connection)

    with connection.cursor() as cursor:
        cursor.execute("SELECT count(*) AS n FROM jobs WHERE type = 'expire_proposals'")
        assert cursor.fetchone()["n"] == 1


def test_stop_ends_the_loop(worker):
    assert worker.running is True
    worker.stop()
    assert worker.running is False


# ------------------------------------------------------------- the whole chain
def test_a_flight_runs_its_whole_lifecycle_through_the_worker(connection, worker):
    """Verify -> schedule -> seats arrive -> match run -> proposal, all through
    the queue, with nothing driving it but the worker."""
    with connection.cursor() as cursor:
        flight_id = make_flight(cursor, "FR", "1234", date(2026, 10, 12))
    connection.commit()
    _enqueue(connection, "verify_flight", {"flight_id": flight_id})

    # 1. verification fills in the flight and queues the rest of its life
    worker.drain(connection)
    with connection.cursor() as cursor:
        cursor.execute("SELECT seat_map_key, checkin_opens_utc FROM flights WHERE id = %s",
                       (flight_id,))
        flight = cursor.fetchone()
        assert flight["seat_map_key"] == "B738"
        assert flight["checkin_opens_utc"] is not None

        cursor.execute("SELECT count(*) AS n FROM jobs WHERE type = 'match_run'")
        assert cursor.fetchone()["n"] == 3

    # 2. people register and send their seats
    with connection.cursor() as cursor:
        make_party(cursor, flight_id, 111, ["14A", "20C"], name="Anna", w_adjacency=200)
        make_party(cursor, flight_id, 222, ["14B"], name="Clara",
                   w_window=60, w_avoid_middle=40)
        # the scheduled runs are months away; an immediate one is queued on submit
        job_queue.enqueue(cursor, "match_run",
                          {"flight_id": flight_id, "trigger": "scheduled"})
    connection.commit()

    # 3. the worker solves it and writes a proposal
    worker.drain(connection)
    with connection.cursor() as cursor:
        cursor.execute("SELECT status, total_gain FROM proposals WHERE flight_id = %s",
                       (flight_id,))
        proposal = cursor.fetchone()
        assert proposal is not None, "no proposal came out of the lifecycle"
        assert proposal["status"] == "pending"
        assert proposal["total_gain"] > 0

    assert worker.failed == 0
