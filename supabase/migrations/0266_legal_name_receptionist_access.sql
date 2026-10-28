-- ===========================================================================
-- HON-58 Q1 (Sam, 28 Oct): receptionist access to legal names is an
-- owner-controlled, per-studio permission, OFF by default.
--
-- Does NOT edit 0258. 0258 keeps can_use_client_legal_identity (owner or
-- practitioner) as the WRITE authority; this adds a separate READ predicate and
-- re-points only the SELECT policy on client_legal_identities to it.
--
--   * studio_legal_name_access: one optional row per studio. No row = OFF.
--   * set_receptionist_legal_name_access(): the ONLY writer. Owner only. Writes
--     the audit row in the same transaction (who, when, old -> new).
--   * client_legal_name_access_audit: append-only (grants + triggers).
--   * can_read_client_legal_identity(): owner/practitioner, OR an ACTIVE
--     receptionist of THAT studio while the studio's switch is ON. Evaluated per
--     statement, so turning the switch OFF (or deactivating the receptionist)
--     removes access on the next request; nothing is cached in the database.
--
-- Nothing else uses the new predicate: a receptionist still cannot read intake
-- forms (which carry a "Full legal name" answer), clinical records or anything
-- else; tests/db/legal-name-access.db.test.ts pins that. No backfill, no data
-- change, no default flip: every studio stays OFF.
-- ===========================================================================

begin;
set local lock_timeout = '5s';

create table public.studio_legal_name_access (
  studio_id           uuid primary key references public.studios(id) on delete cascade,
  receptionist_access boolean not null default false,
  updated_at          timestamptz not null default now(),
  updated_by          uuid,
  -- Same-studio actor attribution, RESTRICT (0179/0220 pattern); NULL = the default row.
  constraint studio_legal_name_access_updated_by_fk
    foreign key (updated_by, studio_id) references public.practitioners (id, studio_id) on delete restrict
);

alter table public.studio_legal_name_access enable row level security;

-- Owners and practitioners may READ the setting; nobody writes it directly.
create policy studio_legal_name_access_select
  on public.studio_legal_name_access for select to authenticated
  using (public.is_studio_member(studio_id));

revoke all on public.studio_legal_name_access from public, anon, authenticated, service_role;
grant select on public.studio_legal_name_access to authenticated;

comment on table public.studio_legal_name_access is
  'HON-58 Q1: per-studio switch for receptionist access to client legal names. No row = OFF. Written only by set_receptionist_legal_name_access.';

-- Append-only audit of every change of the switch.
create table public.client_legal_name_access_audit (
  id             bigint generated always as identity primary key,
  studio_id      uuid not null references public.studios(id) on delete cascade,
  changed_at     timestamptz not null default now(),
  changed_by     uuid not null,
  changed_by_user uuid,
  old_value      boolean not null,
  new_value      boolean not null,
  constraint client_legal_name_access_audit_changed check (old_value is distinct from new_value),
  -- Same-studio actor attribution, RESTRICT (0179/0220 pattern): the record of who
  -- changed the switch cannot be orphaned or re-pointed across studios.
  constraint client_legal_name_access_audit_changed_by_fk
    foreign key (changed_by, studio_id) references public.practitioners (id, studio_id) on delete restrict
);

create index client_legal_name_access_audit_studio_idx
  on public.client_legal_name_access_audit (studio_id, changed_at desc);

alter table public.client_legal_name_access_audit enable row level security;

create policy client_legal_name_access_audit_select
  on public.client_legal_name_access_audit for select to authenticated
  using (public.is_studio_owner(studio_id));

revoke all on public.client_legal_name_access_audit from public, anon, authenticated, service_role;
grant select on public.client_legal_name_access_audit to authenticated;

create function public.client_legal_name_access_audit_immutable()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception 'client_legal_name_access_audit is append-only' using errcode = '23514';
end;
$$;

revoke all on function public.client_legal_name_access_audit_immutable() from public, anon, authenticated, service_role;

create trigger client_legal_name_access_audit_no_update
  before update or delete on public.client_legal_name_access_audit
  for each row execute function public.client_legal_name_access_audit_immutable();

create trigger client_legal_name_access_audit_no_truncate
  before truncate on public.client_legal_name_access_audit
  for each statement execute function public.client_legal_name_access_audit_immutable();

comment on table public.client_legal_name_access_audit is
  'HON-58 Q1: who changed the receptionist legal-name switch, when, old -> new. Append-only; written only inside set_receptionist_legal_name_access. A no-op call writes nothing.';

-- The only writer. Owner of THIS studio only. Returns whether the value changed.
create function public.set_receptionist_legal_name_access(p_studio_id uuid, p_enabled boolean)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_owner uuid;
  v_old   boolean;
