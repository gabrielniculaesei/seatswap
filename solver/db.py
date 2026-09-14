"""Database access for the worker.

One connection, opened lazily and reopened if it drops. No pool: a worker is a
single process doing one job at a time, and a pool would be a moving part that
earns nothing here (CLAUDE.md §17).

Queries are written by hand. There is no ORM and there should not be one.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from contextlib import contextmanager

import psycopg
from psycopg.rows import dict_row


class ConfigurationError(RuntimeError):
    """Something required is missing from the environment."""


def database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise ConfigurationError("DATABASE_URL is not set")
    return url


def connect(url: str | None = None) -> psycopg.Connection:
    """Open a connection. Callers manage the transaction explicitly."""
    connection = psycopg.connect(url or database_url(), row_factory=dict_row)
    connection.autocommit = False
    return connection


@contextmanager
def transaction(connection: psycopg.Connection) -> Iterator[psycopg.Cursor]:
    """Run a block in one transaction, committing on success.

    psycopg's own `connection.transaction()` does the same thing; this wrapper
    exists so every call site also gets a cursor without repeating two lines.
    """
    with connection.transaction():
        with connection.cursor() as cursor:
            yield cursor
