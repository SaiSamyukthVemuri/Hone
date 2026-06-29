-- Migration 0096: Disinfectant discard / replace-by date (PR #280, Chloe record-keeping feedback).
--
-- Chloe wants to record when a prepared disinfectant batch MUST be replaced/discarded
-- and be reminded on that day. This column captures that "replace by" date, kept
-- DISTINCT from the two existing dates:
--   date_prepared   -> when the batch was made
--   discard_due_date-> (NEW) when it must be replaced/discarded by
--   date_discarded  -> when it was ACTUALLY discarded
--
-- This PR uses it only for a READ-TIME in-app due/overdue alert on the Record Keeping
-- page (Option A). NO cron / email / SMS / notification-table writes here — a proactive
-- bell/email reminder is deliberately deferred (see docs/08). Additive + nullable; every
-- legacy row reads safely (no due date = no alert). No RLS change. No payment/storage change.
--
-- PREFLIGHT (read-only; expected 0 before apply):
--   select count(*) from record_keeping_disinfectants where discard_due_date is not null;  -- 0
--
-- Idempotent (add column if not exists). DO NOT apply to production until explicitly approved.

alter table public.record_keeping_disinfectants
  add column if not exists discard_due_date date;
