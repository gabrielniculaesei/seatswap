# How seatswap works

The technical side of [seatswap](../README.md): the matching model, what the
simulator found, how the system is put together, and how it handles personal data.

Comments in the code sometimes refer to sections of an internal design document,
for example `CLAUDE.md §14`. That document is not published.

## Why the trade is free

Airlines split groups up on purpose, because seat selection is a source of
revenue. The usual result is a stranger in the aisle being asked to give up a seat
they chose, by someone with nothing to offer in return.

The two sides of that situation want different things:

| | cares about | does not care about |
|---|---|---|
| a split group | sitting together | which seats exactly |
| a solo traveller | window, aisle, not the middle | who sits around them |

Since a group's preferences barely overlap with a solo traveller's, the group can
pay in a currency that costs it nothing: seat quality. The trade creates value
instead of moving a bad seat from one person to another.

That is also why the product is pitched as "get a better seat for free" and not
"help families sit together". A request for favours gives the people holding the
good seats no reason to sign up. An upgrade does.

Every preference is declared in advance, and the solver never proposes a swap that
leaves anyone worse off. Nobody is asked for a favour. People are only offered an
improvement, which they can accept or decline.

## The solver

The solver can only hand out the seats the participants already hold. Empty seats
are never offered, since they belong to the airline and can be sold at any moment.
A solution is therefore a reshuffle (a permutation) of the seats in the pool.

The model uses Google OR-Tools CP-SAT and maximises the total gain in utility,
subject to these rules:

1. every passenger gets exactly one seat, and no seat goes to two people;
2. a group counts as seated together only if its seats are next to each other
   **on the same side of the aisle**: 14C and 14D are neighbours on a seat map,
   not in a cabin;
3. **individual rationality**: no party ends up worse off than it is now;
4. **minimum gain**: a party that moves must gain a meaningful amount, so nobody is
   shuffled around just to make room for someone else;
5. **no children in exit rows**: a party with children never gets more exit-row
   seats than it has adults, unless the airline already seated it there.

Each party's utility is a weighted sum of seat features (window, aisle, not the
middle, near the front, away from the toilets) plus a large bonus for sitting
together. The weights come from the sign-up questions. The browser only sends the
answers, and the server decides what they are worth, so nobody can give themselves
an inflated weight. Everything is computed in integers, as CP-SAT requires.

### Chains

A noticeboard where people post "swapping 20A for an aisle" can only find trades
between two people, and a lot of value is invisible to it:

```
P1  20A   window, wants an aisle
P2  20C   aisle, wants to be near the front
P3   2B   middle seat at the front, wants a window
```

Every two-person trade here fails, because one side gains nothing from it. Rotate
all three and everyone gains:

```
P1  20A -> 20C   aisle       +60
P2  20C ->  2B   front row   +56
P3   2B -> 20A   window      +60
```

No two of these people could have arranged this between themselves. It takes
something that can see the whole flight at once. This example is a test case in
`solver/tests/test_simulator.py`.

### Keeping proposals small

Every permutation splits into separate cycles, and each cycle frees exactly the
seats it takes. So each cycle becomes its own proposal, which can be accepted or
declined without affecting the others (`solver/cycles.py`).

The simulator showed a problem with the straightforward model. On a busy flight,
maximising total utility does not produce several small cycles. It produces one
very large one, averaging 18 parties. A proposal only goes ahead if everyone in it
accepts, and if each person accepts nine times out of ten, an 18-party proposal
goes ahead 15% of the time. A three-party proposal goes ahead 73% of the time.

So a single solve may move at most four parties, and a match run solves in rounds
over the parties still unmatched (`solver/match_run.py`). At 25% participation:

| parties per proposal | mean cycle length | proposals per flight | groups reunited | reunited and accepted |
|---|---|---|---|---|
| no limit | 18.1 | 1.0 | 33% | 5% |
| 6 | 4.8 | 2.7 | 26% | 16% |
| **4 (default)** | **3.6** | **3.4** | **20%** | **14%** |
| 3 | 2.8 | 4.2 | 19% | 14% |
| 2 | 2.0 | 4.7 | 8% | 7% |

