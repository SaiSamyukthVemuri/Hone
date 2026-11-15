-- 0319 — "these times don't work" (HON-7). DRAFT: not applied, not reviewed.
--
-- WHAT THIS FIXES. An invited prospect whose offered times do not suit them had
-- one exit, `decline_new_client_waitlist_invitation` (0192), and that exit moves
-- the entry to `released`: the person leaves the queue, loses their join date
-- and priority, and nobody is told. Their reason, if any, was nowhere.
--
-- WHAT THIS DOES. One command, with the capability proof 0192 requires:
--
--   decline_waitlist_invitation_times_unsuitable(token, capability, note)
--
--   * closes the invitation exactly as 0192 decline does (declined_at, proof
--     capability cleared);
--   * returns the SAME entry to `waiting` (invited -> released -> waiting, both
--     legal 0188 transitions, in one transaction). `joined_at` and `id` are
--     immutable (0185 trigger) so the original join date and queue priority are
--     preserved by construction, and the entry is not duplicated;
--   * stores the optional text, once, in an OWNER-ONLY table.
--
-- Owner side: count (no text), list (text, owner-gated), acknowledge. The count
-- of unacknowledged rows is the durable in-app item; it survives reload.
--
-- LOCK ORDER. entry FOR UPDATE, then invitation FOR UPDATE: 0192 decline's own
-- order (:1226-1240), release (:1707-1725) and 0200 close/requeue. This command
-- takes no studios or round lock, so it is a prefix-compatible subsequence of
-- 0313's studios -> round -> entry -> invitation order and cannot close a cycle.
--
-- TEXT. Trimmed; empty means none; at most 500 characters; angle brackets and
-- control characters are refused (no markup); the FIRST text for an invitation
-- is kept and a repeat is refused as not_live because the invitation is closed.
-- Bidirectional-control and zero-width characters are refused too (hygiene).
-- A repeat never echoes or overwrites. Every refusal uses the 0192 vocabulary so
-- the command is not an existence oracle for tokens.

begin;

set local lock_timeout = '5s';

create table if not exists public.waitlist_times_feedback (
  id              uuid primary key default gen_random_uuid(),
  studio_id       uuid not null references public.studios(id) on delete cascade,
  entry_id        uuid not null,
  invitation_id   uuid not null,
  note            text
    constraint waitlist_times_feedback_note_check
    check (note is null or (char_length(note) between 1 and 500 and note = btrim(note))),
  created_at      timestamptz not null default now(),
  acknowledged_at timestamptz,
  constraint waitlist_times_feedback_invitation_key unique (invitation_id),
  constraint waitlist_times_feedback_invitation_fk
    foreign key (invitation_id) references public.new_client_waitlist_invitations (id) on delete cascade,
  constraint waitlist_times_feedback_entry_same_studio_fk
    foreign key (entry_id, studio_id)
    references public.new_client_waitlist_entries (id, studio_id) on delete cascade
);

create index if not exists waitlist_times_feedback_open_idx
  on public.waitlist_times_feedback (studio_id, created_at)
  where acknowledged_at is null;

alter table public.waitlist_times_feedback enable row level security;
-- No policy and no grant: reached only through the commands below.
revoke all on public.waitlist_times_feedback from public, anon, authenticated, service_role;

comment on table public.waitlist_times_feedback is
  'Owner-only. One row per invitation whose recipient said the offered times do not work; note is the recipient''s optional text. Never selected by a list or count query other than the owner-gated list command.';

-- ---------------------------------------------------------------------------
-- 1. The recipient command.
-- ---------------------------------------------------------------------------
create or replace function public.decline_waitlist_invitation_times_unsuitable(
  p_raw_token      text,
  p_raw_capability text,
  p_note           text default null
)
returns text
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  r        record;
  v_inv    uuid;
  v_entry  uuid;
  v_studio uuid;
  v_status text;
  v_now    timestamptz;
  v_note   text;
