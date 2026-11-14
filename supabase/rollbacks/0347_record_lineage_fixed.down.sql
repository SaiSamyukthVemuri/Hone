-- Rollback of 0347: drop the five lineage triggers. The 0160 guard functions are shared with other tables and are left in place.
-- Reversing this lets client_id and studio_id of these four record tables be changed by UPDATE again (and photos.session_id be re-pointed).
begin;
set local lock_timeout = '5s';

drop trigger if exists client_personal_notes_lineage_fixed on public.client_personal_notes;
drop trigger if exists treatment_goals_lineage_fixed on public.treatment_goals;
drop trigger if exists client_tags_lineage_fixed on public.client_tags;
drop trigger if exists photos_lineage_fixed on public.photos;
drop trigger if exists photos_session_lineage_clearable on public.photos;

commit;
