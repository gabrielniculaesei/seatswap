"""AeroDataBox wrapper (CLAUDE.md §11).

The one rule that is not negotiable: **one call per flight, never one per user.**
The result is cached on the `flights` row and every later reader uses that. The
free tier is around 600 units a month; with this rule that covers hundreds of
flights, without it you burn through it in an afternoon.

This is the only place in the codebase that talks to AeroDataBox. The web tier
never calls it in-request - it creates the flight row as 'unknown' and queues a
`verify_flight` job - which keeps a third-party API out of the server-rendered
flight pages and makes the one-call-per-flight rule structural rather than a
convention somebody has to remember.

If the API is down, slow, or has never heard of the flight: **degrade, do not
block.** `api_status` becomes 'unknown', the seat map falls back to `_default`,
and the user takes part anyway.

In development and in tests, `AERODATABOX_MODE=fixture` reads from
solver/fixtures/ and never opens a socket.
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


def mode() -> str:
    return os.environ.get("AERODATABOX_MODE", "fixture").strip().lower()


# ----------------------------------------------------------------------- lookup
def lookup(carrier: str, flight_number: str, departure_date: date) -> FlightInfo:
    """Look a flight up. Never raises: an unusable answer is 'unknown'."""
    designator = f"{carrier.upper()}{flight_number}"
    iso_date = departure_date.isoformat()

    try:
        if mode() == "fixture":
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
