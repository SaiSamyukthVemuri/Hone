-- 0364 DOWN. Restores 0363's replace_waitlist_invitation byte for byte (the applied body).
begin;
set local lock_timeout = '5s';

create or replace function public.replace_waitlist_invitation(p_studio_id uuid, p_actor_user_id uuid, p_entry_id uuid, p_expected_invitation_id uuid)
returns table (result text, invitation_id uuid, raw_token text, issued_at timestamptz, expires_at timestamptz)
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor uuid; v_round_id uuid; v_round_allowance integer;
  v_code text; v_status text; v_old record; v_r text; v_issue record; v_issued timestamptz; v_expires timestamptz; v_ttl integer;
  v_svc_active boolean; v_svc_modality text; v_svc_name text;
begin
  select r.practitioner_id, r.code into v_actor, v_code from public.new_client_waitlist_resolve_owner(p_studio_id, p_actor_user_id) r;
  if v_code <> 'ok' then return query select 'not_owner'::text, null::uuid, null::text, null::timestamptz, null::timestamptz; return; end if;
  -- THE STUDIO LOCK FIRST, the same outer mutex admit and create take, so two replaces (or a replace and an admit) in one studio
  -- serialise instead of deadlocking on the entry rows (40P01). Order everywhere: owner -> studio -> entry.
  perform 1 from public.studios s where s.id = p_studio_id for no key update;
  select e.status into v_status from public.new_client_waitlist_entries e where e.id = p_entry_id and e.studio_id = p_studio_id for update;
  if v_status is null then return query select 'not_found'::text, null::uuid, null::text, null::timestamptz, null::timestamptz; return; end if;
  select i.id, i.redeemed_at, i.issued_at, i.expires_at, i.scope_service_id, i.scope_start_date, i.scope_end_date, i.scope_allowed_weekdays
    into v_old from public.new_client_waitlist_invitations i
   where i.entry_id = p_entry_id and i.studio_id = p_studio_id order by i.issued_at desc limit 1;
  if v_status <> 'invited' or v_old.id is null then
    return query select 'no_live_invitation'::text, null::uuid, null::text, null::timestamptz, null::timestamptz; return; end if;
  -- COMPARE-AND-SWAP: the replace applies only to the invitation the caller SAW. Two instances that both re-checked and both call replace cannot
  -- both succeed: the first replaces (a new invitation becomes the latest), the second finds a different latest invitation and changes nothing.
  -- A null expected id never matches a live invitation.
  if v_old.id is distinct from p_expected_invitation_id then
    return query select 'state_changed'::text, null::uuid, null::text, null::timestamptz, null::timestamptz; return; end if;
  if v_old.redeemed_at is not null then
    return query select 'invitation_redeemed'::text, null::uuid, null::text, null::timestamptz, null::timestamptz; return; end if;
  -- THE SAME GUARDS ADMIT APPLIES, re-checked now: the service must still be bookable by a new client, and an entry with an OPEN
  -- decline follow-up or withdrawal request is not offered again until the owner has handled it.
  select sv.active, sv.modality, sv.name into v_svc_active, v_svc_modality, v_svc_name
    from public.services sv where sv.id = v_old.scope_service_id and sv.studio_id = p_studio_id for share;
  if not found or not public.service_is_bookable_by_new_client(v_svc_active, v_svc_modality, v_svc_name) then
    return query select 'invalid_service'::text, null::uuid, null::text, null::timestamptz, null::timestamptz; return; end if;
  if exists (select 1 from public.waitlist_followups f where f.entry_id = p_entry_id and f.studio_id = p_studio_id and f.status = 'open') then
    return query select 'pending_owner_review'::text, null::uuid, null::text, null::timestamptz, null::timestamptz; return; end if;
  v_ttl := greatest(1, least(168, ceil(extract(epoch from (v_old.expires_at - v_old.issued_at)) / 3600.0)::integer));
  begin
    v_r := public.release_new_client_waitlist_entry(p_studio_id, p_entry_id, p_actor_user_id);
    if v_r <> 'released' then raise exception '%', v_r using errcode = 'WA001'; end if;
    v_r := public.requeue_new_client_waitlist_entry(p_studio_id, p_entry_id, p_actor_user_id);
    if v_r <> 'requeued' then raise exception '%', v_r using errcode = 'WA001'; end if;
    v_r := public.claim_new_client_waitlist_entry(p_studio_id, p_entry_id, p_actor_user_id);
    if v_r <> 'claimed' then raise exception '%', v_r using errcode = 'WA001'; end if;
    -- A FULL ADMISSION ROUND DOES NOT BLOCK A REPLACE. Rotated here exactly as admit rotates it (a replace issues a new invitation, which the
    -- round's allowance counts): without it, a replace from a closed older round while the open round is full would be refused as round_full
    -- and hide the delivery retry. Safe for the same reason as in admit: the capacity count is studio-wide, not per round.
    select r.id, r.allowance into v_round_id, v_round_allowance
      from public.studio_waitlist_admission_rounds r
     where r.studio_id = p_studio_id and r.closed_at is null;
    if v_round_id is not null
       and public.waitlist_admission_round_consumed(v_round_id) >= v_round_allowance then
      update public.studio_waitlist_admission_rounds r
         set closed_at = clock_timestamp(), closed_by_practitioner_id = v_actor, updated_at = clock_timestamp()
       where r.id = v_round_id and r.closed_at is null;
      insert into public.studio_waitlist_admission_rounds
        (studio_id, allowance, opened_at, opened_by_practitioner_id, updated_at)
      values (p_studio_id, 100, clock_timestamp(), v_actor, clock_timestamp());
    end if;
    select * into v_issue from public.issue_scoped_new_client_waitlist_invitation(
      p_studio_id, p_entry_id, p_actor_user_id, v_old.scope_service_id, v_old.scope_start_date, v_old.scope_end_date,
      v_old.scope_allowed_weekdays, v_ttl);
    if v_issue.result <> 'issued' then raise exception '%', v_issue.result using errcode = 'WA001'; end if;
    select i.issued_at, i.expires_at into v_issued, v_expires from public.new_client_waitlist_invitations i where i.id = v_issue.invitation_id;
    -- A batch item that pointed at the old invitation follows the new one.
    update public.waitlist_invitation_batch_items bi set invitation_id = v_issue.invitation_id
     where bi.entry_id = p_entry_id and bi.invitation_id = v_old.id and bi.state in ('issued','unknown','failed');
    return query select 'replaced'::text, v_issue.invitation_id, v_issue.raw_token, v_issued, v_expires;
    return;
  exception when sqlstate 'WA001' then
    -- A CLOSED SET OF REFUSAL CODES. The suffix is the inner command's own code when it is one of the known ones and 'refused:other' for anything
    -- else, so no free text (a message, a value) can ride out in a result that a worker logs.
    return query select (case when SQLERRM = any (array['already_redeemed','invalid_input','not_releasable','already_active','not_requeueable',
                                                          'not_found','not_waiting','already_declined_offer','invalid_scope_dates','invalid_service',
                                                          'invalid_weekdays','no_round_open','round_full','unknown_studio','already_invited','invalid_ttl'])
                              then 'refused:' || SQLERRM else 'refused:other' end)::text,
                        null::uuid, null::text, null::timestamptz, null::timestamptz;
    return;
  end;
end;
$$;

revoke all privileges on function public.replace_waitlist_invitation(uuid, uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.replace_waitlist_invitation(uuid, uuid, uuid, uuid) to service_role;
commit;
