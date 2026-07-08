-- 0109_studio_time_format_preference.sql
--
-- SaaS-ready studio time-format preference for PRACTITIONER-FACING time labels
-- (calendar grid, dashboard roster, availability blocks). Default is 12-hour;
-- NO studio is hardcoded. Client-facing surfaces (SMS, email, public booking)
-- already render 12-hour and are unaffected by this.
--
-- Additive + backward-compatible: existing studios get '12h' by default. The app
-- reads the studio via `select *`, so before this migration is applied the
-- column is simply absent and resolveTimeFormat() defaults it to '12h' — no
-- read breaks. The settings-save write is best-effort until this is applied.
--
-- Practitioner-level override (practitioners.time_format_override) is
-- intentionally DEFERRED to a later migration; the audit showed studio-level is
-- sufficient now and keeps this change small.
--
-- NOT applied to production in this PR (proposal only). Because deployed code
-- WRITES this column (settings save), prefer applying via the migration-first
-- flow BEFORE the writing code is exercised (the 0108 lesson).

alter table public.studios
  add column if not exists time_format_preference text not null default '12h';

alter table public.studios
  drop constraint if exists studios_time_format_preference_check;
alter table public.studios
  add constraint studios_time_format_preference_check
  check (time_format_preference in ('12h', '24h'));

comment on column public.studios.time_format_preference is
  'Studio display preference for PRACTITIONER-FACING time labels: 12h (default) or 24h. Client-facing surfaces (SMS/email/public booking) stay 12h regardless. Resolved via lib/booking/tz.ts resolveTimeFormat(); defaults to 12h when absent/null. Tenant/RLS scope inherited from studios.';
