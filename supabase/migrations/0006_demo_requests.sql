-- Stores demo-request submissions from /demo. Anonymous visitors can insert;
-- no read policy means the rows are private to service-role admin access.

create table public.demo_requests (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  practice_name text,
  location text,
  practice_type text check (practice_type in ('electrolysis', 'laser', 'both')),
  practitioner_count text check (practitioner_count in ('1', '2-5', '5+')),
  current_tool text,
  notes text,
  status text default 'new',
  created_at timestamptz not null default now()
);

alter table public.demo_requests enable row level security;

create policy "demo_requests_anonymous_insert"
  on public.demo_requests
  for insert
  to anon, authenticated
  with check (true);
