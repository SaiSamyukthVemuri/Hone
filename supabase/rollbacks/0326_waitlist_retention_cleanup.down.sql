-- Down for 0326: restore 0325's two read bodies exactly, then drop the 0326 functions. It KEEPS waitlist_retention_runs and every erase
-- record (evidence is never destroyed by a rollback); the indexes it added are dropped.
begin;
set local lock_timeout = '5s';

create or replace function public.read_waitlist_followups(
  p_studio_id     uuid,
  p_actor_user_id uuid,
  p_invitation_id uuid default null
)
returns table (followup_id uuid, kind text, entry_id uuid, invitation_id uuid, client_name text,
               opened_at timestamptz, status text, why_not_work text, better_times text,
               answers_erased_at timestamptz, submitted_at timestamptz, closed_at timestamptz, erase_by timestamptz)
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
declare v_actor uuid; v_code text;
begin
  select o.practitioner_id, o.code into v_actor, v_code
    from public.new_client_waitlist_resolve_owner(p_studio_id, p_actor_user_id) o;
  if v_code <> 'ok' then return; end if;

  return query
    select f.id, f.kind, f.entry_id, f.invitation_id, e.name,
           f.opened_at, f.status, a.why_not_work, a.better_times,
           a.erased_at, a.submitted_at, f.closed_at,
           case when a.followup_id is null or a.erased_at is not null then null
                else least(
                       case when f.closed_at is null then null else f.closed_at + interval '30 days' end,
                       a.submitted_at + interval '90 days')
           end
      from public.waitlist_followups f
      join public.new_client_waitlist_entries e on e.id = f.entry_id and e.studio_id = f.studio_id
      left join lateral (
        select a2.* from public.waitlist_decline_answers a2
          join public.waitlist_followups d on d.id = a2.followup_id
         where d.entry_id = f.entry_id and d.kind = 'decline'
           and (f.kind = 'decline' and d.id = f.id or f.kind = 'withdrawal')
         order by a2.submitted_at desc
         limit 1) a on true
     where f.studio_id = p_studio_id
       -- No invitation id: every OPEN follow-up PLUS closed ones whose answers still exist, so the owner can still read and
       -- erase them before the retention date. With an id: that invitation's follow-ups, whatever their state.
       and (case when p_invitation_id is null then (f.status = 'open' or (a.followup_id is not null and a.erased_at is null))
                 else f.invitation_id = p_invitation_id end)
     -- OPEN rows first, newest first, then closed rows with answers still present: past the cap it is the oldest CLOSED rows that drop.
     order by (f.status <> 'open'), f.opened_at desc, f.id
     limit 500;
end;
$$;

create or replace function public.export_waitlist_decline_answers(
  p_studio_id     uuid,
  p_actor_user_id uuid,
  p_after_id      uuid default null,
  p_limit         int  default 1000
)
returns table (answer_id uuid, followup_id uuid, entry_id uuid, invitation_id uuid, client_id uuid, kind text,
               why_not_work text, better_times text, submitted_at timestamptz, answers_erased_at timestamptz)
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
declare v_code text;
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'invalid_limit' using errcode = '22023';
  end if;
  select o.code into v_code
    from public.new_client_waitlist_resolve_owner(p_studio_id, p_actor_user_id) o;
  if v_code is distinct from 'ok' then return; end if;
  return query
    select a.followup_id, d.id, d.entry_id, d.invitation_id, c.id, d.kind,
           a.why_not_work, a.better_times, a.submitted_at, a.erased_at
      from public.waitlist_decline_answers a
      join public.waitlist_followups d on d.id = a.followup_id and d.studio_id = a.studio_id
      join public.new_client_waitlist_entries e on e.id = d.entry_id and e.studio_id = d.studio_id
      left join public.clients c on c.studio_id = e.studio_id and c.normalized_email = e.email_normalized
     where a.studio_id = p_studio_id
       and (p_after_id is null or a.followup_id > p_after_id)
     order by a.followup_id
     limit p_limit;
end;
$$;

revoke all on function public.read_waitlist_followups(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.export_waitlist_decline_answers(uuid, uuid, uuid, int) from public, anon, authenticated, service_role;
grant execute on function public.read_waitlist_followups(uuid, uuid, uuid) to service_role;
grant execute on function public.export_waitlist_decline_answers(uuid, uuid, uuid, int) to service_role;

drop function if exists public.run_waitlist_retention_cleanup(integer);
drop function if exists public.record_waitlist_retention_failure(text);
drop function if exists public.waitlist_retention_health();
drop function if exists public.waitlist_answer_erase_by(uuid);
drop index if exists public.waitlist_decline_answers_unerased_idx;
drop index if exists public.waitlist_erase_records_erased_at_idx;
drop index if exists public.waitlist_decline_owner_emails_terminal_idx;
-- waitlist_retention_runs is deliberately KEPT.

do $$
begin
  if not exists (select 1 from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('public.read_waitlist_followups(uuid,uuid,uuid)') and md5(p.prosrc) = '665b0339cabeab9ff01c82f38cb72c5b') then
    raise exception '0326 down: the restored owner read is not the 0325 body';
  end if;
  if not exists (select 1 from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('public.export_waitlist_decline_answers(uuid,uuid,uuid,integer)') and md5(p.prosrc) = '30ed9bd55cbe7bcbf9c06e4cba3a6c19') then
    raise exception '0326 down: the restored export read is not the 0325 body';
  end if;
end $$;

commit;
