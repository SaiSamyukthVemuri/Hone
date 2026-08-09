-- ---------------------------------------------------------------------------
-- 0174 — PRACTITIONER IDENTITY BOUNDARY (closes audit finding A-P1-01)
--
-- WHAT THIS CLOSES
-- ===========================================================================
-- `public.practitioners` is the identity spine of this product. Every
-- `auth.uid()`-derived clinical guarantee — who charted, who reviewed an
-- intake, who is a member of a studio, who owns it — resolves through a row in
-- this table. Yet the table was an ordinary authenticated-writable table:
--
--   * `authenticated` held INSERT and UPDATE (measured `arwDxtm`), and
--   * the 0001 policy `practitioners: owners update` pins ONLY
--     `is_studio_owner(studio_id)` — it constrains WHICH ROWS, never WHICH
--     COLUMNS.
--
-- REVALIDATED AT PRODUCTION a6b5e9e0 BEFORE WRITING THIS — not inherited from
-- the audit. Reproduced on a local chain as a studio owner through the
-- authenticated role, in ONE statement:
--
--   update public.practitioners
--      set user_id = '<an unrelated auth user>', role = 'owner', active = false,
--          display_name = 'HIJACKED', color = 'rose'
--    where id = '<a COLLEAGUE''s practitioner id>';       -- UPDATE 1
--
-- Rewriting `user_id` is the severe one: it re-points a roster identity at a
-- different auth user, so every clinical record already attributed through
-- `auth.uid()` silently begins vouching for someone else. `role` and `active`
-- are privilege escalation and denial of service on the same statement. A
-- colleague's `calendar_feed_token_hash` was likewise rewritable (UPDATE 1).
--
-- WHAT THE AUDIT CLAIMED THAT IS NO LONGER TRUE
-- ===========================================================================
-- A-P1-01 also claimed authenticated DELETE remained open. It does NOT:
-- migration 0173 (appointment repair / L23 closure) already ran
-- `revoke delete on table public.practitioners from anon, authenticated` and
-- dropped `practitioners: owners delete`. Verified here: a browser DELETE now
-- raises `42501 permission denied for table practitioners`. DELETE is named
-- again below purely so the posture is stated in one auditable place; REVOKE of
-- a privilege already revoked is not an error.
--
-- THE DESIGN — A COMMAND BOUNDARY, NOT A CLEVERER POLICY
-- ===========================================================================
-- Narrowing the RLS predicate while leaving a broad UPDATE grant in place would
-- not close this: a policy can only decide WHICH ROWS a statement may touch,
-- never which columns it may set. So the capability itself is removed and the
-- legitimate self-service writes move behind four narrowly-typed commands.
--
--   ordinary authenticated table DML ......... REVOKED
--   legitimate self-service mutation ......... narrow SECURITY DEFINER command,
--                                              actor proven from auth.uid()
--   privileged roster administration ......... unchanged service_role path
--
-- Deliberately NOT created: any `update_practitioner(jsonb)`,
-- `patch_practitioner(...)` or `update_practitioner_field(column, value)`. An
-- arbitrary-column RPC would rebuild the exact vulnerability behind a function
-- name. Each command below writes ONE named column.
--
-- THE ACTOR IS NEVER TAKEN FROM THE CALLER
-- ===========================================================================
-- Every command takes `p_practitioner_id` as a LOCATOR ONLY, and then proves
-- inside the database that the located row's `user_id = auth.uid()`. A
-- caller-supplied practitioner id is never sufficient authority: an owner
-- passing a colleague's id gets the same refusal as a stranger, because
-- ownership is never consulted. The locator exists because one auth user may
-- hold practitioner rows in several studios.
--
-- WHAT THIS ALSO FIXES, INCIDENTALLY BUT REALLY
-- ===========================================================================
-- `practitioners: owners update` is the ONLY update policy, so a NON-OWNER
-- practitioner's profile save currently matches zero rows and silently does
-- nothing — the app reports success because a zero-row UPDATE is not an error.
-- Measured: `UPDATE 0`. After this migration every practitioner can edit their
-- own name, colour and calendar feed, because the commands are keyed to
-- `auth.uid()` rather than to studio ownership.
--
-- WHAT IS DELIBERATELY NOT TOUCHED
-- ===========================================================================
-- * `authenticated` SELECT and the `practitioners: members read` policy are
--   PRESERVED. 31 read sites depend on them; not one revocation below names
--   SELECT and there is no `revoke all` in this file.
-- * `service_role` and `postgres` privileges are UNCHANGED. Roster
--   administration already runs there: activation/deactivation through
--   `set_practitioner_active_locked` (0150) is called with the ADMIN client and
--   keeps its owner/self-removal protections untouched, and the
--   `default_machine_frequency` writer in the charting flow is likewise an
--   admin-client write. Neither is affected by revoking a browser privilege.
-- * No appointment table, policy, grant or command. B3/0172 and B4/0173 are
--   untouched; this file names no appointment object at all.
-- * No trigger, no constraint, no column, no index, no data change, no
--   `client_clinical_notes` FK change (see the deferral note below).
--
-- CLINICAL-NOTE FK: DEFERRED, AND WHY THAT IS SAFE
-- ===========================================================================
-- The audit also flagged that deleting a practitioner cascade-deletes
-- append-only `client_clinical_notes`. That path is ALREADY closed from the
-- browser: authenticated DELETE was revoked by 0173 and is re-asserted here, so
-- no browser-reachable actor can trigger the cascade. Changing the FK to ON
-- DELETE RESTRICT would alter studio-deletion and retention lifecycle semantics
-- well beyond this focused ticket, so it is recorded as a follow-up rather than
-- improvised here. The DB suite proves the browser DELETE refusal explicitly.
--
-- Own transaction + armed lock_timeout: `supabase db push` does not wrap a
-- migration file in a transaction, so a bare SET LOCAL emits 25P01 and never
-- arms (the 0159 lesson).
--
-- Migration max 0173 -> 0174.
-- ---------------------------------------------------------------------------

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- GROUP 1 — remove the capability. SELECT is deliberately NOT named.
-- ---------------------------------------------------------------------------
revoke insert, update, delete on table public.practitioners from authenticated;
revoke insert, update, delete on table public.practitioners from anon;