begin
  if p_studio_id is null or p_enabled is null or auth.uid() is null then
    raise exception 'set_receptionist_legal_name_access: studio, value and a signed-in caller are required' using errcode = '22004';
  end if;

  select p.id into v_owner
    from public.practitioners p
   where p.studio_id = p_studio_id and p.user_id = auth.uid() and p.active and p.role = 'owner'
   limit 1;
  if v_owner is null then
    raise exception 'only an owner of the studio may change this setting' using errcode = '42501';
  end if;

  -- The default row is OFF and is not itself an audited change.
  insert into public.studio_legal_name_access (studio_id, receptionist_access, updated_by)
    values (p_studio_id, false, null)
    on conflict (studio_id) do nothing;

  select s.receptionist_access into v_old
    from public.studio_legal_name_access s
   where s.studio_id = p_studio_id
   for update;

  if v_old is not distinct from p_enabled then
    return false;
  end if;

  update public.studio_legal_name_access
     set receptionist_access = p_enabled, updated_at = now(), updated_by = v_owner
   where studio_id = p_studio_id;

  insert into public.client_legal_name_access_audit (studio_id, changed_by, changed_by_user, old_value, new_value)
    values (p_studio_id, v_owner, auth.uid(), v_old, p_enabled);

  return true;
end;
$$;

revoke all on function public.set_receptionist_legal_name_access(uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.set_receptionist_legal_name_access(uuid, boolean) to authenticated;

-- The READ predicate. SECURITY DEFINER because a receptionist may not read the
-- setting table or studio_receptionists directly.
create function public.can_read_client_legal_identity(target_studio_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select public.is_studio_member(target_studio_id)
      or (
        public.receptionist_actor_id(target_studio_id) is not null
        and coalesce(
          (select s.receptionist_access
             from public.studio_legal_name_access s
            where s.studio_id = target_studio_id),
          false)
      );
$$;

revoke all on function public.can_read_client_legal_identity(uuid) from public, anon, authenticated, service_role;
grant execute on function public.can_read_client_legal_identity(uuid) to authenticated;

comment on function public.can_read_client_legal_identity(uuid) is
  'HON-58 Q1: owner/practitioner, or an active receptionist of this studio while the studio switch is ON. Evaluated per statement; no caching. Writes stay on can_use_client_legal_identity (owner/practitioner).';

-- Only the SELECT policy moves to the read predicate; insert/update stay owner/practitioner.
drop policy client_legal_identities_select on public.client_legal_identities;
create policy client_legal_identities_select
  on public.client_legal_identities for select to authenticated
  using (public.can_read_client_legal_identity(studio_id));

-- Receptionist client finder, v2: the DISPLAY identity only.
-- The 0216 projection returns and searches clients.name. Once a preferred name
-- exists, a receptionist should be shown (and find clients by) the DISPLAY name:
-- display_name = coalesce(nullif(btrim(preferred_name),''), name). This returns
-- only the display name, phone and email, and matches (literally) on those and
-- nothing else: never client_legal_identities, never the stored name behind a
-- preferred one. It deliberately carries NO intake or consent fact, so the
-- 0243-pinned set of definers that read intake forms is unchanged; the desk's
-- completion facts stay on receptionist_client_contacts (0216, untouched).
-- The fallback with no preferred name is the stored name, exactly as today.
create function public.receptionist_client_contacts_v2(
  p_studio_id uuid,
  p_query     text    default null,
  p_limit     integer default 25
)
returns table (
  client_id    uuid,
  display_name text,
  phone        text,
  email        text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_limit   integer := least(greatest(coalesce(p_limit, 25), 1), 50);
  v_query   text    := nullif(btrim(coalesce(p_query, '')), '');
  v_pattern text;
begin
  if auth.uid() is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if public.receptionist_actor_id(p_studio_id) is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_query is not null then
    if char_length(v_query) < 2 then
      raise exception 'query_too_short' using errcode = '22023';
    end if;
    v_pattern := '%' || replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  return query
    select d.id, d.display_name, d.phone, d.email
      from (
        select c.id, c.phone, c.email,
               coalesce(nullif(pg_catalog.btrim(c.preferred_name), ''), c.name) as display_name
          from public.clients c
         where c.studio_id = p_studio_id
           and c.archived_at is null
      ) d
     where v_pattern is null
        or d.display_name ilike v_pattern
        or d.email ilike v_pattern
        or d.phone ilike v_pattern
     order by d.display_name, d.id
     limit v_limit;
end;
$$;

revoke all on function public.receptionist_client_contacts_v2(uuid, text, integer) from public, anon, authenticated, service_role;
-- Per-role statements as well: tests/security/clinical-rpc-grant-guard.test.ts pins the 0216-style names.
revoke execute on function public.receptionist_client_contacts_v2(uuid, text, integer) from public;
revoke execute on function public.receptionist_client_contacts_v2(uuid, text, integer) from anon;
revoke execute on function public.receptionist_client_contacts_v2(uuid, text, integer) from service_role;
grant execute on function public.receptionist_client_contacts_v2(uuid, text, integer) to authenticated;

comment on function public.receptionist_client_contacts_v2(uuid, text, integer) is
  'HON-58 Q1: receptionist client finder over the display identity only (preferred name, else the stored name). Never reads or matches client_legal_identities, and carries no intake or consent fact.';

commit;
