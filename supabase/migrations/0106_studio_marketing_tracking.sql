-- 0106_studio_marketing_tracking.sql
--
-- Generic, provider-agnostic schema for OPTIONAL studio-owned marketing /
-- conversion tracking. This migration only creates tables + RLS + a dedup RPC.
-- It does NOT enable tracking, wire any sender, add any provider token, add a
-- browser pixel, or send data anywhere. See docs/22 for the plan; the inert
-- code layer lives in lib/conversion/ (PR #347).
--
-- DATA-MINIMIZATION CONTRACT (clinic-adjacent business):
--   * NO clinical/health fields (no notes, intake, contraindications, allergies,
--     body areas, photos, appointment notes, cancellation reasons).
--   * NO raw email/phone — the sender hashes those in-process and never persists
--     them here.
--   * NO token VALUES — only a server-side secret REFERENCE
--     (server_token_secret_ref); the token itself stays in server env.
--   * Studio isolation via public.is_studio_member(studio_id) on every table.

-- ---------------------------------------------------------------------------
-- 1) studio_tracking_providers — per-studio provider configuration.
-- ---------------------------------------------------------------------------
create table if not exists public.studio_tracking_providers (
  id                       uuid primary key default gen_random_uuid(),
  studio_id                uuid not null references public.studios(id) on delete cascade,
  provider                 text not null,
  enabled                  boolean not null default false,
  -- Client-visible tag id (e.g. Meta Pixel id / GA4 measurement id). Not secret.
  browser_tag_id           text,
  -- NAME/reference of a server-only secret. NEVER the token value itself.
  server_token_secret_ref  text,
  conversion_action_id     text,
  test_event_code          text,
  consent_mode             text not null default 'explicit',
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (studio_id, provider)
);

alter table public.studio_tracking_providers
  drop constraint if exists studio_tracking_providers_provider_check;
alter table public.studio_tracking_providers
  add constraint studio_tracking_providers_provider_check
  check (provider in (
    'meta', 'google_ads', 'ga4', 'tiktok',
    'pinterest', 'linkedin', 'microsoft_ads', 'custom'
  ));

alter table public.studio_tracking_providers
  drop constraint if exists studio_tracking_providers_consent_mode_check;
alter table public.studio_tracking_providers
  add constraint studio_tracking_providers_consent_mode_check
  check (consent_mode in ('explicit', 'implied', 'disabled'));

-- Fast "enabled providers for this studio" lookup.
create index if not exists studio_tracking_providers_studio_enabled_idx
  on public.studio_tracking_providers (studio_id) where enabled;

create or replace function public.tg_studio_tracking_providers_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists tg_studio_tracking_providers_set_updated_at
  on public.studio_tracking_providers;
create trigger tg_studio_tracking_providers_set_updated_at
  before update on public.studio_tracking_providers
  for each row execute function public.tg_studio_tracking_providers_set_updated_at();

alter table public.studio_tracking_providers enable row level security;

drop policy if exists "studio_tracking_providers_studio_member_select"
  on public.studio_tracking_providers;
create policy "studio_tracking_providers_studio_member_select"
  on public.studio_tracking_providers for select
  to authenticated
  using (public.is_studio_member(studio_id));

drop policy if exists "studio_tracking_providers_studio_member_insert"
  on public.studio_tracking_providers;
create policy "studio_tracking_providers_studio_member_insert"
  on public.studio_tracking_providers for insert
  to authenticated
  with check (public.is_studio_member(studio_id));

drop policy if exists "studio_tracking_providers_studio_member_update"
  on public.studio_tracking_providers;
create policy "studio_tracking_providers_studio_member_update"
  on public.studio_tracking_providers for update
  to authenticated
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));

comment on table public.studio_tracking_providers is
  'Per-studio, provider-agnostic marketing/conversion tracking configuration (meta/google_ads/ga4/tiktok/pinterest/linkedin/microsoft_ads/custom). enabled defaults false. Stores only a server-side secret REFERENCE (server_token_secret_ref), never the token value. No clinical data. RLS: studio members SELECT/INSERT/UPDATE their studio via is_studio_member; no cross-studio access; no DELETE policy. PR: 0106.';

-- ---------------------------------------------------------------------------
-- 2) conversion_event_deliveries — dedup + delivery status log (no PII).
-- ---------------------------------------------------------------------------
create table if not exists public.conversion_event_deliveries (
  id                        uuid primary key default gen_random_uuid(),
  studio_id                 uuid not null references public.studios(id) on delete cascade,
  provider                  text not null,
  internal_event_name       text not null,
  event_id                  text not null,
  status                    text not null,
  skipped_reason            text,
  provider_event_id_redacted text,
  last_error_safe           text,
  attempted_at              timestamptz,
  created_at                timestamptz not null default now(),
  unique (studio_id, provider, event_id)
);

