// SQL the baseline scripts run inside a stack's database container. Everything a
// restore has to reproduce is generated from the CHAIN stack, never typed by hand.
// This file is itself a cache-key input (key.mjs hashes it), so changing any
// statement here invalidates every cached baseline automatically.

// One raw line per fact, prefixed with its category. The scripts compute count and
// md5 per category themselves, so a mismatch can be shown line by line.
export const FINGERPRINT_SQL = String.raw`
select 'migrations:' || version from supabase_migrations.schema_migrations;
select 'catalog:' || x from (
    select 'rel|' || c.relname || '|' || c.relkind::text from pg_catalog.pg_class c
     where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v','m','f','S','i')
       and not exists (select 1 from pg_catalog.pg_depend d where d.classid = 'pg_catalog.pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
    union all
    select 'col|' || c.relname || '|' || a.attname || '|' || pg_catalog.format_type(a.atttypid, a.atttypmod) || '|' || a.attnotnull::text || '|' || coalesce(pg_catalog.pg_get_expr(ad.adbin, ad.adrelid), '')
      from pg_catalog.pg_attribute a join pg_catalog.pg_class c on c.oid = a.attrelid
      left join pg_catalog.pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
     where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p') and a.attnum > 0 and not a.attisdropped
    union all
    select 'con|' || c.relname || '|' || k.conname || '|' || pg_catalog.pg_get_constraintdef(k.oid)
      from pg_catalog.pg_constraint k join pg_catalog.pg_class c on c.oid = k.conrelid where c.relnamespace = 'public'::regnamespace
    union all
    select 'trg|' || c.relname || '|' || t.tgname || '|' || t.tgenabled::text || '|' || t.tgfoid::regproc::text
      from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid = t.tgrelid
     where c.relnamespace = 'public'::regnamespace and not t.tgisinternal
    union all
    select 'pol|' || c.relname || '|' || p.polname || '|' || p.polcmd::text
      from pg_catalog.pg_policy p join pg_catalog.pg_class c on c.oid = p.polrelid where c.relnamespace = 'public'::regnamespace
    union all
    select 'fn|' || p.oid::regprocedure::text || '|' || pg_catalog.md5(p.prosrc) || '|' || p.prosecdef::text
      from pg_catalog.pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and not exists (select 1 from pg_catalog.pg_depend d where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  ) s(x);
select 'grants:' || x from (
    select 'rel|' || c.relname || '|' || coalesce(c.relacl::text,'') || '|' || pg_get_userbyid(c.relowner) from pg_class c where c.relnamespace='public'::regnamespace and c.relkind in ('r','p','v','m','f','S')
    union all select 'fn|' || p.oid::regprocedure::text || '|' || coalesce(p.proacl::text,'') || '|' || pg_get_userbyid(p.proowner) || '|' || coalesce(p.proconfig::text,'') from pg_proc p where p.pronamespace='public'::regnamespace
    union all select 'nsp|' || n.nspname || '|' || coalesce(n.nspacl::text,'') from pg_namespace n where n.nspname in ('public','supabase_migrations')
    union all select 'def|' || coalesce(n.nspname,'*') || '|' || pg_get_userbyid(d.defaclrole) || '|' || d.defaclobjtype::text || '|' || coalesce(d.defaclacl::text,'') from pg_default_acl d left join pg_namespace n on n.oid=d.defaclnamespace
    union all select 'col|' || c.relname || '|' || a.attname || '|' || coalesce(a.attacl::text,'') from pg_attribute a join pg_class c on c.oid=a.attrelid where c.relnamespace='public'::regnamespace and a.attacl is not null
  ) s(x);
select 'extensions:' || extname || '=' || extversion || '@' || extnamespace::regnamespace::text from pg_extension;
select 'outside:' || x from (
    select 'trg|' || n.nspname || '.' || c.relname || '|' || t.tgname || '|' || t.tgfoid::regproc::text from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where not t.tgisinternal and n.nspname in ('auth','storage','realtime','extensions','supabase_migrations')
    union all select 'pol|' || n.nspname || '.' || c.relname || '|' || p.polname from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname <> 'public'
    union all select 'fn|' || p.oid::regprocedure::text || '|' || md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('auth','storage') and p.oid > 16384 and pg_get_userbyid(p.proowner) = 'postgres'
  ) s(x);
select 'data:' || t || '=' || n from (
    select table_name::text t, (xpath('/row/c/text()', query_to_xml(format('select count(*) c from public.%I', table_name), false, true, '')))[1]::text n from information_schema.tables where table_schema='public' and table_type='BASE TABLE'
  ) s;
select 'authusers:' || count(*) from auth.users;
`;

