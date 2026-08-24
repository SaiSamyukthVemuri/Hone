-- ===========================================================================
-- INTAKE REMINDERS MOVE TO 24h / 2h, COMPOSED INTO THE WINDOW EMAIL — 0186
-- ===========================================================================
--
-- THE PRODUCT CHANGE. Intake-form reminders previously fired ~7 days and
-- ~3 days before a confirmed appointment (0098), as their OWN email. Those
-- windows only ever reached bookings made a week or more in advance, and a
-- client who booked on Tuesday for Thursday received nothing at all. The
-- cadence becomes ~24h and ~2h before the appointment, which is where the
-- booked population actually sits.
--
-- WHY THIS FILE IS ONE COLUMN. The ~24h and ~2h email already exists: the
-- appointment reminder, with a per-appointment, per-window claim slot
-- (`reminder_24h_*` / `reminder_2h_*`, migrations 0025 + 0080) guarded by the
-- atomic `claim_email_send` / `record_email_result` pair. The intake nudge is
-- COMPOSED INTO that one email rather than sent as a second one, so it needs
-- no slot of its own. AT MOST ONE EMAIL PER APPOINTMENT PER WINDOW is then a
-- structural property of a single conditional UPDATE, not a behaviour two
-- independent send paths have to be trusted to respect. Two slots could not
-- give that: two separate conditional UPDATEs cannot be atomic with respect to
-- each other, so a studio toggle or an intake submission landing between two
-- overlapping cron runs would let each run win a different slot and send.
--
-- THEREFORE: no RPC is created or replaced here. `claim_email_send` and
-- `record_email_result` keep the exact definitions 0098 left them with. That
-- also means the failure class of 0129 (`anon` missed), 0164 (`service_role`
-- missed) and 0183/0184 (`MAINTAIN` missed) — Supabase's ALTER DEFAULT
-- PRIVILEGES granting EXECUTE at function-create time — CANNOT occur in this
-- migration, because it creates no function.
--
-- THE 7d / 3d STATE IS PRESERVED, NOT REINTERPRETED. `intake_reminder_7d_*`
-- and `intake_reminder_3d_*` (columns, partial indexes, and the two
-- `claim_email_send` / `record_email_result` branches from 0098) are RETAINED
-- and left exactly as they are. A stamped `intake_reminder_7d_sent_at` means
-- what it has always meant: "we emailed this client seven days out". Reusing
-- those columns for the new cadence would have made every in-flight row that
-- already carried a 7d stamp permanently ineligible for the 24h nudge — a
-- silent, unalertable delivery loss aimed at precisely the clients this change
-- exists to reach — and would have rewritten the meaning of frozen history.
-- The application simply stops writing them. Dropping them is a separate,
-- later change once no code references them.
--
-- THE ONE THING THAT NEEDS NEW STATE. Appointment reminders and intake
-- reminders are INDEPENDENT product controls: a studio that turns off its
-- 24-hour reminder must not thereby silently turn off an intake reminder it
-- has enabled. That case sends a standalone intake email instead — still
-- claiming the same window slot, so the invariant holds. Expressing "intake
-- reminders are on" requires one boolean, and this file adds exactly that.
--
-- DEFAULT TRUE, deliberately. `studios.send_confirmation_emails`,
-- `send_24h_reminders` and `send_2h_reminders` (0025) are all
-- `not null default true`; the SMS toggles (0049) default false because SMS
-- was opt-in from a standing start. Intake reminders are already live in
-- production under the 7d/3d cadence, so defaulting false would silently
-- switch an existing behaviour OFF for every studio at apply time. Default
-- true is the no-change default.
--
-- Additive and backfill-safe: one nullable-free boolean with a constant
-- default, which PostgreSQL 11+ records in the catalog without rewriting the
-- table. NO RLS or policy change, NO enum change, NO index, NO CHECK
-- constraint, NO trigger, NO function, NO destructive DDL, NO row mutation.
-- Re-runnable: add-column-if-not-exists.
--
-- Migration max 0185 -> 0186.
-- ---------------------------------------------------------------------------

begin;

set local lock_timeout = '5s';

alter table public.studios
  add column if not exists send_intake_reminders boolean not null default true;

comment on column public.studios.send_intake_reminders is
  'Independent of send_24h_reminders / send_2h_reminders. When true and the client''s latest non-deleted intake is still in_progress at the send decision, the ~24h / ~2h window email carries a secure intake CTA; when the matching appointment reminder is off, a standalone intake reminder is sent instead. Either way exactly one email is sent per appointment per window, claimed on the existing reminder_24h / reminder_2h slot. Default true: intake reminders already ship under the retired 7d/3d cadence, so false would silently disable an existing behaviour.';

commit;
