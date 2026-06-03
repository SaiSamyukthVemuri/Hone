-- Migration 0055: RLS policies for portal messages + replies.
--
-- PR #130. Tables client_portal_messages (migration 0053) and
-- client_portal_message_replies (migration 0054) currently have RLS
-- enabled with NO policies, with all reads / writes routed through
-- the service-role admin client in server actions that scope every
-- query by (studio_id, client_id). That action-layer scoping is the
-- source of truth and is unchanged by this PR.
--
-- This migration adds database-level defense in depth so an
-- authenticated user-scoped Supabase client (one that does not go
-- through createAdminClient) cannot accidentally widen the surface
-- to messages or replies outside its studio. Today no such code
-- path exists; the policies are the backstop that keeps it that way
-- as portal messaging grows.
--
-- Convention. The repo standardised on the helper function
-- public.is_studio_member(studio_id) in 0001_init.sql and every
-- comparable content-table migration since 0026 uses it
-- (treatment_goals, client_personal_notes, ...). is_studio_member
-- already encodes the "authenticated practitioner row in this studio
-- with active = true" check; inlining a raw practitioners.user_id =
-- auth.uid() join would diverge from the canonical pattern and
-- would not pick up the active=true filter automatically. So both
-- tables use is_studio_member.
--
-- Why we did NOT use FOR ALL. The closest analog tables
-- (treatment_goals, client_personal_notes) use a single FOR ALL
-- policy, but FOR ALL also grants DELETE. The portal-messages
-- product is soft-archive only (status='archived' + archived_at
-- stamp via UPDATE); no code path hard-deletes either row type.
-- Splitting into explicit SELECT + INSERT + UPDATE (and SELECT +
-- UPDATE for replies) keeps DELETE locked down by RLS default-deny
-- without depending on the action layer never inserting a DELETE
-- statement.
--
-- Why we did NOT add a practitioner INSERT policy on replies. v1
-- client_portal_message_replies.created_by has a CHECK constraint
-- limiting it to ('client'). Practitioner-authored replies are a
-- future PR (deferred from PR #129). The reply INSERT path is
-- service-role only (the createPortalMessageReplyAction in
-- app/portal/portal-message-actions.ts) which bypasses RLS by design.
--
-- Portal client side. Portal sessions are custom DB-backed sessions
-- (client_portal_sessions, migration 0052) tied to a httpOnly cookie,
-- NOT a Supabase auth.uid(). There is no clean way to express "this
-- request belongs to portal session X" inside an RLS USING clause
-- without surfacing the cookie hash to Postgres, and weakening RLS
-- to do so would be a net negative. Portal-side reads and writes
-- therefore stay on the service-role admin client, scoped at the
-- action layer by getCurrentPortalSession() + (studio_id, client_id,
-- message_id) matchers. That is the same posture migrations 0052
-- and 0053 take. Anon access to these tables remains denied by RLS
-- default-deny; only authenticated practitioner roles get the
-- scoped read/write described below.
--
-- Strictly additive + idempotent. Every CREATE POLICY is preceded by
-- a DROP POLICY IF EXISTS so re-running the migration is safe.
-- ENABLE ROW LEVEL SECURITY is re-asserted on both tables as a
-- belt-and-braces guard against a future contributor accidentally
-- disabling it.

-- --------------------------------------------------------------------
-- 1) Re-assert RLS on both tables
-- --------------------------------------------------------------------

alter table public.client_portal_messages enable row level security;
alter table public.client_portal_message_replies enable row level security;

-- --------------------------------------------------------------------
-- 2) client_portal_messages: SELECT + INSERT + UPDATE only
-- --------------------------------------------------------------------

drop policy if exists "client_portal_messages_studio_member_select"
  on public.client_portal_messages;
create policy "client_portal_messages_studio_member_select"
  on public.client_portal_messages for select
  to authenticated
  using (public.is_studio_member(studio_id));

drop policy if exists "client_portal_messages_studio_member_insert"
  on public.client_portal_messages;
create policy "client_portal_messages_studio_member_insert"
  on public.client_portal_messages for insert
  to authenticated
  with check (public.is_studio_member(studio_id));

-- UPDATE policy critically uses both USING and WITH CHECK with the
-- same is_studio_member predicate. USING filters which rows the
-- caller can see + write; WITH CHECK prevents an UPDATE from
-- migrating a row's studio_id into a studio the caller is not a
-- member of. Without WITH CHECK an authenticated practitioner with
-- write access to studio A could in principle UPDATE a row's
-- studio_id to studio B.
drop policy if exists "client_portal_messages_studio_member_update"
  on public.client_portal_messages;
create policy "client_portal_messages_studio_member_update"
  on public.client_portal_messages for update
  to authenticated
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));

-- Intentionally no DELETE policy. The portal-messages product is
-- soft-archive only; archivePortalMessageAction sets status='archived'
-- + archived_at via UPDATE. RLS default-deny on DELETE blocks any
-- accidental hard delete from a user-scoped Supabase client.

-- --------------------------------------------------------------------
-- 3) client_portal_message_replies: SELECT + UPDATE only
-- --------------------------------------------------------------------

drop policy if exists "client_portal_message_replies_studio_member_select"
  on public.client_portal_message_replies;
create policy "client_portal_message_replies_studio_member_select"
  on public.client_portal_message_replies for select
  to authenticated
  using (public.is_studio_member(studio_id));

-- UPDATE covers markPortalReplySeenAction (stamps
-- practitioner_seen_at) and any future practitioner-side
-- soft-archive. WITH CHECK reasoning identical to the messages
-- table above.
drop policy if exists "client_portal_message_replies_studio_member_update"
  on public.client_portal_message_replies;
create policy "client_portal_message_replies_studio_member_update"
  on public.client_portal_message_replies for update
  to authenticated
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));

-- Intentionally no INSERT policy. Client replies are inserted by the
-- portal-side createPortalMessageReplyAction (service-role admin
-- client; gated by getCurrentPortalSession() + a parent-message
-- studio/client/message-id match). Practitioner-authored replies
-- are a future PR (CHECK constraint
-- client_portal_message_replies_created_by_check limits created_by
-- to 'client' in v1).

-- Intentionally no DELETE policy. Same reasoning as messages.

-- --------------------------------------------------------------------
-- 4) Table comments (audit trail for future migrators)
-- --------------------------------------------------------------------

comment on table public.client_portal_messages is
  'One-way secure messages from practitioner to client surfaced on the client portal. Practitioner-side writes are scoped by getCurrentPractitionerWithStudio() in the server action; portal-side reads/reviews are scoped by getCurrentPortalSession() + (studio_id, client_id) in the server action. RLS is enabled. PR #130 / migration 0055 adds explicit SELECT / INSERT / UPDATE policies for authenticated practitioners using public.is_studio_member(studio_id) as a database backstop; portal-side access continues to flow through the service-role admin client because portal sessions are not auth.uid()-backed. No DELETE policy: the product is soft-archive only.';

comment on table public.client_portal_message_replies is
  'Client replies to a specific client_portal_messages row. Portal-side writes are scoped by getCurrentPortalSession() + parent-message (studio_id, client_id, message_id) match in the server action; practitioner-side reads / mark-seen are scoped by getCurrentPractitionerWithStudio() + (studio_id, client_id) in the server action. RLS is enabled. PR #130 / migration 0055 adds explicit SELECT + UPDATE policies for authenticated practitioners using public.is_studio_member(studio_id) as a database backstop; portal-side access continues to flow through the service-role admin client. No INSERT policy: practitioner-authored replies are a future PR (created_by CHECK still restricts to ''client''). No DELETE policy: soft-archive only.';
