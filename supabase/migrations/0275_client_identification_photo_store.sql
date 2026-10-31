-- 0275 · FETT photos (HON-43): a separate, private client IDENTIFICATION-PHOTO store (P2).
--
-- DRAFT · HELD · PREPARE-ONLY. Never applied without Sam's per-change approval.
-- Product basis: 01-ops/SAM-DECISIONS-P2-IDPHOTO-20261031.md (ten decisions) and
-- privacy/PROFILE-PHOTO-ADVICE-END.json + privacy/P2-WORDING-END.json (A1-A4, B1-B4,
-- D1-D6, W1-W6). The consent WORDING below is Privacy's v1.1 working text; Sam
-- decides the final text before ANY activation, and it is seeded UNAPPROVED
-- (approved_at is null), so no consent can be recorded until an operator approves it.
--
-- What this is: ONE face photo per client, a server re-encoded square WebP
-- derivative, in its OWN private bucket, apart from treatment photography. It is
-- not a clinical record. It never reads or writes treatment_images.
--
-- Defaults and gates (decision 9): OFF per studio, evaluated IN THE DATABASE.
-- A studio with no row in studio_client_id_photo_settings is OFF. Writes need the
-- switch ON, an active OWNER or PRACTITIONER of the studio, the client in that
-- studio, and a current non-withdrawn consent. Reads (RLS) need the same.
-- Receptionists: no access, by construction (the role list is explicit, so a later
-- receptionist role stays excluded).
--
-- Deletion (decision 5/6, Privacy D1-D3): removal, withdrawal and client archive
-- delete the database row FIRST (the photo stops being served in the same
-- transaction) and queue the storage object for deletion; the app deletes the
-- object through the Storage API and acknowledges it. Nothing is deleted from
-- storage before a command has authorized the caller. An image-free audit event
-- is appended for each.
-- RESIDUAL (documented, for Privacy): a failed object delete leaves the object in
-- the private bucket, unreachable (no row, no policy, no signing), until the
-- queued deletion is retried; archived clients are cleaned up on the next drain.
-- BACKUP LIMITATION: the platform's backups / point-in-time recovery may retain a
-- deleted object (and the database rows) until they age out. Restores must re-run
-- the pending deletions and must not resurrect a withdrawn photo (Privacy D6).
--
-- Decision 10 (the 0231 bypass) is closed HERE, two ways, and the choice is
-- stated: (1) set_client_portrait(uuid,uuid,uuid) is REVOKED from public, anon,
-- authenticated and service_role by name and granted to nobody (retired, not
-- gated: the feature is dead under decision 7 and a second switch would only keep
-- an unused path alive); (2) a BEFORE trigger refuses to SET clients.portrait_image_id
-- to any non-null value for every role, because the Data API's table UPDATE on
-- clients would otherwise be a second door (Privacy B2). Clearing the pointer to
-- null stays possible (0231's archive path and data minimisation). Existing
-- pointers are NOT carried over and are not cleared here (a data write needing its
-- own authorization); the app does not render them (the flag stays off).

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Private bucket (idempotent). NO storage.objects policy for authenticated:
--    the storage plane is the server's (service role), after a command or an RLS
--    read has authorized the caller. A browser-direct storage write is impossible.
-- ---------------------------------------------------------------------------
do $$
begin
  insert into storage.buckets (id, name, public)
  values ('client-identification-photos', 'client-identification-photos', false)
  on conflict (id) do nothing;
exception when insufficient_privilege or undefined_table then
  raise notice 'skipping storage.buckets insert; create a PRIVATE bucket named client-identification-photos manually';
end $$;

-- ---------------------------------------------------------------------------
-- 2. Consent wording, versioned and immutable (Privacy W1, W5).
--    The hash is of the exact text and is checked by the table itself.
-- ---------------------------------------------------------------------------
create table public.client_id_photo_wording_versions (
  version text primary key check (version ~ '^[a-z0-9][a-z0-9._-]{0,39}$'),
  wording text not null check (char_length(wording) between 40 and 4000),
  wording_sha256 text not null,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  constraint client_id_photo_wording_hash_matches
    check (wording_sha256 = encode(sha256(convert_to(wording, 'UTF8')), 'hex'))
);

insert into public.client_id_photo_wording_versions (version, wording, wording_sha256)
select 'v1.1',
       w,
       encode(sha256(convert_to(w, 'UTF8')), 'hex')
  from (select $w$I agree that this studio may store a photo of my face to help the studio's owner and practitioners recognise me at appointments. It is kept privately, is not part of my treatment record, will not be used for marketing, will not be shared outside the studio, and will not be used for automated face recognition. This is optional: saying no will not affect my booking or treatment. I can withdraw my permission at any time; the photo will then stop being shown and will be deleted, although a copy may remain in secure backups for a limited time before it expires.$w$::text as w) s;

-- ---------------------------------------------------------------------------
-- 3. The studio switch (default OFF; absent row == OFF) and its append-only log.
-- ---------------------------------------------------------------------------
create table public.studio_client_id_photo_settings (
  studio_id uuid primary key references public.studios (id) on delete cascade,
  enabled boolean not null default false,
  changed_at timestamptz not null default now(),
  reason text check (reason is null or char_length(reason) between 1 and 300)
);

create table public.studio_client_id_photo_switch_log (
  seq bigint generated always as identity primary key,
  studio_id uuid not null,
  previous_enabled boolean not null,
  new_enabled boolean not null,
  reason text,
  changed_at timestamptz not null default now(),
  changed_by text not null default session_user
);

-- ---------------------------------------------------------------------------
-- 4. Consent evidence (append-only). Who PROVIDED it, who RECORDED it, channel,
--    time, wording version AND the hash of the text shown (W1, W2). Withdrawal is a
--    new row, never an edit. No FK to clients: the evidence outlives the client row.
-- ---------------------------------------------------------------------------
create table public.client_id_photo_consents (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  studio_id uuid not null,
  client_id uuid not null,
  event text not null check (event in ('granted', 'withdrawn')),
  wording_version text not null references public.client_id_photo_wording_versions (version),
  wording_sha256 text not null,
  provided_by text not null check (provided_by in ('client', 'representative', 'system')),
  representative_role text check (representative_role is null or char_length(representative_role) between 2 and 60),
  channel text not null check (channel in ('in_person', 'client_form', 'system')),
  recorded_by_practitioner_id uuid,
  recorded_at timestamptz not null default now(),
  constraint client_id_photo_consent_representative_shape
    check ((provided_by = 'representative') = (representative_role is not null)),
  constraint client_id_photo_consent_system_shape
    check ((provided_by = 'system') = (channel = 'system')),
  constraint client_id_photo_consent_recorder_shape
    check ((channel = 'in_person') = (recorded_by_practitioner_id is not null)),
  constraint client_id_photo_consent_system_is_withdrawal
    check (channel <> 'system' or event = 'withdrawn')
);
create index client_id_photo_consents_latest_idx
  on public.client_id_photo_consents (studio_id, client_id, seq desc);

-- ---------------------------------------------------------------------------
-- 5. The photo: one row per client, same-studio bound, bounded derivative only.
-- ---------------------------------------------------------------------------
create table public.client_id_photos (
  client_id uuid primary key,
  studio_id uuid not null,
  storage_bucket text not null default 'client-identification-photos'
    check (storage_bucket = 'client-identification-photos'),
  storage_path text not null unique,
  content_type text not null default 'image/webp' check (content_type = 'image/webp'),
  byte_size integer not null check (byte_size between 1 and 524288),
  width integer not null check (width between 64 and 1024),
  height integer not null check (height between 64 and 1024),
  consent_id uuid not null references public.client_id_photo_consents (id),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_id_photos_square check (width = height),
  constraint client_id_photos_path_shape
    check (storage_path ~ ('^' || studio_id::text || '/' || client_id::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.]webp$')),
  constraint client_id_photos_client_fk
    foreign key (client_id, studio_id) references public.clients (id, studio_id) on delete cascade,
  constraint client_id_photos_creator_fk
    foreign key (created_by, studio_id) references public.practitioners (id, studio_id)
);

-- ---------------------------------------------------------------------------
-- 6. Image-free audit (append-only, no FK) and the object-deletion queue.
-- ---------------------------------------------------------------------------
create table public.client_id_photo_audit (
  seq bigint generated always as identity primary key,
  studio_id uuid not null,
  client_id uuid not null,
  event text not null check (event in (
    'consent_granted', 'consent_withdrawn', 'photo_set', 'photo_replaced',
    'photo_removed', 'photo_removed_client_archived', 'consent_withdrawn_client_archived')),
  actor_practitioner_id uuid,
  at timestamptz not null default now()
);

create table public.client_id_photo_pending_object_deletions (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null,
  storage_bucket text not null default 'client-identification-photos'
    check (storage_bucket = 'client-identification-photos'),
  storage_path text not null unique,
  queued_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 7. Immutability: the evidence, the log, the audit and the wording cannot be
--    rewritten or removed by anyone (42501), whatever role runs the statement.
-- ---------------------------------------------------------------------------
create or replace function public.client_id_photo_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'This record is append-only.' using errcode = '42501';
end;
$$;

create trigger client_id_photo_consents_immutable
  before update or delete on public.client_id_photo_consents
  for each row execute function public.client_id_photo_immutable();
create trigger client_id_photo_consents_no_truncate
  before truncate on public.client_id_photo_consents
  for each statement execute function public.client_id_photo_immutable();

create trigger studio_client_id_photo_switch_log_immutable
  before update or delete on public.studio_client_id_photo_switch_log
  for each row execute function public.client_id_photo_immutable();
create trigger studio_client_id_photo_switch_log_no_truncate
  before truncate on public.studio_client_id_photo_switch_log
  for each statement execute function public.client_id_photo_immutable();

create trigger client_id_photo_audit_immutable
  before update or delete on public.client_id_photo_audit
  for each row execute function public.client_id_photo_immutable();
create trigger client_id_photo_audit_no_truncate
  before truncate on public.client_id_photo_audit
  for each statement execute function public.client_id_photo_immutable();

create trigger client_id_photo_wording_no_delete
  before delete on public.client_id_photo_wording_versions
  for each row execute function public.client_id_photo_immutable();
create trigger client_id_photo_wording_no_truncate
  before truncate on public.client_id_photo_wording_versions
  for each statement execute function public.client_id_photo_immutable();

-- The wording text, version and hash never change; the only permitted update is the
-- one-way approval of an unapproved version.
create or replace function public.client_id_photo_wording_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.version is distinct from old.version
     or new.wording is distinct from old.wording
     or new.wording_sha256 is distinct from old.wording_sha256
     or new.created_at is distinct from old.created_at
     or old.approved_at is not null
     or new.approved_at is null then
    raise exception 'A consent wording version is immutable; a change is a new version.' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger client_id_photo_wording_guard
  before update on public.client_id_photo_wording_versions
  for each row execute function public.client_id_photo_wording_guard();

-- The switch log is written by a trigger on the settings table.
create or replace function public.studio_client_id_photo_switch_log_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.studio_client_id_photo_switch_log (studio_id, previous_enabled, new_enabled, reason)
  values (new.studio_id, case when tg_op = 'UPDATE' then old.enabled else false end, new.enabled, new.reason);
  return new;
end;
$$;

create trigger studio_client_id_photo_switch_log_write
  after insert or update on public.studio_client_id_photo_settings
  for each row execute function public.studio_client_id_photo_switch_log_write();

-- ---------------------------------------------------------------------------
-- 8. Every way a photo row can disappear or change path queues its object for
--    deletion (remove, withdraw, archive, a cascade, a replacement).
-- ---------------------------------------------------------------------------
create or replace function public.client_id_photo_queue_object()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    insert into public.client_id_photo_pending_object_deletions (studio_id, storage_path)
    values (old.studio_id, old.storage_path)
    on conflict (storage_path) do nothing;
    return old;
  end if;
  -- UPDATE of storage_path: the OLD object is no longer referenced.
  if new.storage_path is distinct from old.storage_path then
    insert into public.client_id_photo_pending_object_deletions (studio_id, storage_path)
    values (old.studio_id, old.storage_path)
    on conflict (storage_path) do nothing;
  end if;
  return new;
end;
$$;

create trigger client_id_photo_queue_object_delete
  after delete on public.client_id_photos
  for each row execute function public.client_id_photo_queue_object();
create trigger client_id_photo_queue_object_update
  after update of storage_path on public.client_id_photos
  for each row execute function public.client_id_photo_queue_object();

-- ---------------------------------------------------------------------------
-- 9. Internal helpers. Actor = an ACTIVE practitioner row with role owner or
--    practitioner in ONE explicit studio (never a receptionist role).
-- ---------------------------------------------------------------------------
create or replace function public.client_id_photo_actor(p_studio_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.id
    from public.practitioners p
   where p.user_id = auth.uid()
     and p.studio_id = p_studio_id
     and p.active = true
     and p.role in ('owner', 'practitioner');
$$;

create or replace function public.client_id_photo_switch_on(p_studio_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select s.enabled from public.studio_client_id_photo_settings s where s.studio_id = p_studio_id), false);
$$;

create or replace function public.client_id_photo_consent_granted(p_studio_id uuid, p_client_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select c.event = 'granted'
      from public.client_id_photo_consents c
     where c.studio_id = p_studio_id
       and c.client_id = p_client_id
     order by c.seq desc
     limit 1), false);
$$;

-- The RLS predicate. It runs as the querying user, so it IS granted to
-- authenticated; it answers true only for an actor of that studio, with the switch
-- ON and a current consent, so it reveals nothing about any other studio.
create or replace function public.client_id_photo_can_read(p_studio_id uuid, p_client_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
     and public.client_id_photo_actor(p_studio_id) is not null
     and public.client_id_photo_switch_on(p_studio_id)
     and public.client_id_photo_consent_granted(p_studio_id, p_client_id);
$$;

-- ---------------------------------------------------------------------------
-- 10. RLS and privileges. Table writes are revoked from every runtime role; the
--     only table the app reads is client_id_photos, through the RLS client.
-- ---------------------------------------------------------------------------
alter table public.client_id_photo_wording_versions enable row level security;
alter table public.studio_client_id_photo_settings enable row level security;
alter table public.studio_client_id_photo_switch_log enable row level security;
alter table public.client_id_photo_consents enable row level security;
alter table public.client_id_photos enable row level security;
alter table public.client_id_photo_audit enable row level security;
alter table public.client_id_photo_pending_object_deletions enable row level security;

create policy "client_id_photos: actors read when enabled and consented"
  on public.client_id_photos for select to authenticated
  using (public.client_id_photo_can_read(studio_id, client_id));

revoke all on table public.client_id_photo_wording_versions from public, anon, authenticated, service_role;
revoke all on table public.studio_client_id_photo_settings from public, anon, authenticated, service_role;
revoke all on table public.studio_client_id_photo_switch_log from public, anon, authenticated, service_role;
revoke all on table public.client_id_photo_consents from public, anon, authenticated, service_role;
revoke all on table public.client_id_photos from public, anon, authenticated, service_role;
revoke all on table public.client_id_photo_audit from public, anon, authenticated, service_role;
revoke all on table public.client_id_photo_pending_object_deletions from public, anon, authenticated, service_role;
grant select on table public.client_id_photos to authenticated;

-- ---------------------------------------------------------------------------
-- 11. COMMANDS (authenticated). Uniform, non-disclosing refusal for: not an actor,
--     unknown client, another studio, switch OFF. The client row is locked FIRST
--     in every command (the same order as 0231), so commands serialize per client.
-- ---------------------------------------------------------------------------

-- The text the UI must show, exactly as stored (W5). Latest APPROVED version only.
create or replace function public.client_id_photo_wording_current(p_studio_id uuid)
returns table (version text, wording text, wording_sha256 text)
language sql
stable
security definer
set search_path = ''
as $$
  select w.version, w.wording, w.wording_sha256
    from public.client_id_photo_wording_versions w
   where w.approved_at is not null
     and public.client_id_photo_actor(p_studio_id) is not null
   order by w.approved_at desc, w.created_at desc
   limit 1;
$$;

create or replace function public.client_id_photo_enabled(p_studio_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.client_id_photo_actor(p_studio_id) is not null
     and public.client_id_photo_switch_on(p_studio_id);
$$;

-- Record a GRANT of consent, in person (the authenticated client form is not built in
-- this migration and is refused; representatives are refused in v1 (W4): staff cannot
-- record someone else's consent as the client's own).
create or replace function public.record_client_id_photo_consent(
  p_client_id uuid,
  p_wording_version text,
  p_wording_sha256 text,
  p_channel text default 'in_person',
  p_provided_by text default 'client'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_studio uuid;
  v_archived timestamptz;
  v_actor uuid;
  v_id uuid;
begin
  select c.studio_id, c.archived_at into v_studio, v_archived
    from public.clients c
   where c.id = p_client_id
     for update;
  if v_studio is not null then
    v_actor := public.client_id_photo_actor(v_studio);
  end if;
  if v_studio is null or v_actor is null or v_archived is not null
     or not public.client_id_photo_switch_on(v_studio) then
    raise exception 'ID photos are not available for this client.' using errcode = 'check_violation';
  end if;
  if p_channel is distinct from 'in_person' then
    raise exception 'Consent can be recorded in person only.' using errcode = 'P0275';
  end if;
  if p_provided_by is distinct from 'client' then
    raise exception 'Consent must be given by the client.' using errcode = 'P0275';
  end if;
  if not exists (
    select 1 from public.client_id_photo_wording_versions w
     where w.version = p_wording_version
       and w.wording_sha256 = p_wording_sha256
       and w.approved_at is not null) then
    raise exception 'That consent wording is not current.' using errcode = 'P0275';
  end if;

  insert into public.client_id_photo_consents
    (studio_id, client_id, event, wording_version, wording_sha256, provided_by, channel, recorded_by_practitioner_id)
  values
    (v_studio, p_client_id, 'granted', p_wording_version, p_wording_sha256, 'client', 'in_person', v_actor)
  returning id into v_id;

  insert into public.client_id_photo_audit (studio_id, client_id, event, actor_practitioner_id)
  values (v_studio, p_client_id, 'consent_granted', v_actor);
  return v_id;
end;
$$;

-- Withdraw consent: append the withdrawal AND remove the photo in one transaction
-- (the row delete stops serving at once; the queue trigger schedules the object).
-- Allowed while the switch is OFF (withdrawal is always possible for an actor).
create or replace function public.withdraw_client_id_photo_consent(p_client_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_studio uuid;
  v_actor uuid;
  v_last record;
  v_deleted int;
begin
  select c.studio_id into v_studio
    from public.clients c
   where c.id = p_client_id
     for update;
  if v_studio is not null then
    v_actor := public.client_id_photo_actor(v_studio);
  end if;
  if v_studio is null or v_actor is null then
    raise exception 'ID photos are not available for this client.' using errcode = 'check_violation';
  end if;

  select cc.event, cc.wording_version, cc.wording_sha256 into v_last
    from public.client_id_photo_consents cc
   where cc.studio_id = v_studio and cc.client_id = p_client_id
   order by cc.seq desc
   limit 1;

  delete from public.client_id_photos where client_id = p_client_id and studio_id = v_studio;
  get diagnostics v_deleted = row_count;

  if v_last.event = 'granted' then
    insert into public.client_id_photo_consents
      (studio_id, client_id, event, wording_version, wording_sha256, provided_by, channel, recorded_by_practitioner_id)
    values
      (v_studio, p_client_id, 'withdrawn', v_last.wording_version, v_last.wording_sha256, 'client', 'in_person', v_actor);
    insert into public.client_id_photo_audit (studio_id, client_id, event, actor_practitioner_id)
    values (v_studio, p_client_id, 'consent_withdrawn', v_actor);
  end if;
  if v_deleted > 0 then
    insert into public.client_id_photo_audit (studio_id, client_id, event, actor_practitioner_id)
    values (v_studio, p_client_id, 'photo_removed', v_actor);
  end if;
  return v_last.event = 'granted' or v_deleted > 0;
end;
$$;

-- Store or replace the photo's metadata AFTER the server uploaded the re-encoded
-- derivative. The path must be <studio>/<client>/<uuid>.webp (checked by the table).
create or replace function public.set_client_id_photo(
  p_client_id uuid,
  p_storage_path text,
  p_byte_size integer,
  p_width integer,
  p_height integer
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_studio uuid;
  v_archived timestamptz;
  v_actor uuid;
  v_consent uuid;
  v_had boolean;
begin
  select c.studio_id, c.archived_at into v_studio, v_archived
    from public.clients c
   where c.id = p_client_id
     for update;
  if v_studio is not null then
    v_actor := public.client_id_photo_actor(v_studio);
  end if;
  if v_studio is null or v_actor is null or v_archived is not null
     or not public.client_id_photo_switch_on(v_studio) then
    raise exception 'ID photos are not available for this client.' using errcode = 'check_violation';
  end if;

  select cc.id into v_consent
    from public.client_id_photo_consents cc
   where cc.studio_id = v_studio and cc.client_id = p_client_id and cc.event = 'granted'
     and not exists (
       select 1 from public.client_id_photo_consents w
        where w.studio_id = cc.studio_id and w.client_id = cc.client_id and w.seq > cc.seq)
   order by cc.seq desc
   limit 1;
  if v_consent is null then
    raise exception 'The client''s consent is needed first.' using errcode = 'P0275';
  end if;

  select exists (select 1 from public.client_id_photos where client_id = p_client_id) into v_had;

  insert into public.client_id_photos
    (client_id, studio_id, storage_path, byte_size, width, height, consent_id, created_by)
  values
    (p_client_id, v_studio, p_storage_path, p_byte_size, p_width, p_height, v_consent, v_actor)
  on conflict (client_id) do update
     set storage_path = excluded.storage_path,
         byte_size = excluded.byte_size,
         width = excluded.width,
         height = excluded.height,
         consent_id = excluded.consent_id,
         created_by = excluded.created_by,
         updated_at = now();

  insert into public.client_id_photo_audit (studio_id, client_id, event, actor_practitioner_id)
  values (v_studio, p_client_id, case when v_had then 'photo_replaced' else 'photo_set' end, v_actor);
  return p_client_id;
end;
$$;

-- Remove the photo (consent stays as it was). Allowed while the switch is OFF.
create or replace function public.remove_client_id_photo(p_client_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_studio uuid;
  v_actor uuid;
  v_deleted int;
begin
  select c.studio_id into v_studio
    from public.clients c
   where c.id = p_client_id
     for update;
  if v_studio is not null then
    v_actor := public.client_id_photo_actor(v_studio);
  end if;
  if v_studio is null or v_actor is null then
    raise exception 'ID photos are not available for this client.' using errcode = 'check_violation';
  end if;
  delete from public.client_id_photos where client_id = p_client_id and studio_id = v_studio;
  get diagnostics v_deleted = row_count;
  if v_deleted > 0 then
    insert into public.client_id_photo_audit (studio_id, client_id, event, actor_practitioner_id)
    values (v_studio, p_client_id, 'photo_removed', v_actor);
  end if;
  return v_deleted > 0;
end;
$$;

-- The deletion queue, drained by the app through the Storage API.
create or replace function public.pending_client_id_photo_object_deletions(p_limit integer default 20)
returns table (storage_path text)
language sql
stable
security definer
set search_path = ''
as $$
  select q.storage_path
    from public.client_id_photo_pending_object_deletions q
   where public.client_id_photo_actor(q.studio_id) is not null
   order by q.queued_at
   limit greatest(1, least(coalesce(p_limit, 20), 100));
$$;

create or replace function public.ack_client_id_photo_object_deletion(p_storage_path text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_studio uuid;
  v_deleted int;
begin
  select q.studio_id into v_studio
    from public.client_id_photo_pending_object_deletions q
   where q.storage_path = p_storage_path;
  if v_studio is null or public.client_id_photo_actor(v_studio) is null then
    return false;
  end if;
  delete from public.client_id_photo_pending_object_deletions where storage_path = p_storage_path;
  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end;
$$;

-- ---------------------------------------------------------------------------
-- 12. OPERATOR commands: no API role may call them (granted to nobody).
-- ---------------------------------------------------------------------------
create or replace function public.set_client_id_photo_enabled(p_studio_id uuid, p_enabled boolean, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_reason is null or char_length(p_reason) not between 1 and 300 then
    raise exception 'A reason of 1 to 300 characters is required.' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.studios s where s.id = p_studio_id) then
    raise exception 'Unknown studio.' using errcode = 'check_violation';
  end if;
  insert into public.studio_client_id_photo_settings (studio_id, enabled, reason)
  values (p_studio_id, p_enabled, p_reason)
  on conflict (studio_id) do update
     set enabled = excluded.enabled, reason = excluded.reason, changed_at = now();
  return p_enabled;
end;
$$;

create or replace function public.approve_client_id_photo_wording(p_version text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.client_id_photo_wording_versions
     set approved_at = now()
   where version = p_version and approved_at is null;
  return found;
end;
$$;

-- ---------------------------------------------------------------------------
-- 13. CLIENT ARCHIVE removes the photo (decision 6). A NEW trigger on clients: no
--     other lane's function is redefined. The photo row goes (the queue trigger
--     schedules the object), a system withdrawal is appended if consent was current,
--     and an image-free audit event is written. treatment_images is never touched.
-- ---------------------------------------------------------------------------
create or replace function public.client_id_photo_on_client_archive()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_last record;
  v_deleted int;
begin
  select cc.event, cc.wording_version, cc.wording_sha256 into v_last
    from public.client_id_photo_consents cc
   where cc.studio_id = new.studio_id and cc.client_id = new.id
   order by cc.seq desc
   limit 1;

  delete from public.client_id_photos where client_id = new.id and studio_id = new.studio_id;
  get diagnostics v_deleted = row_count;

  if v_last.event = 'granted' then
    insert into public.client_id_photo_consents
      (studio_id, client_id, event, wording_version, wording_sha256, provided_by, channel)
    values (new.studio_id, new.id, 'withdrawn', v_last.wording_version, v_last.wording_sha256, 'system', 'system');
    insert into public.client_id_photo_audit (studio_id, client_id, event)
    values (new.studio_id, new.id, 'consent_withdrawn_client_archived');
  end if;
  if v_deleted > 0 then
    insert into public.client_id_photo_audit (studio_id, client_id, event)
    values (new.studio_id, new.id, 'photo_removed_client_archived');
  end if;
  return new;
end;
$$;

create trigger client_id_photo_on_client_archive
  after update of archived_at on public.clients
  for each row
  when (old.archived_at is null and new.archived_at is not null)
  execute function public.client_id_photo_on_client_archive();

-- ---------------------------------------------------------------------------
-- 14. DECISION 10 / Privacy B1, B2: close the 0231 bypass.
-- ---------------------------------------------------------------------------
revoke execute on function public.set_client_portrait(uuid, uuid, uuid) from public;
revoke execute on function public.set_client_portrait(uuid, uuid, uuid) from anon;
revoke execute on function public.set_client_portrait(uuid, uuid, uuid) from authenticated;
revoke execute on function public.set_client_portrait(uuid, uuid, uuid) from service_role;

create or replace function public.clients_portrait_pointer_frozen()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.portrait_image_id is not null
     and (tg_op = 'INSERT' or new.portrait_image_id is distinct from old.portrait_image_id) then
    raise exception 'The treatment-photo identification portrait is retired.' using errcode = 'P0275';
  end if;
  return new;
end;
$$;

create trigger clients_portrait_pointer_frozen
  before insert or update of portrait_image_id on public.clients
  for each row execute function public.clients_portrait_pointer_frozen();

-- ---------------------------------------------------------------------------
-- 15. FUNCTION PRIVILEGES. Supabase's default privileges grant EXECUTE to anon,
--     authenticated AND service_role at create time: revoke all three, and PUBLIC,
--     by name, per signature (CLAUDE.md section 5; clinical-rpc-grant-guard).
--     Commands and the RLS predicate are then granted to authenticated only;
--     internal helpers, trigger functions and operator commands to nobody.
-- ---------------------------------------------------------------------------
revoke execute on function public.client_id_photo_actor(uuid) from public;
revoke execute on function public.client_id_photo_actor(uuid) from anon;
revoke execute on function public.client_id_photo_actor(uuid) from authenticated;
revoke execute on function public.client_id_photo_actor(uuid) from service_role;

revoke execute on function public.client_id_photo_switch_on(uuid) from public;
revoke execute on function public.client_id_photo_switch_on(uuid) from anon;
revoke execute on function public.client_id_photo_switch_on(uuid) from authenticated;
revoke execute on function public.client_id_photo_switch_on(uuid) from service_role;

revoke execute on function public.client_id_photo_consent_granted(uuid, uuid) from public;
revoke execute on function public.client_id_photo_consent_granted(uuid, uuid) from anon;
revoke execute on function public.client_id_photo_consent_granted(uuid, uuid) from authenticated;
revoke execute on function public.client_id_photo_consent_granted(uuid, uuid) from service_role;

revoke execute on function public.client_id_photo_can_read(uuid, uuid) from public;
revoke execute on function public.client_id_photo_can_read(uuid, uuid) from anon;
revoke execute on function public.client_id_photo_can_read(uuid, uuid) from authenticated;
revoke execute on function public.client_id_photo_can_read(uuid, uuid) from service_role;
grant execute on function public.client_id_photo_can_read(uuid, uuid) to authenticated;

revoke execute on function public.client_id_photo_wording_current(uuid) from public;
revoke execute on function public.client_id_photo_wording_current(uuid) from anon;
revoke execute on function public.client_id_photo_wording_current(uuid) from authenticated;
revoke execute on function public.client_id_photo_wording_current(uuid) from service_role;
grant execute on function public.client_id_photo_wording_current(uuid) to authenticated;

revoke execute on function public.client_id_photo_enabled(uuid) from public;
revoke execute on function public.client_id_photo_enabled(uuid) from anon;
revoke execute on function public.client_id_photo_enabled(uuid) from authenticated;
revoke execute on function public.client_id_photo_enabled(uuid) from service_role;
grant execute on function public.client_id_photo_enabled(uuid) to authenticated;

revoke execute on function public.record_client_id_photo_consent(uuid, text, text, text, text) from public;
revoke execute on function public.record_client_id_photo_consent(uuid, text, text, text, text) from anon;
revoke execute on function public.record_client_id_photo_consent(uuid, text, text, text, text) from authenticated;
revoke execute on function public.record_client_id_photo_consent(uuid, text, text, text, text) from service_role;
grant execute on function public.record_client_id_photo_consent(uuid, text, text, text, text) to authenticated;

revoke execute on function public.withdraw_client_id_photo_consent(uuid) from public;
revoke execute on function public.withdraw_client_id_photo_consent(uuid) from anon;
revoke execute on function public.withdraw_client_id_photo_consent(uuid) from authenticated;
revoke execute on function public.withdraw_client_id_photo_consent(uuid) from service_role;
grant execute on function public.withdraw_client_id_photo_consent(uuid) to authenticated;

revoke execute on function public.set_client_id_photo(uuid, text, integer, integer, integer) from public;
revoke execute on function public.set_client_id_photo(uuid, text, integer, integer, integer) from anon;
revoke execute on function public.set_client_id_photo(uuid, text, integer, integer, integer) from authenticated;
revoke execute on function public.set_client_id_photo(uuid, text, integer, integer, integer) from service_role;
grant execute on function public.set_client_id_photo(uuid, text, integer, integer, integer) to authenticated;

revoke execute on function public.remove_client_id_photo(uuid) from public;
revoke execute on function public.remove_client_id_photo(uuid) from anon;
revoke execute on function public.remove_client_id_photo(uuid) from authenticated;
revoke execute on function public.remove_client_id_photo(uuid) from service_role;
grant execute on function public.remove_client_id_photo(uuid) to authenticated;

revoke execute on function public.pending_client_id_photo_object_deletions(integer) from public;
revoke execute on function public.pending_client_id_photo_object_deletions(integer) from anon;
revoke execute on function public.pending_client_id_photo_object_deletions(integer) from authenticated;
revoke execute on function public.pending_client_id_photo_object_deletions(integer) from service_role;
grant execute on function public.pending_client_id_photo_object_deletions(integer) to authenticated;

revoke execute on function public.ack_client_id_photo_object_deletion(text) from public;
revoke execute on function public.ack_client_id_photo_object_deletion(text) from anon;
revoke execute on function public.ack_client_id_photo_object_deletion(text) from authenticated;
revoke execute on function public.ack_client_id_photo_object_deletion(text) from service_role;
grant execute on function public.ack_client_id_photo_object_deletion(text) to authenticated;

-- OPERATOR commands: granted to nobody.
revoke execute on function public.set_client_id_photo_enabled(uuid, boolean, text) from public;
revoke execute on function public.set_client_id_photo_enabled(uuid, boolean, text) from anon;
revoke execute on function public.set_client_id_photo_enabled(uuid, boolean, text) from authenticated;
revoke execute on function public.set_client_id_photo_enabled(uuid, boolean, text) from service_role;

revoke execute on function public.approve_client_id_photo_wording(text) from public;
revoke execute on function public.approve_client_id_photo_wording(text) from anon;
revoke execute on function public.approve_client_id_photo_wording(text) from authenticated;
revoke execute on function public.approve_client_id_photo_wording(text) from service_role;

-- Trigger functions are never callable.
revoke execute on function public.client_id_photo_immutable() from public;
revoke execute on function public.client_id_photo_immutable() from anon;
revoke execute on function public.client_id_photo_immutable() from authenticated;
revoke execute on function public.client_id_photo_immutable() from service_role;
revoke execute on function public.client_id_photo_wording_guard() from public;
revoke execute on function public.client_id_photo_wording_guard() from anon;
revoke execute on function public.client_id_photo_wording_guard() from authenticated;
revoke execute on function public.client_id_photo_wording_guard() from service_role;
revoke execute on function public.studio_client_id_photo_switch_log_write() from public;
revoke execute on function public.studio_client_id_photo_switch_log_write() from anon;
revoke execute on function public.studio_client_id_photo_switch_log_write() from authenticated;
revoke execute on function public.studio_client_id_photo_switch_log_write() from service_role;
revoke execute on function public.client_id_photo_queue_object() from public;
revoke execute on function public.client_id_photo_queue_object() from anon;
revoke execute on function public.client_id_photo_queue_object() from authenticated;
revoke execute on function public.client_id_photo_queue_object() from service_role;
revoke execute on function public.client_id_photo_on_client_archive() from public;
revoke execute on function public.client_id_photo_on_client_archive() from anon;
revoke execute on function public.client_id_photo_on_client_archive() from authenticated;
revoke execute on function public.client_id_photo_on_client_archive() from service_role;
revoke execute on function public.clients_portrait_pointer_frozen() from public;
revoke execute on function public.clients_portrait_pointer_frozen() from anon;
revoke execute on function public.clients_portrait_pointer_frozen() from authenticated;
revoke execute on function public.clients_portrait_pointer_frozen() from service_role;

comment on table public.client_id_photos is
  '0275. One identification photo per client (a square WebP derivative in the private client-identification-photos bucket). NOT a clinical record; never joined to treatment_images. Read through RLS (owner/practitioner, switch ON, current consent).';
comment on table public.client_id_photo_consents is
  '0275. Append-only consent evidence: who provided, who recorded, channel, time, wording version and hash. Withdrawal is a new row.';
comment on table public.client_id_photo_audit is
  '0275. Image-free audit facts: who, when, client reference, action. No path, URL, filename or consent text.';
comment on table public.client_id_photo_pending_object_deletions is
  '0275. Storage objects awaiting deletion through the Storage API. Rows are drained by the app; backups may retain a deleted object until they age out.';

commit;