alter table public.conversion_event_deliveries
  drop constraint if exists conversion_event_deliveries_status_check;
alter table public.conversion_event_deliveries
  add constraint conversion_event_deliveries_status_check
  check (status in ('skipped', 'sent', 'failed', 'claimed'));

create index if not exists conversion_event_deliveries_studio_created_idx
  on public.conversion_event_deliveries (studio_id, created_at desc);
create index if not exists conversion_event_deliveries_studio_provider_idx
  on public.conversion_event_deliveries (studio_id, provider);

alter table public.conversion_event_deliveries enable row level security;

-- Studio members can READ their delivery status. Writes go through the
-- service-role admin client + the claim RPC below (no authenticated write
-- policy → default-deny keeps the log tamper-resistant).
drop policy if exists "conversion_event_deliveries_studio_member_select"
  on public.conversion_event_deliveries;
create policy "conversion_event_deliveries_studio_member_select"
  on public.conversion_event_deliveries for select
  to authenticated
  using (public.is_studio_member(studio_id));

comment on table public.conversion_event_deliveries is
  'Provider-agnostic conversion delivery log + dedup. One row per (studio_id, provider, event_id) — the unique constraint enforces deterministic dedup. status in skipped/sent/failed/claimed. Carries only redacted status fields (provider_event_id_redacted + last_error_safe); no contact identifiers, tokens, or clinical data. RLS: studio members SELECT; writes via service role + claim_conversion_delivery. PR: 0106.';

-- ---------------------------------------------------------------------------
-- 3) booking_tracking_consents — marketing/analytics consent (separable from
--    clinical + payment consent). Booking continues if declined.
-- ---------------------------------------------------------------------------
create table if not exists public.booking_tracking_consents (
  id                         uuid primary key default gen_random_uuid(),
  studio_id                  uuid not null references public.studios(id) on delete cascade,
  appointment_id             uuid references public.appointments(id) on delete set null,
  client_id                  uuid references public.clients(id) on delete set null,
  marketing_analytics_consent boolean not null,
  consent_text_version       text not null,
  consent_source             text not null,
  consented_at               timestamptz not null default now(),
  created_at                 timestamptz not null default now()
);

alter table public.booking_tracking_consents
  drop constraint if exists booking_tracking_consents_source_check;
alter table public.booking_tracking_consents
  add constraint booking_tracking_consents_source_check
  check (consent_source in (
    'public_booking', 'portal', 'studio_website', 'admin_import'
  ));

create index if not exists booking_tracking_consents_studio_appointment_idx
  on public.booking_tracking_consents (studio_id, appointment_id);
create index if not exists booking_tracking_consents_studio_client_idx
  on public.booking_tracking_consents (studio_id, client_id);

alter table public.booking_tracking_consents enable row level security;

-- Studio members can READ consent records. The public booking form is
-- unauthenticated, so consent rows are inserted by the server-role admin client
-- (no anon/authenticated INSERT policy).
drop policy if exists "booking_tracking_consents_studio_member_select"
  on public.booking_tracking_consents;
create policy "booking_tracking_consents_studio_member_select"
  on public.booking_tracking_consents for select
  to authenticated
  using (public.is_studio_member(studio_id));

comment on table public.booking_tracking_consents is
  'Marketing/analytics consent for booking-conversion tracking, recorded separately from clinical + payment consent. Booking MUST proceed regardless of value. Stores only a boolean + text version + source + timestamp — no contact identifiers or clinical data. RLS: studio members SELECT; inserted via service role. PR: 0106.';

-- ---------------------------------------------------------------------------
-- 4) claim_conversion_delivery — atomic dedup claim (modeled on
--    claim_email_send, 0080). Returns true if THIS caller won the claim (should
--    send), false if the (studio, provider, event_id) was already claimed/sent.
-- ---------------------------------------------------------------------------
create or replace function public.claim_conversion_delivery(
  p_studio_id uuid,
  p_provider text,
  p_internal_event_name text,
  p_event_id text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.conversion_event_deliveries
    (studio_id, provider, internal_event_name, event_id, status, attempted_at)
  values
    (p_studio_id, p_provider, p_internal_event_name, p_event_id, 'claimed', now())
  on conflict (studio_id, provider, event_id) do nothing;
  -- FOUND is true only when the INSERT actually created the row (i.e. this
  -- caller won the claim); false when the unique conflict skipped it.
  return found;
end;
$$;

revoke all on function public.claim_conversion_delivery(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.claim_conversion_delivery(uuid, text, text, text)
  to service_role;
