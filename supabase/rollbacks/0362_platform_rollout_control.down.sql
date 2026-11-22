-- ROLLBACK of the platform rollout control.
-- REFUSES unless the mode is 'off' AND no pilot row exists: a live rollout is never silently removed. STEPS: set the mode Off and remove every
-- pilot studio in the admin page (or the commands) FIRST, then run this. Audit rows in admin_action_events are never touched.
begin;
set local lock_timeout = '3s';
do $$
declare v_mode text; n integer;
begin
  lock table public.platform_rollouts in access exclusive mode;
  lock table public.platform_rollout_studios in access exclusive mode;
  select count(*) into n from public.platform_rollout_studios;
  select string_agg(mode, ',') into v_mode from public.platform_rollouts where mode <> 'off';
  if v_mode is not null or n > 0 then
    raise exception 'REFUSED: a rollout is live or has pilot studios (non-off modes: %, pilot rows: %). Set Off and remove the pilots first.', coalesce(v_mode, 'none'), n;
  end if;
end $$;
drop function if exists public.log_refused_platform_rollout_attempt(uuid, text);
drop function if exists public.list_platform_rollout(text);
drop function if exists public.remove_platform_rollout_studio(text, uuid, uuid, text);
drop function if exists public.add_platform_rollout_studio(text, uuid, uuid, text);
drop function if exists public.set_platform_rollout_mode(text, text, uuid, text);
drop function if exists public.platform_rollout_check_actor(uuid, text);
drop function if exists public.platform_rollout_enabled_for(text, uuid);
drop table public.platform_rollout_studios;
drop table public.platform_rollouts;
commit;
