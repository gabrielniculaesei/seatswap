# seatswap

> Working name. The project is greenfield; see `CLAUDE.md` for the full design
> rationale and the decisions that are already settled.

Passengers on the **same flight** declare, ahead of time, the seat they have and
the seat they want. A solver finds swaps — and **chains of swaps** — in which
every participant ends up better off. No money changes hands, and nobody
negotiates with anybody.

The output is an agreement screen you show each other at the gate. The trade was
closed before boarding.

---

## Why this is a real problem and not a toy

Airlines split groups apart on purpose: seat selection is ancillary revenue, so
the default allocation scatters a family and sells them the fix. Everyone has
watched the result — a stranger in the aisle being asked to give up the seat they
paid for, by someone who has no way to compensate them.

The interesting part is that **the two sides of this market want different
things**, and that is what makes a free trade possible:

| | cares about | does not care about |
|---|---|---|
| a split group | sitting together | which seat, exactly |
| a solo traveller | window / aisle / not-the-middle | who sits where else |

A group's utility is nearly **orthogonal** to a single traveller's. So the group
can pay the single traveller in a currency — seat quality — that costs the group
essentially nothing. The trade creates value; it does not move a disappointment
from one person to another.

That is also why the product is positioned as *"upgrade your seat for free"* and
not as *"help reunite families"*. A favour-based framing gives the people who own
the good seats no reason to show up.

### Nobody ever asks anybody for a favour

Every preference is declared in advance, and the solver is constrained so that
**no party can end up worse off than it is now** (individual rationality), and so
that **any party that moves gains a real amount** — not a token — for doing so.

The consequence is that there is no social pressure anywhere in the product,
because there is no favour to grant. There is only an improvement to accept or
decline.

---

## Status

| Milestone | | |
|---|---|---|
| **M0** Schema, migrations, seat geometry | ✅ | `db/`, `web/lib/seatmap.ts`, `solver/seatmap.py` |
| **M1** Solver, cycle decomposition, simulator | ✅ | `solver/` |
| **M2** Next.js flight page, Telegram auth, sign-up | ✅ | `web/app/` |
| **M3** Worker, job queue, AeroDataBox | ✅ | `solver/worker.py`, `handlers.py` |
| **M4** Telegram bot, proposals, agreement screen | ✅ | `web/app/api/telegram/`, `a/[token]` |
| M5 BCBP parsing, verification badge, GDPR purge | ⬜ | |
| M6 i18n, SEO, docs | ⬜ | |

The solver was built before any UI on purpose. It is the part that either works or
does not, and it can be proven out on synthetic flights without a single user.
M3 came before M2 for the same reason: it is what turns the solver from a library
into a service, and none of it depends on what the pages look like.

300 tests — 231 Python and 69 TypeScript, of which 75 need a real Postgres. Without
a database those skip and everything else still runs, so a machine without Postgres
can still check everything that does not need one.

---

## The algorithm

The pool of reassignable seats is **exactly the seats the participants already
occupy** — never an empty seat on the map, because we do not control those and the
airline can sell one at any moment. So a solution is a **permutation** of that
pool, which is what makes the whole thing tractable and safe.

A CP-SAT model (OR-Tools) maximises total utility gain subject to:

1. every member gets exactly one seat, and every seat goes to at most one member;
2. a party counts as "together" only if its members hold contiguous seats **on the
   same side of the aisle** — 14C and 14D are neighbours on a seat map and not on
   an aeroplane;
3. **individual rationality**: `U_p(new) ≥ U_p(current)` for every party;
4. **minimum gain**: a party that moves must gain at least `MIN_GAIN`, so nobody is
   shuffled for nothing in order to unblock somebody else.

Constraint 4 is doing more work than it looks. Here is the solver refusing a
higher-scoring solution because it would have moved someone for zero benefit:

```
Anna + Ben  14A, 20C   split, only want to sit together    (w_adjacency = 200)
Clara       14B        middle seat, wants a window          (w_window = 60, w_avoid_middle = 40)
Dan         20B        middle seat, wants an aisle          (w_aisle  = 60, w_avoid_middle = 40)

  →  Anna + Ben  20C → 14B   together in 14A + 14B   +200
     Clara       14B → 20C   aisle instead of middle  +40
     Dan         stays put                              0
```

Total utility would have been higher if Dan had moved to 14B and Clara had taken
the window at 14A — but Dan would have gained nothing from the move. That is a
favour wearing a disguise, and the model will not ask for it.

