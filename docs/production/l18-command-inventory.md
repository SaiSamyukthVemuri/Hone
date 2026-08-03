# L18 — clinical direct-DML writer inventory (final-state record)

**Purpose.** L18 recorded that `authenticated` holds direct row DML on the clinical tables. Closing
it means moving every *legitimate runtime writer* onto narrow reviewed database commands, deploying
those commands, and only then revoking the grants. This document is the final-state record of that
work.

**Status: writers are ZERO on every table. The revocation — migration `0169` — is prepared but
NOT APPLIED. L18 stays OPEN until it is applied and merged.**

---

## Original finding vs verified baseline

The findings register said **26** application call sites. The verified number was **25**, counted by
parsing each `.from("<table>")` occurrence and walking forward to the end of its own statement chain
(tracking bracket depth, terminating at the first top-level `;`), so every site is attributed to the
table it actually writes and reads are never miscounted as writes.

The count is method-sensitive, which is almost certainly the source of the discrepancy: a proximity
grep returns **25** at a 6-line window and **27** at a 12-line window, because a wider window
captures operations belonging to a *later, different* `.from()` chain in the same function.
**25 is the statement-accurate count.**

That findings register is the immutable original audit artifact and is **not** edited. This document
is where the corrected count and the closure history live.

**Excluded from the count** (not runtime application writers): `supabase/migrations/**`, `tests/**`,
`e2e/**`, `scripts/verify-production.mjs`, and service-role maintenance paths.

---

## Writer families — all now zero

| Table | Original direct writers | Now | Command boundary |
|---|---|---|---|
| `sessions` | 10 | **0** | `0167` |
| `session_blocks` | 7 | **0** | `0166` |
| `electrolysis_entries` | 4 | **0** | `0166` |
| `treatment_images` | 3 | **0** | `0168` |
| `laser_entries` | 1 | **0** | `0164` (+ `0165` privilege repair) |
| `session_block_areas` | 0 | **0** | already behind `0128`/`0129` |
| **Total** | **25** | **0** | |

No `.delete()` or `.upsert()` ever existed against these tables in runtime code — every removal is a
soft delete performed as an `UPDATE`, and that is still true through the commands.

The writer guard (`tests/security/entry-direct-dml-guard.test.ts`) measures all six tables, prints
the census, and carries **no exception list**.

---

## Command-bound migrations (all APPLIED and FROZEN)

| Migration | Scope | Commands |
|---|---|---|
| `0164` / `0165` | laser entry creation | `create_laser_entry` |
| `0166` | session blocks + electrolysis entries | `create_block_with_entry`, `update_block_with_entry`, `add_electrolysis_pass`, `soft_delete_session_block` |
| `0167` | sessions | `start_session`, `set_session_price`, `set_next_session_note`, `set_session_performer`, `edit_session_started_at`, `soft_delete_session`, `set_session_treatment_plan`, `set_session_aftercare_explained` |
| `0168` | treatment images | `create_treatment_image_metadata`, `set_treatment_image_note`, `archive_treatment_image` |

**16 public commands.** Every one is `SECURITY DEFINER` with `search_path=""`, executable by
`authenticated` only (`anon` and `service_role` denied), with internal helpers denied to every client
role. Each derives the studio and the acting practitioner from `auth.uid()` — none accepts a studio
id, actor id, uploader or `deleted_by` from the caller.

All four command migrations were deliberately **additive**: they revoked nothing, so the deployed
application kept working before, during and after each apply.

Two real defects were closed along the way, not merely relocated: the duplicate-session race in
`startSessionAction` (the coalesce lookup is now `FOR UPDATE` in the insert's transaction) and the
loseable `session_audit` row in `editSessionStartedAtAction` (both writes are now one transaction).

---

## Migration `0169` — the revocation (PREPARED, NOT APPLIED)

Revokes `INSERT`, `UPDATE`, `DELETE` from `authenticated` on exactly six tables: `sessions`,
`session_blocks`, `session_block_areas`, `electrolysis_entries`, `laser_entries`, `treatment_images`.

- **`authenticated` SELECT is RETAINED** on every table — reads, listings and signed-URL lookups are
  unaffected. No SELECT revocation, and no `REVOKE ALL`.
- **`service_role` and `anon` are unchanged.** PUBLIC holds no grant on any of these tables
  (measured: 0) and is not mutated.
- **No function EXECUTE, policy, trigger, constraint, column, index, ownership, storage permission or
  data change.** There is not a single `GRANT` statement in the file.
- **`session_block_areas` is a deliberate no-op.** Measured in production before writing: it already
  has no `authenticated` write grant, only SELECT. It is listed so the posture is explicit for all
  six tables in one auditable place, and so a future grant would have to actively contradict it.
- `TRUNCATE` was already denied to `authenticated` and `anon` on all six (0159 §5b) and is untouched.

Reversal, if ever needed, is a **new** migration re-granting the privileges — `0169` is frozen once
applied.

---

## What the revocation does NOT change

- **Retired finalization** and the **immutable legacy artifact** remain enforced by their triggers.
  No command accepts or writes `record_status`.
- **Current records remain fully editable through the commands** — proven against a chain that
  includes `0169`.
- **The image upload is still not atomic.** Storage and Postgres are separate planes and cannot share
  a transaction. The application's compensating cleanup — remove the uploaded object when metadata
  creation fails, and raise a **CRITICAL** orphaned-object alert if that removal also fails —
  remains **required**, and must not be deleted on the grounds that the metadata write is now a
  command.

---

## Verification honesty

**Production behavioural write-probing was never performed.** The `db query` classifier blocks
INSERT/UPDATE-bearing SQL, so every command is **source- and privilege-verified in production and
never behaviourally exercised there**. Behaviour is proven on a fresh local stack and in the browser
lane only. Real practitioner traffic is the first production exercise of these paths.

---

## Remaining to close L18

1. Apply migration `0169` to production.
2. Merge its PR and confirm the deployment.

Until both are done, **L18 remains OPEN**: the commands are in place and no application code writes
directly, but the *capability* to do so is still granted to `authenticated`.
