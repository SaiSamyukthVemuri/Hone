-- Migration 0057: consent forms foundation.
--
-- PR #134. Adds the v1 consent / e-sign foundation:
--   * consent_form_templates: studio-authored consent templates.
--     Versioned, status-gated, with form_type so the same surface
--     can house treatment consent, policy acknowledgement, photo
--     consent, and a card-on-file authorization placeholder for the
--     future Stripe / card-on-file PR (no payment code in this PR).
--   * client_consent_signatures: an immutable append-only history of
--     client signings. Each row carries a full snapshot of the
--     title + body + version the client actually saw, plus a
--     SHA-256 hex hash of the canonical (title, body, version)
--     tuple so a future "did the template change between v1 and
--     v2?" verification stays cheap. Multiple signatures of the
--     same (client, template) pair are allowed and preserved; the
--     practitioner profile and portal show the latest per
--     template.
--
-- Strictly additive + idempotent. Both tables use the canonical
-- public.is_studio_member(studio_id) helper for RLS to match every
-- comparable studio-scoped content table since migration 0026.
-- Hard delete is intentionally not supported on either table; a
-- signed record is a point-in-time legal artifact.

-- --------------------------------------------------------------------
-- 1) consent_form_templates
-- --------------------------------------------------------------------

create table if not exists public.consent_form_templates (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  title text not null,
  description text,
  body text not null,
  -- form_type narrows what the template is for. 'general' is the
  -- catch-all; the others are reserved so the practitioner-side UI
  -- and portal-side render can branch on it once each surface
  -- exists. card_authorization is the placeholder for the future
  -- Stripe / card-on-file PR; storing the type here does NOT enable
  -- any payment behaviour.
  form_type text not null default 'general',
  version integer not null default 1,
  -- status = 'active' surfaces in the portal "Forms to review"
  -- block; 'draft' is practitioner-only edit state; 'archived'
  -- hides from both portal and the practitioner default list. We
  -- never hard-delete a template because client_consent_signatures
  -- references it via ON DELETE RESTRICT (a signed history row is
  -- not erasable by archiving the template).
  status text not null default 'active',
  created_by_practitioner_id uuid
    references public.practitioners(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.consent_form_templates
  drop constraint if exists consent_form_templates_status_check;
alter table public.consent_form_templates
  add constraint consent_form_templates_status_check
  check (status in ('draft', 'active', 'archived'));

alter table public.consent_form_templates
  drop constraint if exists consent_form_templates_form_type_check;
alter table public.consent_form_templates
  add constraint consent_form_templates_form_type_check
  check (form_type in (
    'general',
    'treatment_consent',
    'policy_acknowledgement',
    'card_authorization',
    'photo_consent'
  ));

alter table public.consent_form_templates
  drop constraint if exists consent_form_templates_title_length_check;
alter table public.consent_form_templates
  add constraint consent_form_templates_title_length_check
  check (char_length(title) between 1 and 160);

alter table public.consent_form_templates
  drop constraint if exists consent_form_templates_body_length_check;
alter table public.consent_form_templates
  add constraint consent_form_templates_body_length_check
  check (char_length(body) between 1 and 20000);

alter table public.consent_form_templates
  drop constraint if exists consent_form_templates_version_check;
alter table public.consent_form_templates
  add constraint consent_form_templates_version_check
  check (version >= 1);

create index if not exists consent_form_templates_studio_status_type_idx
  on public.consent_form_templates (studio_id, status, form_type);

create index if not exists consent_form_templates_studio_created_idx
  on public.consent_form_templates (studio_id, created_at desc);

create or replace function public.tg_consent_form_templates_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists tg_consent_form_templates_set_updated_at
  on public.consent_form_templates;
create trigger tg_consent_form_templates_set_updated_at
  before update on public.consent_form_templates
  for each row execute function public.tg_consent_form_templates_set_updated_at();

alter table public.consent_form_templates enable row level security;

-- Studio members (active practitioners in this studio) can SELECT,
-- INSERT, and UPDATE their studio's templates. No DELETE policy:
-- archived state is the soft-delete path. No anon policy.
drop policy if exists "consent_form_templates_studio_member_select"
  on public.consent_form_templates;
create policy "consent_form_templates_studio_member_select"
  on public.consent_form_templates for select
  to authenticated
  using (public.is_studio_member(studio_id));

drop policy if exists "consent_form_templates_studio_member_insert"
  on public.consent_form_templates;
create policy "consent_form_templates_studio_member_insert"
  on public.consent_form_templates for insert
  to authenticated
  with check (public.is_studio_member(studio_id));

drop policy if exists "consent_form_templates_studio_member_update"
  on public.consent_form_templates;
create policy "consent_form_templates_studio_member_update"
  on public.consent_form_templates for update
  to authenticated
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));

