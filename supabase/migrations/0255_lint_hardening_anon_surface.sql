-- 0255: LINT hardening (Sam decision 16, 2026-10-25). Reserved to Team.
--
-- Maps the Supabase security-advisor WARN rows the lint triage classified
-- ACTIONABLE or INTENTIONAL-but-removable. Four independent parts, one
-- transaction, each ending in a hard assertion so a half-applied state is
-- impossible:
--
--   1. function_search_path_mutable (13 rows): pin search_path on the 13 SECURITY
--      INVOKER trigger functions. Every body already schema-qualifies its
--      relations (public.*) and uses only pg_catalog functions, so the pin
--      changes no behaviour; it is the lint's remedy as written.
--   2. anon/authenticated EXECUTE on trigger functions: handle_new_user,
--      enforce_appointment_buffer, guard_scoped_recurring_rule_capacity,
--      studios_admission_mode_guard, snapshot_appointment_buffer. A trigger
--      function's EXECUTE is checked when the trigger is CREATED, never when it
--      fires, and a direct call already fails ("trigger functions can only be
--      called as triggers"), so the grants buy nothing. snapshot_appointment_buffer
--      is also the chain-vs-hosted drift (LINT-004): hosted already grants only
--      postgres and service_role. NO function body is created, replaced or
--      dropped here (standing prohibition for snapshot_appointment_buffer).
--   3. anon EXECUTE on the three RLS predicates (is_studio_member,
--      is_studio_owner, session_is_visible). A policy with no TO clause applies
--      to PUBLIC, anon included, and its function calls are checked against the
--      QUERYING role, so revoking EXECUTE alone would turn an anonymous empty
--      read into a permission error. Every such policy is therefore retargeted
--      TO authenticated first: for anon the result is unchanged (no policy
--      applies, zero rows) and for authenticated nothing changes. A policy that
--      NAMES anon and calls a predicate aborts the migration instead of being
--      silently rewritten.
--   4. rls_policy_always_true (2 rows): waitlist and demo_requests become
--      INSERT-only for anon/authenticated (no SELECT, UPDATE, DELETE, TRUNCATE
--      grant), the insert policy states what a form may write, and CHECK
--      constraints bound field length and email format. The constraints are
--      NOT VALID: existing rows are not scanned, so legacy data cannot block the
--      apply. A NOT VALID check still binds every later INSERT, COPY and UPDATE
--      of a row, against ALL its columns, so a legacy row that violates one
--      cannot be updated (the admin "mark contacted" UPDATE) and aborts a
--      logical restore load. NOT VALID is therefore only a bridge. The S1
--      preflight (supabase/preflight/0255-lint-hardening.preflight.sql) counts
--      violating rows per constraint, read-only and counts only; when every
--      count is zero the operator runs supabase/preflight/0255-lint-hardening.
--      validate.sql, which validates only the constraints whose count is zero.
--      A non-zero count needs an approved data step first; until then the
--      restore plan drops and re-adds the constraint around the load.
--
-- NOT touched, on purpose: rls_auto_enable (platform-owned, backs the ensure_rls
-- event trigger), btree_gist (extension_in_public), leaked-password protection
-- (dashboard setting), 0242/0247-0250, and every business RPC.
--
-- MERGE IS HELD behind 0213-0250. This file assumes the 0246 chain.

begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Pin search_path on the 13 invoker trigger functions.
-- ---------------------------------------------------------------------------
alter function public.set_updated_at() set search_path = pg_catalog, pg_temp;
alter function public.reject_payment_consents_mutation() set search_path = pg_catalog, pg_temp;
alter function public.reject_payment_audit_mutation() set search_path = pg_catalog, pg_temp;
alter function public.set_updated_at_now() set search_path = pg_catalog, pg_temp;
alter function public.treatment_plan_stages_set_studio_id() set search_path = pg_catalog, pg_temp;
alter function public.client_personal_notes_set_studio_id() set search_path = pg_catalog, pg_temp;
alter function public.tg_client_portal_messages_set_updated_at() set search_path = pg_catalog, pg_temp;
alter function public.tg_client_portal_message_replies_set_updated_at() set search_path = pg_catalog, pg_temp;
alter function public.tg_consent_form_templates_set_updated_at() set search_path = pg_catalog, pg_temp;
alter function public.tg_client_payment_methods_set_updated_at() set search_path = pg_catalog, pg_temp;
alter function public.payment_charge_attempts_touch_updated_at() set search_path = pg_catalog, pg_temp;
alter function public.enforce_treatment_image_integrity() set search_path = pg_catalog, pg_temp;
alter function public.tg_studio_tracking_providers_set_updated_at() set search_path = pg_catalog, pg_temp;

do $$
declare
  v_fn pg_catalog.text;
begin
  foreach v_fn in array array[
    'public.set_updated_at()',
    'public.reject_payment_consents_mutation()',
    'public.reject_payment_audit_mutation()',
    'public.set_updated_at_now()',
    'public.treatment_plan_stages_set_studio_id()',
    'public.client_personal_notes_set_studio_id()',
    'public.tg_client_portal_messages_set_updated_at()',
    'public.tg_client_portal_message_replies_set_updated_at()',
    'public.tg_consent_form_templates_set_updated_at()',
    'public.tg_client_payment_methods_set_updated_at()',
    'public.payment_charge_attempts_touch_updated_at()',
    'public.enforce_treatment_image_integrity()',
    'public.tg_studio_tracking_providers_set_updated_at()'
  ] loop
    if not exists (
      select 1 from pg_catalog.pg_proc p
       where p.oid = pg_catalog.to_regprocedure(v_fn)
         and not p.prosecdef
         and p.proconfig @> array['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
    ) then
      raise exception '0255: % is not an invoker function with a pinned search_path', v_fn;
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Trigger functions: no browser-role or PUBLIC EXECUTE. service_role and the
--    owner keep what they hold.
-- ---------------------------------------------------------------------------
revoke execute on function public.snapshot_appointment_buffer() from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.enforce_appointment_buffer() from public, anon, authenticated;
revoke execute on function public.guard_scoped_recurring_rule_capacity() from public, anon, authenticated;
revoke execute on function public.studios_admission_mode_guard() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. RLS predicates: retarget PUBLIC-default policies to authenticated, then
--    remove anon EXECUTE.
-- ---------------------------------------------------------------------------
do $$
declare
  v_anon pg_catalog.oid;
  v_pol record;
  v_expr pg_catalog.text;
  v_pattern constant pg_catalog.text :=
    '(^|[^a-z_])(is_studio_member|is_studio_owner|session_is_visible)\(';
begin
  select r.oid into v_anon from pg_catalog.pg_roles r where r.rolname = 'anon';
  if v_anon is null then
    raise exception '0255: anon role unavailable';
  end if;

  for v_pol in
    select pol.polname, pol.polrelid, pol.polroles, pol.polpermissive, n.nspname, c.relname,
           coalesce(pg_catalog.pg_get_expr(pol.polqual, pol.polrelid), '') || ' ' ||
           coalesce(pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid), '') as expr
      from pg_catalog.pg_policy pol
      join pg_catalog.pg_class c on c.oid = pol.polrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and (pol.polroles = array[0]::pg_catalog.oid[] or v_anon = any(pol.polroles))
  loop
    v_expr := pg_catalog.lower(v_pol.expr);
    if v_expr !~ v_pattern then continue; end if;
    if v_anon = any(v_pol.polroles) then
      raise exception '0255: policy % on %.% names anon and calls an RLS predicate; review before revoking',
        v_pol.polname, v_pol.nspname, v_pol.relname;
    end if;
    -- Retargeting a RESTRICTIVE policy would LOOSEN anon (a restrictive policy
    -- narrows what permissive ones allow). None exists today; fail closed.
    if not v_pol.polpermissive then
      raise exception '0255: restrictive policy % on %.% calls an RLS predicate and applies to anon; review before retargeting',
        v_pol.polname, v_pol.nspname, v_pol.relname;
    end if;
    execute pg_catalog.format('alter policy %I on %I.%I to authenticated',
      v_pol.polname, v_pol.nspname, v_pol.relname);
  end loop;

  -- Assertion: no policy that still applies to anon (or PUBLIC) calls a predicate.
  for v_pol in
    select pol.polname, n.nspname, c.relname,
           pg_catalog.lower(
             coalesce(pg_catalog.pg_get_expr(pol.polqual, pol.polrelid), '') || ' ' ||
             coalesce(pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid), '')) as expr
      from pg_catalog.pg_policy pol
      join pg_catalog.pg_class c on c.oid = pol.polrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and (pol.polroles = array[0]::pg_catalog.oid[] or v_anon = any(pol.polroles))
  loop
    if v_pol.expr ~ v_pattern then
      raise exception '0255: policy % on %.% still applies to anon and calls an RLS predicate',
        v_pol.polname, v_pol.nspname, v_pol.relname;
    end if;
  end loop;
