-- Public waitlist for the landing page. Anonymous visitors can insert their
-- email here; reads are restricted (no select policy = no access for anon).

create table public.waitlist (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  practice_name text,
  source text default 'landing',
  created_at timestamptz not null default now()
);

alter table public.waitlist enable row level security;

create policy "waitlist_anonymous_insert"
  on public.waitlist
  for insert
  to anon, authenticated
  with check (true);