begin
  if p_raw_token is null or p_raw_token !~ '^[a-f0-9]{64}$'
     or p_raw_capability is null or p_raw_capability !~ '^[a-f0-9]{64}$' then
    return 'invalid_input';
  end if;

  v_note := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
  if v_note is not null and (
       pg_catalog.char_length(v_note) > 500
       or v_note ~ '[<>]'
       or v_note ~ '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]'
       or v_note ~ '[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]'
     ) then
    return 'invalid_note';
  end if;

  select i.id, i.entry_id, i.studio_id into v_inv, v_entry, v_studio
    from public.new_client_waitlist_invitations i
   where i.token_hash = pg_catalog.encode(extensions.digest(p_raw_token, 'sha256'), 'hex');
  if v_inv is null then return 'invalid_token'; end if;

  -- ENTRY FIRST, THEN INVITATION (0192 decline's order).
  select e.status into v_status
    from public.new_client_waitlist_entries e
   where e.id = v_entry and e.studio_id = v_studio
   for update;

  select * into r from public.new_client_waitlist_invitations i
   where i.id = v_inv
   for update;
  if r.id is null then return 'invalid_token'; end if;

  v_now := clock_timestamp();

  if r.redeemed_at is not null or r.expired_at is not null
     or r.released_at is not null or r.declined_at is not null
     or r.expires_at <= v_now or v_status is distinct from 'invited' then
    return 'not_live';
  end if;
  if r.proof_capability_hash is null then return 'proof_required'; end if;
  if r.proof_capability_expires_at <= v_now then return 'proof_expired'; end if;
  if r.proof_capability_hash <> pg_catalog.encode(extensions.digest(p_raw_capability, 'sha256'), 'hex') then
    return 'proof_invalid';
  end if;

  update public.new_client_waitlist_invitations
     set declined_at = v_now,
         proof_capability_hash = null, proof_capability_expires_at = null
   where id = r.id;

  -- invited -> released -> waiting: the SAME row, so joined_at and id (immutable)
  -- keep the original queue position. Column resets mirror 0200 requeue.
  update public.new_client_waitlist_entries
     set status = 'released', released_at = v_now
   where id = v_entry and studio_id = v_studio and status = 'invited';

  update public.new_client_waitlist_entries
     set status = 'waiting',
         claimed_at = null, claimed_by_practitioner_id = null,
         invited_at = null, expired_at = null, released_at = null
   where id = v_entry and studio_id = v_studio and status = 'released';

  insert into public.waitlist_times_feedback (studio_id, entry_id, invitation_id, note)
  values (v_studio, v_entry, v_inv, v_note)
  on conflict (invitation_id) do nothing;

  return 'returned_to_waiting';
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Owner-gated count (no text), list (text) and acknowledge.
-- ---------------------------------------------------------------------------
create or replace function public.count_waitlist_times_feedback(
  p_studio_id     uuid,
  p_actor_user_id uuid
)
returns table (result text, n integer)
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
declare v_actor uuid; v_code text;
begin
  select o.practitioner_id, o.code into v_actor, v_code
    from public.new_client_waitlist_resolve_owner(p_studio_id, p_actor_user_id) o;
  if v_code <> 'ok' then return query select v_code, 0; return; end if;
  return query
    select 'ok'::text, (select count(*)::integer from public.waitlist_times_feedback f
                         where f.studio_id = p_studio_id and f.acknowledged_at is null);
end;
$$;

create or replace function public.list_waitlist_times_feedback(
  p_studio_id     uuid,
  p_actor_user_id uuid
)
returns table (result text, invitation_id uuid, entry_id uuid, entry_name text, note text, created_at timestamptz)
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
declare v_actor uuid; v_code text;
begin
  select o.practitioner_id, o.code into v_actor, v_code
    from public.new_client_waitlist_resolve_owner(p_studio_id, p_actor_user_id) o;
  if v_code <> 'ok' then
    return query select v_code, null::uuid, null::uuid, null::text, null::text, null::timestamptz; return;
  end if;
  return query
    select 'ok'::text, f.invitation_id, f.entry_id, e.name, f.note, f.created_at
      from public.waitlist_times_feedback f
      join public.new_client_waitlist_entries e
        on e.id = f.entry_id and e.studio_id = f.studio_id
     where f.studio_id = p_studio_id and f.acknowledged_at is null
     order by f.created_at, f.id
     limit 200;
end;
$$;

create or replace function public.acknowledge_waitlist_times_feedback(
  p_studio_id     uuid,
  p_invitation_id uuid,
  p_actor_user_id uuid
)
returns text
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare v_actor uuid; v_code text; v_n int;
begin
  select o.practitioner_id, o.code into v_actor, v_code
    from public.new_client_waitlist_resolve_owner(p_studio_id, p_actor_user_id) o;
  if v_code <> 'ok' then return v_code; end if;
  if p_invitation_id is null then return 'invalid_input'; end if;
  -- Keyed by INVITATION id: a later invitation's feedback is not cleared with this one.
  update public.waitlist_times_feedback f
     set acknowledged_at = now()
   where f.studio_id = p_studio_id and f.invitation_id = p_invitation_id and f.acknowledged_at is null;
  get diagnostics v_n = row_count;
  return case when v_n > 0 then 'acknowledged' else 'not_found' end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Grants, restated BY NAME for all three default grantees.
-- ---------------------------------------------------------------------------
revoke all on function public.decline_waitlist_invitation_times_unsuitable(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.count_waitlist_times_feedback(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.list_waitlist_times_feedback(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.acknowledge_waitlist_times_feedback(uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.decline_waitlist_invitation_times_unsuitable(text, text, text) to service_role;
grant execute on function public.count_waitlist_times_feedback(uuid, uuid) to service_role;
grant execute on function public.list_waitlist_times_feedback(uuid, uuid) to service_role;
grant execute on function public.acknowledge_waitlist_times_feedback(uuid, uuid, uuid) to service_role;

commit;
