-- Down for 0351. Drops the two per-studio manual-fee switches. Touches no other column and no data besides these two
-- columns. After this, the application code that reads the columns must not be deployed (it fails closed: a missing
-- column reads as OFF, so no manual fee can be charged). Run it only if 0351 must be undone.
begin;

set local lock_timeout = '5s';

alter table public.studios
  drop column if exists late_cancel_fee_enabled,
  drop column if exists no_show_fee_enabled;

commit;
