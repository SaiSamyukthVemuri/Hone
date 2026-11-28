-- DOWN for 0399. EMERGENCY ONLY. This DESTROYS EVERY autosaved note draft (the table is dropped, not archived): drafts are transient working copies, but
-- anything not yet saved as a note or budget record is lost. Switch autosave OFF (app env and the enabled-studios table) and roll the application back
-- FIRST: with the objects gone, the draft actions and the nightly cron route return their closed error / 503. The saved records are untouched.
-- Order: the two clear triggers on the clinical tables, then the functions, then the tables, then the extra unique index.
begin;

set local lock_timeout = '5s';

drop trigger if exists client_note_drafts_clear_on_note on public.client_clinical_notes;
drop trigger if exists client_note_drafts_clear_on_budget on public.client_budget_context;

drop function if exists public.client_note_drafts_clear_on_note();
drop function if exists public.client_note_drafts_clear_on_budget();
drop function if exists public.save_client_note_draft(uuid, uuid, text, text, jsonb, integer, uuid);
drop function if exists public.discard_client_note_draft(uuid, uuid, text, text);
drop function if exists public.sweep_client_note_drafts();

drop table if exists public.client_note_drafts;
drop table if exists public.client_note_draft_enabled_studios;

drop function if exists public.client_note_drafts_set_studio_id();
drop function if exists public.client_note_drafts_guard();
drop function if exists public.client_note_drafts_cap();
drop function if exists public.client_note_draft_retention();

drop index if exists public.client_clinical_notes_id_client_studio_kind_key;

commit;