### Chains are the reason this is not a swap board

A noticeboard where people post "swapping 20A for an aisle" only ever finds trades
between two people. Plenty of value is invisible to it:

```
P1  20A   window, wants an aisle
P2  20C   aisle,  wants to be near the front
P3   2B   middle at the front, wants a window
```

Every **two-party** trade here is refused, because in each one the other person
gains nothing: P1↔P2 leaves P2 in another row-20 seat, P1↔P3 leaves P1 in a
middle, P2↔P3 leaves P3 on an aisle. Nobody would agree to any of them.

Rotate all three at once and everyone is better off:

```
P1  20A → 20C    aisle          +60
P2  20C →  2B    front row       +56
P3   2B → 20A    window          +60
```

That trade cannot be discovered by talking to your neighbour, and it cannot be
executed by two people agreeing. It needs someone holding the whole flight at
once. (This example is a test, not a hypothetical:
`solver/tests/test_simulator.py::test_baseline_cannot_close_a_three_party_chain`.)

### Cycles, and why they are kept short

The optimum is a permutation, and every permutation decomposes into disjoint
cycles. Each cycle is **closed** — the seats it releases are exactly the seats it
takes — so each one can be accepted or declined on its own without affecting the
others. That is what `solver/cycles.py` produces: one proposal per cycle.

The simulator then turned up something the design had not anticipated. Maximising
total utility on a busy flight does not produce several independent cycles — it
produces **one enormous one**, averaging 18 parties. A proposal is atomic, so that
is eighteen people who all have to press Accept. At 90 % acceptance each, it closes
15 % of the time. A three-party cycle closes 73 % of the time.

So the solver caps how many parties may move in a single solve, and a match run
**solves in rounds**, re-running over the parties left untouched
(`solver/match_run.py`). Measured at 25 % participation:

| parties per proposal | mean cycle | proposals per flight | groups reunited | × P(all accept) |
|---|---|---|---|---|
| uncapped | 18.1 | 1.0 | 33 % | 5 % |
| 6 | 4.8 | 2.7 | 26 % | 16 % |
| **4** (default) | **3.6** | **3.4** | **20 %** | **14 %** |
| 3 | 2.8 | 4.2 | 19 % | 14 % |
| 2 | 2.0 | 4.7 | 8 % | 7 % |

It gives up total utility on paper and gets roughly three times as much of it in
practice. The cap of 2 — pure two-party swaps — collapses back to the baseline,
which is the measurement that says the chains are the product.

### When the solver runs

Not on every sign-up. Firing the first decent two-way swap burns a seat that ten
minutes later could have completed a much better three-way chain — the same reason
kidney-exchange programmes batch their matching instead of running it continuously.

- an **immediate** run happens on every seat submission, but only emits if every
  party involved has reached its theoretical best;
- **scheduled** runs at T-20h, T-12h and T-4h emit the best available.

---

## What the simulator says

`solver/simulator.py` generates synthetic flights with a realistic mix of party
sizes and preferences, sweeps the share of the cabin that participates, and runs
the real solver. It is the honest, quantitative way to talk about cold start: it
gives the participation threshold below which this product simply does not work.

It also runs a deliberately strong **baseline** — greedy, mutually-improving
swaps between two people only, obeying the same rules — which is the closest
thing to "what you could arrange yourself by asking a neighbour". The gap between
the two lines is the value the algorithm actually adds.

```bash
cd solver
python simulator.py --flights 200 --participation 0.02:0.40:0.02 \
    --out ../docs/liquidity.png --json ../docs/liquidity.json
```

![success rate vs participation density](docs/liquidity.png)

Three findings, from 800 synthetic flights:

**Below roughly 8 % of a cabin this does not work.** At 4 % participation — eight
passengers on a 737-800 — 3 % of the groups that wanted to sit together get to.
There is nobody to trade with. The threshold to aim at is **10 % of one cabin,
about twenty passengers**, where it jumps to 13 %. It is a *per-flight* threshold:
a thousand users scattered across Europe are worth nothing, twenty on one flight
are worth everything.

**Maximising total welfare makes the product worse the more popular it gets.**
This is the result that changed the design. An uncapped solve reunites far more
groups on paper — 57 % against 33 % at 40 % participation — but its mean cycle
grows to 28 parties, and the chance that all 28 accept collapses faster than the
gains grow. Its delivered value *peaks around 10 % participation and then falls*,
to 3.3 % at 40 %, while the capped version climbs to 22 %. Capping turns a
strategy that degrades with success into one that improves with it.

