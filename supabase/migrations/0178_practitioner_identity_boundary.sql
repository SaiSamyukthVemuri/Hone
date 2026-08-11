-- ===========================================================================
-- PRACTITIONER IDENTITY + MUTATION BOUNDARY — 0178
-- ===========================================================================
--
-- The appointment program (B3–B8, 0172–0177) closed the APPOINTMENT write
-- surface. This file closes the next trust boundary: BUSINESS ACTOR IDENTITY.
--
-- TRANSPORT IDENTITY IS NOT A BUSINESS ACTOR. A request being authenticated
-- does not mean the caller may name or mutate any practitioner row in the
-- studio, and a service_role connection does not authenticate the human behind
-- it. The server resolves actor context; the database validates authority and
-- parentage.
--
-- THREE FACTS FROM RECON DROVE THIS FILE, and each is measured, not assumed.
--
-- 1. `public.practitioners` never received a table-level GRANT/REVOKE. 0173
--    revoked DELETE and dropped the delete policy; everything else was still
--    Supabase's default ALL grant, so on the 0177 schema BOTH `anon` and
--    `authenticated` held INSERT, UPDATE, TRUNCATE, REFERENCES and TRIGGER.
--    RLS is the only gate there, and RLS DOES NOT GOVERN TRUNCATE, REFERENCES
--    OR TRIGGER. That is a latent privilege exposure regardless of whether
--    PostgREST happens to expose a path to those verbs today: runtime-facing
--    roles simply should not hold powers outside the intended DML contract.
--
-- 2. THREE "own profile" ACTIONS WERE OWNER-ONLY IN PRACTICE. The display-name,
--    colour and calendar-feed actions update `practitioners` through the
--    AUTHENTICATED cookie client, but the only UPDATE policy is
--    `practitioners: owners update`. Measured against real RLS, a non-owner
--    renaming themselves affects ZERO ROWS AND RAISES NOTHING — the action
--    reports success and nothing changes. Governing these is a bug fix, not a
--    behaviour preservation.
--
-- 3. `treatment_image_actor()` resolved the actor with
--    `where user_id = auth.uid() and active limit 1` — no studio scope, no
--    ORDER BY. For a user with two active memberships that is a
--    planner-dependent choice. The commands then check the client against the
--    chosen studio, so a wrong pick FAILS CLOSED rather than attributing across
--    tenants: the defect is NONDETERMINISM AND INTERMITTENT REFUSAL, not a
--    proven cross-studio leak. It is stated that way here on purpose.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT TOUCH
--   * Every appointment object. 0172–0177 are untouched, no appointment grant
--     changes, and `snapshot_appointment_buffer` is neither referenced nor
--     re-emitted (STANDING PROHIBITION).
--   * `set_practitioner_active_locked` / `lock_studio_and_assert_owner`. Recon
--     proved team lifecycle is already owner-gated per studio and already
--     multi-owner safe. A correct subsystem is not rewritten because this
--     migration is about identity.
--   * `resolveActivePractitionerMembership` in the application. It already
--     honours a validated studio selection, never auto-picks, and never trusts
--     a forged one.
--   * Invitations and onboarding.
-- ---------------------------------------------------------------------------

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- GROUP 1 · HELPER — the caller's OWN practitioner row in an EXPLICIT studio
-- ---------------------------------------------------------------------------
-- The actor is ALWAYS `auth.uid()`. The browser supplies a STUDIO, never a
-- practitioner id, so there is nothing to forge: the worst a caller can do is
-- name a studio they are not an active member of, which resolves to NULL.
--
-- The explicit studio is what makes this deterministic for a user with two
-- memberships. `limit 1` over a global membership set is exactly the defect
-- this file removes from the treatment-image path; it is not reintroduced here.
-- (studio_id, user_id) is unique in practice, so the lookup is single-valued by
-- construction rather than by luck.
create or replace function public.own_practitioner_in_studio(p_studio_id uuid)
returns uuid
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select p.id
    from public.practitioners p
   where p.user_id = auth.uid()
     and p.studio_id = p_studio_id
     and p.active = true;
$$;

