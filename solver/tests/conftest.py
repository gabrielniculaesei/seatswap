"""Shared fixtures. `pythonpath = .` in pytest.ini puts solver/ on sys.path."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path

import pytest

from seatmap import load_seat_map

REPO_ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = REPO_ROOT / "db" / "migrations"

#: Tables holding test data, in an order that is safe to truncate together.
DATA_TABLES = ("jobs", "flight_stats", "flight_creations", "flights")

# The wrapper defaults to 'off' so a deploy that forgets the setting makes no
# calls and invents no data. The tests want the fixtures, so they ask for them.
os.environ.setdefault("AERODATABOX_MODE", "fixture")


@pytest.fixture
def b738():
    """Boeing 737-800: 33 rows, ABC | DEF, lavatories at rows 1, 32, 33."""
    return load_seat_map("B738")


@pytest.fixture
def generic():
    """The `_default` fallback used when the aircraft type is unknown."""
    return load_seat_map(None)


# --------------------------------------------------------------------- database
def _database_url() -> str | None:
    return os.environ.get("TEST_DATABASE_URL") or os.environ.get("DATABASE_URL")


requires_db = pytest.mark.skipif(
    _database_url() is None,
    reason="set TEST_DATABASE_URL (or DATABASE_URL) to run the database tests",
)


@pytest.fixture(scope="session")
def database_url() -> str:
    url = _database_url()
    if url is None:
        pytest.skip("no database configured")
    return url


def migration_checksum(body: str) -> str:
    """Identical to web/scripts/migrate.mjs, so the two agree on every file."""
    return hashlib.sha256(body.encode("utf-8")).hexdigest()[:16]


@pytest.fixture(scope="session")
def migrated(database_url):
    """Apply every migration once per test session.

    Deliberately the same bookkeeping as web/scripts/migrate.mjs - same table, same
    columns, same checksum - so that whichever of the two runs first, the other
    sees the work as done and skips it. They used to create *different*
    schema_migrations tables, and running the JS one first made every database test
    fail on a NOT NULL checksum.
    """
    import psycopg

    with psycopg.connect(database_url, autocommit=True) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS schema_migrations (
                    filename    TEXT PRIMARY KEY,
                    checksum    TEXT NOT NULL,
                    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
                )
                """
            )
            cursor.execute("SELECT filename FROM schema_migrations")
            applied = {row[0] for row in cursor.fetchall()}

            for path in sorted(MIGRATIONS.glob("*.sql")):
                if path.name in applied:
                    continue
                body = path.read_text()
                cursor.execute(body)
                cursor.execute(
                    "INSERT INTO schema_migrations (filename, checksum) VALUES (%s, %s)",
                    (path.name, migration_checksum(body)),
                )
    return database_url


@pytest.fixture
def connection(migrated):
    """A clean database for one test.

    Truncating `flights` cascades to parties, members, match_runs, proposals and
    everything hanging off them, which is itself a small check that the foreign
    keys are wired the way the purge job assumes.
    """
    import psycopg
    from psycopg.rows import dict_row

    conn = psycopg.connect(migrated, row_factory=dict_row)
    conn.autocommit = False
    with conn.cursor() as cursor:
        cursor.execute(f"TRUNCATE {', '.join(DATA_TABLES)} RESTART IDENTITY CASCADE")
    conn.commit()
    try:
        yield conn
    finally:
        conn.rollback()
        conn.close()


@pytest.fixture
def cursor(connection):
    """A cursor whose work is committed at the end of the test."""
    with connection.cursor() as cur:
        yield cur
    connection.commit()
