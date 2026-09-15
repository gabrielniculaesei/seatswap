"""Minimal Telegram Bot API client.

Direct HTTP with the standard library, no wrapper package: the whole surface we
need is sendMessage plus an inline keyboard, and CLAUDE.md §12 asks for one fewer
dependency where the choice is close.

Privacy rules that this module has to enforce, because it is the only place that
formats text about other people (CLAUDE.md §13):

* only `display_name` ever appears - never a real name, never a passenger name
  parsed out of a boarding pass;
* no phone numbers exist anywhere in this system to leak;
* seat numbers are fine: they are the thing being traded, and they stop being
  personal 24 hours after departure when purge_flight runs.

With no TELEGRAM_BOT_TOKEN set the client runs in dry mode and returns the
payloads it would have sent, which is what the tests use.
"""

from __future__ import annotations

import json
import logging
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass

log = logging.getLogger(__name__)

API_BASE = "https://api.telegram.org"
REQUEST_TIMEOUT = 10.0
MAX_RETRIES = 3


class TelegramError(RuntimeError):
    pass


@dataclass
class SentMessage:
    chat_id: int
    text: str
    reply_markup: dict | None = None
    delivered: bool = False


def token() -> str | None:
    value = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    return value or None


def enabled() -> bool:
    return token() is not None


def send_message(
    chat_id: int,
    text: str,
    reply_markup: dict | None = None,
) -> SentMessage:
    """Send one message. Never raises: a failed notification must not fail a job.

    A proposal that was written to the database but not announced is recoverable -
    the next match run or a page refresh will surface it. A match run rolled back
    because Telegram had a bad minute is not.
    """
    message = SentMessage(chat_id=chat_id, text=text, reply_markup=reply_markup)
    bot_token = token()
    if bot_token is None:
        log.info("telegram dry mode, would send to %s: %s", chat_id, text)
        return message

    payload = {"chat_id": chat_id, "text": text, "parse_mode": "HTML"}
    if reply_markup:
        payload["reply_markup"] = reply_markup

    request = urllib.request.Request(
        f"{API_BASE}/bot{bot_token}/sendMessage",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )

    for attempt in range(MAX_RETRIES):
        try:
            with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT) as response:
                body = json.loads(response.read().decode("utf-8"))
            if body.get("ok"):
                message.delivered = True
                return message
            log.warning("telegram refused the message: %s", body.get("description"))
            return message
        except urllib.error.HTTPError as error:
            # 403 means the user blocked the bot. Nothing to retry, and nothing
            # to fix: they have opted out and that is a legitimate answer.
            if error.code == 403:
                log.info("chat %s has blocked the bot", chat_id)
                return message
            if error.code not in (429, 500, 502, 503, 504):
                log.warning("telegram HTTP %s", error.code)
                return message
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            log.warning("telegram unreachable: %s", error)

        if attempt < MAX_RETRIES - 1:
            time.sleep(2**attempt)

    return message


def accept_reject_keyboard(proposal_id: int) -> dict:
    """The two inline buttons on a proposal (CLAUDE.md §7.7).

    Callback data is `proposal:<id>:accept|reject`; the webhook in M4 parses it and
    checks that the presser is actually in the proposal.
    """
    return {
        "inline_keyboard": [
            [
                {"text": "Accept", "callback_data": f"proposal:{proposal_id}:accept"},
                {"text": "Decline", "callback_data": f"proposal:{proposal_id}:reject"},
            ]
        ]
    }


def format_proposal(
    designator: str,
    departure_date: str,
    your_moves: list[tuple[str, str]],
    other_parties: list[str],
    gain: int,
    total_parties: int,
) -> str:
    """The proposal message for one party.

    Deliberately states what *they* get first and the mechanics second. Nobody is
    being asked for a favour, so the message must not read like a request for one.
    """
    moves = "\n".join(f"  {frm} → <b>{to}</b>" for frm, to in your_moves)
    others = ", ".join(other_parties) if other_parties else "one other traveller"

    if total_parties == 2:
        shape = "a straight swap with " + others
    else:
        shape = f"a {total_parties}-way swap with {others}"

    return (
        f"<b>{designator}</b> on {departure_date}\n\n"
        f"A better seat is available:\n{moves}\n\n"
        f"This is {shape}. Everyone involved improves — "
        f"nobody is giving anything up.\n\n"
        f"If everyone accepts, you will each get a page to show at the gate."
    )


def format_checkin_reminder(
    designator: str,
    departure_date: str,
    flight_url: str | None = None,
    estimated: bool = False,
) -> str:
    """The message that opens phase two (CLAUDE.md §7.5).

    It offers typing, because typing is the ten-second answer this whole design
    exists to protect. The boarding-pass route is a link rather than "send me a
    photo": a barcode mailed to the bot would be a barcode on our servers, and
    CLAUDE.md §10 and §13.1 both say it is read in the browser and never sent.

    `estimated` means we never learned the departure time and are sending this at
    the earliest check-in could open (aerodatabox.estimated_schedule). "Check-in
    is open" might then be a few hours early, so it says what we actually know.
    """
    opening = (
        f"Check-in for <b>{designator}</b> on {departure_date} opens around now. "
        f"Once the airline has given you a seat, send it to me and I will look "
        f"for a swap"
        if estimated
        else f"Check-in is open for <b>{designator}</b> on {departure_date}.\n\n"
        f"Send me your seat numbers and I will look for a swap"
    )
    text = (
        f"{opening} — just the seats, like <code>14A</code> or <code>14A, 22F</code>."
    )
    if flight_url:
        text += (
            f"\n\nRather scan your boarding pass? Do it on the flight page: "
            f"{flight_url}\nIt reads the barcode in your browser, fills the seats "
            f"in for you, and earns a checked badge."
        )
    return text


def format_agreement(base_url: str, token_value: str) -> str:
    return (
        "Everyone accepted. Here is your agreement:\n"
        f"{base_url}/a/{token_value}\n\n"
        "Show it to each other on board. Nothing else to do."
    )
