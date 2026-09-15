-- 0003_checkin_sequence.sql
-- Record the check-in sequence number a boarding pass carries (CLAUDE.md §10).
--
-- BCBP is not signed, so reading a boarding pass proves nothing on its own. What
-- it buys us is scarce, checkable facts. The seat was already one of them (see
-- members_unique_seat_per_flight in 0001); the check-in sequence number is the
-- other. It is issued once per passenger per flight, so two parties claiming the
-- same one means at least one of them is wrong — and a fabricated pass has to
-- guess a number nobody else on the flight has taken.
--
-- Nullable, and it stays nullable: tier 0 is the default and nothing here is
-- required to take part. Deleted with the rest of the flight by purge_flight,
-- which cascades from parties (CLAUDE.md §13.4).

BEGIN;

ALTER TABLE members ADD COLUMN checkin_sequence INTEGER
  CONSTRAINT members_checkin_sequence_range CHECK (checkin_sequence BETWEEN 0 AND 9999);

CREATE UNIQUE INDEX members_unique_sequence_per_flight
  ON members (flight_id, checkin_sequence)
  WHERE checkin_sequence IS NOT NULL;

COMMIT;
