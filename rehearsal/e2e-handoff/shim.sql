-- REHEARSAL - NEVER MERGE. The minimum a plain PostgreSQL needs so that the d189768b migration chain applies:
-- the Supabase roles, the extensions schema with pgcrypto and btree_gist, auth.users / auth.uid(), storage.buckets /
-- storage.objects / storage.foldername(), default privileges like a Supabase project. No Hone data. Not part of the package.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create role authenticator noinherit nologin;
create role "postgres.alhhybgqdmcdyzpybykj" superuser login password :'pw';
create schema extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists btree_gist with schema extensions;
alter database postgres set search_path to "$user", public, extensions;
grant usage on schema public, extensions to anon, authenticated, service_role;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb, created_at timestamptz default now());
create function auth.uid() returns uuid language sql stable as $f$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
create function auth.role() returns text language sql stable as $f$ select nullif(current_setting('request.jwt.claim.role', true), '')::text $f$;
create function auth.jwt() returns jsonb language sql stable as $f$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $f$;
grant usage on schema auth to anon, authenticated, service_role;
create schema storage;
create table storage.buckets (id text primary key, name text not null, public boolean default false, file_size_limit bigint, allowed_mime_types text[], created_at timestamptz default now());
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets (id), name text, owner uuid, metadata jsonb, created_at timestamptz default now());
create function storage.foldername(name text) returns text[] language sql immutable as $f$ select string_to_array(name, '/') $f$;
grant usage on schema storage to anon, authenticated, service_role;
alter default privileges for role postgres, "postgres.alhhybgqdmcdyzpybykj" in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres, "postgres.alhhybgqdmcdyzpybykj" in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges for role postgres, "postgres.alhhybgqdmcdyzpybykj" in schema public grant all on functions to anon, authenticated, service_role;
