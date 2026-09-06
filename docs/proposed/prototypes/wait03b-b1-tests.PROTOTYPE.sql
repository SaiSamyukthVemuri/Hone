-- WAIT-03B B1 PROTOTYPE TESTS — real database behaviour, disposable instance.
-- Fixtures are built through the LEGITIMATE lifecycle (auth user -> studio ->
-- practitioner -> join_ -> claim_). No trigger, constraint or authorization
-- check is disabled to make setup work, and nothing is mocked.
\set ON_ERROR_STOP off
\pset pager off
create schema if not exists t;
create or replace function t.ok(label text, cond boolean) returns void language plpgsql as $$
begin raise notice '% %', case when cond then 'PASS' else '*** FAIL' end, label; end $$;
create or replace function t.raises(label text, sql text, expect text) returns void language plpgsql as $$
begin
  begin execute sql; raise notice '*** FAIL % (no error raised)', label;
  exception when others then
    if expect = '' or position(lower(expect) in lower(sqlerrm)) > 0 then raise notice 'PASS %', label;
    else raise notice '*** FAIL % (got: %)', label, left(sqlerrm,70); end if;
  end;
end $$;
create table if not exists t.fx(k text primary key, v uuid);

-- ============ FIXTURE, VIA THE REAL LIFECYCLE ============
do $$
declare v_u uuid; v_s uuid; v_sb uuid; v_p uuid; v_svc uuid; v_svcb uuid; v_run text;
        r record; v_e1 uuid; v_e2 uuid; v_res text;
begin
  -- NO DELETES. 0188 makes invitations append-only provenance and a delete
  -- trigger refuses them, correctly. Each run therefore uses a FRESH studio
  -- rather than fighting the design or disabling the trigger.
  v_run := substr(replace(gen_random_uuid()::text,'-',''),1,8);
  delete from t.fx where true;

  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at)
    values (gen_random_uuid(),'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
            'b1-syn-'||v_run||'@synthetic.test','x',now(),now(),now()) returning id into v_u;

  insert into public.studios (name, slug, timezone, owner_email)
    values ('B1 Synthetic A','b1-syn-a-'||v_run,'America/Toronto','b1-syn-'||v_run||'@synthetic.test') returning id into v_s;
  insert into public.studios (name, slug, timezone, owner_email)
    values ('B1 Synthetic B','b1-syn-b-'||v_run,'America/Toronto','b1-syn-o-'||v_run||'@synthetic.test') returning id into v_sb;

  insert into public.practitioners (studio_id, user_id, email, display_name, role, active)
    values (v_s, v_u, 'b1-syn-'||v_run||'@synthetic.test','B1 Owner','owner', true) returning id into v_p;

  insert into public.services (studio_id, name, default_duration_minutes, price_cents)
    values (v_s,'B1 Synthetic Service',60,10000) returning id into v_svc;
  insert into public.services (studio_id, name, default_duration_minutes, price_cents)
    values (v_sb,'B1 Other Studio Service',60,10000) returning id into v_svcb;

  -- entries created by the REAL join_ command, then claimed by the REAL claim_
  select * into r from public.join_new_client_waitlist(v_s,'P One','p1-'||v_run||'@synthetic.test',null);
  v_e1 := r.entry_id;
  select public.claim_new_client_waitlist_entry(v_s, v_e1, v_u) into v_res;
  perform t.ok('A0 fixture: entry reaches claimed through the real lifecycle', v_res = 'claimed');

  select * into r from public.join_new_client_waitlist(v_s,'P Two','p2-'||v_run||'@synthetic.test',null);
  v_e2 := r.entry_id;
  perform public.claim_new_client_waitlist_entry(v_s, v_e2, v_u);

  insert into t.fx values ('u',v_u),('studio',v_s),('studio_b',v_sb),('prac',v_p),
                          ('svc',v_svc),('svc_b',v_svcb),('e1',v_e1),('e2',v_e2);
end $$;

-- ============ COMMAND BEHAVIOUR ============
do $$
declare v_s uuid := (select v from t.fx where k='studio');
        v_svc uuid := (select v from t.fx where k='svc');
        v_svcb uuid := (select v from t.fx where k='svc_b');
        v_u uuid := (select v from t.fx where k='u');
        v_e1 uuid := (select v from t.fx where k='e1'); r record;
