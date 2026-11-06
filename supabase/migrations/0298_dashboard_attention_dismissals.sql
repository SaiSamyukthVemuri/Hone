-- 0298 dashboard attention dismissals (HELD: written for the owned-stack test; not applied anywhere, not approved for hosted apply).
--
-- WHAT THIS IS. The owner's tidy-up of THEIR OWN Dashboard "Needs attention" view. Dismissing a reminder hides that reminder from that
-- owner, on every device that owner signs in on. It changes nothing else: no balance, no payment row, no setup status, no access, no
-- message. Nothing in this file reads or writes a payment table. `item_key` and `instance_token` hold record identifiers (client,
-- appointment and session ids) and, for unpaid reminders, the dismissed outstanding amount in cents; no names, free text or clinical content.
--
-- SHAPE. Append-only events (dismiss | restore). The latest event per (studio, user, item_key) is the state, and a dismissal only
-- counts while the live item's instance_token equals the stored one, so a NEW issue under the same key (a new intake submission, a
-- new reaction, an unpaid balance that grew) shows again. The page decides that match in TypeScript (lib/dashboard/attention-
-- dismissal.ts); the database stores and returns what the owner chose.
--
-- WHO. Per dismissing owner (Sam, 4 Nov): rows are keyed by the caller's user id and every command and read is scoped to auth.uid(),
-- so one owner's dismissals never hide anything from another user. Non-owners are refused by every command.

begin;
set local lock_timeout = '5s';

create table if not exists public.dashboard_attention_events (
  id uuid primary key default gen_random_uuid(),
  -- Deterministic order of events: created_at can tie inside one transaction.
  seq bigint generated always as identity,
  studio_id uuid not null references public.studios(id) on delete cascade,
  user_id uuid not null,
  item_key text not null,
  instance_token text not null,
  action text not null,
  created_at timestamptz not null default now(),
  constraint dashboard_attention_events_key_shape
    check (char_length(item_key) between 1 and 200 and item_key ~ '^[A-Za-z0-9:_.-]+$'),
  constraint dashboard_attention_events_token_shape
    check (char_length(instance_token) between 1 and 200 and instance_token ~ '^[A-Za-z0-9:_.-]+$'),
  constraint dashboard_attention_events_action_known check (action in ('dismiss', 'restore'))
);

create index if not exists dashboard_attention_events_latest_idx
  on public.dashboard_attention_events (studio_id, user_id, item_key, seq desc);

-- Events are history: an update is refused, and a delete is refused unless the whole studio is being removed (the foreign key's
-- cascade runs after the studio row is gone, so a direct delete of an event can never pass).
create or replace function public.dashboard_attention_events_immutable()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'dashboard_attention_events: events are append-only' using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.studios s where s.id = old.studio_id) then
    raise exception 'dashboard_attention_events: events are never deleted' using errcode = 'check_violation';
  end if;
  return old;
end;
$$;

drop trigger if exists dashboard_attention_events_immutable on public.dashboard_attention_events;
create trigger dashboard_attention_events_immutable
  before update or delete on public.dashboard_attention_events
  for each row execute function public.dashboard_attention_events_immutable();

