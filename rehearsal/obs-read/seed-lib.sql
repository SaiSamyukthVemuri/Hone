set session_replication_role = replica;
create or replace function pg_temp.ins(tbl text, ov jsonb) returns void language plpgsql as $f$
declare cols text; j jsonb := '{}'; r record;
begin
  for r in select column_name c, data_type d, udt_name u from information_schema.columns
           where table_schema = 'public' and table_name = tbl and is_nullable = 'NO' and column_default is null
             and is_generated = 'NEVER' and is_identity = 'NO' and not (ov ? column_name)
  loop
    j := j || jsonb_build_object(r.c, case
      when r.d in ('text', 'character varying', 'character') then to_jsonb('x'::text)
      when r.d = 'uuid' then to_jsonb(gen_random_uuid()::text)
      when r.d in ('integer', 'bigint', 'smallint', 'numeric') then to_jsonb(0)
      when r.d = 'boolean' then to_jsonb(false)
      when r.d like 'timestamp%' then to_jsonb(now()::text)
      when r.d = 'date' then to_jsonb(current_date::text)
      when r.d in ('jsonb', 'json') then '{}'::jsonb
      when r.d = 'ARRAY' then '[]'::jsonb
      when r.d = 'USER-DEFINED' then to_jsonb((select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = r.u order by e.enumsortorder limit 1))
      else to_jsonb('x'::text) end);
  end loop;
  j := j || ov;
  select string_agg(quote_ident(k), ',') into cols from jsonb_object_keys(j) k;
  execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, %L::jsonb)', tbl, cols, cols, tbl, j);
end $f$;
create or replace function pg_temp.sid(i int) returns text language sql as $$ select ('00000000-0000-0000-0000-00000000000' || i)::uuid::text $$;