The limit gives up some utility on paper and delivers about three times as much in
practice. With a limit of two, which allows only plain swaps between two people,
the results fall back to the baseline. That is the measurement that shows the
chains are where the value is.

### When it runs

Not on every sign-up. Proposing the first acceptable two-person swap can use up a
seat that would have completed a much better three-person chain ten minutes later.
Kidney exchange programmes batch their matching for the same reason.

- After every seat submission an **immediate** run is tried, but its result is
  only sent if every party in it gets the best outcome it could possibly have.
- **Scheduled** runs at 20, 12 and 4 hours before departure send the best result
  available.
- A pending proposal is replaced only if every party in it does strictly better,
  and a proposal that anyone has already accepted is never replaced.

## What the simulator shows

`solver/simulator.py` generates synthetic flights with a realistic mix of solo
travellers, couples and larger groups, varies the share of the cabin that takes
part, and runs the real solver on each one. It compares the results with a strong
baseline: greedy two-person swaps under the same fairness rules, which is roughly
what passengers could arrange by asking their neighbours.

![Groups reunited against participation](liquidity.png)

Across 800 synthetic flights:

- **Below about 8% of the cabin, it does not work.** At 4% participation only 3%
  of the groups that wanted to sit together manage it. At 10%, about twenty
  passengers on a Boeing 737-800, that rises to 13%. The threshold is per flight:
  a thousand users spread across Europe are worth less than twenty on the same
  plane.
- **Without the limit, the solver gets worse as the product gets more popular.**
  At 40% participation it reunites 57% of groups on paper, but its cycles grow to
  28 parties and almost none would be accepted by everyone. What it actually
  delivers peaks around 10% participation and then falls to 3%, while the limited
  solver climbs to 22%.
- **Chains beat two-person swaps at every level.** At 10% participation the
  two-person baseline reunites 4.8% of groups against 13.3% for the solver, even
  though two-person proposals have the best possible odds of being accepted.

The solver stays fast. Its 95th-percentile solve time is under 1.4 seconds up to
30% participation and 5.3 seconds at 40%, inside a 10-second limit. The method,
full tables and caveats are in [liquidity.md](liquidity.md).

## Architecture

Two processes and one database.

```
Next.js (Vercel)  ------>  Telegram Bot API  (sign-in and notifications)
       |
       v
Postgres (Neon)  <--jobs-->  worker (Python, OR-Tools CP-SAT)
       |
       v
AeroDataBox  (one lookup per flight, cached)
```

The web app never runs the solver during a request. It adds a row to a `jobs`
table, and the worker picks jobs up with `FOR UPDATE SKIP LOCKED`, so several
workers can share the queue without ever taking the same job. Postgres is the
queue. There is no Redis, Celery or message broker.

| job | when | what it does |
|---|---|---|
| `verify_flight` | someone signs up for a new flight | looks the flight up once, stores the route, aircraft and times, then schedules the jobs below |
| `checkin_reminder` | check-in opens | asks each party for its seats |
| `match_run` | 20, 12 and 4 hours before departure, and after each seat submission | runs the solver and writes proposals |
| `expire_proposals` | every 10 minutes | closes proposals nobody answered in time |
| `purge_flight` | 24 hours after departure | deletes all personal data about the flight |

Each job runs in a single transaction. If it fails, its work is rolled back and
retried with backoff. Telegram messages are sent outside the transaction, because
a message cannot be taken back.

If the flight data API is down, out of quota or does not know the flight, nothing
breaks. The flight is marked unverified, a generic seat layout is used, and
check-in, match runs and the purge are scheduled from the departure date alone.

### Why a website and not an app

People would use this twice a year for twenty minutes, and nobody installs an app
for that. A website offers the one thing that matters: a link to a specific flight
that can be dropped into a group chat and found by searching for the flight
number. Flight pages are server-rendered for that reason. The bot covers the one
thing websites do badly, which is notifications on iOS.