-- Maintenance / definition verbs an identity table must not expose to a browser
-- role, same doctrine as 0172 GROUP 4/5. MAINTAIN is PostgreSQL 17+.
revoke truncate, references, trigger on table public.practitioners from anon, authenticated;
revoke maintain on table public.practitioners from anon, authenticated;

-- ---------------------------------------------------------------------------
-- GROUP 2 — policy residue. The write policies are now unreachable; leaving
-- them would describe a capability that no longer exists, which is worse than
-- no policy at all. The READ policy is preserved untouched.
-- ---------------------------------------------------------------------------
drop policy if exists "practitioners: owners insert" on public.practitioners;
drop policy if exists "practitioners: owners update" on public.practitioners;

-- ---------------------------------------------------------------------------
-- GROUP 3 — the four self-service commands.
-- ---------------------------------------------------------------------------
--
-- Shared contract, enforced independently inside EVERY function so that no
-- single helper becomes the one thing worth bypassing:
--
--   1. auth.uid() must be present            -> 42501 otherwise
--   2. the located row must EXIST            -> P0002 otherwise
--   3. row.user_id must EQUAL auth.uid()     -> 42501 otherwise
--   4. exactly one named column is written
--
-- Ownership is never consulted, so an owner has no more authority here than any
-- other practitioner. Cross-studio targeting fails at step 3 for the same
-- reason a colleague does: the row's user_id is not the caller's.

