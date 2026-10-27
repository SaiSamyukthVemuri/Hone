-- REHEARSAL - NEVER MERGE. Session helper: pg_temp.rh_ins(table, overrides) inserts one synthetic row, filling every required column by type.
set session_replication_role = replica;
create function pg_temp.rh_ins(tbl regclass, ov jsonb) returns void language plpgsql as $f$
declare cols text := ''; vals text := ''; c record; v text; lbl text;
begin
  for c in
    select a.attname::text as name, a.attnotnull, a.atthasdef, a.attgenerated, a.attidentity,
           format_type(a.atttypid, a.atttypmod) as ft, t.typcategory, t.oid as toid, a.atttypid
    from pg_attribute a join pg_type t on t.oid = a.atttypid
    where a.attrelid = tbl and a.attnum > 0 and not a.attisdropped
    order by a.attnum
  loop
    if c.attgenerated <> '' or c.attidentity <> '' then continue; end if;
    v := null;
    if ov ? c.name then
      if jsonb_typeof(ov -> c.name) = 'null' then v := 'null';
      else v := quote_literal(ov ->> c.name) || '::' || c.ft; end if;
    elsif c.attnotnull and not c.atthasdef then
      v := case
        when c.ft = 'uuid' then 'gen_random_uuid()'
        when c.ft in ('jsonb', 'json') then '''{}''::' || c.ft
        when c.ft = 'bytea' then '''\x00''::bytea'
        when c.typcategory = 'S' then quote_literal(left(md5(random()::text), 12)) || '::' || c.ft
        when c.typcategory = 'N' then '0::' || c.ft
        when c.typcategory = 'B' then 'false'
        when c.typcategory = 'D' then '(now())::' || c.ft
        when c.typcategory = 'T' then '''0 seconds''::' || c.ft
        when c.typcategory = 'A' then '''{}''::' || c.ft
        when c.typcategory = 'I' then '''127.0.0.1''::' || c.ft
        when c.typcategory = 'E' then
          quote_literal((select e.enumlabel from pg_enum e where e.enumtypid = c.atttypid order by e.enumsortorder limit 1)) || '::' || c.ft
        else null end;
      if v is null then raise exception 'rehearsal cannot fill %.% of type % (category %)', tbl, c.name, c.ft, c.typcategory; end if;
    end if;
    if v is not null then cols := cols || case when cols = '' then '' else ', ' end || quote_ident(c.name); vals := vals || case when vals = '' then '' else ', ' end || v; end if;
  end loop;
  execute format('insert into %s (%s) values (%s)', tbl, cols, vals);
end $f$;