**The chains are the product.** Two-party swaps — the strongest version of "just
ask your neighbour", run to exhaustion under the same fairness rules — reunite
4.8 % of groups at 10 % participation against 13.3 % for the solver, and lose
across the entire range. They enjoy the best possible acceptance odds, being only
ever two people, and still lose.

Full numbers, method and caveats in [`docs/liquidity.md`](docs/liquidity.md).

---

## Signing up

The flight page is server-rendered and lives at a link you can paste into a group
chat: `/f/W6-3234/2026-10-12`. Anyone can open it, and anyone can see how busy the
flight is — **counts only, never names or seats**, because looking alive matters
for a product whose whole problem is liquidity, and because a stranger has no
business knowing who is on your aircraft.

Signing in is the Telegram Login Widget: one click, no password, no email, and no
phone number ever reaches us. That last part is the reason it is Telegram rather
than SMS or WhatsApp — joining a group chat would expose your number to strangers
who also know exactly when you are away from home.

Then three questions, which fill in the weights from §8: how many of you, how much
sitting together matters, which seat you would rather have. **Never a slider and
never free text.** A slider invites a precision nobody has, and free text cannot be
optimised over. The browser sends *answers*; the server decides what they are
worth — otherwise anyone could post themselves a `w_adjacency` of 10000 and
monopolise every match run.

No seat is asked for here. Weeks before departure there is no seat to give: the
airline assigns it at check-in, and that is when the bot asks.

## Closing the loop

When check-in opens the bot asks for your seat. You reply `14A` — or `14A, 22F`, or
`we're in 14A and 22F`, or `W6 3234: 14A, 22F` if you have more than one flight in
the air. The parser is deliberately generous, because you are answering this in an
airport and you are doing us a favour by answering at all.

Then, if the solver finds something, a message with two buttons.

**A proposal is atomic: it happens when everyone in the cycle accepts, and not
before.** One decline ends it for all of them. That sounds harsh, and it is the
only coherent rule — a cycle with a hole in it would leave somebody moving into a
seat that nobody is vacating. Nobody is worse off when it fails, because until
people physically sit down the airline's own allocation is untouched.

The same reasoning settles what happens if you accept and then pull out: the cycle
dies for everyone and a fresh match run starts looking immediately. Its mirror
image is a rule the worker already enforces — **a proposal somebody has already
accepted is never superseded**, however good a later idea the solver has.

When the last person accepts, everyone gets a link to `/a/<token>`: a page with the
flight, the names and who moves where. That page is the product's entire output.
It needs no login, because the point is that you can hold up a phone at the gate.
The token is 128 random bits, it is `noindex`, and it stops existing when
`purge_flight` runs.

## The worker

One process, polling one table. `FOR UPDATE SKIP LOCKED` means several workers can
share the queue without ever being handed the same job, and it costs one index —
no broker, no scheduler daemon, no cron.

| job | when | what it does |
|---|---|---|
| `verify_flight` | a flight is first mentioned | one AeroDataBox call, fills in route, aircraft and times, then queues everything below |
| `checkin_reminder` | check-in opens | asks each registered party for their seats |
| `match_run` | T-20h, T-12h, T-4h, and on every seat submission | solves, writes proposals |
| `expire_proposals` | every 10 minutes | times out stale offers, frees their parties, re-queues itself |
| `purge_flight` | departure + 24h | deletes every personal trace of the flight |

Each job runs in one transaction: raise and the work is rolled back and retried
with backoff, return and the result commits together with the job being marked
done. Telegram calls sit deliberately outside that boundary — they cannot be
rolled back, and an unannounced proposal is recoverable where a rolled-back match
run is just wasted work.

There is no cron anywhere. `verify_flight` queues a flight's whole life the moment
its departure time is known, and `expire_proposals` re-queues itself.

### Replacing an offer that is already on the table

A match run can find something better for someone who is already looking at a
proposal. Two rules decide what happens, and both are about not being rude:

- a new proposal replaces a live one only if **every** party it touches does
  strictly better;
- a proposal that **anyone has already accepted** is never superseded, whatever
  the solver finds afterwards.

## Architecture

Two processes and a database. That is the whole thing.