create or replace function public.set_own_practitioner_display_name(
  p_practitioner_id uuid,
  p_display_name text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_name  text := btrim(coalesce(p_display_name, ''));
  v_owner uuid;
begin
  if v_actor is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  -- Product contract preserved from the server action: a blank name is refused.
  if v_name = '' then
    raise exception 'Your name is required.' using errcode = '22023';
  end if;
  if length(v_name) > 200 then
    raise exception 'Your name is too long.' using errcode = '22023';
  end if;

  select user_id into v_owner
    from public.practitioners
   where id = p_practitioner_id;
  if not found then
    raise exception 'practitioner not found' using errcode = 'P0002';
  end if;
  -- THE authority check. A caller-supplied id is a locator, never a permission.
  if v_owner is distinct from v_actor then
    raise exception 'not your practitioner record' using errcode = '42501';
  end if;

  update public.practitioners
     set display_name = v_name
   where id = p_practitioner_id;
end;
$$;

create or replace function public.set_own_practitioner_color(
  p_practitioner_id uuid,
  p_color text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_color text := btrim(coalesce(p_color, ''));
  v_owner uuid;
begin
  if v_actor is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  -- SHAPE check only, deliberately. The authoritative palette lives in
  -- lib/practitioner-colors.ts, and that module's documented contract is that
  -- adding a colour is "a pure code change: append to the array, no migration
  -- needed". Hard-coding the palette here would silently break that contract
  -- and make every future colour a migration. The server action still gates on
  -- isPractitionerColor(); this is the defensive floor beneath it.
  if v_color !~ '^[a-z][a-z0-9_-]{1,29}$' then
    raise exception 'Pick a color from the palette.' using errcode = '22023';
  end if;

  select user_id into v_owner
    from public.practitioners
   where id = p_practitioner_id;
  if not found then
    raise exception 'practitioner not found' using errcode = 'P0002';
  end if;
  if v_owner is distinct from v_actor then
    raise exception 'not your practitioner record' using errcode = '42501';
  end if;

  update public.practitioners
     set color = v_color
   where id = p_practitioner_id;
end;
$$;

-- Calendar feed: HASH ONLY at rest (0079 + 0116). The raw token is generated by
-- a CSPRNG in the application, returned to the caller once, and never sent to
-- the database — so this command accepts the SHA-256 hex and nothing else. The
-- `active` requirement is the existing product contract, moved from a server
-- action into the database where it cannot be skipped.
create or replace function public.rotate_own_calendar_feed_token(
  p_practitioner_id uuid,
  p_token_hash text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := auth.uid();
  v_owner  uuid;
  v_active boolean;
begin
  if v_actor is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  -- Matches practitioners_calendar_feed_token_hash_check (0079). Refusing here
  -- keeps the raw-token-at-rest mistake unreachable: a 43-char base64url token
  -- cannot satisfy this.
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid calendar feed token hash' using errcode = '22023';
  end if;

  select user_id, active into v_owner, v_active
    from public.practitioners
   where id = p_practitioner_id;
  if not found then
    raise exception 'practitioner not found' using errcode = 'P0002';
  end if;
  if v_owner is distinct from v_actor then
    raise exception 'not your practitioner record' using errcode = '42501';
  end if;
  if v_active is not true then
    raise exception 'Inactive practitioners cannot manage feeds.' using errcode = '42501';
  end if;

  update public.practitioners
     set calendar_feed_token_hash = p_token_hash
   where id = p_practitioner_id;
end;
$$;

create or replace function public.clear_own_calendar_feed_token(
  p_practitioner_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := auth.uid();
  v_owner  uuid;
  v_active boolean;
begin
  if v_actor is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select user_id, active into v_owner, v_active
    from public.practitioners
   where id = p_practitioner_id;
  if not found then
    raise exception 'practitioner not found' using errcode = 'P0002';
  end if;
  if v_owner is distinct from v_actor then
    raise exception 'not your practitioner record' using errcode = '42501';
  end if;
  if v_active is not true then
    raise exception 'Inactive practitioners cannot manage feeds.' using errcode = '42501';
  end if;

  update public.practitioners
     set calendar_feed_token_hash = null
   where id = p_practitioner_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- GROUP 4 — EXECUTE grants, named exhaustively.
-- ---------------------------------------------------------------------------
-- Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to anon, authenticated AND
-- service_role at function-create time, so an authenticated-only command must
-- revoke from all three by name. Missed once in 0129 (anon) and again in 0164
-- (service_role); pinned since by tests/security/clinical-rpc-grant-guard.
--
-- service_role is revoked deliberately, not by omission: these commands resolve
-- their actor from auth.uid(), which is NULL for service_role, so a service-role
-- caller could only ever fail — and leaving the grant would suggest a
-- back-channel exists. Roster administration has its own governed path.
revoke execute on function public.set_own_practitioner_display_name(uuid, text) from public, anon, service_role;
revoke execute on function public.set_own_practitioner_color(uuid, text)        from public, anon, service_role;
revoke execute on function public.rotate_own_calendar_feed_token(uuid, text)    from public, anon, service_role;
revoke execute on function public.clear_own_calendar_feed_token(uuid)           from public, anon, service_role;

grant execute on function public.set_own_practitioner_display_name(uuid, text) to authenticated;
grant execute on function public.set_own_practitioner_color(uuid, text)        to authenticated;
grant execute on function public.rotate_own_calendar_feed_token(uuid, text)    to authenticated;
grant execute on function public.clear_own_calendar_feed_token(uuid)           to authenticated;

comment on function public.set_own_practitioner_display_name(uuid, text) is
  'Self-service: sets ONLY display_name on the caller''s own practitioner row. p_practitioner_id is a locator; authority is user_id = auth.uid().';
comment on function public.set_own_practitioner_color(uuid, text) is
  'Self-service: sets ONLY color on the caller''s own practitioner row. Palette remains authoritative in lib/practitioner-colors.ts.';
comment on function public.rotate_own_calendar_feed_token(uuid, text) is
  'Self-service: sets ONLY calendar_feed_token_hash (SHA-256 hex) on the caller''s own ACTIVE practitioner row. Raw tokens are never stored.';
comment on function public.clear_own_calendar_feed_token(uuid) is
  'Self-service: nulls ONLY calendar_feed_token_hash on the caller''s own ACTIVE practitioner row.';

commit;