end;
$$;

revoke execute on function public.is_studio_member(uuid) from public, anon;
revoke execute on function public.is_studio_owner(uuid) from public, anon;
revoke execute on function public.session_is_visible(uuid) from public, anon;

-- ---------------------------------------------------------------------------
-- 4. waitlist and demo_requests: anonymous INSERT only, validated.
-- ---------------------------------------------------------------------------
revoke all on table public.waitlist from public, anon, authenticated;
revoke all on table public.demo_requests from public, anon, authenticated;
grant insert on table public.waitlist to anon, authenticated;
grant insert on table public.demo_requests to anon, authenticated;

drop policy if exists "waitlist_anonymous_insert" on public.waitlist;
create policy "waitlist_anonymous_insert"
  on public.waitlist
  for insert
  to anon, authenticated
  with check (source = 'landing' and email is not null);

drop policy if exists "demo_requests_anonymous_insert" on public.demo_requests;
create policy "demo_requests_anonymous_insert"
  on public.demo_requests
  for insert
  to anon, authenticated
  with check (status = 'new' and name is not null and email is not null);

alter table public.waitlist
  drop constraint if exists waitlist_email_format_chk,
  drop constraint if exists waitlist_field_length_chk,
  add constraint waitlist_email_format_chk
    check (char_length(email) between 3 and 254 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') not valid,
  add constraint waitlist_field_length_chk
    check (char_length(practice_name) <= 300 and char_length(source) <= 40) not valid;

alter table public.demo_requests
  drop constraint if exists demo_requests_email_format_chk,
  drop constraint if exists demo_requests_field_length_chk,
  add constraint demo_requests_email_format_chk
    check (char_length(email) between 3 and 254 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') not valid,
  add constraint demo_requests_field_length_chk
    check (
      char_length(name) between 1 and 200
      and char_length(practice_name) <= 300
      and char_length(location) <= 300
      and char_length(current_tool) <= 300
      and char_length(notes) <= 5000
      and char_length(status) <= 40
    ) not valid;

-- ---------------------------------------------------------------------------
-- Assertions.
-- ---------------------------------------------------------------------------
do $$
declare
  v_fn pg_catalog.text;
  v_role pg_catalog.text;
  v_table pg_catalog.text;
  v_priv pg_catalog.text;
begin
  foreach v_fn in array array[
    'public.snapshot_appointment_buffer()',
    'public.handle_new_user()',
    'public.enforce_appointment_buffer()',
    'public.guard_scoped_recurring_rule_capacity()',
    'public.studios_admission_mode_guard()'
  ] loop
    foreach v_role in array array['anon', 'authenticated'] loop
      if pg_catalog.has_function_privilege(v_role, pg_catalog.to_regprocedure(v_fn), 'EXECUTE') then
        raise exception '0255: % still executable by %', v_fn, v_role;
      end if;
    end loop;
  end loop;

  foreach v_fn in array array[
    'public.is_studio_member(uuid)',
    'public.is_studio_owner(uuid)',
    'public.session_is_visible(uuid)'
  ] loop
    if pg_catalog.has_function_privilege('anon', pg_catalog.to_regprocedure(v_fn), 'EXECUTE') then
      raise exception '0255: % still executable by anon', v_fn;
    end if;
    if not pg_catalog.has_function_privilege('authenticated', pg_catalog.to_regprocedure(v_fn), 'EXECUTE') then
      raise exception '0255: % lost authenticated EXECUTE', v_fn;
    end if;
  end loop;

  foreach v_table in array array['public.waitlist', 'public.demo_requests'] loop
    foreach v_role in array array['anon', 'authenticated'] loop
      if not pg_catalog.has_table_privilege(v_role, v_table, 'INSERT') then
        raise exception '0255: % lost INSERT on %', v_role, v_table;
      end if;
      foreach v_priv in array array['SELECT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
        if pg_catalog.has_table_privilege(v_role, v_table, v_priv)
           or (v_priv in ('SELECT', 'UPDATE') and pg_catalog.has_any_column_privilege(v_role, v_table, v_priv)) then
          raise exception '0255: % still holds % on %', v_role, v_priv, v_table;
        end if;
      end loop;
    end loop;
    if not pg_catalog.has_table_privilege('service_role', v_table, 'SELECT') then
      raise exception '0255: service_role lost SELECT on % (admin console reads it)', v_table;
    end if;
  end loop;
end;
$$;

-- Policy shape on the two forms, asserted by CATALOG, never by name alone: a
-- differently named always-true copy that survived the replacement above would
-- OR together with the new policy and make this hardening a silent no-op.
do $$
declare
  v_table pg_catalog.text;
  v_rel pg_catalog.regclass;
  v_anon pg_catalog.oid;
  v_auth pg_catalog.oid;
  v_n pg_catalog.int4;
begin
  select r.oid into v_anon from pg_catalog.pg_roles r where r.rolname = 'anon';
  select r.oid into v_auth from pg_catalog.pg_roles r where r.rolname = 'authenticated';
  foreach v_table in array array['waitlist', 'demo_requests'] loop
    v_rel := pg_catalog.to_regclass('public.' || v_table);
    if v_rel is null then
      raise exception '0255: public.% is missing', v_table;
    end if;

    select pg_catalog.count(*)::pg_catalog.int4 into v_n from pg_catalog.pg_policy pol
     where pol.polrelid = v_rel and pol.polcmd in ('a', '*');
    if v_n <> 1 then
      raise exception '0255: public.% must have exactly one INSERT-capable policy, found %', v_table, v_n;
    end if;

    if exists (
      select 1 from pg_catalog.pg_policy pol
       where pol.polrelid = v_rel and pol.polcmd in ('a', '*') and pol.polpermissive
         and coalesce(
               pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid),
               pg_catalog.pg_get_expr(pol.polqual, pol.polrelid),
               'true') = 'true'
    ) then
      raise exception '0255: public.% still has a permissive always-true INSERT policy', v_table;
    end if;

    if not exists (
      select 1 from pg_catalog.pg_policy pol
       where pol.polrelid = v_rel and pol.polname = v_table || '_anonymous_insert'
         and pol.polcmd = 'a' and pol.polpermissive
    ) then
      raise exception '0255: public.% lacks its bounded INSERT policy', v_table;
    end if;

    -- INSERT-only: no policy of any other command may apply to PUBLIC, anon or
    -- authenticated, so no anonymous (or signed-in) read, update or delete path
    -- exists even if a grant is later restored.
    if exists (
      select 1 from pg_catalog.pg_policy pol
       where pol.polrelid = v_rel and pol.polcmd in ('r', 'w', 'd', '*')
         and (pol.polroles = array[0]::pg_catalog.oid[] or v_anon = any (pol.polroles) or v_auth = any (pol.polroles))
    ) then
      raise exception '0255: public.% has a read, update or delete policy applying to a browser role', v_table;
    end if;
  end loop;

  select pg_catalog.count(*)::pg_catalog.int4 into v_n from pg_catalog.pg_constraint con
   where con.conname in ('waitlist_email_format_chk', 'waitlist_field_length_chk',
                         'demo_requests_email_format_chk', 'demo_requests_field_length_chk');
  if v_n <> 4 then
    raise exception '0255: expected 4 form CHECK constraints, found %', v_n;
  end if;
end;
$$;

commit;
