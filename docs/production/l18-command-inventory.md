# L18 — clinical direct-DML writer inventory

**Purpose.** L18 records that `authenticated` holds direct row DML on five clinical tables. Closing
it means moving every *legitimate runtime writer* onto narrow reviewed database commands, deploying
those commands, and only then revoking the grants. This document is the writer inventory that work
is planned from.

**Baseline:** production branch `722bd617c6ca1fd17c34b9378b44aad2570e24e8` · hosted migration max
`0163` · next migration `0164`.

**Status: PHASE 1A DELIVERED (migration `0164`, NOT APPLIED).** The two cleanly separable
entry-only writers now call narrow reviewed commands. The two block-coupled writers are
deliberately unchanged — see [Hard stop](#hard-stop--unresolved-cross-table-transaction-dependency),
which remains the reason they are deferred.

**L18 status: PARTIAL — the two clean entry-only creation paths now use narrow commands. Two electrolysis entry writers remain temporarily direct because they are coupled to `session_blocks` and must move atomically in the combined block/entry phase. Direct table grants remain in place.**

---

## Corrected call-site count

The findings register says **26** application call sites. The verified number at this baseline is
**25**.

| Table | Runtime write sites |
|---|---|
| `sessions` | 10 |
| `session_blocks` | 7 |
| `electrolysis_entries` | 4 |
| `laser_entries` | 1 |
| `treatment_images` | 3 |
| **Total** | **25** |

**Why the number differs.** The count is method-sensitive, which is almost certainly the source of
the discrepancy. A proximity grep (“an `.insert(`/`.update(`/`.delete(` within *N* lines of a
`.from("<table>")`”) returns **25** at a 6-line window and **27** at a 12-line window, because a
wider window captures operations belonging to a *later, different* `.from()` chain in the same
function. The figure above was produced by parsing each `.from("<table>")` occurrence and walking
forward to the end of its own statement chain (tracking bracket depth, terminating at the first
top-level `;`), so each site is attributed to the table it actually writes. **25 is the
statement-accurate count.** No `.delete()` or `.upsert()` call exists against any of the five
tables in runtime code — every removal is a soft delete performed as an `UPDATE`.

**Excluded from the count** (not runtime application writers): `supabase/migrations/**`,
`tests/**`, `e2e/**` (including seeds and fixtures), `scripts/verify-production.mjs`, and
service-role maintenance paths. None of these is a browser-role writer and none blocks L18.

---

## Phase 1 scope — `electrolysis_entries` and `laser_entries`

Five write sites across four server actions. **All four are server-action modules** — neither file
carries `"use client"`, and no browser or client component writes any of the five tables directly.
**All four use the RLS-scoped `createClient()`**; none uses `createAdminClient()`.

### 1. `addElectrolysisEntryAction` — **cleanly separable**

| Field | Value |
|---|---|
| File / function | `app/(app)/clients/[id]/sessions/[sessionId]/actions.ts:213` (write at `:334`) |
| Table / operation | `electrolysis_entries` / INSERT |
| User-visible command | “Add another pass” — append an electrolysis entry to an existing block |
| Client type | RLS-scoped `createClient()` |
| Authorization | `getCurrentPractitionerWithStudio()` then `assertSessionVisible(studio.id, clientId, sessionId)` — any active practitioner of the studio; no owner gate |
| Lineage | `studio` server-derived from the authenticated practitioner; `session_id`/`client_id` validated by `assertSessionVisible`; `probe_lot_id` validated to belong to this studio by `validateProbeLotId` |
| Validation / defaulting | Strict `formData` parsing (a malformed/non-array payload throws before any write); pulse clamping; structured reading columns by modality; retired `galvanic_intensity_percent` forced NULL server-side |
| Audit / events | None on this path (`session_audit` is written elsewhere in the file, at `:756`) |
| Multi-table transaction | **None** — `electrolysis_entries` only (one INSERT plus a re-read) |
| Replacement | **`create_electrolysis_entry(...)`** — SECURITY DEFINER, `search_path = ''`, explicit typed params (migration `0164`) |
| Phase | **MOVED in 0164** |

### 2. `addLaserEntryAction` — **cleanly separable**

| Field | Value |
|---|---|
| File / function | `app/(app)/clients/[id]/sessions/[sessionId]/actions.ts:416` (write at `:443`) |
| Table / operation | `laser_entries` / INSERT |
| User-visible command | Record a laser treatment entry on a session |
| Client type | RLS-scoped `createClient()` |
| Authorization | Same studio-member pattern as (1) |
| Lineage | `studio` server-derived; session verified before the write |
| Validation / defaulting | Laser-specific reading validation |
| Audit / events | None on this path |
| Multi-table transaction | **None** — `laser_entries` only (single INSERT) |
| Replacement | **`create_laser_entry(...)`** — SECURITY DEFINER, `search_path = ''` (migration `0164`) |
| Phase | **MOVED in 0164** |

### 3. `createTreatmentAreaWithEntryAction` — **ENTANGLED, blocks Phase 1**

| Field | Value |
|---|---|
| File / function | `app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts:917` (entry write at `:1082`) |
| Tables / operations | `session_blocks` ×4 (INSERT or the 0129 atomic RPC, a re-read, and a **compensating soft-delete UPDATE**) **+** `electrolysis_entries` ×1 (INSERT) |
| User-visible command | “Add a treatment area” — create a settings block and its first entry in one action |
| Client type | RLS-scoped `createClient()` |
| Authorization | Studio-member; areas path goes through `create_session_block_with_areas` (0129), which re-checks `is_studio_member` inside the RPC |
| Multi-table transaction | **YES — and it is not atomic today.** The block is created first (atomically with its area set when areas are present, via 0129), then the entry is inserted. **If the entry INSERT fails, the action issues a compensating `UPDATE session_blocks SET deleted_at = now()`** to retire the just-created block so its minutes cannot pollute total-treatment-time. |
| Replacement | Cannot be an entry-only command — see the hard stop |
| Phase | **DEFERRED to the combined block/entry phase.** Labelled `TEMPORARY L18 BLOCK-ENTRY ATOMICITY EXCEPTION` in source and pinned by `tests/security/entry-direct-dml-guard.test.ts` |

### 4. `updateTreatmentAreaWithEntryAction` — **ENTANGLED, blocks Phase 1**

| Field | Value |
|---|---|
| File / function | `app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts:1182` (entry writes at `:1389` UPDATE, `:1403` INSERT) |
| Tables / operations | `session_blocks` ×3 + `rpc(update_session_block_with_areas)` **+** `electrolysis_entries` ×2 (UPDATE the first entry, or INSERT one if the block had none) |
| User-visible command | Edit a treatment area’s settings and its primary entry together |
| Client type | RLS-scoped `createClient()` |
| Authorization | Studio-member; areas path uses the 0129 update RPC, which carries optimistic concurrency (`stale_block_version`) |
| Multi-table transaction | **YES — and it has no compensation at all.** The block update commits first; if the subsequent entry UPDATE/INSERT fails, the block edit is already durable and the entry is not, leaving block and entry describing different treatments. |
| Replacement | Cannot be an entry-only command — see the hard stop |
| Phase | **DEFERRED to the combined block/entry phase.** Labelled `TEMPORARY L18 BLOCK-ENTRY ATOMICITY EXCEPTION` in source and pinned by `tests/security/entry-direct-dml-guard.test.ts` |

---

## Hard stop — unresolved cross-table transaction dependency

**Two of the four `electrolysis_entries` writers cannot be moved to an entries-only command.**

`createTreatmentAreaWithEntryAction` and `updateTreatmentAreaWithEntryAction` each write
`session_blocks` **and** `electrolysis_entries` as one user-visible command. Moving only the entry
half to an RPC leaves the pair split across two independent transactions — a browser-role block
write followed by an RPC entry write — which is the same non-atomicity that exists today, and in
the update case there is not even a compensating write.

That collides directly with the Phase 1 requirement that every command **“perform related writes
atomically in the same transaction.”** There are only two ways to satisfy it, and both are outside
this phase as scoped:

1. **Give the entry command ownership of the block write** — i.e. a `create/update block + entry`
   command. That writes `session_blocks`, which this phase excludes, and it changes block/session
   command semantics (the 0129 RPCs would be superseded or nested).
2. **Move `session_blocks` in the same phase** — explicitly ruled out (“Do NOT attempt all five
   tables in one PR”), and it would roughly double the diff.

Proceeding with an entries-only Phase 1 would mean either silently accepting non-atomic block+entry
writes, or silently redesigning around the dependency. Both were forbidden, so implementation is
halted here for a decision.

### Options

| Option | What ships | Trade-off |
|---|---|---|
| **A — split Phase 1** | Commands for the two cleanly separable writers only: `addElectrolysisEntryAction` (`electrolysis_entries` INSERT) and `addLaserEntryAction` (`laser_entries` INSERT). The two entangled actions keep direct DML and move in the block phase. | Smallest, safest, fully satisfies every stated constraint including atomicity. **Does not** let the entry-table grants be revoked yet — 2 of 4 electrolysis writers remain direct. The static drift guard would need a documented, closed exception for exactly those two call sites. |
| **B — merge with the block phase** | One phase covering `session_blocks` + `electrolysis_entries` + `laser_entries`, with block+entry as a single atomic command. | The only route to genuinely atomic block+entry writes and to revoking the entry grants. Larger than “one focused PR” as scoped, and supersedes the 0129 RPCs. |
| **C — accept current semantics explicitly** | Entries-only commands for all four writers; block+entry stays non-atomic exactly as today, compensating soft-delete preserved. | Moves all five Phase-1 sites, but knowingly ships commands that do not meet the atomicity requirement, and the update path keeps its no-compensation gap. Requires an explicit written waiver of that requirement. |

**Option A was chosen and delivered as migration `0164` (Phase 1A).** It is the only option that
satisfies every constraint as written, ships real value now, and leaves the atomicity problem to
the phase that can actually solve it. The two entangled actions are a `session_blocks` problem
wearing an `electrolysis_entries` hat.

**Neither entry table is command-boundary complete.** `electrolysis_entries` still has two direct
writers; `laser_entries` has none left, but its grant is unchanged and it will only be revoked
with the rest. **L18 is not closed.**

---

## Later phases — remaining tables (recorded, not implemented)

| Table | Sites | Notable |
|---|---|---|
| `sessions` | 10 | `sessions/[sessionId]/actions.ts` ×5, `sessions/new/actions.ts` ×2 (one INSERT), `treatment-plans-actions.ts` ×2, `records/actions.ts` ×1 |
| `session_blocks` | 7 | `actions.ts` ×1 INSERT, `block-actions.ts` ×6; two of these are the compensating/paired writes above |
| `treatment_images` | 3 | `images/actions.ts` — 1 INSERT, 2 UPDATE (archive is a soft delete); note the 0093 storage trust boundary already routes object access through service role |

**L18 remains OPEN.** Nothing in this document revokes a privilege or drops a policy.
