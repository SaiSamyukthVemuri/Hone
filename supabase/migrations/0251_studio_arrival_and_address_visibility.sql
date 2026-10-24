-- DRAFT, UNNUMBERED. HON-50 PR B: studio arrival instructions and address visibility.
--
-- Prepared by Willow, 2026-10-24 (OPS-ASSIGNMENT-20261024T1445Z-HON-50-ADDRESS-ARRIVAL).
-- NOT a migration yet. OPS allocates the number; it is then copied verbatim to
-- supabase/migrations/<NNNN>_studio_arrival_and_address_visibility.sql in its
-- own PR together with the app branch feat/hon-50-arrival-visibility. Never
-- applied anywhere: no local stack (disk floor), no hosted apply.
--
-- WHAT IT ADDS (two owner-authored studio settings, both additive):
--
--   1. studios.arrival_instructions  text NULL
--      Arrival / parking instructions shown in the client's appointment emails
--      (confirmation, 24h and 2h reminders, appointment-update). It is a
--      separate field ON PURPOSE: booking_description is the public booking-page
--      intro and is not repurposed. NULL means "no section". The CHECK refuses a
--      blank or whitespace-only value, so the database has one spelling of
--      "none"; the app normalizes blank input to NULL before writing.
--
--   2. studios.address_visibility  text NOT NULL DEFAULT 'both'
--      Where studios.address is shown: 'booking_page' | 'emails' | 'both'.
--      The DEFAULT 'both' is exactly today's behaviour (the booking page and the
--      appointment emails both show the address), so every existing row and
--      every new studio keep their current output byte-for-byte until an owner
--      changes it. A blank address stays absent everywhere, whatever this says.
--
-- RLS AND GRANTS (the 0129 / 0164 rule):
--   * No function, trigger or view is created, so there is no EXECUTE grant to
--     revoke. The 0129/0164 rule (Supabase's ALTER DEFAULT PRIVILEGES grants
--     EXECUTE to anon, authenticated AND service_role at create time, so an
--     authenticated-only command must revoke all three by name) has nothing to
--     act on here. A later edit that adds a routine must add its three revokes
--     in the same file (tests/migrations guard on the numbered copy).
--   * Table privileges are unchanged. `studios` has no column-level grants; new
--     columns inherit the table's privileges.
--   * RLS is unchanged. Reads: "studios: members read" (0001). Writes:
--     "studios: owners update" (0001), which is exactly the intended writer: the
--     owner's Settings > Booking save. The 0204 admission-mode guard only
--     constrains new_client_admission_mode, so it does not affect these columns.
--   * anon has no studios read path (the public booking page reads through the
--     server-only admin client), so an 'emails' address cannot reach anon via
--     PostgREST. The app-side leak boundary is the booking page and is proved
--     by tests/app/book/address-visibility-leak.test.ts on the app branch.
--
-- ROLLOUT ORDER: either order is safe. The app branch reads both columns as
-- optional (absent column = 'both' and no arrival section), and the settings
-- page offers the two controls only when the loaded studio row carries them,
-- so an app-first deploy never writes a column that does not exist yet. An old
-- app against the new columns ignores them.

begin;

set local lock_timeout = '5s';

-- 1. Arrival instructions ----------------------------------------------------

alter table public.studios
  add column if not exists arrival_instructions text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.studios'::regclass
      and conname = 'studios_arrival_instructions_check'
  ) then
    alter table public.studios
      add constraint studios_arrival_instructions_check
      check (
        arrival_instructions is null
        or (btrim(arrival_instructions) <> '' and char_length(arrival_instructions) <= 1000)
      );
  end if;
end;
$$;

comment on column public.studios.arrival_instructions is
  'HON-50. Owner-authored arrival/parking instructions rendered in client '
  'appointment emails (confirmation, 24h/2h reminders, appointment-update). '
  'NULL = no section. Separate from booking_description (booking-page intro).';

-- 2. Address visibility -------------------------------------------------------

alter table public.studios
  add column if not exists address_visibility text not null default 'both';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.studios'::regclass
      and conname = 'studios_address_visibility_check'
  ) then
    alter table public.studios
      add constraint studios_address_visibility_check
      check (address_visibility in ('booking_page', 'emails', 'both'));
  end if;
end;
$$;

comment on column public.studios.address_visibility is
  'HON-50. Where studios.address is shown: booking_page | emails | both. '
  'Default both = the behaviour before this column existed. A blank address is '
  'shown nowhere regardless.';

-- 3. Self-check -----------------------------------------------------------------
-- Read back what this file promises, so a partial or edited copy fails loudly
-- inside its own transaction instead of shipping a different default.

do $$
begin
  if (select data_type from information_schema.columns
       where table_schema = 'public' and table_name = 'studios'
         and column_name = 'address_visibility') is distinct from 'text'
     or (select column_default from information_schema.columns
       where table_schema = 'public' and table_name = 'studios'
         and column_name = 'address_visibility') is distinct from '''both''::text' then
    raise exception 'HON-50 draft: address_visibility must be text default ''both''';
  end if;
end;
$$;

commit;
