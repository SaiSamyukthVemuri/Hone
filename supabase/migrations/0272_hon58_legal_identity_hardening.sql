-- ===========================================================================
-- HON-58 legal-identity hardening (Privacy PEER-0258-0266-SQL, C1 and C2).
--
-- 0258 is SEALED: its bytes are not edited. This migration follows it and
-- changes only what the review asked for, on objects 0258 created:
--
--   C1 (F1, F2)  updated_by is no longer caller-chosen. A before-insert/update
--                trigger sets it to the CALLER's own active practitioner row in
--                the row's studio (null when the caller has none), whatever the
--                statement supplied, so attribution cannot be forged and the
--                foreign key cannot be used to probe whether a practitioner id
--                exists in another studio. created_at and updated_at are set by
--                the database on INSERT as well as UPDATE.
--   C2 (F3)      the two invoker functions 0258 created move from
--                search_path = public to pg_catalog, pg_temp (every reference
--                in them is already schema-qualified).
--
-- Additive in effect: no table, column, policy or grant is created or dropped;
-- two functions are replaced and one trigger is added. No data is touched (no
-- insert, update or delete of any row). Grants are asserted again by name.
-- 0258's header still says "unnumbered ... not in supabase/migrations": that
-- text is stale and is left as it is in sealed bytes (Privacy F6).
--
-- ACCEPTED RESIDUALS (Privacy C5; owner: Sam (engineering), the owner of the
-- other known limitations; OPS to confirm). Recorded, not fixed here:
--   G2  client_legal_name_access_audit is append-only and its studio FK cascades
--       into a BEFORE DELETE trigger that raises. A studio that has ever had its
--       switch changed cannot be hard-deleted, and a practitioner who ever
--       changed it cannot be hard-deleted (RESTRICT). Not a leak; a future
--       offboarding/erasure blocker (no studio-deletion path exists today).
--   G3  with the switch ON a receptionist's session can read EVERY legal
--       identity of the studio through the API, and no read is audited. Owner
--       consent and default OFF bound it; the owner-facing text says "every
--       client"; a read audit is an open decision.
--   F5  only the LAST editor of a legal name is recorded (no change trail).
--   Export gap (TRUTH-01B): the three HON-58 tables are registered in
--       lib/export/resource-registry.ts as kind "pending", so legal names are
--       NOT in studio exports yet. A known gap, not a leak.
-- ===========================================================================

begin;
set local lock_timeout = '5s';

-- C2: the predicate's search path.
create or replace function public.can_use_client_legal_identity(target_studio_id uuid)
returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select public.is_studio_member(target_studio_id);
$$;

revoke all on function public.can_use_client_legal_identity(uuid) from public, anon, authenticated, service_role;
grant execute on function public.can_use_client_legal_identity(uuid) to authenticated;

-- C1 and C2: the guard now also runs on INSERT and owns provenance.
create or replace function public.client_legal_identities_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'UPDATE' then
    if new.client_id is distinct from old.client_id or new.studio_id is distinct from old.studio_id then
      raise exception 'client_legal_identities: client and studio are immutable' using errcode = '23514';
    end if;
    new.created_at := old.created_at;
  else
    new.created_at := pg_catalog.now();
  end if;
  new.updated_at := pg_catalog.now();
  -- The caller's own active practitioner row in THIS studio, never a supplied id.
  new.updated_by := (
    select p.id
      from public.practitioners p
     where p.studio_id = new.studio_id
       and p.user_id = auth.uid()
       and p.active = true
  );
  return new;
end;
$$;

revoke all on function public.client_legal_identities_guard() from public, anon, authenticated, service_role;

drop trigger client_legal_identities_guard on public.client_legal_identities;
create trigger client_legal_identities_guard
  before insert or update on public.client_legal_identities
  for each row execute function public.client_legal_identities_guard();

commit;
