-- Migration 0019: session blocks for multi-block sessions.
-- Creates the session_blocks table and adds block_id to electrolysis_entries.
-- No data backfill here; that's migration 0020.
--
-- Safe to paste as one block: no constraint changes against existing data,
-- only structural additions. Idempotent via `if not exists` everywhere.

create table if not exists public.session_blocks (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,

  -- Display order within the session (1, 2, 3, ...).
  sort_order integer not null default 1,

  -- Free-text labels for the block.
  block_name text,
  block_notes text,

  -- Treatment-level params that apply to every entry in this block.
  -- mode values: 'thermo' | 'blend' | 'galv' matches electrolysis_entries.mode.
  mode text,
  apilus_modality text,
  energy_level numeric,
  minutes_performed integer,
  probe_type text,
  probe_size text,
  machine_frequency text,

  -- Block-level audit times. Optional; future UI may populate these.
  started_at timestamptz,
  ended_at timestamptz,

  -- Soft-delete pattern matching sessions (migration 0013).
  deleted_at timestamptz,
  deleted_by uuid references public.practitioners(id) on delete set null,
  delete_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists session_blocks_session_id_idx
  on public.session_blocks (session_id, sort_order)
  where deleted_at is null;

create index if not exists session_blocks_studio_id_idx
  on public.session_blocks (studio_id)
  where deleted_at is null;

-- updated_at trigger uses public.set_updated_at() from migration 0015.
drop trigger if exists session_blocks_set_updated_at on public.session_blocks;
create trigger session_blocks_set_updated_at
  before update on public.session_blocks
  for each row execute function public.set_updated_at();

-- RLS: studio members read/write their own studio's blocks.
alter table public.session_blocks enable row level security;

drop policy if exists "session_blocks_member_all" on public.session_blocks;
create policy "session_blocks_member_all"
  on public.session_blocks
  for all
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));

-- Add block_id to entries. Nullable for now; the 0020 backfill points
-- existing rows at their session's "Main" block, and new code will write
-- block_id on every insert going forward.
alter table public.electrolysis_entries
  add column if not exists block_id uuid references public.session_blocks(id) on delete set null;

create index if not exists electrolysis_entries_block_id_idx
  on public.electrolysis_entries (block_id);
