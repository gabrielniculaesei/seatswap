-- 0004_flight_creation_quota.sql
-- Cap how many brand-new flights one account can bring into existence per day.
--
-- Creating a flight row is the only action on the site that spends a genuinely
-- scarce external resource: it queues the single `verify_flight` job for that
-- flight, which is one AeroDataBox call out of roughly 600 a month (CLAUDE.md
-- §11). M6 moved creation behind the Telegram login so that a crawler could not
-- do it. That raised the price of the attack without bounding it: a Telegram
-- account takes half a minute to make, and an authenticated script can still walk
-- carrier / number / date and burn the month's quota.
--
-- So creation is metered per account. Joining a flight that already exists is NOT
-- metered and never will be — it costs nothing, and it is the thing we actually
-- want people doing (CLAUDE.md §2.2: liquidity lives inside one flight, so ten
-- people arriving on the same flight is success, not abuse).
--
-- One row per creation, holding only who and when. Rows outside the window are
-- deleted as new ones are written, so the table stays about a day deep and this
-- is not a log of what anyone did (CLAUDE.md §13).

BEGIN;

CREATE TABLE flight_creations (
  id                BIGSERIAL PRIMARY KEY,
  telegram_user_id  BIGINT      NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX flight_creations_recent
  ON flight_creations (telegram_user_id, created_at DESC);

COMMIT;
