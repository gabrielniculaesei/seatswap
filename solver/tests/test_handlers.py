"""The five job handlers, end to end against a real database.

Telegram runs in dry mode throughout (no TELEGRAM_BOT_TOKEN), so nothing leaves
the machine; what is asserted is the database state each handler leaves behind.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import handlers
import telegram
from conftest import requires_db
from jobs import Job

pytestmark = requires_db


# ------------------------------------------------------------------- factories
def make_flight(
    cursor,
    carrier="W6",
    number="3234",
    departure=date(2026, 10, 12),
    seat_map_key=None,
    departure_utc=None,
) -> int:
    cursor.execute(
        """
        INSERT INTO flights (carrier, flight_number, departure_date, seat_map_key,
                             scheduled_departure_utc)
        VALUES (%s, %s, %s, %s, %s)
        RETURNING id
        """,
        (carrier, number, departure, seat_map_key, departure_utc),
    )
    return cursor.fetchone()["id"]


def make_party(
    cursor,
    flight_id: int,
    telegram_user_id: int,
    seats: list[str] | None,
    name="Traveller",
    state="seated",
    **weights,
) -> int:
    size = len(seats) if seats else 1
    columns = {
        "w_window": 0, "w_aisle": 0, "w_front": 0,
        "w_avoid_middle": 0, "w_avoid_lavatory": 0, "w_adjacency": 0,
        "children": 0,
    }
    columns.update(weights)
    cursor.execute(
        f"""
        INSERT INTO parties (flight_id, telegram_user_id, display_name, size, state,
                             {', '.join(columns)})
        VALUES (%s, %s, %s, %s, %s, {', '.join(['%s'] * len(columns))})
        RETURNING id
        """,
        (flight_id, telegram_user_id, name, size, state, *columns.values()),
    )
    party_id = cursor.fetchone()["id"]

    for seat in seats or [None]:
        cursor.execute(
            "INSERT INTO members (party_id, flight_id, current_seat) VALUES (%s, %s, %s)",
            (party_id, flight_id, seat),
        )
    return party_id


def job(job_type: str, payload: dict) -> Job:
    return Job(id=1, type=job_type, payload=payload, attempts=1)


# --------------------------------------------------------------- verify_flight
def test_verify_flight_fills_in_the_row_from_the_fixture(cursor):
    flight_id = make_flight(cursor, "W6", "3234", date(2026, 10, 12))
    result = handlers.verify_flight(cursor, job("verify_flight", {"flight_id": flight_id}))

    assert result["api_status"] == "verified"
    cursor.execute("SELECT * FROM flights WHERE id = %s", (flight_id,))
    row = cursor.fetchone()
    assert row["origin"] == "OTP"
    assert row["destination"] == "BGY"
    assert row["aircraft_type"] == "Airbus A321"
    assert row["seat_map_key"] == "A321"
    assert row["api_verified_at"] is not None
    assert row["scheduled_departure_utc"] == datetime(2026, 10, 12, 5, 40, tzinfo=timezone.utc)


def test_verify_flight_applies_the_carrier_checkin_policy(cursor):
    """W6 opens check-in 48h before; FR 24h. Hardcoded because no API exposes it."""
    wizz = make_flight(cursor, "W6", "3234", date(2026, 10, 12))
    handlers.verify_flight(cursor, job("verify_flight", {"flight_id": wizz}))
    cursor.execute("SELECT scheduled_departure_utc, checkin_opens_utc FROM flights WHERE id = %s", (wizz,))
    row = cursor.fetchone()
    assert row["scheduled_departure_utc"] - row["checkin_opens_utc"] == timedelta(hours=48)

    ryanair = make_flight(cursor, "FR", "1234", date(2026, 10, 12))
    handlers.verify_flight(cursor, job("verify_flight", {"flight_id": ryanair}))
    cursor.execute("SELECT scheduled_departure_utc, checkin_opens_utc FROM flights WHERE id = %s", (ryanair,))
    row = cursor.fetchone()
    assert row["scheduled_departure_utc"] - row["checkin_opens_utc"] == timedelta(hours=24)


def test_verify_flight_schedules_the_lifecycle(cursor):
    flight_id = make_flight(cursor, "W6", "3234", date(2026, 10, 12))
    handlers.verify_flight(cursor, job("verify_flight", {"flight_id": flight_id}))

    cursor.execute("SELECT type FROM jobs ORDER BY run_after")
    assert [r["type"] for r in cursor.fetchall()] == [
        "checkin_reminder", "match_run", "match_run", "match_run", "purge_flight",
    ]


def test_verify_flight_degrades_when_the_flight_is_unknown(cursor):
    """An unknown flight must never block the user (CLAUDE.md §11)."""
    flight_id = make_flight(cursor, "XX", "9999", date(2026, 10, 12))
    result = handlers.verify_flight(cursor, job("verify_flight", {"flight_id": flight_id}))

    assert result["api_status"] == "not_found"
    cursor.execute("SELECT api_status, seat_map_key FROM flights WHERE id = %s", (flight_id,))
    row = cursor.fetchone()
    assert row["api_status"] == "not_found"
    assert row["seat_map_key"] is None  # load_seat_map(None) -> estimated layout


def test_an_unknown_flight_still_gets_its_whole_lifecycle(cursor):
    """Before 2026-09-15 a flight with no departure time from the API got no jobs
    at all: no reminder, no match runs, and no purge, so its personal data was
    kept forever. It now gets the lot, from the date alone."""
    flight_id = make_flight(cursor, "XX", "9999", date(2026, 10, 12))
    handlers.verify_flight(cursor, job("verify_flight", {"flight_id": flight_id}))

    cursor.execute("SELECT type, run_after FROM jobs ORDER BY run_after")
    jobs = cursor.fetchall()
    assert [r["type"] for r in jobs] == [
        "checkin_reminder", "match_run", "match_run", "match_run", "purge_flight",
    ]

    midnight = datetime(2026, 10, 12, tzinfo=timezone.utc)
    by_type = {r["type"]: r["run_after"] for r in jobs}
    # XX is not in carriers.json, so the default 24-hour check-in policy applies.
    assert by_type["checkin_reminder"] == midnight - timedelta(hours=24)
    # Every scheduled run lands before the first flight of the day can leave...
    assert all(r["run_after"] < midnight for r in jobs if r["type"] == "match_run")
    # ...and the purge after the last one possibly could, plus a day.
    assert by_type["purge_flight"] == midnight + timedelta(hours=60)

    cursor.execute(
        "SELECT scheduled_departure_utc, checkin_opens_utc FROM flights WHERE id = %s",
        (flight_id,),
    )
    row = cursor.fetchone()
    assert row["scheduled_departure_utc"] is None, "an estimate is never stored as a fact"
    assert row["checkin_opens_utc"] == midnight - timedelta(hours=24), "the web can open"


def test_off_mode_makes_no_call_and_still_schedules(cursor, monkeypatch):
    """Running with no API key at all: every flight unknown, every flight working."""
    monkeypatch.setenv("AERODATABOX_MODE", "off")
    flight_id = make_flight(cursor, "W6", "3234", date(2026, 10, 12))
    result = handlers.verify_flight(cursor, job("verify_flight", {"flight_id": flight_id}))

    assert result["api_status"] == "unknown", "the W6 fixture exists but must not be read"
    assert result["jobs_scheduled"] == 5


def test_the_reminder_does_not_overclaim_on_an_estimate():
    known = telegram.format_checkin_reminder("W6 3234", "2026-10-12")
    guessed = telegram.format_checkin_reminder("W6 3234", "2026-10-12", estimated=True)
    assert "Check-in is open" in known
    assert "Check-in is open" not in guessed
    assert "opens around now" in guessed


def test_verify_flight_on_a_deleted_flight_is_a_no_op(cursor):
    result = handlers.verify_flight(cursor, job("verify_flight", {"flight_id": 999999}))
    assert "skipped" in result


# ------------------------------------------------------------ checkin_reminder
def test_checkin_reminder_targets_only_parties_without_seats(cursor, monkeypatch):
    sent = []
    monkeypatch.setattr(telegram, "send_message",
                        lambda chat_id, text, markup=None: sent.append((chat_id, text))
                        or telegram.SentMessage(chat_id, text))

    flight_id = make_flight(cursor)
    make_party(cursor, flight_id, 111, None, state="registered")
    make_party(cursor, flight_id, 222, None, state="registered")
    make_party(cursor, flight_id, 333, ["14A"], state="seated")

    result = handlers.checkin_reminder(cursor, job("checkin_reminder", {"flight_id": flight_id}))

    assert result["parties_reminded"] == 2
    assert {chat for chat, _ in sent} == {111, 222}
    assert "W63234" in sent[0][1]


# ------------------------------------------------------------------- match_run
def test_match_run_writes_a_proposal(cursor):
    """The whole point, end to end: a split pair and a single, in the database."""
    flight_id = make_flight(cursor, seat_map_key="B738")
    pair = make_party(cursor, flight_id, 111, ["14A", "20C"], name="Anna", w_adjacency=200)
    single = make_party(cursor, flight_id, 222, ["14B"], name="Clara",
                        w_window=60, w_avoid_middle=40)

    result = handlers.match_run(cursor, job("match_run", {"flight_id": flight_id}))
    assert result["proposals_sent"] == 1

    cursor.execute("SELECT * FROM proposals WHERE flight_id = %s", (flight_id,))
    proposal = cursor.fetchone()
    assert proposal["status"] == "pending"
    assert proposal["total_gain"] > 0
    assert len(proposal["agreement_token"]) == 32  # 128 bits of hex
    assert proposal["expires_at"] > datetime.now(timezone.utc)

    cursor.execute(
        "SELECT party_id, gain FROM proposal_parties WHERE proposal_id = %s ORDER BY party_id",
        (proposal["id"],),
    )
    gains = {r["party_id"]: r["gain"] for r in cursor.fetchall()}
    assert gains[pair] == 200
    assert gains[single] > 0

    cursor.execute(
        "SELECT from_seat, to_seat FROM proposal_assignments WHERE proposal_id = %s",
        (proposal["id"],),
    )
    moves = cursor.fetchall()
    assert {m["from_seat"] for m in moves} == {m["to_seat"] for m in moves}, "cycle is closed"


def test_match_run_moves_parties_to_matched(cursor):
    flight_id = make_flight(cursor, seat_map_key="B738")
    make_party(cursor, flight_id, 111, ["14A", "20C"], w_adjacency=200)
    make_party(cursor, flight_id, 222, ["14B"], w_window=60, w_avoid_middle=40)

    handlers.match_run(cursor, job("match_run", {"flight_id": flight_id}))

    cursor.execute("SELECT DISTINCT state FROM parties WHERE flight_id = %s", (flight_id,))
    assert [r["state"] for r in cursor.fetchall()] == ["matched"]


def test_match_run_records_solver_stats(cursor):
    flight_id = make_flight(cursor, seat_map_key="B738")
    make_party(cursor, flight_id, 111, ["14A", "20C"], w_adjacency=200)
    make_party(cursor, flight_id, 222, ["14B"], w_window=60)

    handlers.match_run(cursor, job("match_run", {"flight_id": flight_id}))

    cursor.execute("SELECT status, solver_stats, finished_at FROM match_runs WHERE flight_id = %s",
                   (flight_id,))
    run = cursor.fetchone()
    assert run["status"] == "done"
    assert run["finished_at"] is not None
    assert run["solver_stats"]["parties"] == 2
    assert run["solver_stats"]["rounds"] >= 1


def test_match_run_ignores_parties_without_seats(cursor):
    """Before check-in there is nothing to trade."""
    flight_id = make_flight(cursor, seat_map_key="B738")
    make_party(cursor, flight_id, 111, None, state="registered")
    make_party(cursor, flight_id, 222, None, state="registered")

    result = handlers.match_run(cursor, job("match_run", {"flight_id": flight_id}))
    assert result["parties"] == 0
    assert result["proposals_sent"] == 0


def test_match_run_with_nothing_to_gain_writes_no_proposal(cursor):
    flight_id = make_flight(cursor, seat_map_key="B738")
    make_party(cursor, flight_id, 111, ["14A"])
    make_party(cursor, flight_id, 222, ["14B"])

    result = handlers.match_run(cursor, job("match_run", {"flight_id": flight_id}))
    assert result["proposals_sent"] == 0
    cursor.execute("SELECT count(*) AS n FROM proposals")
    assert cursor.fetchone()["n"] == 0


def test_a_new_run_does_not_replace_a_proposal_somebody_accepted(cursor):
    """Superseding a trade a person has already said yes to would be the one
    genuinely rude thing this system could do."""
    flight_id = make_flight(cursor, seat_map_key="B738")
    make_party(cursor, flight_id, 111, ["14A", "20C"], w_adjacency=200)
    single = make_party(cursor, flight_id, 222, ["14B"], w_window=60, w_avoid_middle=40)

    handlers.match_run(cursor, job("match_run", {"flight_id": flight_id}))
    cursor.execute("SELECT id FROM proposals")
    first = cursor.fetchone()["id"]
    cursor.execute(
        "UPDATE proposal_parties SET response = 'accept', responded_at = now() "
        "WHERE proposal_id = %s AND party_id = %s",
        (first, single),
    )

    handlers.match_run(cursor, job("match_run", {"flight_id": flight_id}))

    cursor.execute("SELECT status FROM proposals WHERE id = %s", (first,))
    assert cursor.fetchone()["status"] == "pending", "accepted proposal was superseded"


def test_a_second_identical_run_does_not_pile_up_duplicates(cursor):
    flight_id = make_flight(cursor, seat_map_key="B738")
    make_party(cursor, flight_id, 111, ["14A", "20C"], w_adjacency=200)
    make_party(cursor, flight_id, 222, ["14B"], w_window=60, w_avoid_middle=40)

    handlers.match_run(cursor, job("match_run", {"flight_id": flight_id}))
    handlers.match_run(cursor, job("match_run", {"flight_id": flight_id}))

    cursor.execute("SELECT count(*) AS n FROM proposals WHERE status = 'pending'")
    assert cursor.fetchone()["n"] == 1, "the same offer was made twice"


# ------------------------------------------------------------ expire_proposals
def test_expire_proposals_frees_the_parties(cursor):
    flight_id = make_flight(cursor, seat_map_key="B738")
    make_party(cursor, flight_id, 111, ["14A", "20C"], w_adjacency=200)
    make_party(cursor, flight_id, 222, ["14B"], w_window=60, w_avoid_middle=40)
    handlers.match_run(cursor, job("match_run", {"flight_id": flight_id}))

    cursor.execute("UPDATE proposals SET expires_at = now() - interval '1 minute'")
    result = handlers.expire_proposals(cursor, job("expire_proposals", {}))

    assert result["expired"] == 1
    cursor.execute("SELECT status FROM proposals")
    assert cursor.fetchone()["status"] == "expired"
    cursor.execute("SELECT DISTINCT state FROM parties WHERE flight_id = %s", (flight_id,))
    assert [r["state"] for r in cursor.fetchall()] == ["seated"], "parties not released"


def test_expire_proposals_leaves_live_ones_alone(cursor):
    flight_id = make_flight(cursor, seat_map_key="B738")
    make_party(cursor, flight_id, 111, ["14A", "20C"], w_adjacency=200)
    make_party(cursor, flight_id, 222, ["14B"], w_window=60, w_avoid_middle=40)
    handlers.match_run(cursor, job("match_run", {"flight_id": flight_id}))

    result = handlers.expire_proposals(cursor, job("expire_proposals", {}))
    assert result["expired"] == 0


def test_expire_proposals_requeues_itself(cursor):
    """No cron entry: the sweeper keeps itself alive."""
    handlers.expire_proposals(cursor, job("expire_proposals", {}))
    cursor.execute("SELECT type, run_after FROM jobs WHERE type = 'expire_proposals'")
    rows = cursor.fetchall()
    assert len(rows) == 1
    assert rows[0]["run_after"] > datetime.now(timezone.utc)


def test_expire_proposals_prunes_old_flight_creations(cursor):
    """The backstop for a quiet site: no Telegram id outlives the quota window
    by more than a day, even if nobody creates a flight to trigger the web
    tier's own pruning (CLAUDE.md §13)."""
    cursor.execute(
        "INSERT INTO flight_creations (telegram_user_id, created_at) VALUES "
        "(111, now() - interval '3 days'), (222, now() - interval '1 hour')"
    )
    result = handlers.expire_proposals(cursor, job("expire_proposals", {}))

    assert result["flight_creations_pruned"] == 1
    cursor.execute("SELECT telegram_user_id FROM flight_creations")
    assert [r["telegram_user_id"] for r in cursor.fetchall()] == [222], (
        "a row still inside the quota window must survive"
    )


