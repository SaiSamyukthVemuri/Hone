-- Migration 0040: studio-level birthday reminder accent color.
--
-- Chloe feedback: PR #35 made the dashboard "Birthdays this month" cards
-- warm/rose, but red/rose reads as an alert. Red/rose is reserved for
-- allergies and cautions. Birthday reminders should default to purple,
-- and each studio can pick its own accent from a small safe preset list.
--
-- Adds one column to public.studios:
--
--   birthday_reminder_color text NOT NULL DEFAULT 'purple'
--     CHECK (birthday_reminder_color in
--            ('purple', 'orange', 'blue', 'green', 'neutral'))
--
-- Why a fixed preset list (no arbitrary hex):
--   - This is a small accent preference, not a theming system. The five
--     presets map to vetted Tailwind palettes in lib/birthday-colors.ts.
--   - A closed CHECK keeps the rendering helper total (every stored value
--     maps to a known class bundle) and prevents an injected hex value
--     from ever reaching a className.
--   - 'purple' default matches Chloe's request; existing studios backfill
--     to purple automatically via the column default, so no row is
--     invalid and no data rewrite is needed.
--
-- Untouched: every other studios column, booking availability, the
-- appointment lifecycle, public booking, email/SMS templates, the cron,
-- Stripe/payments, require_card_on_file, session logging, TTT, treatment
-- plans, and every RLS policy. This is a purely additive, re-runnable
-- column add with a fast non-volatile default.

alter table public.studios
  add column if not exists birthday_reminder_color text not null default 'purple';

alter table public.studios
  drop constraint if exists studios_birthday_reminder_color_check;
alter table public.studios
  add constraint studios_birthday_reminder_color_check
  check (
    birthday_reminder_color in ('purple', 'orange', 'blue', 'green', 'neutral')
  );