-- No browser-reachable path: RLS on with NO policy, and no table privilege for any API role. The commands below are the only way in.
alter table public.dashboard_attention_events enable row level security;
revoke all on table public.dashboard_attention_events from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Commands. Owner-only, per caller (auth.uid()), refusals as codes, nothing echoed raw.
-- ---------------------------------------------------------------------------------------------------------------------------
create or replace function public.dismiss_attention_item(p_studio uuid, p_item_key text, p_instance_token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_last record;
begin
  if v_user is null or p_studio is null or not public.is_studio_owner(p_studio) then
    return jsonb_build_object('ok', false, 'code', 'refused');
  end if;
  if p_item_key is null or p_instance_token is null
     or char_length(p_item_key) not between 1 and 200 or p_item_key !~ '^[A-Za-z0-9:_.-]+$'
     or char_length(p_instance_token) not between 1 and 200 or p_instance_token !~ '^[A-Za-z0-9:_.-]+$' then
    return jsonb_build_object('ok', false, 'code', 'invalid_item');
  end if;

  -- One writer per (studio, user, key) at a time, so "already dismissed" is decided on the real latest event.
  perform pg_advisory_xact_lock(hashtextextended(p_studio::text || ':' || v_user::text || ':' || p_item_key, 0));
  select e.action, e.instance_token into v_last
    from public.dashboard_attention_events e
   where e.studio_id = p_studio and e.user_id = v_user and e.item_key = p_item_key
   order by e.seq desc limit 1;
  if found and v_last.action = 'dismiss' and v_last.instance_token = p_instance_token then
    return jsonb_build_object('ok', true, 'changed', false);
  end if;
  insert into public.dashboard_attention_events (studio_id, user_id, item_key, instance_token, action)
  values (p_studio, v_user, p_item_key, p_instance_token, 'dismiss');
  return jsonb_build_object('ok', true, 'changed', true);
end;
$$;

create or replace function public.restore_attention_item(p_studio uuid, p_item_key text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_last record;
begin
  if v_user is null or p_studio is null or not public.is_studio_owner(p_studio) then
    return jsonb_build_object('ok', false, 'code', 'refused');
  end if;
  if p_item_key is null or char_length(p_item_key) not between 1 and 200 or p_item_key !~ '^[A-Za-z0-9:_.-]+$' then
    return jsonb_build_object('ok', false, 'code', 'invalid_item');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_studio::text || ':' || v_user::text || ':' || p_item_key, 0));
  select e.action, e.instance_token into v_last
    from public.dashboard_attention_events e
   where e.studio_id = p_studio and e.user_id = v_user and e.item_key = p_item_key
   order by e.seq desc limit 1;
  if not found or v_last.action <> 'dismiss' then
    return jsonb_build_object('ok', true, 'changed', false);
  end if;
  -- The restore carries the token it restores, so the history reads "dismissed X, restored X".
  insert into public.dashboard_attention_events (studio_id, user_id, item_key, instance_token, action)
  values (p_studio, v_user, p_item_key, v_last.instance_token, 'restore');
  return jsonb_build_object('ok', true, 'changed', true);
end;
$$;

-- The caller's CURRENT dismissals: the latest event per key, only where that event is a dismiss. Bounded; `capped` says so.
create or replace function public.list_dismissed_attention(p_studio uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_rows jsonb;
  v_n int;
begin
  if v_user is null or p_studio is null or not public.is_studio_owner(p_studio) then
    return jsonb_build_object('ok', false, 'code', 'refused');
  end if;
  with latest as (
    select distinct on (e.item_key) e.item_key, e.instance_token, e.action, e.created_at
      from public.dashboard_attention_events e
     where e.studio_id = p_studio and e.user_id = v_user
     order by e.item_key, e.seq desc
  ), live as (
    select item_key, instance_token, created_at from latest where action = 'dismiss' order by created_at desc, item_key limit 501
  )
  select coalesce(jsonb_agg(jsonb_build_object('item_key', item_key, 'instance_token', instance_token, 'dismissed_at', created_at)
                            order by created_at desc, item_key), '[]'::jsonb), count(*)
    into v_rows, v_n from live;
  if v_n > 500 then
    return jsonb_build_object('ok', true, 'rows', v_rows - 500, 'capped', true);
  end if;
  return jsonb_build_object('ok', true, 'rows', v_rows, 'capped', false);
end;
$$;

-- Authenticated-only: revoke from every default-granted role BY NAME, then grant to authenticated (0129 / 0164 lesson).
revoke execute on function public.dismiss_attention_item(uuid, text, text) from public, anon, service_role, authenticated;
revoke execute on function public.restore_attention_item(uuid, text) from public, anon, service_role, authenticated;
revoke execute on function public.list_dismissed_attention(uuid) from public, anon, service_role, authenticated;
grant execute on function public.dismiss_attention_item(uuid, text, text) to authenticated;
grant execute on function public.restore_attention_item(uuid, text) to authenticated;
grant execute on function public.list_dismissed_attention(uuid) to authenticated;

commit;