begin
  delete from public.studio_waitlist_admission_rounds where studio_id = v_s;
  select * into r from public.issue_scoped_new_client_waitlist_invitation(v_s,v_e1,v_u,v_svc,current_date,current_date+13,null,72);
  perform t.ok('D1 NULL allowance means no round open, not unlimited', r.result='no_round_open');

  insert into public.studio_waitlist_admission_rounds (studio_id, allowance) values (v_s, 2)
    on conflict (studio_id) do update set allowance = 2;
  select * into r from public.issue_scoped_new_client_waitlist_invitation(v_s,v_e1,v_u,v_svcb,current_date,current_date+13,null,72);
  perform t.ok('D2 a service from another studio is refused', r.result='invalid_service');

  select * into r from public.issue_scoped_new_client_waitlist_invitation(v_s,v_e1,v_u,v_svc,current_date+5,current_date,null,72);
  perform t.ok('D3 inverted date range refused', r.result='invalid_scope_dates');

  select * into r from public.issue_scoped_new_client_waitlist_invitation(v_s,v_e1,v_u,v_svc,current_date,current_date+13,array[7]::smallint[],72);
  perform t.ok('D3b weekday outside 0..6 refused by the command', r.result='invalid_weekdays');

  select * into r from public.issue_scoped_new_client_waitlist_invitation(v_s,v_e1,v_u,v_svc,current_date,current_date+13,array[4,2,2,4]::smallint[],72);
  perform t.ok('D4 scoped issue succeeds and returns a raw token',
               r.result='issued' and r.raw_token ~ '^[a-f0-9]{64}$');
  perform t.ok('D4b duplicate weekdays canonicalised to sorted distinct',
    (select scope_allowed_weekdays from public.new_client_waitlist_invitations where id=r.invitation_id)=array[2,4]::smallint[]);
  perform t.ok('D4c scope is stored on the row, not supplied by the caller at use time',
    (select scope_start_date=current_date and scope_end_date=current_date+13 and scope_service_id=v_svc
       from public.new_client_waitlist_invitations where id=r.invitation_id));
  insert into t.fx values ('inv1',r.invitation_id) on conflict (k) do update set v=excluded.v;
end $$;

-- ============ CONSTRAINTS, AGAINST REAL ROWS ============
-- Each constraint case gets its OWN freshly claimed entry. Previously they all
-- reused e1, which already held a live invitation, so one_live_per_entry fired
-- before the scope CHECK was ever reached and the suite stopped being
-- idempotent. Entries are still created through join_ + claim_.
do $$
declare v_s uuid := (select v from t.fx where k='studio');
        v_u uuid := (select v from t.fx where k='u');
        v_run text := substr(replace(gen_random_uuid()::text,'-',''),1,8);
        r record; v_id uuid;
begin
  foreach v_id in array array[]::uuid[] loop end loop;
  for i in 1..4 loop
    select * into r from public.join_new_client_waitlist(v_s,'C'||i,'c'||i||'-'||v_run||'@syn.test',null);
    perform public.claim_new_client_waitlist_entry(v_s, r.entry_id, v_u);
    insert into t.fx values ('c'||i, r.entry_id) on conflict (k) do update set v=excluded.v;
  end loop;
end $$;

select t.raises('C1 partial scope is unrepresentable',
  $q$ insert into public.new_client_waitlist_invitations
      (studio_id, entry_id, token_hash, expires_at, issued_by_practitioner_id, scope_start_date)
      select (select v from t.fx where k='studio'), (select v from t.fx where k='c1'), encode(extensions.digest(gen_random_uuid()::text,'sha256'),'hex'),
             now()+interval '1 day', (select v from t.fx where k='prac'), current_date $q$, 'scope_complete');
select t.raises('C2 end date before start is unrepresentable',
  $q$ insert into public.new_client_waitlist_invitations
      (studio_id, entry_id, token_hash, expires_at, issued_by_practitioner_id,
       scope_service_id, scope_start_date, scope_end_date)
      select (select v from t.fx where k='studio'), (select v from t.fx where k='c2'), encode(extensions.digest(gen_random_uuid()::text,'sha256'),'hex'),
             now()+interval '1 day', (select v from t.fx where k='prac'),
             (select v from t.fx where k='svc'), current_date+5, current_date $q$, 'scope_complete');
select t.raises('C3 weekday outside 0..6 is unrepresentable at the table',
  $q$ update public.new_client_waitlist_invitations set scope_allowed_weekdays=array[9]::smallint[]
      where id=(select v from t.fx where k='inv1') $q$, 'weekdays');
select t.raises('C4 a service from another studio is refused by the composite FK',
  $q$ update public.new_client_waitlist_invitations
        set scope_service_id=(select v from t.fx where k='svc_b')
      where id=(select v from t.fx where k='inv1') $q$, 'same_studio_fk');

-- ============ ALLOWANCE ACCOUNTING ============
do $$
declare v_s uuid := (select v from t.fx where k='studio');
        v_svc uuid := (select v from t.fx where k='svc');
        v_u uuid := (select v from t.fx where k='u');
        v_e2 uuid := (select v from t.fx where k='e2'); r record;
