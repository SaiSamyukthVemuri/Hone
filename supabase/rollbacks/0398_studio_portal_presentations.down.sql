-- Emergency database removal only: export owner drafts and published copy first.
-- Normal rollback is Switch to classic in Settings; that preserves the draft.
begin;
set local lock_timeout = '5s';
drop function if exists public.edit_studio_portal_presentation(uuid,integer,text,jsonb);
drop table if exists public.studio_portal_presentations;
commit;
