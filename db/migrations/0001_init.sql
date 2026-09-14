-- 0001_init.sql
-- Core schema: flights, parties, members, match runs, proposals, job queue.
-- All identifiers, comments and enum-like strings are English (see CLAUDE.md §0).

BEGIN;

-- ---------------------------------------------------------------- flights
CREATE TABLE flights (
  id                      BIGSERIAL PRIMARY KEY,
  carrier                 CHAR(2)      NOT NULL,   -- IATA, e.g. 'W6', 'FR'
  flight_number           VARCHAR(5)   NOT NULL,   -- without carrier, e.g. '3234'
  departure_date          DATE         NOT NULL,   -- local departure date
  origin                  CHAR(3),                 -- IATA, e.g. 'OTP'
  destination             CHAR(3),
  -- As AeroDataBox reports it, e.g. 'Boeing 737-800'. Free text, kept for display
  -- and for spotting models we do not yet map. 10 chars was not enough: the very
  -- first real response, 'Airbus A321', is eleven.
  aircraft_type           VARCHAR(40),
  -- The resolved key into config/seatmaps.json, e.g. 'B738'. NULL means we could
  -- not identify the aircraft and the UI must show an estimated layout.
  seat_map_key            VARCHAR(20),
  scheduled_departure_utc TIMESTAMPTZ,
  checkin_opens_utc       TIMESTAMPTZ,             -- derived: departure - carrier policy
  api_verified_at         TIMESTAMPTZ,             -- when AeroDataBox confirmed it
  api_status              VARCHAR(20)  NOT NULL DEFAULT 'unknown',
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (carrier, flight_number, departure_date),
  CONSTRAINT flights_api_status_check
    CHECK (api_status IN ('verified', 'unknown', 'not_found'))
);

-- Job pickup for scheduled match runs / purges walks flights by departure time.
CREATE INDEX flights_departure ON flights (scheduled_departure_utc);

-- ---------------------------------------------------------------- parties
CREATE TABLE parties (
  id                  BIGSERIAL PRIMARY KEY,
  flight_id           BIGINT NOT NULL REFERENCES flights(id) ON DELETE CASCADE,
  telegram_user_id    BIGINT NOT NULL,
  display_name        VARCHAR(40) NOT NULL,        -- nickname or first name + initial. NEVER a full name
  size                SMALLINT NOT NULL CHECK (size BETWEEN 1 AND 8),
  state               VARCHAR(20) NOT NULL DEFAULT 'registered',
  -- preference weights (0..100, see CLAUDE.md §8)
  w_window            SMALLINT NOT NULL DEFAULT 0 CHECK (w_window        BETWEEN 0 AND 100),
  w_aisle             SMALLINT NOT NULL DEFAULT 0 CHECK (w_aisle         BETWEEN 0 AND 100),
  w_front             SMALLINT NOT NULL DEFAULT 0 CHECK (w_front         BETWEEN 0 AND 100),
  w_avoid_middle      SMALLINT NOT NULL DEFAULT 0 CHECK (w_avoid_middle  BETWEEN 0 AND 100),
  w_avoid_lavatory    SMALLINT NOT NULL DEFAULT 0 CHECK (w_avoid_lavatory BETWEEN 0 AND 100),
  w_adjacency         SMALLINT NOT NULL DEFAULT 0 CHECK (w_adjacency IN (0, 40, 200)),
  verification_tier   SMALLINT NOT NULL DEFAULT 0 CHECK (verification_tier BETWEEN 0 AND 2),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  seats_submitted_at  TIMESTAMPTZ,
  UNIQUE (flight_id, telegram_user_id),
  CONSTRAINT parties_state_check
    CHECK (state IN ('registered', 'seated', 'matched', 'settled', 'withdrawn', 'expired')),
  -- lets members carry a denormalised flight_id that provably matches this party's
  UNIQUE (id, flight_id)
);

-- The solver only ever loads one flight's seated parties.
CREATE INDEX parties_flight_state ON parties (flight_id, state);

-- ---------------------------------------------------------------- members
-- flight_id is denormalised on purpose (CLAUDE.md §6): it makes the
-- "one seat belongs to one person per flight" rule a plain UNIQUE index.
-- The composite FK below guarantees it can never drift from the party's flight.
CREATE TABLE members (
  id                  BIGSERIAL PRIMARY KEY,
  party_id            BIGINT NOT NULL,
  flight_id           BIGINT NOT NULL,
  label               VARCHAR(20),                 -- 'me', 'brother', 'child, 4'
  current_seat        VARCHAR(4),                  -- e.g. '14A'. NULL before check-in
  is_child            BOOLEAN NOT NULL DEFAULT false,
  -- The composite FK covers party_id on its own, so there is no separate
  -- REFERENCES parties(id): one constraint, not two doing the same work.
  FOREIGN KEY (party_id, flight_id)
    REFERENCES parties(id, flight_id) ON DELETE CASCADE
);