begin
  perform t.ok('E1 one live invitation consumes one permission', public.waitlist_admission_consumed(v_s)=1);
  select * into r from public.issue_scoped_new_client_waitlist_invitation(v_s,v_e2,v_u,v_svc,current_date,current_date+13,null,72);
  perform t.ok('E2 the second issue fills an allowance of 2', r.result='issued');
  perform t.ok('E3 consumed now equals the allowance', public.waitlist_admission_consumed(v_s)=2);
  select * into r from public.issue_scoped_new_client_waitlist_invitation(v_s,v_e2,v_u,v_svc,current_date,current_date+13,null,72);
  perform t.ok('E4 issuing beyond the round allowance is refused', r.result='round_full');
  update public.new_client_waitlist_invitations set declined_at=now() where entry_id=v_e2 and declined_at is null;
  perform t.ok('E5 a decline frees admission permission', public.waitlist_admission_consumed(v_s)=1);
end $$;

-- ============ DECLINE / LIVENESS ============
do $$
declare v_s uuid := (select v from t.fx where k='studio');
        v_svc uuid := (select v from t.fx where k='svc');
        v_u uuid := (select v from t.fx where k='u');
        v_e2 uuid := (select v from t.fx where k='e2'); r record;
begin
  -- F1 IS NOT IMPLEMENTED IN B1, and the proof says so rather than passing it.
  -- Setting declined_at closes the INVITATION but does not return the ENTRY to
  -- a re-invitable status; that transition belongs to the token-authorised
  -- decline command (G3), deliberately deferred. Measured here so the gap is
  -- recorded rather than assumed: the entry remains 'invited' and issue_
  -- answers 'not_claimed'.
  select * into r from public.issue_scoped_new_client_waitlist_invitation(v_s,v_e2,v_u,v_svc,current_date+20,current_date+27,null,72);
  raise notice 'NOT IMPLEMENTED F1 later offer after decline needs G3 (entry stayed %, issue_ said %)',
    (select status from public.new_client_waitlist_entries where id=v_e2), r.result;
end $$;
select t.raises('F2 the SAME declined offer cannot be recorded twice',
  $q$ insert into public.new_client_waitlist_invitations
      (studio_id, entry_id, token_hash, expires_at, issued_by_practitioner_id,
       scope_service_id, scope_start_date, scope_end_date, declined_at)
      select studio_id, entry_id, encode(extensions.digest(gen_random_uuid()::text,'sha256'),'hex'), now()+interval '1 day', issued_by_practitioner_id,
             scope_service_id, scope_start_date, scope_end_date, now()
        from public.new_client_waitlist_invitations where declined_at is not null limit 1 $q$,
  'duplicate key');
select t.raises('F3 two terminal outcomes on one invitation are unrepresentable',
  $q$ update public.new_client_waitlist_invitations set declined_at=now(), released_at=now()
      where id=(select v from t.fx where k='inv1') $q$, 'one_terminal_outcome');

-- ============ PRIVILEGE POSTURE ============
select t.ok('G1 anon cannot execute the scoped issue command',
  has_function_privilege('anon','public.issue_scoped_new_client_waitlist_invitation(uuid,uuid,uuid,uuid,date,date,smallint[],integer)','EXECUTE')=false);
select t.ok('G2 authenticated cannot execute the scoped issue command',
  has_function_privilege('authenticated','public.issue_scoped_new_client_waitlist_invitation(uuid,uuid,uuid,uuid,date,date,smallint[],integer)','EXECUTE')=false);
select t.ok('G3 service_role CAN execute the scoped issue command',
  has_function_privilege('service_role','public.issue_scoped_new_client_waitlist_invitation(uuid,uuid,uuid,uuid,date,date,smallint[],integer)','EXECUTE')=true);
select t.ok('G4 anon cannot execute the accounting function',
  has_function_privilege('anon','public.waitlist_admission_consumed(uuid)','EXECUTE')=false);
select t.ok('G5 existing applied grants are unweakened',
  has_function_privilege('service_role','public.issue_new_client_waitlist_invitation(uuid,uuid,uuid,integer)','EXECUTE')=true);
select t.ok('G6 no broad direct-write privilege was introduced on the invitations table',
  has_table_privilege('authenticated','public.new_client_waitlist_invitations','INSERT')=false
  and has_table_privilege('authenticated','public.new_client_waitlist_invitations','UPDATE')=false
  and has_table_privilege('anon','public.new_client_waitlist_invitations','INSERT')=false
  and has_table_privilege('anon','public.new_client_waitlist_invitations','UPDATE')=false);
select t.ok('G7 the allowance is not browser-writable through any table grant',
  has_table_privilege('authenticated','public.studio_waitlist_admission_rounds','UPDATE')=false
  and has_table_privilege('authenticated','public.studio_waitlist_admission_rounds','INSERT')=false
  and has_table_privilege('anon','public.studio_waitlist_admission_rounds','UPDATE')=false
  and has_table_privilege('anon','public.studio_waitlist_admission_rounds','INSERT')=false);
select t.ok('G8 the allowance carries no leftover column on studios',
  (select count(*) from information_schema.columns
    where table_name='studios' and column_name='waitlist_round_allowance')=0);
select t.ok('G9 RLS is enabled on the allowance table',
  (select relrowsecurity from pg_class where oid='public.studio_waitlist_admission_rounds'::regclass)=true);