comment on function public.own_practitioner_in_studio(uuid) is
  '0178. Resolves auth.uid() to the ACTIVE practitioner row in ONE explicit studio. Returns NULL when the caller has no active membership there. Never selects across studios and never LIMIT 1s a global membership set. Internal helper: EXECUTE is revoked from every runtime role.';

-- ---------------------------------------------------------------------------
-- GROUP 1 · COMMAND 1 — own display name and colour
-- ---------------------------------------------------------------------------
-- NULL MEANS "LEAVE UNCHANGED", which is unambiguous here because neither field
-- has a legitimate NULL value: the name is required non-empty and the colour is
-- always one of the eight palette tokens. One command therefore serves both the
-- name form and the colour picker without a JSON patch surface.
--
-- WHAT A PRACTITIONER MAY NOT REACH. `id`, `studio_id`, `user_id`, `role`,
-- `active`, `email`, `created_at` and the terms/privacy acceptance columns are
-- not parameters and are not in the SET list. There is no field name accepted
-- from the caller, so no future column becomes writable by accident.
--
-- Returns the practitioner id, or NULL when the caller has no ACTIVE membership
-- in that studio — so a caller can never report success for a zero-row write,
-- which is precisely the failure the old owner-gated RLS produced silently.
create or replace function public.update_own_practitioner_profile(
  p_studio_id    uuid,
  p_display_name text,
  p_color        text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_pract uuid;
  v_name  text;
begin
  v_pract := public.own_practitioner_in_studio(p_studio_id);
  if v_pract is null then
    return null;
  end if;

  if p_display_name is not null then
    v_name := btrim(p_display_name);
    if v_name = '' then
      raise exception 'Your name is required.' using errcode = 'check_violation';
    end if;
    if length(v_name) > 120 then
      raise exception 'Your name is too long.' using errcode = 'check_violation';
    end if;
  end if;

  -- The palette is closed, and it is validated HERE rather than trusted from
  -- the caller: `practitioners.color` carries no CHECK constraint, so the
  -- application's `isPractitionerColor` was the only gate.
  if p_color is not null
     and p_color not in ('amber','emerald','indigo','neutral','rose','sky','teal','violet')
  then
    raise exception 'Pick a colour from the palette.' using errcode = 'check_violation';
  end if;

  update public.practitioners p
     set display_name = coalesce(v_name, p.display_name),
         color        = coalesce(p_color, p.color)
   where p.id = v_pract;

  return v_pract;
end;
$$;

comment on function public.update_own_practitioner_profile(uuid, text, text) is
  '0178. A practitioner edits their OWN display name and colour in one explicit studio. Actor is auth.uid(); no practitioner id crosses the boundary. NULL leaves a field unchanged. Cannot reach id, studio_id, user_id, role, active, email or created_at. Returns NULL when the caller has no active membership in that studio.';

-- ---------------------------------------------------------------------------
-- GROUP 1 · COMMAND 2 — own calendar-feed token HASH
-- ---------------------------------------------------------------------------
-- The raw token never reaches the database. It is generated by the trusted
-- server with the existing CSPRNG, returned to the practitioner exactly once,
-- and only its SHA-256 hash is stored — the posture 0116 established.
--
-- NULL CLEARS, which is the deliberate difference from COMMAND 1: revoking a
-- feed is a real operation, so here NULL is a value rather than "unchanged".
create or replace function public.set_own_calendar_feed_token_hash(
  p_studio_id  uuid,
  p_token_hash text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_pract uuid;
begin
  v_pract := public.own_practitioner_in_studio(p_studio_id);
  if v_pract is null then
    return null;
  end if;

  -- Shape backstop mirroring the 0116 CHECK, so a malformed value fails with a
  -- clean message instead of a constraint error.
  if p_token_hash is not null and p_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Could not update the calendar feed.' using errcode = 'check_violation';
  end if;

  update public.practitioners p
     set calendar_feed_token_hash = p_token_hash
   where p.id = v_pract;

  return v_pract;
end;
$$;

comment on function public.set_own_calendar_feed_token_hash(uuid, text) is
  '0178. Rotates (hash) or revokes (NULL) the caller''s OWN calendar-feed token in one explicit studio. Only the SHA-256 hash crosses this boundary; the raw token is server-generated and never persisted. Returns NULL when the caller has no active membership in that studio.';

-- ---------------------------------------------------------------------------
-- GROUP 1 · COMMAND 3 — own default machine frequency
-- ---------------------------------------------------------------------------
-- A UI convenience default, previously written with the ADMIN client because
-- the authenticated path was owner-gated. Same user-visible entitlement, now
-- reached without a service-role bypass. NULL clears the default.
create or replace function public.set_own_default_machine_frequency(
  p_studio_id uuid,
  p_frequency text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_pract uuid;
begin
  v_pract := public.own_practitioner_in_studio(p_studio_id);
  if v_pract is null then
    return null;
  end if;

  if p_frequency is not null and p_frequency not in ('13.56 MHz', '27.12 MHz') then
    raise exception 'Unsupported machine frequency.' using errcode = 'check_violation';
  end if;

  update public.practitioners p
     set default_machine_frequency = p_frequency
   where p.id = v_pract;

  return v_pract;
end;
$$;

comment on function public.set_own_default_machine_frequency(uuid, text) is
  '0178. Stores the caller''s OWN machine-frequency UI default in one explicit studio. Same entitlement the admin-client write already provided, without the service-role bypass. Returns NULL when the caller has no active membership in that studio.';

-- ---------------------------------------------------------------------------
-- GROUP 2 · TREATMENT-IMAGE ACTOR — resource determines studio
-- ---------------------------------------------------------------------------
-- THE INVERSION. 0168 asked "which studio is this user in?" and then checked
-- the resource against that answer. With two memberships the first question has
-- no single answer, so the result depended on the planner. The order is now:
--
--     RESOURCE -> STUDIO -> ACTIVE PRACTITIONER IN THAT STUDIO
--
-- The three command SIGNATURES are unchanged, so the application needs no
-- change and this introduces no deployment skew of its own. The internal helper
-- is replaced: the no-argument form is dropped and a studio-scoped form takes
-- its name, which keeps `proname = 'treatment_image_actor'` — the shape the
-- existing 0168 privilege and posture suites assert.
--
-- `search_path = ''` is preserved for this whole family, matching 0168 and the
-- suite that pins it. Every reference is schema-qualified accordingly.
drop function if exists public.treatment_image_actor();

create or replace function public.treatment_image_actor(p_studio_id uuid)
returns table (studio_id uuid, practitioner_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select p.studio_id, p.id
    from public.practitioners p
   where p.user_id = auth.uid()
     and p.studio_id = p_studio_id
     and p.active = true;
$$;

comment on function public.treatment_image_actor(uuid) is
  '0178. Resolves auth.uid() to the ACTIVE practitioner in ONE explicit studio, replacing 0168''s global LIMIT-1 selection. Returns zero rows when there is no such membership, so each command chooses its own non-disclosing message. Internal helper: EXECUTE revoked from every runtime role.';

-- COMMAND 1 — create metadata. Studio now comes from the CLIENT.
--
-- NON-DISCLOSURE IS PRESERVED EXACTLY. "client does not exist" and "client
-- exists in a studio you are not an active member of" both raise the same
-- 'That client is not available.' — so the rewrite cannot be used to probe
-- another tenant's client ids. Every path/session/block integrity rule below is
-- carried over unchanged from 0168.
create or replace function public.create_treatment_image_metadata(
  p_id                uuid,
  p_client_id         uuid,
  p_session_id        uuid,
  p_session_block_id  uuid,
  p_storage_bucket    text,
  p_storage_path      text,
  p_original_filename text,
  p_content_type      text,
  p_size_bytes        bigint
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_studio      uuid;
  v_pract       uuid;
  v_session     uuid := p_session_id;
  v_block_sess  uuid;
  v_expected    text;
begin
  -- `auth.uid()` is already schema-qualified, so it resolves under the empty
  -- search_path exactly as it did in 0168. No wrapper is needed.
  if auth.uid() is null then
    raise exception 'An authenticated practitioner is required.'
      using errcode = 'check_violation';
  end if;

  if p_id is null or p_client_id is null then
    raise exception 'Could not save the image.' using errcode = 'check_violation';
  end if;

  -- RESOURCE FIRST: the client determines the studio.
  select c.studio_id into v_studio
    from public.clients c
   where c.id = p_client_id;

  -- ...then the actor must be an ACTIVE member of THAT studio. Both failures
  -- share one message on purpose.
  if v_studio is not null then
    select a.practitioner_id into v_pract
      from public.treatment_image_actor(v_studio) a;
  end if;
  if v_studio is null or v_pract is null then
    raise exception 'That client is not available.' using errcode = 'check_violation';
  end if;

  -- A block implies its session: derive the session FROM the block, and refuse
  -- a submitted session id that disagrees with it.
  if p_session_block_id is not null then
    select b.session_id into v_block_sess
      from public.session_blocks b
      join public.sessions s on s.id = b.session_id
     where b.id = p_session_block_id
       and b.studio_id = v_studio
       and s.studio_id = v_studio
       and s.client_id = p_client_id;

    if v_block_sess is null then
      raise exception 'That treatment area is not available for this client.'
        using errcode = 'check_violation';
    end if;
    if p_session_id is not null and p_session_id <> v_block_sess then
      raise exception 'That treatment area is not available for this client.'
        using errcode = 'check_violation';
    end if;
    v_session := v_block_sess;
  elsif p_session_id is not null then
    perform 1 from public.sessions s
      where s.id = p_session_id
        and s.studio_id = v_studio
        and s.client_id = p_client_id;
    if not found then
      raise exception 'That session is not available for this client.'
        using errcode = 'check_violation';
    end if;
  end if;

  -- Bucket is fixed, and the path must be exactly the studio/client/id prefix
  -- this actor is allowed to write. The 0093 CHECKs enforce the same shape;
  -- checking here refuses a forged path with a clean message instead of a
  -- constraint error.
  if p_storage_bucket is distinct from 'treatment-images' then
    raise exception 'Could not save the image.' using errcode = 'check_violation';
  end if;
  v_expected := v_studio::text || '/' || p_client_id::text || '/' || p_id::text || '.';
  if p_storage_path is null or position(v_expected in p_storage_path) <> 1 then
    raise exception 'Could not save the image.' using errcode = 'check_violation';
  end if;

  insert into public.treatment_images (
    id, studio_id, client_id, session_id, session_block_id,
    storage_bucket, storage_path, original_filename, content_type, size_bytes,
    uploaded_by
  ) values (
    p_id, v_studio, p_client_id, v_session, p_session_block_id,
    p_storage_bucket, p_storage_path, p_original_filename, p_content_type,
    p_size_bytes,
    -- DERIVED, never accepted from the caller.
    v_pract
  );

  return p_id;
end;
$$;

-- COMMAND 2 — note. Studio now comes from the IMAGE.
--
-- The generic NULL return is preserved for every miss: unknown image, wrong
-- client, already archived, AND "you are not an active member of that image's
-- studio" are all indistinguishable to the caller.
create or replace function public.set_treatment_image_note(
  p_image_id  uuid,
  p_client_id uuid,
  p_note      text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_studio uuid;
  v_pract  uuid;
  v_note   text;
  v_id     uuid;
begin
  -- Trim, then whitespace-only becomes NULL — the application's own rule,
  -- repeated here so the stored value cannot depend on the caller trimming.
  v_note := nullif(btrim(coalesce(p_note, '')), '');

  -- BACKSTOP only: the application validates first and owns the wording.
  if v_note is not null and length(v_note) > 1000 then
    raise exception 'Note is too long.' using errcode = 'check_violation';
  end if;

  select t.studio_id into v_studio
    from public.treatment_images t
   where t.id = p_image_id
     and t.client_id = p_client_id
     and t.deleted_at is null;
  if v_studio is null then
    return null;
  end if;

  select a.practitioner_id into v_pract
    from public.treatment_image_actor(v_studio) a;
  if v_pract is null then
    return null;
  end if;

  update public.treatment_images t
     set practitioner_note = v_note
   where t.id = p_image_id
     and t.studio_id = v_studio
     and t.client_id = p_client_id
     and t.deleted_at is null
  returning t.id into v_id;

  return v_id;
end;
$$;

-- COMMAND 3 — soft archive. Studio now comes from the IMAGE.
--
-- SOFT only: `deleted_at` is stamped by the DATABASE and `deleted_by` is
-- DERIVED from the resolved actor. No storage object is touched.
create or replace function public.archive_treatment_image(
  p_image_id  uuid,
  p_client_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_studio uuid;
  v_pract  uuid;
  v_id     uuid;
begin
  select t.studio_id into v_studio
    from public.treatment_images t
   where t.id = p_image_id
     and t.client_id = p_client_id
     and t.deleted_at is null;
  if v_studio is null then
    return null;
  end if;

  select a.practitioner_id into v_pract
    from public.treatment_image_actor(v_studio) a;
  if v_pract is null then
    return null;
  end if;

  update public.treatment_images t
     set deleted_at = now(),
         deleted_by = v_pract
   where t.id = p_image_id
     and t.studio_id = v_studio
     and t.client_id = p_client_id
     and t.deleted_at is null
  returning t.id into v_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- GROUP 3 · PRIVILEGE CLOSURE ON public.practitioners
-- ---------------------------------------------------------------------------
-- The current-tree census found FIVE direct writers, all UPDATE, all migrated
-- by this change; ZERO INSERT and ZERO DELETE anywhere in app/, lib/ or
-- components/. Nothing legitimate is left to serve, so the runtime roles drop
-- to SELECT-only.
--
-- TRUNCATE, REFERENCES and TRIGGER are named explicitly because RLS never
-- governed them: a policy cannot stop a role that holds TRUNCATE, and no amount
-- of `using (...)` limits a role that may attach a trigger. This is the 0157
-- doctrine applied to the practitioner roster.
--
-- SECURITY DEFINER commands are unaffected: they execute as the function owner,
-- not as the calling runtime role, so the governed team-lifecycle path
-- (`set_practitioner_active_locked`) and invitation reconciliation keep working
-- with no grant of their own.
revoke insert, update, truncate, references, trigger
  on table public.practitioners from anon;
revoke insert, update, truncate, references, trigger
  on table public.practitioners from authenticated;
revoke insert, update, truncate, references, trigger
  on table public.practitioners from service_role;
revoke insert, update, truncate, references, trigger
  on table public.practitioners from public;

-- DELETE was already revoked from anon/authenticated by 0173; service_role and
-- PUBLIC are closed here so the posture is uniform rather than partly historical.
revoke delete on table public.practitioners from service_role;
revoke delete on table public.practitioners from public;

-- The obsolete mutation policies. With the underlying privileges gone these can
-- never grant anything, and leaving them would advertise a direct-write path
-- that does not exist — the misleading shadow this program keeps removing.
-- `practitioners: members read` is deliberately KEPT: the roster is read all
-- over the product through the authenticated client.
drop policy if exists "practitioners: owners insert" on public.practitioners;
drop policy if exists "practitioners: owners update" on public.practitioners;

-- ---------------------------------------------------------------------------
-- GROUP 4 · EXECUTE POSTURE
-- ---------------------------------------------------------------------------
-- Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to PUBLIC, anon,
-- authenticated AND service_role at function-create time, so every function
-- above must revoke from all four by name and then grant back only what it
-- needs. Missed once in 0129 (anon) and again in 0164 (service_role).
--
-- The three own-preference commands are AUTHENTICATED-callable by design: they
-- bind the actor to auth.uid() inside the database, so there is no supplied
-- identity to forge and service_role never has to vouch for a human. The
-- helpers are granted to nobody.
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.own_practitioner_in_studio(uuid)',
    'public.treatment_image_actor(uuid)',
    'public.update_own_practitioner_profile(uuid, text, text)',
    'public.set_own_calendar_feed_token_hash(uuid, text)',
    'public.set_own_default_machine_frequency(uuid, text)'
  ] loop
    execute format('revoke execute on function %s from public', fn);
    execute format('revoke execute on function %s from anon', fn);
    execute format('revoke execute on function %s from authenticated', fn);
    execute format('revoke execute on function %s from service_role', fn);
  end loop;
end $$;

grant execute on function public.update_own_practitioner_profile(uuid, text, text) to authenticated;
grant execute on function public.set_own_calendar_feed_token_hash(uuid, text) to authenticated;
grant execute on function public.set_own_default_machine_frequency(uuid, text) to authenticated;

commit;
