-- 0117_session_audit_cross_tenant_insert_hardening.sql
--
-- Close a confirmed CROSS-TENANT integrity-write on session_audit.
--
-- Defect (final state through 0116): the INSERT policy
-- `session_audit_studio_member_insert` (0008) only checks that
-- `edited_by_practitioner_id` belongs to the caller — it does NOT constrain
-- `session_id`. session_audit has no `studio_id` column and no composite FK, so
-- an authenticated Studio A practitioner who knows a Studio B session UUID can
-- INSERT a fabricated audit event onto Studio B's session history (a
-- cross-tenant integrity write; not a confidentiality leak — the SELECT policy
-- still hides Studio B rows from Studio A).
--
-- Fix (minimal, fully closes the cross-tenant path; Option A): tighten the
-- INSERT WITH CHECK so the target `session_id` must belong to a studio the
-- caller is an active member of — mirroring the existing SELECT policy's
-- session scoping — while keeping the existing actor binding. After this, a new
-- audit row is insertable ONLY for a session the caller can already see, and
-- ONLY attributed to one of the caller's own active practitioners.
--
-- SAFE / SCOPE:
--   * Policy-only; the INSERT policy is REPLACED with a stricter check. No
--     SELECT / UPDATE / DELETE policy change (UPDATE/DELETE stay RLS
--     default-deny → audit rows remain immutable). No grant change.
--   * NO schema change, NO data change, NO backfill; existing historical rows
--     are untouched (WITH CHECK applies only to NEW inserts). A read-only audit
--     found 0 cross-studio-mismatched historical rows.
--   * HARDENS RLS (adds a constraint); does not weaken it.
--   * NO code change required: the only app writer
--     (editSessionStartedAtAction) already sets edited_by = the caller's own
--     practitioner and session_id = a same-studio session, so it satisfies the
--     stricter check. Migration-first is safe (deployed code keeps working).
--
-- Migration max 0116 -> 0117.

drop policy if exists "session_audit_studio_member_insert" on public.session_audit;

create policy "session_audit_studio_member_insert"
  on public.session_audit for insert
  with check (
    -- Actor must be one of the CALLER'S OWN active practitioners (unchanged;
    -- prevents attributing an event to a foreign/other practitioner).
    edited_by_practitioner_id in (
      select id from public.practitioners
      where user_id = auth.uid() and active = true
    )
    -- NEW: the target session must belong to a studio the caller is an active
    -- member of (same scoping as the SELECT policy). This is what closes the
    -- cross-tenant write — a Studio A caller cannot pass a Studio B session_id.
    and session_id in (
      select s.id
      from public.sessions s
      join public.clients c on s.client_id = c.id
      where c.studio_id in (
        select studio_id from public.practitioners
        where user_id = auth.uid() and active = true
      )
    )
  );