comment on table public.consent_form_templates is
  'Studio-authored consent / e-sign templates. Versioned + status-gated. Active templates surface in the client portal for review and signing; archived templates hide from both portal and default practitioner lists but remain referenced by historical client_consent_signatures via ON DELETE RESTRICT. PR #134 / migration 0057. RLS enabled; authenticated studio members can SELECT / INSERT / UPDATE rows for their studio via is_studio_member. No DELETE policy.';

-- --------------------------------------------------------------------
-- 2) client_consent_signatures
-- --------------------------------------------------------------------
--
-- Append-only immutable record of one client signing one template
-- one time. Multiple signatures of the same (client, template) pair
-- are allowed; the latest is what the portal + practitioner profile
-- render, but every row is preserved.
--
-- The DB enforces "immutability by RLS posture": only SELECT and
-- service-role INSERT are allowed; no UPDATE or DELETE policy means
-- an authenticated client of any role cannot mutate or remove a
-- signed row. The portal-side createConsentSignatureAction uses the
-- service-role admin client and inserts the resolved studio /
-- client / template / snapshot / hash; the practitioner side never
-- inserts signatures (signing is a client action only in v1).
--
-- ON DELETE RESTRICT on template_id is the second guardrail:
-- archiving a template via the practitioner UI is allowed (it
-- flips status to 'archived'), but hard-deleting the template row
-- itself would orphan signed history rows and is therefore blocked
-- at the DB level.

create table if not exists public.client_consent_signatures (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  template_id uuid not null
    references public.consent_form_templates(id) on delete restrict,
  template_title_snapshot text not null,
  template_body_snapshot text not null,
  template_version integer not null,
  template_hash text not null,
  signature_name text not null,
  signed_at timestamptz not null default now(),
  -- Optional fingerprint columns. Hashed (never raw) via the same
  -- hashFingerprint(input) helper used by client_portal_magic_links.
  -- A signed row can survive even when neither fingerprint is
  -- available (older browsers, internal test environments) so both
  -- are nullable.
  ip_hash text,
  user_agent_hash text,
  created_at timestamptz not null default now()
);

alter table public.client_consent_signatures
  drop constraint if exists client_consent_signatures_name_length_check;
alter table public.client_consent_signatures
  add constraint client_consent_signatures_name_length_check
  check (char_length(signature_name) between 1 and 200);

alter table public.client_consent_signatures
  drop constraint if exists client_consent_signatures_hash_check;
alter table public.client_consent_signatures
  add constraint client_consent_signatures_hash_check
  check (char_length(template_hash) > 0);

alter table public.client_consent_signatures
  drop constraint if exists client_consent_signatures_version_check;
alter table public.client_consent_signatures
  add constraint client_consent_signatures_version_check
  check (template_version >= 1);

create index if not exists client_consent_signatures_client_idx
  on public.client_consent_signatures (studio_id, client_id, signed_at desc);

create index if not exists client_consent_signatures_template_idx
  on public.client_consent_signatures (studio_id, template_id, signed_at desc);

create index if not exists client_consent_signatures_client_template_idx
  on public.client_consent_signatures (client_id, template_id, signed_at desc);

alter table public.client_consent_signatures enable row level security;

-- Studio members can SELECT signed rows for their studio. No
-- authenticated INSERT / UPDATE / DELETE policies: the portal-side
-- write path goes through the service-role admin client in
-- signConsentFormAction, which scopes by getCurrentPortalSession +
-- (studio_id = session.studioId, client_id = session.clientId).
-- RLS default-deny on UPDATE / DELETE keeps signed rows immutable
-- against any future authenticated user-scoped client. No anon
-- policy.
drop policy if exists "client_consent_signatures_studio_member_select"
  on public.client_consent_signatures;
create policy "client_consent_signatures_studio_member_select"
  on public.client_consent_signatures for select
  to authenticated
  using (public.is_studio_member(studio_id));

comment on table public.client_consent_signatures is
  'Append-only immutable client consent / e-sign signatures. Each row carries a snapshot of (title, body, version) the client actually saw at signing time plus a SHA-256 hex hash of the canonical concatenation so a future template-drift check is cheap. Multiple signatures of the same (client, template) pair are allowed and preserved; portal + practitioner UI surface the latest. PR #134 / migration 0057. RLS enabled; authenticated studio members can SELECT via is_studio_member. INSERT happens through the service-role admin client in signConsentFormAction, scoped by getCurrentPortalSession + (studio_id, client_id). No INSERT / UPDATE / DELETE policy; RLS default-deny keeps signed rows immutable.';