### A URL space of tens of millions

Every airline, flight number and date has a valid page, which means tens of
millions of addresses open to search engine crawlers. That shaped the code in
three ways:

- **Viewing a flight page writes nothing.** A flight is only created when a
  signed-in user joins it. Otherwise a crawler could spend the monthly flight
  lookup quota in an afternoon. Breaking this rule would produce no visible error,
  so a test reads the page's source and fails if a write appears.
- **Creating flights is rate-limited per account**, to five new flights a day by
  default. Joining a flight that already exists is never limited, since it costs
  nothing and is exactly what the product needs.
- **Empty flight pages are not indexed.** A flight nobody has joined is marked
  `noindex` and left out of the sitemap until the first person signs up, so search
  engines are not offered millions of nearly identical empty pages.

## Privacy

These rules were part of the design from the start.

- **No phone numbers.** That is why sign-in uses Telegram rather than SMS or
  WhatsApp. A group chat would show your number to strangers who also know when
  you will be away from home.
- **No full names.** Everyone chooses a display name of up to 40 characters.
- **Boarding pass barcodes never reach the server.** They are read in the browser,
  six fields per flight are extracted, and everything else, including the
  passenger's name, is thrown away.
- **Automatic deletion.** Everything personal about a flight is deleted 24 hours
  after departure. Only an anonymous summary row is kept.
- **No third-party trackers or analytics.** Fonts are served from the site's own
  domain.
- **No personal data in URLs.** Agreement links use a random 128-bit token and
  expire.

## Boarding pass verification

Boarding pass barcodes follow the IATA BCBP standard (Resolution 792) and contain
the flight, the seat and the passenger's name. They can be read, but they cannot be
proven genuine: the standard's signature is optional, almost no airline uses it,
and the keys are not public.

So verification is a badge, never a requirement. Anyone can take part by typing
their seat, and a checked boarding pass only gives a small priority bonus in the
solver. The badge says "boarding pass checked" rather than "verified traveller",
because the second is a claim the system cannot back up.

What makes faking it costly is a set of server-side checks. The pass has to match
a flight the user joined, on the right date and route. The seat has to exist on
that aircraft. And both the seat and the check-in sequence number have to be
unique on the flight. Those last two are database constraints, and because both are
scarce, a fake account has to use real ones without knowing which are taken.

Barcodes are decoded with the browser's built-in `BarcodeDetector`, so no barcode
library is shipped to visitors. Safari and Firefox do not support it yet, and there
the user can paste the barcode text instead.

## Running it locally

You need Node.js 24 or newer, Python 3.13, and either Docker or a local Postgres.

```bash
cp .env.example .env                 # set at least SESSION_SECRET
set -a; source .env; set +a          # export the variables to this shell

docker compose up -d                 # Postgres and the worker
npm install --prefix web
npm run migrate --prefix web
npm run dev --prefix web             # http://localhost:3000
```

To run the worker without Docker:

```bash
cd solver
python3.13 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python worker.py           # keeps polling for jobs
.venv/bin/python worker.py --once    # processes the queue once and exits
```

`AERODATABOX_MODE` controls flight lookups. `off` (the default) makes no calls and
estimates times from the date, `fixture` uses the canned responses in
`solver/fixtures/`, and `live` calls the real API and needs `RAPIDAPI_KEY`.

### Tests

```bash
cd web && npm test                          # TypeScript unit tests, no database
cd solver && .venv/bin/python -m pytest     # Python tests
```

Tests that need a database are skipped unless `TEST_DATABASE_URL` is set. They
empty the tables they use, so point it at a throwaway database:

```bash
TEST_DATABASE_URL=postgres://... npm run test:db --prefix web
TEST_DATABASE_URL=postgres://... .venv/bin/python -m pytest
```

The utility function exists twice, in TypeScript for the preview on the page and
in Python for the solver. `solver/tests/test_cross_language.py` runs the same cases
through both and checks that the results are identical.
