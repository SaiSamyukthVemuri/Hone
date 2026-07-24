-- 0153 — Explicit per-SERVICE calendar color. The internal calendar previously
-- derived an appointment card's color from a djb2 HASH of the service id, so
-- unrelated services collided on the same color (the "colors look duration-based"
-- confusion). Persist the color on the service instead: the calendar renders the
-- SERVICE's chosen color explicitly, independent of duration or client history.
--
-- Allowed values ONLY: amber, emerald, teal, sky, indigo, violet. The rose/red
-- family is deliberately EXCLUDED — Hone reserves it for allergy / EpiPen /
-- clinical-caution signals. Additive + forward-only; rewrites no appointment
-- rows; changes no service identity or pricing. NOT hosted-applied.

begin;

-- 1) Add nullable first so the backfill can run, then lock it down.
alter table public.services
  add column if not exists calendar_color text;

-- 2) Backfill existing services with a DETERMINISTIC per-service default (stable
--    per service id, spread across the six allowed colors) so the calendar isn't
--    uniform on day one; owners then explicitly pick the intended color in
--    Settings -> Services. Only touches the new column.
update public.services
   set calendar_color = (
         array['amber','emerald','teal','sky','indigo','violet']
       )[1 + (abs(hashtext('svc-color:' || id::text)::bigint) % 6)]
 where calendar_color is null;

-- 3) Safe default for NEW services + NOT NULL now every row has a value.
alter table public.services
  alter column calendar_color set default 'sky';
alter table public.services
  alter column calendar_color set not null;

-- 4) Allowed-values CHECK — no rose/red, no arbitrary CSS / browser-supplied
--    class strings can ever reach the column.
alter table public.services
  drop constraint if exists services_calendar_color_allowed;
alter table public.services
  add constraint services_calendar_color_allowed
  check (calendar_color in ('amber','emerald','teal','sky','indigo','violet'));

commit;

-- ===========================================================================
-- ROLLBACK (throwaway/local only; not part of this PR's hosted apply):
--   alter table public.services drop constraint services_calendar_color_allowed;
--   alter table public.services drop column calendar_color;
-- No appointment rows and no service identity/pricing are touched by 0153.
-- ===========================================================================
