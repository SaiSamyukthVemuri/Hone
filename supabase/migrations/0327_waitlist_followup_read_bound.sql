-- 0327 — the owner follow-up read shows a WITHDRAWAL row exactly the answer waitlist_answer_erase_by binds it to (HON-7). Reviewed by Privacy at 9c41be316 (PASS); apply needs Sam's per-change approval.
--
-- THE BUG (Sam's production retest): withdraw -> Keep on the waitlist -> invite again (new window) -> decline with answers. The later
-- decline's answers ALSO showed on the earlier withdrawal card, because 0326's read took the entry's newest decline answer for any withdrawal
-- row, with no bound on when the withdrawal opened. DISPLAY ONLY: waitlist_answer_erase_by (0326) already binds a withdrawal to the latest
-- decline answer submitted at or before it opened (submitted_at desc, followup_id desc), and the daily cleanup and the read's masking both
-- use that function, so no clock, erase or export changes. Erase stays entry-wide.
--
-- THE FIX: ONE clause in the lateral for a withdrawal row, `and a2.submitted_at <= f.opened_at`, with the tie-break the lateral already
-- had. Nothing else in the body changes (proved by a mechanical diff against 0326's body in the package). waitlist_answer_erase_by is NOT
-- touched. Same signature and return type, so CREATE OR REPLACE; the ACL is restated by name.
--
-- 0326 is applied and frozen. The down restores 0326's body byte for byte (md5 bfff39742592fb6b4a3f43f9e2429417).

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
           f.opened_at, f.status,
           case when a.erased_at is null and a.eb <= pg_catalog.now() then null else a.why_not_work end,
           case when a.erased_at is null and a.eb <= pg_catalog.now() then null else a.better_times end,
           coalesce(a.erased_at, case when a.eb <= pg_catalog.now() then a.eb end), a.submitted_at, f.closed_at,
           case when a.followup_id is null or a.erased_at is not null or a.eb <= pg_catalog.now() then null else a.eb end
      from public.waitlist_followups f
      join public.new_client_waitlist_entries e on e.id = f.entry_id and e.studio_id = f.studio_id
      left join lateral (
        select a2.*, public.waitlist_answer_erase_by(a2.followup_id) as eb from public.waitlist_decline_answers a2
          join public.waitlist_followups d on d.id = a2.followup_id
         where d.entry_id = f.entry_id and d.kind = 'decline'
           and (f.kind = 'decline' and d.id = f.id or f.kind = 'withdrawal' and a2.submitted_at <= f.opened_at)
         order by a2.submitted_at desc, a2.followup_id desc
         limit 1) a on true
     where f.studio_id = p_studio_id
       -- No invitation id: every OPEN follow-up PLUS closed ones whose answers still exist, so the owner can still read and
       -- erase them before the retention date. With an id: that invitation's follow-ups, whatever their state.
       and (case when p_invitation_id is null then (f.status = 'open' or (a.followup_id is not null and a.erased_at is null and a.eb > pg_catalog.now()))
                 else f.invitation_id = p_invitation_id end)
     -- OPEN rows first, newest first, then closed rows with answers still present: past the cap it is the oldest CLOSED rows that drop.
     order by (f.status <> 'open'), f.opened_at desc, f.id
     limit 500;
end;
$$;

revoke all on function public.read_waitlist_followups(uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.read_waitlist_followups(uuid, uuid, uuid) to service_role;

do $$
declare
  v_oid oid := pg_catalog.to_regprocedure('public.read_waitlist_followups(uuid,uuid,uuid)');
  v_role text;
begin
  if v_oid is null or (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
                        where n.nspname = 'public' and p.proname = 'read_waitlist_followups') <> 1 then
    raise exception '0327: expected exactly one read_waitlist_followups';
  end if;
  if not (select p.prosecdef and p.proconfig @> array['search_path=pg_catalog, pg_temp'] from pg_catalog.pg_proc p where p.oid = v_oid) then
    raise exception '0327: read_waitlist_followups must be a security definer with a pinned search_path';
  end if;
  foreach v_role in array array['anon','authenticated'] loop
    if pg_catalog.has_function_privilege(v_role, v_oid, 'EXECUTE') then
      raise exception '0327: read_waitlist_followups must not be executable by %', v_role;
    end if;
  end loop;
  if pg_catalog.has_function_privilege('public', v_oid, 'EXECUTE') then
    raise exception '0327: read_waitlist_followups must not be executable by PUBLIC';
  end if;
  if not pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE') then
    raise exception '0327: service_role must keep EXECUTE on read_waitlist_followups';
  end if;
  if not exists (select 1 from pg_catalog.pg_proc p where p.oid = v_oid and md5(p.prosrc) = 'a1943da8ebdb12d8beb2be6f71ad8117') then
    raise exception '0327: read_waitlist_followups is not the sealed body';
  end if;
end $$;

commit;
