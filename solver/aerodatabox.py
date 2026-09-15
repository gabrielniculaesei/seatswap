"""AeroDataBox wrapper (CLAUDE.md §11).

The one rule that is not negotiable: **one call per flight, never one per user.**
The result is cached on the `flights` row and every later reader uses that. The
free Basic plan on RapidAPI is 400 units a month and the flight-status endpoint
is Tier 2, two units a call: about 200 new flights a month. With this rule that
is a real launch; without it you burn through it in an afternoon.

This is the only place in the codebase that talks to AeroDataBox. The web tier
never calls it in-request - it creates the flight row as 'unknown' and queues a
`verify_flight` job - which keeps a third-party API out of the server-rendered
flight pages and makes the one-call-per-flight rule structural rather than a
convention somebody has to remember.

If the API is down, slow, or has never heard of the flight: **degrade, do not
block.** `api_status` becomes 'unknown', the seat map falls back to `_default`,
and the user takes part anyway.

Three modes, from `AERODATABOX_MODE`:

  off      no calls at all; every flight is 'unknown'. The default, and the right
           setting until there is a key: the date-based estimate in
           estimated_schedule() keeps every flight working.
  fixture  reads solver/fixtures/, never opens a socket. Development and tests.
  live     calls the API with RAPIDAPI_KEY.

`off` is the default, not `fixture`, because the fixture's `_default.json`
answers for *every* flight with an invented route, aircraft and departure time
and marks it verified. A deploy that forgot to set the mode would have told the
world, in structured data, that every flight leaves at 05:40 — and scheduled
each flight's GDPR purge from that invented time.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
_FIXTURE_DIR = Path(os.environ.get("AERODATABOX_FIXTURES", Path(__file__).parent / "fixtures"))
_CARRIERS_PATH = Path(
    os.environ.get("CARRIERS_PATH", _REPO_ROOT / "web" / "config" / "carriers.json")
)

API_HOST = "aerodatabox.p.rapidapi.com"
REQUEST_TIMEOUT = 10.0
MAX_RETRIES = 3

#: Substring of AeroDataBox's free-text aircraft model -> our seat map key.
#: Ordered: the first match wins, so put the specific variants first.
AIRCRAFT_ALIASES: tuple[tuple[str, str], ...] = (
    ("737-8200", "B38M"),
    ("737 max 8200", "B38M"),
    ("737-800", "B738"),
    ("737-8", "B38M"),
    ("737", "B738"),
    ("a321", "A321"),
    ("321", "A321"),
    ("a320", "A320"),
    ("320", "A320"),
)


class AeroDataBoxError(RuntimeError):
    """The API could not be reached or returned something unusable."""


@dataclass(frozen=True)
class FlightInfo:
    status: str  # 'verified' | 'not_found' | 'unknown'
    origin: str | None = None
    destination: str | None = None
    aircraft_type: str | None = None
    seat_map_key: str | None = None
    scheduled_departure_utc: datetime | None = None

    @property
    def verified(self) -> bool:
        return self.status == "verified"


UNKNOWN = FlightInfo(status="unknown")


# --------------------------------------------------------------------- helpers
@lru_cache(maxsize=1)
def _carriers() -> dict:
    with open(_CARRIERS_PATH, encoding="utf-8") as handle:
        return json.load(handle)


def checkin_opens(carrier: str, scheduled_departure_utc: datetime) -> datetime:
    """Departure minus the carrier's check-in window.

    Hardcoded per carrier because no API exposes it (CLAUDE.md §11).
    """
    carriers = _carriers()
    policy = carriers.get(carrier.upper()) or carriers["_default"]
    return scheduled_departure_utc - timedelta(hours=policy["checkin_opens_hours_before"])


def seat_map_key_for(aircraft_model: str | None) -> str | None:
    """Map AeroDataBox's free-text model to a seat map key, or None if unrecognised.

    None is a perfectly good answer: load_seat_map(None) returns the generic
    narrow-body and flags the layout as estimated in the UI.
    """
    if not aircraft_model:
        return None
    haystack = aircraft_model.lower()
    for needle, key in AIRCRAFT_ALIASES:
        if needle in haystack:
            return key
    return None


def _parse_utc(value: str | None) -> datetime | None:
    """AeroDataBox returns '2026-10-12 06:15Z' or ISO-8601. Accept both."""
    if not value:
        return None
    text = value.strip().replace("Z", "+00:00")
    if " " in text and "T" not in text:
        text = text.replace(" ", "T", 1)
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


@dataclass(frozen=True)
class EstimatedSchedule:
    """Stand-in times for a flight whose departure we never learned."""

    #: When the web shows the seat form and the bot asks for seats.
    checkin_opens_utc: datetime
    #: Plays the departure's part in scheduling the T-20h/12h/4h match runs.
    anchor_utc: datetime
    #: When purge_flight deletes everything personal about the flight.
    purge_utc: datetime


def estimated_schedule(carrier: str, departure_date: date) -> EstimatedSchedule:
    """A schedule from the departure *date* alone, for when the API gave no time.

    Without it an unverified flight had no lifecycle at all: no check-in reminder,
    no seat form, no scheduled match runs — and no purge_flight, so its personal
    data was never deleted. "Degrade, do not block" (CLAUDE.md §11) has to cover
    the clock too, not just the seat map.

    Each time errs in the direction that is safe for what it drives:

      * check-in and match runs are anchored to 00:00 UTC on the departure date,
        about the earliest a European departure can be. The reminder may come a
        few hours before check-in really opens — its wording says "today" — but
        every scheduled run lands before the first flight of that day leaves.
      * the purge is anchored to the *latest* the flight could possibly depart,
        23:59 local time at UTC-12, which is 36 hours after that midnight, plus
        the usual 24. Deleting late is a bug; deleting early would destroy
        someone's agreed swap before they board.
    """
    midnight = datetime(
        departure_date.year, departure_date.month, departure_date.day, tzinfo=timezone.utc
    )
    return EstimatedSchedule(
        checkin_opens_utc=checkin_opens(carrier, midnight),
        anchor_utc=midnight,
        purge_utc=midnight + timedelta(hours=36 + 24),
    )


def mode() -> str:
    return os.environ.get("AERODATABOX_MODE", "off").strip().lower()


# ----------------------------------------------------------------------- lookup
def lookup(carrier: str, flight_number: str, departure_date: date) -> FlightInfo:
    """Look a flight up. Never raises: an unusable answer is 'unknown'."""
    designator = f"{carrier.upper()}{flight_number}"
    iso_date = departure_date.isoformat()

    current = mode()
    if current not in ("fixture", "live"):
        # 'off', and anything misspelt: never call out on a guess.
        return UNKNOWN

    try:
        if current == "fixture":
            payload = _read_fixture(designator, iso_date)
        else:
            payload = _fetch_live(designator, iso_date)
    except FileNotFoundError:
        return FlightInfo(status="not_found")
    except AeroDataBoxError:
        return UNKNOWN

    return _normalise(payload)


def _normalise(payload: object) -> FlightInfo:
    """Pull the four fields we care about out of the response and drop the rest.

    AeroDataBox returns a lot about a flight. We keep the route, the aircraft and
    the departure time; none of it is personal and none of the rest is useful.
    """
    if isinstance(payload, list):
        if not payload:
            return FlightInfo(status="not_found")
        payload = payload[0]
    if not isinstance(payload, dict):
        return UNKNOWN

    departure = payload.get("departure") or {}
    arrival = payload.get("arrival") or {}
    aircraft = payload.get("aircraft") or {}

    scheduled = departure.get("scheduledTime") or {}
    scheduled_utc = _parse_utc(scheduled.get("utc") if isinstance(scheduled, dict) else scheduled)

    model = aircraft.get("model")
    return FlightInfo(
        status="verified",
        origin=_iata(departure.get("airport")),
        destination=_iata(arrival.get("airport")),
        aircraft_type=model,
        seat_map_key=seat_map_key_for(model),
        scheduled_departure_utc=scheduled_utc,
    )


def _iata(airport: object) -> str | None:
    if isinstance(airport, dict):
        code = airport.get("iata")
        return code.upper() if isinstance(code, str) and len(code) == 3 else None
    return None


def _read_fixture(designator: str, iso_date: str) -> object:
    """Fixtures are named <DESIGNATOR>_<YYYY-MM-DD>.json, with a fallback.

    `_default.json` stands in for any flight without its own file, so a test can
    make up a flight number without also having to invent a response for it.
    """
    specific = _FIXTURE_DIR / f"{designator}_{iso_date}.json"
    generic = _FIXTURE_DIR / f"{designator}.json"
    fallback = _FIXTURE_DIR / "_default.json"

    for candidate in (specific, generic, fallback):
        if candidate.exists():
            with open(candidate, encoding="utf-8") as handle:
                return json.load(handle)
    raise FileNotFoundError(f"no fixture for {designator} on {iso_date}")


def _fetch_live(designator: str, iso_date: str) -> object:
    """One HTTP call, with backoff. Raises AeroDataBoxError rather than leaking
    urllib exceptions to callers."""
    key = os.environ.get("RAPIDAPI_KEY")
    if not key:
        raise AeroDataBoxError("RAPIDAPI_KEY is not set but AERODATABOX_MODE=live")

    url = f"https://{API_HOST}/flights/number/{designator}/{iso_date}"
    request = urllib.request.Request(
        url,
        headers={
            "X-RapidAPI-Key": key,
            "X-RapidAPI-Host": API_HOST,
            "Accept": "application/json",
        },
    )

    last_error: Exception | None = None
    for attempt in range(MAX_RETRIES):
        try:
            with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            if error.code == 404:
                raise FileNotFoundError(designator) from error
            # 429 and 5xx are worth another go; a 400 never is.
            if error.code not in (429, 500, 502, 503, 504):
                raise AeroDataBoxError(f"HTTP {error.code}") from error
            last_error = error
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            last_error = error

        if attempt < MAX_RETRIES - 1:
            time.sleep(2**attempt)

    raise AeroDataBoxError(f"giving up after {MAX_RETRIES} attempts: {last_error}")
