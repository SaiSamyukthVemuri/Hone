-- DOWN for 0289_roles_edit_record_protections (HELD, not applied anywhere). NOT a migration: supabase never runs this directory.
-- Run by an operator, once, inside the maintenance window, and only with the app on a build that does not call correct_session_performer
-- (the previous build calls set_session_performer, whose overwrite body this file restores).
--
-- WHAT THIS DESTROYS: chart_revisions (the append-only edit history) and session_performer_corrections (who corrected a performer, when,
-- why). The triggers refuse UPDATE, DELETE and TRUNCATE but a DROP is not one of them. EXPORT BOTH TABLES FIRST if the history must be kept.
-- WHAT IT RESTORES: the 0167 body of set_session_performer (direct performer overwrite); no edit-key check at the database (the app check, if any, remains).
-- It touches no source column and no existing command body: 0289 changed none.
begin;
set local lock_timeout = '5s';

do $$
declare t text;
begin
  foreach t in array array['sessions','session_blocks','session_block_areas','electrolysis_entries','laser_entries','treatment_plans','treatment_plan_stages','client_clinical_notes']
  loop
    execute format('drop trigger if exists zz_chart_write_guard_trg on public.%I', t);
    execute format('drop trigger if exists chart_revision_write_trg on public.%I', t);
  end loop;
end $$;
drop trigger if exists chart_attribution_guard_sessions on public.sessions;
drop trigger if exists chart_attribution_guard_plans on public.treatment_plans;
drop trigger if exists chart_attribution_guard_notes on public.client_clinical_notes;

drop function if exists public.correct_session_performer(uuid, uuid, uuid, text);
drop table if exists public.session_performer_corrections;
drop table if exists public.chart_revisions;

drop function if exists public.chart_attribution_guard();
drop function if exists public.chart_revision_write();
drop function if exists public.chart_revision_image(jsonb);
drop function if exists public.chart_write_guard();
drop function if exists public.chart_scope(text, jsonb);
drop function if exists public.chart_revisions_append_only();

-- Restore the 0167 body of set_session_performer EXACTLY (the overwrite). Its signature and grant (authenticated only) were never changed.
create or replace function public.set_session_performer(
  p_session_id   uuid,
  p_client_id    uuid,
  p_performer_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_studio_id uuid;
begin
  v_studio_id := public.assert_session_writable(p_session_id, p_client_id);

  if p_performer_id is not null then
    perform 1 from public.practitioners p
      where p.id = p_performer_id and p.studio_id = v_studio_id;
    if not found then
      raise exception 'Practitioner not found in this studio.' using errcode = 'check_violation';
    end if;
  end if;

  update public.sessions s
     set performed_by_practitioner_id = p_performer_id
   where s.id = p_session_id
     and s.studio_id = v_studio_id;
end;
$$;

commit;
