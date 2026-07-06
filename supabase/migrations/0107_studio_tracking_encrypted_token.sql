-- 0107_studio_tracking_encrypted_token.sql
--
-- Evolve studio_tracking_providers to SELF-SERVE, ENCRYPTED per-studio provider
-- tokens. Studio owners add their own CAPI/server token in Hone settings; it is
-- encrypted (AES-256-GCM, one server-side master key TRACKING_TOKEN_ENCRYPTION_KEY,
-- see lib/conversion/token-crypto.ts) and only the ciphertext + last4 are stored.
-- Replaces the earlier env-ref model. NO raw token ever lives in the DB.
--
-- No provider rows exist yet, so this is low-risk. NOT applied to production in
-- this PR (proposal only; apply via the migration-first flow after approval).

alter table public.studio_tracking_providers
  add column if not exists encrypted_server_token text,
  add column if not exists server_token_last4      text,
  add column if not exists server_token_added_at    timestamptz,
  add column if not exists server_token_rotated_at  timestamptz,
  add column if not exists token_status             text not null default 'absent';

alter table public.studio_tracking_providers
  drop constraint if exists studio_tracking_providers_token_status_check;
alter table public.studio_tracking_providers
  add constraint studio_tracking_providers_token_status_check
  check (token_status in ('absent', 'active'));

comment on column public.studio_tracking_providers.server_token_secret_ref is
  'DEPRECATED (0107): superseded by encrypted_server_token. Retained nullable for back-compat; unused by the sender.';
comment on column public.studio_tracking_providers.encrypted_server_token is
  'AES-256-GCM ciphertext of the studio-owned provider token (base64(iv):base64(tag):base64(ct)). NEVER the raw token; decrypted server-side only, never sent to the client.';
comment on column public.studio_tracking_providers.server_token_last4 is
  'Last 4 chars of the provider token, for owner UI recognition only (non-sensitive).';

-- Owner-only management of provider config/tokens. Ordinary practitioners may
-- READ provider status (member select) but may NOT add or edit tokens. This
-- replaces the 0106 member insert/update policies with owner-scoped ones.
drop policy if exists "studio_tracking_providers_studio_member_insert"
  on public.studio_tracking_providers;
drop policy if exists "studio_tracking_providers_studio_member_update"
  on public.studio_tracking_providers;

drop policy if exists "studio_tracking_providers_owner_insert"
  on public.studio_tracking_providers;
create policy "studio_tracking_providers_owner_insert"
  on public.studio_tracking_providers for insert
  to authenticated
  with check (public.is_studio_owner(studio_id));

drop policy if exists "studio_tracking_providers_owner_update"
  on public.studio_tracking_providers;
create policy "studio_tracking_providers_owner_update"
  on public.studio_tracking_providers for update
  to authenticated
  using (public.is_studio_owner(studio_id))
  with check (public.is_studio_owner(studio_id));

comment on table public.studio_tracking_providers is
  'Per-studio provider config with SELF-SERVE encrypted tokens (0107). Owners add/rotate/delete their own token in Hone settings; stored AES-256-GCM-encrypted (encrypted_server_token) with only last4 shown. enabled defaults false. RLS: members SELECT status; only studio OWNERS INSERT/UPDATE via is_studio_owner. No raw token in DB/client/logs. PR: 0107 (evolves 0106).';