CREATE INDEX members_party ON members (party_id);

-- A seat belongs to exactly one person on a flight. This is also our anti-Sybil
-- defence: seats are scarce, so a fake party has to burn a real seat (CLAUDE.md §10).
CREATE UNIQUE INDEX members_unique_seat_per_flight
  ON members (flight_id, current_seat)
  WHERE current_seat IS NOT NULL;

-- ---------------------------------------------------------------- match runs
CREATE TABLE match_runs (
  id                  BIGSERIAL PRIMARY KEY,
  flight_id           BIGINT NOT NULL REFERENCES flights(id) ON DELETE CASCADE,
  trigger             VARCHAR(20) NOT NULL,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at         TIMESTAMPTZ,
  status              VARCHAR(20) NOT NULL DEFAULT 'running',
  solver_stats        JSONB,                       -- wall time, CP-SAT status, objective, #vars
  CONSTRAINT match_runs_trigger_check
    CHECK (trigger IN ('immediate', 'scheduled', 'manual')),
  CONSTRAINT match_runs_status_check
    CHECK (status IN ('running', 'done', 'failed'))
);

CREATE INDEX match_runs_flight ON match_runs (flight_id, started_at DESC);

-- ---------------------------------------------------------------- proposals
-- one proposal = one independent, atomic swap cycle
CREATE TABLE proposals (
  id                  BIGSERIAL PRIMARY KEY,
  match_run_id        BIGINT NOT NULL REFERENCES match_runs(id) ON DELETE CASCADE,
  flight_id           BIGINT NOT NULL REFERENCES flights(id) ON DELETE CASCADE,
  cycle_index         SMALLINT NOT NULL,
  status              VARCHAR(20) NOT NULL DEFAULT 'pending',
  total_gain          INTEGER NOT NULL,
  expires_at          TIMESTAMPTZ NOT NULL,
  -- public agreement screen /a/<token>: 128 random bits, expires (CLAUDE.md §13.6)
  agreement_token     VARCHAR(32) UNIQUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT proposals_status_check
    CHECK (status IN ('pending', 'accepted', 'rejected', 'expired', 'superseded')),
  UNIQUE (match_run_id, cycle_index)
);

CREATE INDEX proposals_pending_expiry
  ON proposals (expires_at) WHERE status = 'pending';
CREATE INDEX proposals_flight ON proposals (flight_id, status);

CREATE TABLE proposal_parties (
  proposal_id         BIGINT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  party_id            BIGINT NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  gain                INTEGER NOT NULL,            -- utility delta for this party
  response            VARCHAR(10),
  responded_at        TIMESTAMPTZ,
  PRIMARY KEY (proposal_id, party_id),
  CONSTRAINT proposal_parties_response_check
    CHECK (response IS NULL OR response IN ('accept', 'reject'))
);

CREATE INDEX proposal_parties_party ON proposal_parties (party_id);

CREATE TABLE proposal_assignments (
  proposal_id         BIGINT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  member_id           BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  from_seat           VARCHAR(4) NOT NULL,
  to_seat             VARCHAR(4) NOT NULL,
  PRIMARY KEY (proposal_id, member_id)
);

-- ---------------------------------------------------------------- job queue
-- Postgres is the queue. FOR UPDATE SKIP LOCKED, no Redis, no Celery (CLAUDE.md §4).
CREATE TABLE jobs (
  id                  BIGSERIAL PRIMARY KEY,
  type                VARCHAR(40) NOT NULL,
  payload             JSONB NOT NULL DEFAULT '{}',
  run_after           TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at           TIMESTAMPTZ,
  locked_by           VARCHAR(60),
  attempts            SMALLINT NOT NULL DEFAULT 0,
  last_error          TEXT,
  status              VARCHAR(20) NOT NULL DEFAULT 'queued',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT jobs_type_check
    CHECK (type IN ('verify_flight', 'checkin_reminder', 'match_run',
                    'expire_proposals', 'purge_flight')),
  CONSTRAINT jobs_status_check
    CHECK (status IN ('queued', 'running', 'done', 'failed'))
);

CREATE INDEX jobs_pickup ON jobs (run_after) WHERE status = 'queued';

-- ---------------------------------------------------------------- flight stats
-- Survives purge_flight. Anonymous aggregate only, no personal data (CLAUDE.md §13.4).
CREATE TABLE flight_stats (
  flight_id           BIGINT PRIMARY KEY,
  party_count         INTEGER NOT NULL,
  matched_party_count INTEGER NOT NULL,
  avg_gain            INTEGER NOT NULL,
  purged_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
