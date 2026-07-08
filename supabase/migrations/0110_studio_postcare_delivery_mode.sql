-- 0110_studio_postcare_delivery_mode.sql
--
-- SaaS-ready postcare automation: a per-studio delivery mode that lets a studio
-- choose to have postcare sent AUTOMATICALLY when an appointment is marked
-- complete, instead of the practitioner clicking "Send postcare" every time.
--
-- SAFE BY DEFAULT: default is 'manual' — existing behavior is unchanged and NO
-- studio auto-sends until its owner explicitly opts in. No Willow hardcoding.
--
-- Additive + backward-compatible. The delivery/send-state columns on
-- appointments (postcare_email_sent_at / _claimed_at / _failed_at /
-- _last_error / _last_attempt_at / _send_attempts, migrations 0043/0100) already
-- exist and are reused for idempotent, observable, non-duplicative sends — the
-- auto path shares those claim columns with the manual path, so postcare is sent
-- at most once. No new appointment column is needed.
--
-- The app reads the studio via `select *`, so before this migration is applied
-- the column is simply absent and the app defaults it to 'manual' (no read
-- break). NOT applied to production in this PR (proposal only). Because deployed
-- code writes this column (settings save, best-effort), prefer migration-first
-- (apply BEFORE the writing code is exercised — the 0108/0109 lesson).

alter table public.studios
  add column if not exists postcare_delivery_mode text not null default 'manual';

alter table public.studios
  drop constraint if exists studios_postcare_delivery_mode_check;
alter table public.studios
  add constraint studios_postcare_delivery_mode_check
  check (postcare_delivery_mode in ('manual', 'auto_on_complete'));

comment on column public.studios.postcare_delivery_mode is
  'Postcare delivery mode: manual (default — practitioner clicks Send postcare) or auto_on_complete (postcare auto-sends when an appointment is marked complete). Safe by default (manual). Reused send-state columns on appointments keep the auto path idempotent + observable. Resolved via lib/postcare/... ; defaults to manual when absent/null. Tenant/RLS scope inherited from studios.';