```
Next.js (TS) on Vercel  ──►  Telegram Bot API  (login + notifications)
        │
        ▼
   Postgres (Neon)  ◄──jobs──►  solver worker (Python, OR-Tools CP-SAT)
        │
        ▼
   AeroDataBox  (one call per flight, cached hard)
```

The web tier never runs the solver in-request; it enqueues a job. The worker polls
the `jobs` table with `FOR UPDATE SKIP LOCKED`. **Postgres is the queue** — no
Redis, no Celery, one fewer moving part.

### Why web and not a native app

The product is used twice a year for twenty minutes. Nobody installs an app for
that. The web gives the one thing that matters: a **shareable link**
(`/f/W6-3234/2026-10-12`) that goes into a WhatsApp group, gets posted to Reddit,
and is indexed by Google. Flight-number searches are the only acquisition channel
with the right granularity, so flight pages are server-rendered.

The single weakness of the web — push notifications on iOS — is covered by the
Telegram bot.

---

## Privacy

These are design constraints, not a policy page written afterwards.

- **No phone numbers, ever.** That is why authentication is Telegram and not SMS
  or WhatsApp. Joining a WhatsApp group would expose your number to strangers who
  also know when you are not at home — an unacceptable trade for a product whose
  entire purpose is avoiding an awkward moment.
- **No full names.** Only a display name you choose, 40 characters, nickname or
  first name plus an initial.
- **Raw boarding-pass barcodes are never stored.** Parsed in the browser, the
  useful fields extracted, everything else discarded — including the passenger
  name the barcode contains.
- **Automatic deletion.** A `purge_flight` job runs 24 hours after departure and
  deletes parties, members, proposals and assignments. What survives is one
  anonymous aggregate row per flight.
- No third-party trackers. No Google Analytics.
- No personal data in URLs. The agreement token is 128 random bits and expires.

### On boarding-pass verification

Boarding-pass barcodes follow IATA BCBP (Resolution 792) and contain the flight,
the seat and the passenger name. We can read one. We **cannot prove it is real**:
the standard's security section is optional, almost no airline uses it, and the
keys are not public.

So verification is a **badge, never a gate** — no tier is required to take part.
What actually raises the cost of a fake is the cross-checks: the flight has to
exist that day on that route, the seat has to exist on that aircraft type, and
**a seat belongs to exactly one person per flight** (a database constraint). That
last one is the good one, and it is free: seats are scarce, so a Sybil attack has
to burn real seats.

---

## Development

```bash
# database and worker
cp .env.example .env
docker compose up -d                 # postgres + worker
npm install --prefix web
npm run migrate --prefix web

# web
npm run dev --prefix web             # :3000
npm test --prefix web                # auth, sessions, seat and URL parsing
TEST_DATABASE_URL=postgres://… npm run test:db --prefix web   # proposals, seat submission

# solver and worker, outside docker
cd solver
python3.13 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m pytest
.venv/bin/python worker.py           # poll forever
.venv/bin/python worker.py --once    # drain the queue and exit
```

The database tests need somewhere to run. They `TRUNCATE`, so point them at a
throwaway database and never at anything real:

```bash
TEST_DATABASE_URL=postgres://seatswap:seatswap@localhost:5432/seatswap_test \
  .venv/bin/python -m pytest
```

Without it they skip. AeroDataBox is in fixture mode by default
(`AERODATABOX_MODE=fixture`), so neither the tests nor local development ever
open a socket to it — set `live` only in production.

To point Telegram at the webhook, once per deployment:

```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H 'Content-Type: application/json' \
  -d "{\"url\": \"$PUBLIC_BASE_URL/api/telegram/webhook\",
       \"secret_token\": \"$TELEGRAM_WEBHOOK_SECRET\",
       \"allowed_updates\": [\"message\", \"callback_query\"]}"
```

The secret token is not optional. Telegram sends it back as a header on every
request, and without checking it the endpoint is an unauthenticated way to act as
any user — the payload names its own `chat.id`.

The solver and the web app **share one seat-map file** (`web/config/seatmaps.json`)
and implement the utility function twice, in TypeScript for the UI preview and in
Python for the solver. `solver/tests/test_cross_language.py` runs the same cases
through both and asserts the integers are identical — if they ever drift, the UI
would promise a gain the solver never optimised for.

---

## Non-goals

No payments. No reputation, ratings or stars. No native apps. No chat. No Kafka,
Kubernetes, microservices or Redis. No machine learning in the solver — this is
combinatorial optimisation, not prediction. The reasoning for each is in
`CLAUDE.md`.
