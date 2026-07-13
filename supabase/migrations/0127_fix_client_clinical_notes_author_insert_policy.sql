-- ---------------------------------------------------------------------------
-- Migration 0127: fix the client_clinical_notes author-INSERT RLS policy so its
-- same-studio-practitioner clause is enforced at the RLS layer (defense in
-- depth), not only by the composite foreign key.
--
-- BACKGROUND. Migration 0126 shipped the author-INSERT policy with an
-- unqualified `studio_id` reference INSIDE the practitioner subquery:
--
--     exists (select 1 from public.practitioners p
--             where p.id = practitioner_id
--               and p.studio_id = studio_id            -- <-- ambiguous
--               ...)
--
-- Because `practitioners` also has a `studio_id` column, PostgreSQL resolves the
-- unqualified `studio_id` to the INNER `p.studio_id`, so the clause degrades to
-- the tautology `p.studio_id = p.studio_id` (always true). The intended
-- "practitioner belongs to the note's studio" check was therefore NOT enforced
-- by RLS. It was never exploitable — the composite FK
-- (practitioner_id, studio_id) -> practitioners(id, studio_id) independently
-- rejects a cross-studio practitioner — but the policy did not carry its share
-- of the intended two-layer guarantee.
--
-- THIS MIGRATION drops ONLY that INSERT policy and recreates it with every
-- reference fully qualified: target-table columns as
-- `client_clinical_notes.<col>` and practitioner columns as `p.<col>`. No
-- unqualified `studio_id` remains, so the same-studio comparison is explicit and
-- unambiguous. Nothing else from 0126 is touched: the table, columns,
-- constraints, indexes, triggers, functions, the member-SELECT policy, and all
-- grants/revocations are preserved. Additive + non-destructive. 0126 is already
-- applied to production and is NOT edited. No backfill; no data change.
-- ---------------------------------------------------------------------------

drop policy if exists "client_clinical_notes_author_insert" on public.client_clinical_notes;

create policy "client_clinical_notes_author_insert"
  on public.client_clinical_notes for insert to authenticated
  with check (
    -- Caller is a member of the NOTE's studio (fully qualified — never the
    -- practitioner subquery's studio_id).
    public.is_studio_member(client_clinical_notes.studio_id)
    and exists (
      select 1 from public.practitioners p
      where p.id = client_clinical_notes.practitioner_id
        -- The authoring practitioner must belong to the SAME studio as the note
        -- (this is the clause 0126 accidentally turned into a tautology).
        and p.studio_id = client_clinical_notes.studio_id
        -- ...and must be the signed-in caller, and active.
        and p.user_id = (select auth.uid())
        and p.active
    )
  );
