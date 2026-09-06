-- WAIT-03B B1 — P3-2 targeted proof: the no-repeat-declined key must name every
-- field that defines the same logical offer, without weakening the guard.
\set ON_ERROR_STOP off
\pset pager off
create schema if not exists t;
create or replace function t.ok(label text, cond boolean) returns void language plpgsql as $$
begin raise notice '% %', case when cond then 'PASS' else '*** FAIL' end, label; end $$;

-- fixture through the real lifecycle, fresh studio per run
do $$
declare v_u uuid; v_s uuid; v_s2 uuid; v_p uuid; v_p2 uuid; v_svc uuid; v_svc2 uuid;
        r record; v_run text := substr(replace(gen_random_uuid()::text,'-',''),1,8);
begin
  create table if not exists t.px(k text primary key, v uuid);
  delete from t.px where true;
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at)
    values (gen_random_uuid(),'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
            'p32-'||v_run||'@syn.test','x',now(),now(),now()) returning id into v_u;
  insert into public.studios (name, slug, timezone, owner_email)
    values ('P32 A','p32-a-'||v_run,'America/Toronto','p32-'||v_run||'@syn.test') returning id into v_s;
  insert into public.studios (name, slug, timezone, owner_email)
    values ('P32 B','p32-b-'||v_run,'America/Toronto','p32b-'||v_run||'@syn.test') returning id into v_s2;
  insert into public.practitioners (studio_id,user_id,email,display_name,role,active)
    values (v_s, v_u, 'p32-'||v_run||'@syn.test','P32 Owner','owner',true) returning id into v_p;
  insert into public.practitioners (studio_id,email,display_name,role,active)
    values (v_s2, 'p32b-'||v_run||'@syn.test','P32 B Owner','owner',true) returning id into v_p2;
  insert into public.services (studio_id,name,default_duration_minutes,price_cents)
    values (v_s,'P32 Service',60,10000) returning id into v_svc;
  insert into public.services (studio_id,name,default_duration_minutes,price_cents)
    values (v_s2,'P32 B Service',60,10000) returning id into v_svc2;
  select * into r from public.join_new_client_waitlist(v_s,'H','h-'||v_run||'@syn.test',null);
  insert into t.px values ('u',v_u),('s',v_s),('s2',v_s2),('p',v_p),('p2',v_p2),
                          ('svc',v_svc),('svc2',v_svc2),('e',r.entry_id);
  select * into r from public.join_new_client_waitlist(v_s2,'H2','h2-'||v_run||'@syn.test',null);
  insert into t.px values ('e2', r.entry_id);
end $$;

-- helper: insert a DECLINED invitation with an explicit offer shape
create or replace function t.decl(p_entry uuid, p_studio uuid, p_prac uuid, p_svc uuid,
                                  p_start date, p_end date, p_wd smallint[])
returns text language plpgsql as $$
begin
  insert into public.new_client_waitlist_invitations
    (studio_id, entry_id, token_hash, expires_at, issued_by_practitioner_id,
     scope_service_id, scope_start_date, scope_end_date, scope_allowed_weekdays, declined_at)
  values (p_studio, p_entry, encode(extensions.digest(gen_random_uuid()::text,'sha256'),'hex'),
          now()+interval '1 day', p_prac, p_svc, p_start, p_end, p_wd, now());
  return 'accepted';
exception when unique_violation then return 'conflict';
          when others then return 'other:'||left(sqlerrm,40);
end $$;

do $$
declare e uuid := (select v from t.px where k='e'); s uuid := (select v from t.px where k='s');
        p uuid := (select v from t.px where k='p'); sv uuid := (select v from t.px where k='svc');
        e2 uuid := (select v from t.px where k='e2'); s2 uuid := (select v from t.px where k='s2');
        p2 uuid := (select v from t.px where k='p2'); sv2 uuid := (select v from t.px where k='svc2');
        d1 date := current_date; d2 date := current_date + 13;
begin
  -- H1: two IDENTICAL offers (same weekdays) must still conflict
  perform t.ok('H1a first declined offer accepted',
    t.decl(e,s,p,sv,d1,d2,array[2,4]::smallint[]) = 'accepted');
  perform t.ok('H1b an IDENTICAL declined offer conflicts',
    t.decl(e,s,p,sv,d1,d2,array[2,4]::smallint[]) = 'conflict');

  -- H2: differing ONLY by allowed weekdays must NOT conflict
  perform t.ok('H2 an offer differing only by weekdays is accepted',
    t.decl(e,s,p,sv,d1,d2,array[3,5]::smallint[]) = 'accepted');

  -- H3: NULLS NOT DISTINCT -- two identical all-days offers still conflict
  perform t.ok('H3a first all-days (NULL weekdays) offer accepted',
    t.decl(e,s,p,sv,d1,d2,null) = 'accepted');
  perform t.ok('H3b an IDENTICAL all-days offer conflicts (NULLS NOT DISTINCT)',
    t.decl(e,s,p,sv,d1,d2,null) = 'conflict');

  -- H4: NULL and the explicit full array are NOT made equivalent
  perform t.ok('H4 explicit [0..6] is a DIFFERENT key from NULL',
    t.decl(e,s,p,sv,d1,d2,array[0,1,2,3,4,5,6]::smallint[]) = 'accepted');

  -- H5: tenant separation -- the same offer shape for another studio's entry
  perform t.ok('H5 an identical shape in ANOTHER studio does not conflict',
    t.decl(e2,s2,p2,sv2,d1,d2,array[2,4]::smallint[]) = 'accepted');
end $$;

-- index shape assertions
select t.ok('H6 the key names all five offer-defining fields',
  (select count(*) from pg_index i
     join pg_class c on c.oid=i.indexrelid
    where c.relname='new_client_waitlist_invitations_no_repeat_declined_offer'
      and i.indnatts = 5) = 1);
select t.ok('H7 the index is NULLS NOT DISTINCT',
  (select indnullsnotdistinct from pg_index i join pg_class c on c.oid=i.indexrelid
    where c.relname='new_client_waitlist_invitations_no_repeat_declined_offer') = true);