# ---------------------------------------------------------------- purge_flight
def test_purge_flight_removes_every_personal_trace(cursor):
    """CLAUDE.md §13.4. This is the test that has to keep passing forever."""
    flight_id = make_flight(cursor, seat_map_key="B738")
    make_party(cursor, flight_id, 111, ["14A", "20C"], name="Anna B.", w_adjacency=200)
    make_party(cursor, flight_id, 222, ["14B"], name="Clara D.",
               w_window=60, w_avoid_middle=40)
    handlers.match_run(cursor, job("match_run", {"flight_id": flight_id}))
    cursor.execute("UPDATE proposals SET status = 'accepted'")
    cursor.execute("UPDATE parties SET state = 'settled'")

    result = handlers.purge_flight(cursor, job("purge_flight", {"flight_id": flight_id}))
    assert result["parties_deleted"] == 2

    for table in ("parties", "members", "proposal_parties", "proposal_assignments", "proposals"):
        cursor.execute(f"SELECT count(*) AS n FROM {table}")
        assert cursor.fetchone()["n"] == 0, f"{table} still holds data after a purge"

    # the flight itself survives (it is not personal data), as does the aggregate
    cursor.execute("SELECT count(*) AS n FROM flights WHERE id = %s", (flight_id,))
    assert cursor.fetchone()["n"] == 1


