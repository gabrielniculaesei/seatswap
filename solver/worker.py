"""The worker process.

Polls the `jobs` table, runs one job at a time, commits the result and the job's
new status in the same transaction. That is the whole design. There is no broker,
no scheduler daemon and no cron: `expire_proposals` re-queues itself and
`verify_flight` queues a flight's whole lifecycle at the moment its times become
known.

Running several of these is safe - `FOR UPDATE SKIP LOCKED` means two workers
never pick up the same job - but one is enough for a long time.

    python worker.py                 # poll forever
    python worker.py --once          # drain the queue and exit (used by tests)
    python worker.py --types match_run
"""

from __future__ import annotations

import argparse
import logging
import os
import signal
import socket
import sys
import time
import traceback

import db
import jobs as job_queue
from handlers import HANDLERS

log = logging.getLogger("worker")

#: How long to wait when the queue is empty. Long enough not to hammer the
#: database, short enough that an immediate match run feels immediate.
IDLE_SLEEP = 2.0

#: How often to look for jobs abandoned by a dead worker.
REAP_EVERY = 60.0


class Worker:
    def __init__(self, worker_id: str, types: tuple[str, ...] | None = None) -> None:
        self.worker_id = worker_id
        self.types = types
        self.running = True
        self.processed = 0
        self.failed = 0
        self._last_reap = 0.0

    def stop(self, *_: object) -> None:
        # Finish the job in flight, then exit. A SIGTERM in the middle of a match
        # run should not leave a half-written proposal set.
        log.info("shutdown requested, finishing current job")
        self.running = False

    def run_once(self, connection) -> bool:
        """Claim and run a single job. Returns False when the queue is empty.

        The job is claimed in its own transaction so the claim is visible to other
        workers immediately; the handler then runs in a second transaction. If the
        handler raises, only its own work is rolled back - the attempt count
        survives, which is what makes the backoff terminate.
        """
        with db.transaction(connection) as cursor:
            job = job_queue.claim(cursor, self.worker_id, self.types)
        if job is None:
            return False

        log.info("job %s %s attempt %s", job.id, job.type, job.attempts)
        handler = HANDLERS.get(job.type)
        if handler is None:
            with db.transaction(connection) as cursor:
                job_queue.fail(cursor, job.id, f"no handler for {job.type}", job.attempts)
            self.failed += 1
            return True

        try:
            with db.transaction(connection) as cursor:
                result = handler(cursor, job)
                job_queue.complete(cursor, job.id)
            log.info("job %s done: %s", job.id, result)
            self.processed += 1
        except Exception:
            error = traceback.format_exc()
            log.error("job %s failed:\n%s", job.id, error)
            with db.transaction(connection) as cursor:
                job_queue.fail(cursor, job.id, error, job.attempts)
            self.failed += 1
        return True

    def drain(self, connection, limit: int = 1000) -> int:
        """Run everything currently due, then stop. Used by --once and by tests."""
        done = 0
        while done < limit and self.run_once(connection):
            done += 1
        return done

    def loop(self, connection) -> None:
        while self.running:
            self._maybe_reap(connection)
            try:
                if not self.run_once(connection):
                    time.sleep(IDLE_SLEEP)
            except Exception:
                # A database blip must not kill the process; back off and retry.
                log.exception("worker loop error")
                time.sleep(IDLE_SLEEP * 5)

    def _maybe_reap(self, connection) -> None:
        now = time.monotonic()
        if now - self._last_reap < REAP_EVERY:
            return
        self._last_reap = now
        with db.transaction(connection) as cursor:
            released = job_queue.release_stale(cursor)
        if released:
            log.warning("requeued %s stale job(s) from a dead worker", released)


def bootstrap(connection) -> None:
    """Make sure the self-perpetuating sweeper is in the queue."""
    with db.transaction(connection) as cursor:
        job_queue.enqueue(cursor, "expire_proposals", {})


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="seatswap solver worker")
    parser.add_argument("--once", action="store_true",
                        help="drain the queue and exit instead of polling")
    parser.add_argument("--types", nargs="*", default=None,
                        help="only take these job types")
    parser.add_argument("--worker-id", default=None)
    parser.add_argument("--log-level", default=os.environ.get("LOG_LEVEL", "INFO"))
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=args.log_level.upper(),
        format="%(asctime)s %(levelname)-7s %(name)s %(message)s",
    )

    # jobs.locked_by is VARCHAR(60); a long hostname or a pod name must not make
    # every claim fail with a truncation error.
    worker_id = (args.worker_id or f"{socket.gethostname()}:{os.getpid()}")[:60]
    worker = Worker(worker_id, tuple(args.types) if args.types else None)

    signal.signal(signal.SIGTERM, worker.stop)
    signal.signal(signal.SIGINT, worker.stop)

    connection = db.connect()
    try:
        bootstrap(connection)
        if args.once:
            done = worker.drain(connection)
            log.info("drained %s job(s): %s ok, %s failed",
                     done, worker.processed, worker.failed)
        else:
            log.info("worker %s polling", worker_id)
            worker.loop(connection)
    finally:
        connection.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
