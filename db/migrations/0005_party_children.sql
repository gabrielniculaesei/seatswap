-- How many of a party are under 16, so the solver never proposes a child into
-- an exit row.
--
-- Exit rows carry a legal restriction: no children (Ryanair and most European
-- carriers draw the line at 16). The solver knew where the exit rows were
-- (seatmaps.json) but not who was a child, so a family with a four-year-old could
-- be offered row 16 of a 737, which cabin crew would refuse at the gate — a
-- proposal that looks like a success and dies at boarding (found 2026-09-15).
--
-- A count on the party, not a flag on members. members.is_child exists in 0001
-- but cannot be used: members are created at sign-up, before any seat, and the
-- seats arrive later as "14A, 22F" with nothing saying whose is whose. It does not
-- need to be known either — a party sorts out among itself who sits where, so
-- the constraint the solver needs is only "at most size - children of this
-- party's seats are in exit rows". members.is_child stays unused.
--
-- Deleted with the party by purge_flight (CLAUDE.md §13.4).

BEGIN;

ALTER TABLE parties ADD COLUMN children SMALLINT NOT NULL DEFAULT 0;

-- At least one member is the adult who signed up (the terms require 16+).
ALTER TABLE parties ADD CONSTRAINT parties_children_range
  CHECK (children >= 0 AND children < size);

COMMIT;