// Extensions the migrations create. A -n public dump does not carry them, and without
// btree_gist the exclusion constraints cannot be rebuilt.
export const EXTENSIONS_SQL = String.raw`
select format('create extension if not exists %I schema %I;', e.extname, n.nspname)
  from pg_extension e join pg_namespace n on n.oid = e.extnamespace
 where e.extname <> 'plpgsql' order by e.extname;
`;

// Triggers the migrations put on tables OUTSIDE the dumped schemas (auth.users).
export const TRIGGERS_SQL = String.raw`
select pg_get_triggerdef(t.oid) || ';'
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
 where not t.tgisinternal and n.nspname in ('auth','storage','realtime')
 order by n.nspname, c.relname, t.tgname;
`;

// EXPLICIT grants, regenerated from the chain stack with aclexplode and replayed after a
// --no-acl restore. pg_dump emits no GRANT for an ACL equal to the built-in default, so a
// plain restore lets the TARGET's default privileges (anon, authenticated, service_role)
// apply on top and can give a restored object MORE access than the chain gave it. Every
// object is revoked from every role first, then granted exactly what the chain has.
export const ACL_SQL = String.raw`
with allroles as (
  select string_agg(quote_ident(rolname), ', ') l from pg_roles where rolname !~ '^pg_'
),
objs as (
  select 'TABLE' kind, format('public.%I', c.relname) ident, coalesce(c.relacl, acldefault('r', c.relowner)) acl
    from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v','m','f')
  union all
  select 'SEQUENCE', format('public.%I', c.relname), coalesce(c.relacl, acldefault('S', c.relowner))
    from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'S'
  union all
  select 'ROUTINE', p.oid::regprocedure::text, coalesce(p.proacl, acldefault('f', p.proowner))
    from pg_proc p where p.pronamespace = 'public'::regnamespace
  union all
  select 'SCHEMA', 'public', coalesce(n.nspacl, acldefault('n', n.nspowner))
    from pg_namespace n where n.nspname = 'public'
)
select format('revoke all on %s %s from public, %s;', o.kind, o.ident, r.l) from objs o, allroles r
union all
select format('grant %s on %s %s to %s%s;', x.privilege_type, o.kind, o.ident,
              case when x.grantee = 0 then 'public' else quote_ident(pg_get_userbyid(x.grantee)) end,
              case when x.is_grantable then ' with grant option' else '' end)
  from objs o, lateral aclexplode(o.acl) x
union all
select format('revoke all (%I) on table public.%I from public, %s;', a.attname, c.relname, r.l)
  from pg_attribute a join pg_class c on c.oid = a.attrelid, allroles r
 where c.relnamespace = 'public'::regnamespace and a.attacl is not null
union all
select format('grant %s (%I) on table public.%I to %s%s;', x.privilege_type, a.attname, c.relname,
              case when x.grantee = 0 then 'public' else quote_ident(pg_get_userbyid(x.grantee)) end,
              case when x.is_grantable then ' with grant option' else '' end)
  from pg_attribute a join pg_class c on c.oid = a.attrelid, lateral aclexplode(a.attacl) x
 where c.relnamespace = 'public'::regnamespace and a.attacl is not null
union all
select format('alter default privileges for role %I in schema public grant %s on %s to %s%s;',
              pg_get_userbyid(d.defaclrole), x.privilege_type,
              case d.defaclobjtype when 'r' then 'tables' when 'S' then 'sequences' when 'f' then 'functions' when 'T' then 'types' else 'schemas' end,
              case when x.grantee = 0 then 'public' else quote_ident(pg_get_userbyid(x.grantee)) end,
              case when x.is_grantable then ' with grant option' else '' end)
  from pg_default_acl d, lateral aclexplode(d.defaclacl) x
 where d.defaclnamespace = 'public'::regnamespace;
`;

// What a restore clears before it loads the dump (all of it is rebuilt from the dump or
// from the replays above).
export const RESET_SQL = `drop schema if exists supabase_migrations cascade; drop schema if exists public cascade; create schema public authorization pg_database_owner;`;