def test_purge_flight_keeps_an_anonymous_aggregate(cursor):
    flight_id = make_flight(cursor, seat_map_key="B738")
    make_party(cursor, flight_id, 111, ["14A", "20C"], w_adjacency=200)
    make_party(cursor, flight_id, 222, ["14B"], w_window=60, w_avoid_middle=40)
    handlers.match_run(cursor, job("match_run", {"flight_id": flight_id}))
    cursor.execute("UPDATE proposals SET status = 'accepted'")
    cursor.execute("UPDATE parties SET state = 'settled'")

    handlers.purge_flight(cursor, job("purge_flight", {"flight_id": flight_id}))

    cursor.execute("SELECT * FROM flight_stats WHERE flight_id = %s", (flight_id,))
    stats = cursor.fetchone()
    assert stats["party_count"] == 2
    assert stats["matched_party_count"] == 2
    assert stats["avg_gain"] > 0
    # nothing in the aggregate identifies anyone
    assert set(stats) == {"flight_id", "party_count", "matched_party_count",
                          "avg_gain", "purged_at"}


def test_purge_is_idempotent(cursor):
    """The job may be retried; a second run must not blow up on the aggregate."""
    flight_id = make_flight(cursor, seat_map_key="B738")
    make_party(cursor, flight_id, 111, ["14A"])
    handlers.purge_flight(cursor, job("purge_flight", {"flight_id": flight_id}))
    handlers.purge_flight(cursor, job("purge_flight", {"flight_id": flight_id}))

    cursor.execute("SELECT count(*) AS n FROM flight_stats WHERE flight_id = %s", (flight_id,))
    assert cursor.fetchone()["n"] == 1


def test_purge_does_not_touch_another_flight(cursor):
    keep = make_flight(cursor, "FR", "1234", date(2026, 10, 12), seat_map_key="B738")
    make_party(cursor, keep, 999, ["14A"])
    drop = make_flight(cursor, "W6", "3234", date(2026, 10, 12), seat_map_key="B738")
    make_party(cursor, drop, 111, ["14A"])

    handlers.purge_flight(cursor, job("purge_flight", {"flight_id": drop}))

    cursor.execute("SELECT count(*) AS n FROM parties WHERE flight_id = %s", (keep,))
    assert cursor.fetchone()["n"] == 1
