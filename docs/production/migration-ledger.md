# Hone — Migration Ledger

**Canonical migration ledger.** Regenerate the "applied" column from
`supabase migration list --linked`; regenerate the max from
`ls supabase/migrations/ | tail -1`. Verify filenames directly against
`supabase/migrations` — never reconstruct a migration number or purpose from memory.

Related: [current-state.md](./current-state.md) ·
[capability-register.md](./capability-register.md) ·
[known-limitations.md](./known-limitations.md) ·
[release-changelog.md](./release-changelog.md) ·
[../runbooks/migration-first-process.md](../runbooks/migration-first-process.md) ·
per-rollout closeouts: [0155](../runbooks/0155-probe-inventory-linkage-rollout.md) ·
[0156](../runbooks/0156-conditional-numbing-notes-rollout.md) ·
[0157](../runbooks/0157-whole-session-copy-rollout.md)

## Current state (verified 2026-08-03, post-0168 apply)

| Field | Value |
|---|---|
| **Hosted (production) migration max** | **0168** (`0168_treatment_image_write_commands.sql`, applied 2026-08-03T17:23:06Z→17:23:14Z) |
| **Repo migration max** | **0168** — **hosted == repo.** Next free number is **0169**. |
| **Total migrations in repo** | **167** (`0001` … `0157`, `0159` … `0168` — **no `0158`**) |
| **Total applied in production** | **167**, each applied **exactly once**. Applied count moved 166 → 167. |
| **`0168` checksum (frozen)** | `8408af03df458391e75820c0a78ffa04628965b3cf1ae65af3897f1e390adac9` |
| **Authorized head** | `c8c99caf95890a68eefc6302cfe00e1c39cbe213` (PR #506), CI run `30835292509` SUCCESS |

### 0168 — L18 Phase 4: the `treatment_images` write-command boundary

**Class: additive function/RPC.** Three `authenticated`-only commands
(`create_treatment_image_metadata`, `set_treatment_image_note`,
`archive_treatment_image`) plus one fully-revoked internal helper
(`treatment_image_actor`). **No table, column, constraint, index, policy or
trigger change; no data change; no privilege revoked.** Applied
**migration-first**, ahead of the PR #506 code merge.

**This completes the L18 application-writer programme.** With Phases 1A–4
applied, EVERY L18 table has zero direct runtime writers:
`sessions` 0 · `session_blocks` 0 · `session_block_areas` 0 ·
`electrolysis_entries` 0 · `laser_entries` 0 · `treatment_images` 0.

**Post-apply verification (production, read-only):**

| Check | Result |
|---|---|
| Hosted max | `0167` → **`0168`** |
| Applied count | 166 → **167** |
| `treatment_images` rows | **3 → 3** (2 live, unchanged) |
| `sessions` / `session_blocks` / `electrolysis_entries` | **83 / 61 / 45**, all unchanged |
| Functions present before | **0 of 4** |
| Effective EXECUTE | 3 commands `authenticated` only; `anon` ✗, `service_role` ✗ and **0 PUBLIC grants** on all 4; the helper denied to every client role |
| `SECURITY DEFINER` + `search_path=""` | **4 of 4** |
| Any command can reach storage | **0** |
| Any command issues a hard DELETE | **0** |
| Any command consults `current_user` | **0** |
| Actor derived from `auth.uid()` | confirmed |
| Fixed `treatment-images` bucket validated | confirmed |
| Studio/client/image-bound path validated | confirmed |
| Session/block/client consistency validated | confirmed |
| Note length + archived-row protection | confirmed |
| `deleted_at` / `deleted_by` derived | confirmed |
| `treatment_images` triggers | **3 of 3 intact** |
| Direct `authenticated` INSERT on `treatment_images` | **still granted** — nothing revoked |

⚠️ **Behavioural write-probing was NOT performed.** The `db query` classifier blocks
INSERT/UPDATE-bearing SQL, so these commands are **source- and privilege-verified in
production, never behaviourally exercised there.** Behaviour is proven on a fresh
local stack (28 DB cases) and in the extended browser lane.

⚠️ **Storage and Postgres are still NOT one transaction.** The upload writes a
storage object through the service-role client and then records metadata through
this command. The application's compensating cleanup — remove the object on
metadata failure, CRITICAL alert if that removal also fails — remains load-bearing
and must not be removed on the grounds that the metadata write is now a command.

**L18 REMAINS OPEN.** Direct authenticated table DML is **not** revoked by this
migration. The final L18 revocation is a separate migration, now unblocked because
every application writer is gone.

---

## Previous state (verified 2026-08-03, post-0167 apply)

| Field | Value |
|---|---|
| **Hosted (production) migration max** | **0167** (`0167_session_write_commands.sql`, applied 2026-08-03T16:04:38Z→16:04:40Z) |
| **Repo migration max** | **0167** — **hosted == repo.** Next free number is **0168**. |
| **Total migrations in repo** | **166** (`0001` … `0157`, `0159` … `0167` — **no `0158`**) |
| **Total applied in production** | **166**, each applied **exactly once**. Applied count moved 165 → 166. |
| **`0167` checksum (frozen)** | `507034dd01987308f976a3097da5fabd902165ea66a699e0b9550d67d5619b2e` |
| **Authorized head** | `aee9dd94fc0835f24bcd0fb45b965fea82bff299` (PR #505), CI run `30828905065` SUCCESS |

### 0167 — L18 Phase 3: the `sessions` write-command boundary

**Class: additive function/RPC.** Eight `authenticated`-only commands
(`start_session`, `set_session_price`, `set_next_session_note`, `set_session_performer`,
`edit_session_started_at`, `soft_delete_session`, `set_session_treatment_plan`,
`set_session_aftercare_explained`) plus two fully-revoked internal helpers. **No table,
column, constraint, index, policy or trigger change; no data change; no privilege
revoked.** Applied **migration-first**, ahead of the PR #505 code merge.

**Post-apply verification (production, read-only):**

| Check | Result |
|---|---|
| Hosted max | `0166` → **`0167`** |
| Applied count | 165 → **166** |
| `sessions` rows | **83 → 83** (unchanged) |
| `session_audit` rows | **12 → 12** (unchanged) |
| `treatment_plans` rows | **10 → 10** (unchanged) |
| `appointments` rows | **124 → 124** (unchanged) |
| Functions present before | **0 of 10** |
| Effective EXECUTE | 8 commands `authenticated` only; `anon` ✗ and `service_role` ✗ on **all 10**; both helpers denied to all three roles |
| `SECURITY DEFINER` + `search_path=""` | **10 of 10** |
| `start_session` closes the duplicate race | `for update` present in deployed `prosrc` |
| `edit_session_started_at` writes its audit row atomically | `insert into public.session_audit` present |
| `soft_delete_session` derives the actor | `deleted_by` + `auth.uid()` present |
| Any command writes `record_status` | **0** |
| Any command accepts `p_studio_id` | **0** |
| `sessions` triggers | **4 of 4 intact** |
| Direct `authenticated` UPDATE on `sessions` | **still granted** — nothing revoked |

⚠️ **Behavioural write-probing was NOT performed.** The `db query` classifier blocks
INSERT/UPDATE-bearing SQL, so these commands are **source- and privilege-verified in
production, never behaviourally exercised there.** Behaviour is proven on a fresh local
stack (34 DB cases) and in the targeted browser lane, not against production data.

**L18 REMAINS OPEN.** `treatment_images` still has **3** direct writers, and direct
authenticated DML on `sessions` is **not** revoked. Revocation is a separate final
migration once treatment_images also reaches zero.

---

## Previous state (verified 2026-08-03, post-0166 apply)

| Field | Value |
|---|---|
| **Hosted (production) migration max** | **0166** (`0166_session_block_electrolysis_commands.sql`, applied 2026-08-03T12:40:31Z→12:40:42Z) |
| **Repo migration max** | **0166** — **hosted == repo.** Next free number is **0167**. |
| **Total migrations in repo** | **165** (`0001` … `0157`, `0159` … `0166` — **no `0158`**) |
| **Total applied in production** | **165**, each applied **exactly once**. Applied count moved 164 → 165. |
| **`0166` checksum (frozen)** | `8bd0779661819444a083485df4fe69ea9d5ec5a6b976faadcbc9f4b9d9815b43` |
| **Authorized head** | `669cc3646e7f95aaf02af1688bacb8ba467a801d` (PR #503), CI run `30777890502` SUCCESS |

### 0166 — L18 Phase 2: session_blocks + electrolysis_entries command boundary

**Class: additive function/RPC.** Four `authenticated`-only commands
(`create_block_with_entry`, `update_block_with_entry`, `add_electrolysis_pass`,
`soft_delete_session_block`) plus four fully-revoked internal helpers. **No table, column,
constraint, index, policy or trigger change; no data change; no privilege revoked.** The
deployed application kept writing directly and worked unchanged throughout — this apply is
**migration-first**, ahead of the PR #503 code merge.

**Post-apply verification (production, read-only):**

| Check | Result |
|---|---|
| Hosted max | `0165` → **`0166`** |
| Applied count | 164 → **165** |
| `session_blocks` rows | **61 → 61** (unchanged) |
| `electrolysis_entries` rows | **45 → 45** (unchanged) |
| `session_block_areas` rows | **27 → 27** (unchanged) |
| Functions present before | **0 of 8** |
| Effective EXECUTE | 4 commands `authenticated` only; `anon` ✗ and `service_role` ✗ on **all 8**; 4 helpers denied to all three roles |
| `SECURITY DEFINER` + `search_path=""` | **8 of 8** |
| Seven-key allow-list incl. `probe_inventory_item_id` | present in deployed `prosrc` |
| `p_areas` NULL preserves the area set | present in deployed `prosrc` |
| Entry UPDATE omits `probe_type` | confirmed |
| Dead `p_probe_inventory_item_id` parameter | **absent from all signatures** |

⚠️ **Behavioural write-probing was NOT performed.** The `db query` classifier blocks
INSERT/UPDATE-bearing SQL, so the commands are **source- and privilege-verified in production,
never behaviourally exercised there.** Their behaviour is proven on a fresh local stack
(41 DB cases) and in the browser lane, not against production data.

**L18 REMAINS OPEN.** Direct authenticated table DML is not revoked by this migration.
`sessions` (10 direct writers) and `treatment_images` (3) are untouched.

---

## Previous state (verified 2026-08-02, post-0165 apply)

| Field | Value |
|---|---|
| **Hosted (production) migration max** | **0165** (`0165_revoke_service_role_laser_entry_execute.sql`, applied 2026-08-02T20:20:02Z→20:20:06Z) |
| **Repo migration max** | **0165** — **hosted == repo.** Parity restored by the 2026-08-02T20:20Z apply. Next free number is **0166**. |
| **Total migrations in repo** | **164** (`0001` … `0157`, `0159` … `0165` — **no `0158`**) |
| **Total applied in production** | **164**, each applied **exactly once** (0 duplicate versions, no repaired or reverted entry). Every file on disk is applied. |
| **`0158`** | **Deliberately skipped, permanently.** DRAFT PR #481 carries a *different*, superseded migration under that number on a branch retained as audit evidence; two artifacts must never share a number. `0158` will never be applied. |
| **`0160`** | **APPLIED 2026-07-30**, exactly once. Immutable clinical lineage. Its source merge (PR #483) completed on 2026-07-30 (merge `c64366c9ba4130283932bbe21e32bf2ed62c4975`) and deployed successfully. |
| **Immediately preceding `0160`** | `0159` (which is itself immediately preceded by `0157`) |
| **Reconciliation** | `supabase migration list --linked` shows Local and Remote matching at **every** version, including `0162` — there is no longer any pending row. `0159`/`0160` Remote populated 2026-07-30. **`0161` was APPLIED 2026-07-30 and is present in Remote exactly once (sha256 `e2a3e4a770c79799042b542d9f2fcbdc13d2a9f1e30774221c1777ccbae33a46`).** **`0162` was APPLIED 2026-08-02 and is present in Remote exactly once (sha256 `41ccc745536806a417614b92202634811f0ae9e854f584f26badbf6ec01c1088`).** |

**Every migration `0001`–`0157` plus `0159`–`0165` is applied in production.** The recent tail was applied
**migration-first** — the migration applied to production and verified *before* the code
merge — with two deliberate exceptions noted below.

### Apply-order discipline

- **Migration-first (default).** Apply and verify against production, then merge the code.
  Required whenever the new application code reads or writes the new object.
- **Code-first (destructive only).** Used when a migration destructively drops a column the
  deployed code still writes. **0116** is the one code-first apply in the recent tail — it
  dropped the raw `practitioners.calendar_feed_token` after PR #395's hash-only code was
  already live.
- **App-first batch.** The `0134`→`0151` capacity/onboarding window was applied in one push
  *after* the final application commit was live, because every new flag defaulted OFF and the
  code was written to be safe pre-migration.

### Migration classes used in this ledger

- **Migration-first** — applied before its code merged.
- **Code-only PR** — a PR that ships behaviour with *no* migration (the hosted max does not move).
- **Dormant migration** — applied and merged, but nothing in production reads or writes it
  because a flag is off, no worker exists, or no tenant is eligible.

### 0165 — APPLIED 2026-08-02

**`0165_revoke_service_role_laser_entry_execute.sql` — revoke the unintended `service_role`
EXECUTE that `0164` left on `create_laser_entry`.**

| Field | Value |
|---|---|
| **Migration** | `0165_revoke_service_role_laser_entry_execute.sql` |
| **Status** | ✅ **APPLIED 2026-08-02T20:20:02Z → 20:20:06Z** at authorized head `2fe88d6e176b13b3620921280e75182e6cdedae2` (CI run `30764322410`, success at that exact sha). Hosted max `0164`→**`0165`**; applied 163→164; repo == hosted. No error, no notices. |
| **Frozen checksum** | `sha256 b3a150bd1d6478b7eaafe42f0ec599bcae123bacb8bc7106085196f921492193`. **FROZEN — never edit.** |
| **Post-apply verification** | ACL `{postgres=X/postgres,authenticated=X/postgres}` — was `{postgres,authenticated,service_role}`. `service_role` EXECUTE **true → false**; `authenticated` **true**; `anon` **false**; PUBLIC **0 ACL entries**. Function UNCHANGED: `pg_get_functiondef` md5 **`b25acad06fda86adb9a85e334ca0570d`** identical before and after, `prosecdef=true`, `proconfig=search_path=""`, owner `postgres` — REVOKE does not touch the definition. Direct table DML unchanged: `laser_entries` INSERT **true**, `electrolysis_entries` INSERT **true**. ZERO clinical rows changed across the apply (laser 2, electrolysis 44, sessions 82 before and after). |
| **Class** | One `REVOKE` on one exact function signature. **No** function recreation, body change, schema, policy, trigger or data change; **no** table-privilege change; **no** `ALTER DEFAULT PRIVILEGES` change. |
| **Defect** | `0164` intended EXECUTE for `authenticated` only and said so in its header. Supabase's `ALTER DEFAULT PRIVILEGES` grants EXECUTE to `anon`, `authenticated` AND `service_role` at create time; `0164` revoked only `public` and `anon`. Deployed ACL after the apply: `{postgres=X, authenticated=X, service_role=X}`. |
| **Precedent** | Identical class to `0129` (revoked only `from public`, leaving `anon`) which `0130` repaired. `0164` quoted that lesson and reproduced it one role over. |
| **Exposure** | **None found.** `create_laser_entry`'s first statement requires a non-null `auth.uid()`; a `service_role` caller has no JWT so it raises `check_violation` before touching a row. A least-privilege deviation and a false source comment, not a reachable path. |
| **Preserved** | `authenticated` EXECUTE; `anon`/PUBLIC already none; `postgres` ownership; the function body, `prosecdef` and `search_path` (no `create or replace`); all direct table DML. |
| **Prevention** | `tests/security/clinical-rpc-grant-guard.test.ts` now requires every authenticated-only clinical RPC to revoke from `public`, `anon` AND `service_role` explicitly, searching all migrations so a later repair counts. `returns trigger` functions are excluded — they are not directly callable (`0A000`), so EXECUTE on them is inert. |
| **Transaction + locks** | Own `begin; … commit;` with `set local lock_timeout = '5s'`, per the 0159–0164 precedent. |
| **Editable?** | **NO — FROZEN as of the 2026-08-02 apply.** `0159`–`0165` are applied and must never be edited. |
| **Proof** | `tests/migrations/0165-revoke-service-role-laser-entry-execute.test.ts` (19 source-contract cases + the repo migration-max tripwire, moved here from the 0164 test) and `tests/db/entry-create-commands.db.test.ts` (23 cases; asserts the full post-0165 ACL is exactly `{authenticated, postgres}` with `service_role` **false** and `postgres` still owner). |

### 0164 — APPLIED 2026-08-02

**`0164_clean_entry_create_commands.sql` — L18 Phase 1A: a narrow reviewed create command for the
ONE genuinely entry-only writer (`addLaserEntryAction`).**

| Field | Value |
|---|---|
| **Migration** | `0164_clean_entry_create_commands.sql` |
| **Status** | ✅ **APPLIED 2026-08-02T19:39:45Z → 19:39:49Z** at authorized head `eca934b5cc9e1fa8a5149d87f8e04793d6975d12` (CI run `30762245378`, success at that exact sha). Hosted max `0163`→**`0164`**; applied 162→163. No error, no notices, no 25P01/55P03. |
| **Frozen checksum** | `sha256 a1f3aa2754378ee5c171d62fa2a60b5c787801953f4a887b031db4ec439a3826`. **FROZEN — never edit.** |
| **Post-apply verification** | `create_laser_entry` present exactly once; `create_electrolysis_entry` absent (count 0); `prosecdef=true`, `proconfig=search_path=""`; `authenticated` EXECUTE **true**, `anon` **false**, PUBLIC **false** (0 PUBLIC ACL entries); direct DML on `laser_entries` and `electrolysis_entries` both **still true** — additive confirmed; ZERO clinical rows changed (electrolysis 43, laser 2, sessions 81, blocks 59; both id-hashes byte-identical across the apply). |
| ⚠️ **Defect found AFTER the apply** | **`service_role` EXECUTE was `true`, contrary to this migration's own header claim of "deliberately no service_role grant".** Supabase's `ALTER DEFAULT PRIVILEGES` grants EXECUTE to `service_role` at create time and `0164` revoked only from `public` and `anon`. Deployed ACL: `{postgres=X/postgres, authenticated=X/postgres, service_role=X/postgres}`. Same defect class as `0129`→`0130`, one role over. **No exposure found** — the command requires a non-null `auth.uid()`, so a service-role caller raises `check_violation` before touching a row. Repaired by **`0165`** (written, NOT applied). `0164` is frozen and was **not** edited. |
| **Class** | **Purely additive** — ONE SECURITY DEFINER function plus its EXECUTE grants. **No** schema, column, constraint, index, policy, trigger or grant-removal change; **no** data change, backfill or deletion. **Nothing is revoked**, so direct DML keeps working throughout this phase and the deployed application is unaffected by the apply. |
| **Finding** | `L18` — `authenticated` holds direct row DML on five clinical tables. Closing it requires moving every legitimate runtime writer onto narrow commands FIRST, deploying, and only then revoking. This is the first step. |
| **Writer census** | Phase 0 recon verified **25** runtime write sites, **not the 26** the findings register records — the register's figure came from a proximity grep; the corrected count follows each `.from()` statement chain to bracket depth zero. See [l18-command-inventory.md](./l18-command-inventory.md). |
| **What it adds** | `create_laser_entry(...)` — SECURITY DEFINER; `search_path = ''`; requires a non-null `auth.uid()`; resolves `studio_id`/`client_id` from the trusted `sessions` row; requires the caller to be an **ACTIVE practitioner of that same studio** matched by `auth.uid()`; re-checks the asserted client against the session's real client; explicit typed parameters only; no dynamic SQL; no generic JSON patch; returns only the new row id. |
| **Attribution** | The command takes no studio, practitioner or actor parameter, so a caller cannot assert another practitioner or redirect a row to another tenant. |
| **Validation** | Unchanged and un-reimplemented: every clinical value passes through verbatim, so the existing CHECK constraints and the 0119/0159 `guard_finalized_clinical_write` and 0160 `guard_immutable_clinical_lineage` triggers remain the sole authority. |
| **Privileges** | EXECUTE revoked from `PUBLIC` **and** `anon` explicitly (the 0129/0130 lesson), granted to `authenticated` only. **No service-role command** — ordinary practitioner charting must not run through an admin client, and both commands require a non-null `auth.uid()` anyway. `postgres` retains ownership. |
| **Scope — honest** | **LASER-ONLY.** PARTIAL — the clean laser-entry creation path uses a narrow command. Electrolysis entry writers remain direct because each relevant user workflow can depend on `session_blocks` and must move atomically in the combined phase. Direct table grants remain in place. **All three** electrolysis writers are block-coupled and deferred: `createTreatmentAreaWithEntryAction` and `updateTreatmentAreaWithEntryAction` write a block then an entry, and `addElectrolysisEntryAction` can create a default `session_blocks` row through `ensureBlockForSession` before creating the electrolysis entry; the two writes are not atomic today and must move together. ⚠️ **Correction:** an earlier revision of this migration wrongly classified `addElectrolysisEntryAction` as cleanly separable and created a `create_electrolysis_entry` command; both were removed. **`electrolysis_entries` is NOT command-bound. Neither entry table is command-boundary complete. L18 is NOT closed.** |
| **Drift guard** | `tests/security/entry-direct-dml-guard.test.ts` fails CI if a runtime direct writer reappears. Exactly **three** exceptions, pinned to exact file AND function, each labelled `TEMPORARY L18 BLOCK-ENTRY ATOMICITY EXCEPTION` in source; the count is asserted, so a fourth cannot be appended quietly. It also asserts that `laser_entries` has **no** direct writer left and that electrolysis direct DML is **not** claimed closed. It is not a growable allowlist. |
| **Transaction + locks** | Opens its own `begin; … commit;` with `set local lock_timeout = '5s'`, per the 0159–0163 precedent. |
| **Editable?** | **NO — FROZEN as of the 2026-08-02 apply.** `0159`–`0164` are applied and must never be edited. |
| **Proof** | `tests/db/entry-create-commands.db.test.ts` (22 cases on a fresh pinned reset) and `tests/migrations/0164-clean-entry-create-commands.test.ts` (source contract + the repo migration-max tripwire, moved here from the 0163 test), plus `tests/app/sessions/entry-actions-use-commands.test.ts`. |

### 0163 — APPLIED 2026-08-02

**`0163_revoke_authenticated_intake_insert.sql` — remove the `authenticated` INSERT capability on
`client_intake_forms`, closing the residual 0162 could not reach.**

| Field | Value |
|---|---|
| **Migration** | `0163_revoke_authenticated_intake_insert.sql` |
| **Status** | ✅ **APPLIED 2026-08-02T17:37:23Z → 17:37:27Z** from `~/Hone-intake-insert` at authorized head `d04f15ed299304f99a982970910fca95b1bc6950` (CI run `30758514555`, completed/success at that exact sha). Hosted max `0162`→**`0163`**; applied count 161→162; repo == hosted. |
| **Frozen checksum** | `sha256 71bc681aa87740af7696cb602c188acc9bbd9be6d0989dcc1f09000f3d8960d6`. **This file is now FROZEN and must never be edited.** |
| **Apply evidence** | Guard PASS `project-ref = alhhybgqdmcdyzpybykj`. Pre-apply: hosted max `0162`, `0163` the ONLY pending row, `db push --dry-run` listed only `0163`, all four inconsistency probes **0**, `client_intake_forms` **0** ungranted locks / **0** conflicting transactions / DB **0** active backends. **Privilege-source check (the gate):** INSERT reached both browser roles via a DIRECT ACL entry granted by `postgres` (`anon=arwdDxtm/postgres`, `authenticated=arwdDxtm/postgres` — the `a` bit); **PUBLIC held ZERO INSERT grants** and neither role inherits from any other role (`pg_auth_members` empty for both), so the two REVOKEs remove the ONLY path. Applied with `supabase db push --linked --yes`: four benign `policy … does not exist, skipping` NOTICEs (confirming no legacy broad policy existed), **no error, no 25P01, no 55P03** — the file's own `begin; … commit;` worked. |
| **Post-apply verification** | Hosted max **`0163`**, present exactly once. **Effective privileges via `has_table_privilege` (not merely `information_schema`):** `anon` INSERT **false** · `authenticated` INSERT **false** · `authenticated` SELECT **true** · `authenticated` UPDATE **true** · `service_role` INSERT **true**. Table ACL now `anon=rwdDxtm/postgres, authenticated=rwdDxtm/postgres` — the `a` (INSERT) bit is GONE from both, while `postgres`/`service_role` keep `arwdDxtm`. `pg_policies` holds exactly `client_intake_forms_member_select` (SELECT) and `client_intake_forms_member_update` (UPDATE) — **no INSERT policy, no ALL policy**. 0162 UNCHANGED: trigger `client_intake_forms_terminal_immutability` `tgenabled='O'`, `tgtype=19`, `prosecdef=false`, `proconfig=search_path=""`, function md5 **`9e50a57a0781d5caa045224f2dd05970`** — byte-identical to the 0162 apply. |
| **Zero data change** | 35 rows before and after; status split 9 in_progress / 6 submitted / 20 reviewed unchanged; stable state hash `2e53949e8eb2e1df336ff5a176def3ea` **byte-identical** across the apply; all four inconsistency probes still **0**. |
| **Verification method** | This is a privilege-removal migration, so **no production INSERT probe was performed** and the classifier was not worked around. The production evidence is: effective `has_table_privilege` results, policy inspection, the table ACL bits, the exact applied source, and the green real-DB `db integration` lane of CI run `30758514555`. |
| **Class** | Privilege + policy change only. **No** schema, column, constraint, index, trigger or function change; **no** data change, backfill or deletion. |
| **Finding** | The `client_intake_forms` authenticated INSERT residual. 0162's guard is a BEFORE **UPDATE** trigger, so it never fires on INSERT: a member could skip the guarded transition entirely and INSERT a row already `status='reviewed'` with a NULL `submitted_at` and a forged `reviewed_at`. Two things made it reachable — the `authenticated` INSERT grant, and `client_intake_forms_member_insert`, whose `WITH CHECK` was only a studio-membership test (which studio, never what state). |
| **Caller audit (the gate)** | At baseline `b176f115d40f25ad0efb3fc02aa6bc4db61ebda0`, `client_intake_forms` has exactly **two** runtime INSERT writers and **both are service role**: `lib/intake/queries.ts :: ensureIntakeForClient` and `:: createIntakeRequestForClient`, each via `createAdminClient()`. No upsert, no INSERT-performing RPC, no raw INSERT. **Zero legitimate authenticated INSERT paths**, so the capability is removed outright rather than constrained. |
| **What it does** | Defensively drops any legacy `FOR ALL` policy (a FOR ALL policy would silently re-grant INSERT); drops `client_intake_forms_member_insert`; `REVOKE INSERT … FROM authenticated`; `REVOKE INSERT … FROM anon`. Revoking both the policy and the grant means two independent things must be undone before a browser role can insert again. |
| **`anon`** | Revoked explicitly by role name — the 0129/0130 lesson: `revoke … from public` alone leaves `anon` holding a privilege, because Supabase's `ALTER DEFAULT PRIVILEGES` grants it at create time. Defence in depth; `anon` could not satisfy a membership check today. |
| **Preserved** | `authenticated` **SELECT** and **UPDATE** (both policies untouched, so reading an intake and the 0162-guarded review transition keep working). **service_role / admin INSERT** — the two legitimate writers are unaffected. 0162's trigger and function are **not** touched; 0162 is APPLIED and FROZEN. |
| **Scope — honest** | `client_intake_forms` authenticated INSERT residual closed by 0163; broader direct clinical DML findings remain open. `authenticated` retains direct row DML on `sessions`, `session_blocks`, `electrolysis_entries`, `laser_entries` and `treatment_images`; this migration does not touch them. **Do not describe L18 as closed.** |
| **Transaction + locks** | Opens its own `begin; … commit;` with `set local lock_timeout = '5s'`, following the 0159/0160/0161/0162 precedent (`db push` does not wrap a file in a transaction, so a bare `SET LOCAL` would emit 25P01 and never arm). On lock timeout (55P03) COMMIT is never reached and the previous grants and policies remain in place. |
| **Idempotent** | Every statement is `drop … if exists` or a plain `REVOKE`, so it replays cleanly on a fresh database and on one already at 0163. Verified: a pinned-CLI `db reset --local` applied it with only four benign "policy does not exist, skipping" notices — confirming no legacy broad policy exists at this baseline. |
| **Editable?** | **NO — FROZEN as of the 2026-08-02 apply.** `0159`, `0160`, `0161`, `0162` and now `0163` are applied and must never be edited. |
| **Proof** | `tests/db/intake-insert-boundary.db.test.ts` (14 cases: same-studio in_progress and already-reviewed INSERT denied, cross-studio denied, anon denied, service-role INSERT succeeds, both writer shapes still create rows, SELECT/UPDATE preserved, 0162's transition still enforced, and no INSERT policy or privilege remains) and `tests/migrations/0163-revoke-authenticated-intake-insert.test.ts` (source contract + the repo migration-max tripwire, which moved here from the 0162 test). The former `RESIDUAL: the INSERT path is NOT closed by 0162` cases in `tests/db/intake-review-db-boundary.db.test.ts` are **inverted**. Local: 58/58 focused intake DB cases pass on a fresh pinned-CLI reset. |
| **Post-apply verification** | Carried as a comment at the foot of the migration: no INSERT privilege for `anon`/`authenticated`; only `member_select` (SELECT) and `member_update` (UPDATE) policies remain and none is INSERT or ALL; the 0162 trigger and function md5 unchanged; row count unchanged. |

### 0162 — APPLIED 2026-08-02

**`0162_intake_review_transition_integrity.sql` — an intake may only become `reviewed` from a
genuinely SUBMITTED row, by the caller's own active practitioner in that studio, at a
database-stamped time.**

| Field | Value |
|---|---|
| **Migration** | `0162_intake_review_transition_integrity.sql` |
| **Status** | ✅ **APPLIED 2026-08-02T14:10:32Z → 14:10:36Z** from `~/Hone-0162` at authorized head `dddfae60524fb6e179f35269e5c102abd7d017ba` (tree clean apart from the untracked local-only `supabase/config.toml`). Repo max `0162` = hosted max `0162`; applied count 160 → 161. |
| **Frozen checksum** | `sha256 41ccc745536806a417614b92202634811f0ae9e854f584f26badbf6ec01c1088`. **This file is now FROZEN and must never be edited.** |
| **Apply evidence** | Guard PASS `project-ref = alhhybgqdmcdyzpybykj`. Pre-apply: hosted max `0161`, 160 applied, `0162` the ONLY row with a blank Remote column, `db push --dry-run` listed only `0162`, all four inconsistency counts **0**, `client_intake_forms` had **0** ungranted locks and the DB **0** active backends. Applied with `supabase db push --linked --yes`. **No SQL error, no NOTICE, no 25P01, no 55P03** — the file's own `begin; … commit;` worked, as with 0159/0160/0161. One benign CLIENT-SIDE warning only: the CLI could not write its local `pgdelta` catalog cache (missing `supabase/.temp/pgdelta/*.crt`); it is a caching step that runs after the migration and has no bearing on the applied SQL. |
| **Post-apply verification** | Hosted max **`0162`**, present exactly once; `0158` still absent (permanently skipped). Trigger `client_intake_forms_terminal_immutability` on `client_intake_forms` → `enforce_intake_terminal_immutability`, `tgenabled='O'`, `tgtype=19` (BEFORE UPDATE FOR EACH ROW), `prosecdef=false` (**SECURITY INVOKER**), `proconfig=search_path=""`. Exactly 2 triggers on the table (the guard + the pre-existing `set_updated_at`), no duplicates. Function replaced: length 2002 → **8291**, md5 `689014c8…` → `9e50a57a…`. **The deployed function body is byte-identical to the reviewed source in this file** — comment-stripped, whitespace-normalized sha256 `5b2826dda11efdf44535ab15ff4fc343f1fc4f80b59ff0ec8898d5343745679a` on both sides, 3003 chars each. All ten guard predicates present, and the section-1 reviewer predicate precedes the `auth.uid() is null` early return (offsets 155 < 4144), so service-role review transitions fail closed. |
| **Zero data change** | `client_intake_forms` 34 rows before and after; state md5 `26c7795adb311d39ae9fd8552f25bb6b` **byte-identical** across the apply; status split unchanged (20 reviewed / 5 submitted / 9 in_progress); all four inconsistency counts still **0**. |
| **⚠️ Verification limit — stated plainly** | **No production behavioural write-probe was performed.** The intended negative control (attempt `in_progress -> reviewed` as `authenticated` inside `begin; … rollback;`) was refused by the environment's auto-mode classifier, which blocks UPDATE-bearing SQL through `supabase db query`. It was **not** worked around. Behavioural proof therefore rests on (a) the exact deployed-source verification above and (b) the green `db integration (local supabase)` lane of CI run `30750450652` at head `dddfae6`, which exercises the full adversarial refusal matrix against a real migrated database. Production refusal is inferred from identical source, not observed. |
| **Class** | Trigger-function replacement. **No** schema, column, constraint, index, policy or grant change; **no** data change, backfill or deletion. |
| **Finding** | `F-CLIN-004`. Migration `0118` nests every review check inside `if old.status in ('submitted','reviewed')`, so an `in_progress` OLD row skipped the block entirely and an authenticated direct PostgREST `PATCH` could drive `in_progress -> reviewed` with `submitted_at` NULL (`UPDATE 1`). |
| **Depends on** | `0118` (whose function body it replaces). Trigger **name** and attachment are unchanged. |
| **Contract added** | For any `new.status = 'reviewed'` where `old.status IS DISTINCT FROM 'reviewed'`: `old.status = 'submitted'`; `old.submitted_at IS NOT NULL`; `new.submitted_at` unchanged; non-null `reviewed_by` that is an **active** practitioner with `user_id = auth.uid()` **and** `studio_id = old.studio_id`; and `reviewed_at` **stamped by the database** via `transaction_timestamp()`. |
| **Hardenings** | **Three**, in body order. **(7)** `reviewed` becomes terminal for end users (0118 blocked only `-> in_progress`, leaving `reviewed -> submitted` open as two-step attribution laundering). **(9)** **Only the CLIENT may submit** — without this rule the contract above is bypassable in TWO statements (forge `status='submitted', submitted_at=now()`, then review it: step one manufactures the evidence step two checks). Found by the adversarial pass and reproduced end-to-end as `authenticated`; safe because `status: "submitted"` is written in exactly ONE place in the repository — the public tokenized route, which runs as service role and is exempt. **(8)** review metadata may not be attached to a non-reviewed row. |
| **Service role** | The 0118 blanket `auth.uid() is null` exemption is **not** preserved for the review transition — a caller audit found `status: "reviewed"` written in exactly one place in the repository, on the authenticated path — so a service-role review **fails closed**. Service-role client submission (`in_progress -> submitted`), inserts and link-metadata writes are untouched and still exempt from the end-user rules. |
| **App compatibility** | The DEPLOYED `markIntakeReviewedAction` (PR #497, merge `b7d85f5`) still succeeds: it selects back only `id, client_id` and never asserts the `reviewed_at` it sent, so the DB stamp is invisible to it. Proven by the "deployed PR #497 application compatibility" cases in the DB suite. |
| **Transaction + locks** | Opens its own `begin; … commit;` with `set local lock_timeout = '5s'`, following the 0159/0160/0161 precedent (`db push` does not wrap a file in a transaction, so a bare `SET LOCAL` would emit 25P01 and never arm). On lock timeout (55P03) COMMIT is never reached and the previous 0118 function and trigger remain in place. |
| **Idempotent** | `CREATE OR REPLACE FUNCTION` + `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER` — replays cleanly on a fresh database. |
| **Editable?** | **NO — FROZEN as of the 2026-08-02 apply.** `0159`, `0160`, `0161` and now `0162` are applied and must never be edited. |
| **Pre-apply requirement** | ✅ Satisfied. The read-only aggregate at the foot of the migration was re-run immediately before the apply and returned **zero** on all four counts for both studios holding intake rows (`My Studio`, `Willow Electrolysis`). The defect was reachable but never exercised. |
| **Proof** | `tests/db/intake-review-db-boundary.db.test.ts` (adversarial matrix + a real two-connection concurrency race) and `tests/migrations/0162-intake-review-transition-integrity.test.ts` (source contract + the repo migration-max tripwire, which moved here from the 0161 test). |

### 0160 — current purpose and status

**`0160_immutable_clinical_lineage.sql` — a treatment record belongs to ONE client and ONE encounter.**

| Field | Value |
|---|---|
| **Migration** | `0160_immutable_clinical_lineage.sql` |
| **Applied to production** | **2026-07-30T17:52:48Z → 17:52:51Z** (~3 s) |
| **SHA-256** | `e56a1ee7efc95e561cd17a0c33750ee4aaaf2a956f425576af39ce4a0e6094d4` |
| **Applied from** | PR #483 head `ba6c62a2ed0c2a294313a0d89d110c0ef8a9028f`, clean worktree; dry run listed **only** 0160 |
| **Transaction** | **Explicit `begin;` / `set local lock_timeout = '5s'` / `commit;` inside the file** |
| **Lock timeout** | **Armed correctly** — unlike 0159, whose `SET LOCAL` never took effect |
| **`25P01`** | **None.** The 0159 `SET LOCAL can only be used in transaction blocks` warning did **not** recur |
| **`55P03`** | **None.** No lock timeout fired; the pre-apply check found a completely quiet database |
| **Errors** | **None** |
| **Notices** | **5**, all benign `DROP TRIGGER IF EXISTS … does not exist, skipping` |
| **Business-data operations** | **ZERO** — no row inserted, updated or deleted; no flag changed; counts and lineage checksums identical across the apply window |
| **Provider operations** | **ZERO** — Stripe, Google, Twilio, Resend all untouched |
| **Installed** | **2 functions** (`guard_immutable_clinical_lineage`, `guard_clearable_clinical_lineage`) and **5 triggers** (`sessions_immutable_lineage`, `session_blocks_immutable_lineage`, `electrolysis_entries_immutable_lineage`, `electrolysis_entries_clearable_lineage`, `laser_entries_immutable_lineage`) |
| **Preserved** | Migration 0093's `treatment_images_enforce_integrity` remains enabled; 0160 added **no** trigger to `treatment_images` |
| **Migration max** | **0159 → 0160**; `0158` remains deliberately absent |

**Why the explicit transaction.** Applying 0159 proved that `supabase db push` does not wrap a
migration file in a transaction: its `SET LOCAL lock_timeout` raised `WARNING (25P01)` and never armed,
leaving that apply non-atomic. 0160 therefore opens its own transaction, which was validated before the
apply on a CI-parity database under a real competing `SHARE ROW EXCLUSIVE` lock — it failed in ~5 s with
`55P03` instead of hanging, and rolled back to **zero** ledger rows, functions, triggers and comments.

> **Neither `0159` nor `0160` may be edited.** Both are applied; their recorded checksums must keep
> describing the files on disk. Behaviour changes require a **new** migration — the next number is
> `0163`, since `0158` is permanently skipped, `0161` is applied, and `0162` is already allocated
> (written but NOT applied).

### 0159 — current purpose and status

**`0159_retire_signed_clinical_records.sql` — retire signed / cryptographically finalized
clinical records, and harden the clinical write surface where nothing exercises it.**

| Field | Value |
|---|---|
| **Migration** | `0159_retire_signed_clinical_records.sql` (595 lines) |
| **Applied to production** | **2026-07-30T13:25:39Z → 13:25:43Z** (~4 s) |
| **SHA-256** | `ea39fc360cc75609a92a3686d677486720e9d234c4b70b81a07913c31fb889f8` |
| **Applied from** | PR #482 head `04c8832f1fe176b9ff136f512e2c1e71b6bc8faf`, clean worktree; dry run listed **only** 0159 |
| **`0158`** | **Intentionally skipped** — see the table above |
| **`0160`** | **Absent / not applied** |
| **Business-data operations** | **ZERO.** No row inserted, updated or deleted; no flag value changed; no snapshot created, regenerated or rehashed; no amendment; no clinical audit event; no session status changed. All counts identical before and after; nothing created in the apply window. |
| **Purpose** | Make the retired capability unreachable at the database layer rather than only in the UI — the flags were browser-reachable through the `studios: owners update` policy plus `EXECUTE` on the retired RPCs. |

**What it enforces.** Both clinical flags pinned `false` by validated CHECK constraints
(`studios_clinical_finalization_retired`, `studios_clinical_corrections_retired`); `EXECUTE`
revoked from `PUBLIC`/`anon`/`authenticated`/`service_role` on all **10** retired functions (the 5
RPCs plus the 5 `_apply_*_correction` appliers) while the owner retains it for the documented
read-only hash re-derivation; a *transition* guard refusing any move into `finalized`/`void`;
`INSERT` refused on all three signed ledgers; the 0120 `hone.correction_session_id` permit
**removed**; and privilege hardening that no code path exercises — every remaining `anon` write
removed from the six clinical tables, `TRUNCATE`/`REFERENCES`/`TRIGGER` removed from `anon` **and**
`authenticated` on all six plus the three ledgers, `session_block_areas` reduced to a SELECT-only
policy, and the 0128 studio-derive trigger widened to `session_block_id, studio_id`.
**It drops nothing** — the 0119/0120 objects and the guards protecting the legacy artifact are kept.

> **Apply anomaly — recorded truthfully.** The migration's `set local lock_timeout = '5s'` emitted
> **`WARNING (25P01): SET LOCAL can only be used in transaction blocks`**, because the CLI did not
> execute the file inside an explicit transaction. **The intended five-second lock timeout did not
> arm, and the apply was therefore NOT atomic.** The migration nonetheless completed successfully
> with no errors (7 benign `drop … if exists` NOTICEs), and **every section was independently
> verified afterward** rather than assumed from all-or-nothing rollback: both CHECK constraints
> present and validated; 10/10 functions with zero runtime `EXECUTE`; all 4 retirement triggers
> present and enabled; the GUC permit and every `current_setting` reference gone from
> `guard_finalized_clinical_write` (definition md5 `af50bdcf…` → `ddc5fa69…`, its 5 triggers intact);
> the legacy snapshot byte-identical (md5 `e3c47f5e133e724a78d3aefc866c35c5`, 1389 bytes, hash
> `34ecc21a…`, still re-deriving byte-identically); `anon` writes 6→0 and `anon`/`authenticated`
> TRUNCATE·REFERENCES·TRIGGER 20→0 while `authenticated` kept every row-DML privilege the deployed
> application uses; `session_block_areas` reduced to one `_member_select` policy with the derive
> trigger widened.
>
> **Do not "fix" the lock-timeout line in `0159` — it is already applied.** A migration file must
> never be rewritten after it has been applied; the checksum above is the historical record.
> **The same `set local lock_timeout` line in `0160` HAS BEEN CORRECTED** (DRAFT PR #483,
> 2026-07-30): that migration now opens its own `begin;` … `commit;` so the timeout genuinely arms
> and the apply is atomic. Proven under real lock contention on a CI-parity database — it failed in
> ~5 s with SQLSTATE 55P03 instead of hanging, and left zero ledger rows, zero functions and zero
> triggers behind. **`0160` was subsequently applied to production on 2026-07-30 — see its own
> section above — and must not be edited either.**

### 0157 — purpose and status

**`0157_whole_session_copy_setup.sql` — whole-session "Copy areas and settings from last
session": atomic, idempotent, source-authoritative batch commit + provenance ledger.**

- **Applied to production 2026-07-27T02:01:29Z**, from the whole-session-copy worktree at
  PR #478 head `1dbca69`. The dry-run showed **only** 0157; the apply was clean with no
  notices, warnings or errors.
- **Applied BEFORE PR #478 merged** (13:12:34Z) — migration-first, so the deployed commit
  path never faced a missing-function window.
- **Additive.** It adds **one provenance table** and **four functions**. There is **no
  backfill** and **no mutation of any existing clinical object** — no existing table, column,
  index, policy or grant was changed.
- **Provenance table** `public.session_copy_operations` — `(target_session_id,
  idempotency_key)` UNIQUE and **three** same-studio composite foreign keys (target session,
  source session, and the committing practitioner). **0 rows in production**:
  no real copy has ever been performed.
- **Verified privilege posture** (`has_table_privilege` / `has_function_privilege`, 2026-07-27):

| Object | anon | authenticated | service_role |
|---|---|---|---|
| `session_copy_operations` (table) | **no privileges at all** | **SELECT only** — no INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER | full |
| `copy_session_setup(...)` — the commit RPC | no EXECUTE | **no EXECUTE** | EXECUTE |
| `whole_session_copy_source_descriptor(uuid, uuid)` | no EXECUTE | EXECUTE | EXECUTE |
| `_whole_session_copy_fingerprint(uuid)` — private helper | no EXECUTE | no EXECUTE | EXECUTE |
| `_whole_session_copy_source_id(uuid, uuid)` — private helper | no EXECUTE | no EXECUTE | EXECUTE |

  All four functions are `SECURITY DEFINER` with `search_path = ""`. The commit RPC is
  **service-role only** — the browser cannot call it. It is invoked solely by the
  authenticated Next.js server action, which passes a **server-derived** practitioner id, and
  the RPC re-verifies active studio membership because service_role bypasses RLS.
- The authenticated `SELECT`-only grant on the ledger is studio-scoped by RLS. Revoking
  TRUNCATE / REFERENCES / TRIGGER matters because **RLS does not protect those** — see
  [../09_DATABASE_AND_RLS.md](../09_DATABASE_AND_RLS.md).
- The RPC body enforces the product contract: reusable setup only (**minutes and outcomes are
  never copied**) and `galvanic_intensity_percent` is written as a **literal `NULL`** at the
  destination, with the source fingerprint excluding it so a forged spec cannot reintroduce it.

### Test tripwire

`tests/scripts/verify-production.test.ts` pins the **derived** expected migration max — it
reads `supabase/migrations/` at run time rather than hardcoding a literal, so the pin moves
automatically when a new migration lands. Per-migration shape tests assert repo contents.

> **Scope of this ledger.** The tail from 0089 is enumerated below with a one-line purpose
> and applied status. Full per-migration narrative for **0001–0088** lives in
> [../09_DATABASE_AND_RLS.md](../09_DATABASE_AND_RLS.md) and the dated per-PR entries in
> [../13_BACKLOG_AND_DECISIONS.md](../13_BACKLOG_AND_DECISIONS.md) /
> [../14_AI_HANDOFF.md](../14_AI_HANDOFF.md).

---

## Recent tail (0089 → 0157)

| # | Filename | Purpose | Applied |
|---|---|---|---|
| 0089 | `0089_imported_treatment_memory.sql` | Imported treatment-memory tables (studio-scoped, RLS, read-model) | ✅ |
| 0090 | token hash-at-rest (cancellation) | Hash appointment/cancellation tokens at rest | ✅ |
| 0091 | drop raw cancellation_token column | Destructive hardening after the 0090 hash cutover | ✅ |
| 0092 | `0092_treatment_images.sql` | Private `treatment-images` bucket + metadata table + studio-scoped RLS | ✅ |
| 0093 | `0093_harden_treatment_image_storage.sql` | Service-role-only storage; path/identity CHECKs + integrity trigger | ✅ (NOT pending) |
| 0094 | `0094_tenant_consistency_constraints.sql` | Composite same-studio FKs (sessions/blocks/intake/imported) | ✅ (NOT pending) |
| 0095 | `0095_charting_numbing_and_probe_lot_confirm.sql` | `session_blocks.numbing_status` + `probe_lot_confirmed` | ✅ |
| 0096 | `0096_disinfectant_discard_due_date.sql` | Record-keeping disinfectant "replace by" date | ✅ |
| 0097 | intake link columns | Intake link last-sent / send-count / expires | ✅ |
| 0098 | intake reminder columns | Intake 7d/3d reminder columns + indexes + RPC branches | ✅ |
| 0099 | `0099_treatment_image_notes.sql` | `treatment_images.practitioner_note` | ✅ |
| 0101 | payment live-capability | Make payment rows live-capable (supervised live session payments are now enabled for approved studios) | ✅ |
| 0103 | mode-scoped payment settings | Per-studio test/live payment settings scoping (live/test isolation is live) | ✅ |
| 0105 | mode-scoped attempt uniqueness | Test + live attempt uniqueness per session; underpins live/test card + attempt isolation | ✅ |
| 0106 | `0106_*studio_marketing_tracking*.sql` | Per-studio marketing tracking settings + booking consent | ✅ |
| 0107 | `0107_studio_tracking_encrypted_token.sql` | Encrypted provider token storage + owner-only RLS | ✅ (NOT pending) |
| **0108** | `0108_electrolysis_observation_chips.sql` | **Treatment observation chips** — structured `observation_chips` on `session_blocks`; per-row backfill from legacy `comments` on edit | ✅ |
| **0109** | `0109_studio_time_format_preference.sql` | **Studio 12h/24h time-format preference** (`studios.time_format_preference`, default `12h`; existing studios → 12h) | ✅ |
| **0110** | `0110_studio_postcare_delivery_mode.sql` | **Postcare delivery mode** (`studios.postcare_delivery_mode` text, default `manual`, CHECK `manual`/`auto_on_complete`) — enables opt-in auto-send; default OFF | ✅ |
| **0111** | `0111_client_portal_access_events.sql` | **Client portal access events** — append-only, studio-scoped, SELECT-only RLS (`is_studio_member`), no INSERT/UPDATE/DELETE policy (service-role writes only), composite same-studio FK, no token/URL/PII columns | ✅ |
| **0112** | `0112_public_booking_horizon_expand.sql` | **Public booking horizon 1–12** — widen `studios.public_booking_horizon_months` CHECK from `(3,4,6)` to `(1..12)`; default 3 unchanged; existing values unchanged | ✅ |
| **0113** | `0113_admin_action_events.sql` | **Admin Action Audit Log** — append-only `admin_action_events` (operator-action events). RLS enabled with **no policies** (service-role reads + writes only; admin authorized at the app layer); **no foreign keys** (audit durability); write grants revoked from `authenticated`/`anon`; **no token/URL/IP/email/clinical/payment columns**; metadata allowlisted + redacted | ✅ |
| **0114** | `0114_entry_soft_delete.sql` | **Audited "Remove/void pass"** — adds `deleted_at`/`deleted_by`/`delete_reason` (+ active partial indexes) to `electrolysis_entries` and `laser_entries`, mirroring the `session_blocks` soft-delete triad (0019). Lets a practitioner remove ONE pass from a multi-pass area without hard-deleting the clinical record. **Additive**; nullable; no backfill; **no RLS change** (the pre-existing entry DELETE policy is left intact but unused — the code PR switches the entry delete actions to soft-delete). Applied **migration-first** (before the code merge). | ✅ |
| **0115** | `0115_entry_hard_delete_hardening.sql` | **Entry hard-delete hardening** — closes the residual hard-delete path an independent audit confirmed: **drops** the `for delete to authenticated` RLS policy on `electrolysis_entries` + `laser_entries` (kept by 0087) and **revokes** `truncate, delete` from `anon, authenticated`, so removals go only through the audited soft-delete UPDATE (0114/#391). **Policy/grant-only**; no schema/data change; **hardens** RLS (does not weaken it); `service_role` unaffected (maintenance path preserved). Applied **migration-first**. | ✅ |
| **0116** | `0116_drop_calendar_feed_raw_token.sql` | **Calendar-feed credential hash-only at rest** — **drops** the raw `practitioners.calendar_feed_token` column + its partial unique index (kept `calendar_feed_token_hash` from 0079, which the feed route authenticates by). Removes the only same-studio-member-readable feed credential; raw token now surfaced only once at generate/rotate. Existing subscriptions keep working (hash lookup); no reconnect. **Drop-only**; no other schema/data/RLS change. Applied **code-first** (2026-07-10, after PR #395's hash-only code deployed — destructive drop of a written column). | ✅ |
| **0117** | `0117_session_audit_cross_tenant_insert_hardening.sql` | **session_audit cross-tenant INSERT hardening** — tightens the `session_audit_studio_member_insert` policy so a new audit row's `session_id` must belong to a studio the caller is an active member of (mirrors the SELECT scoping), in addition to the existing actor binding. Closes a confirmed cross-tenant integrity-write (Studio A could attach a fabricated audit event to a Studio B session). **Policy-only** (INSERT policy replaced, stricter); no SELECT/UPDATE/DELETE/grant/schema/data change; **hardens** RLS. A read-only audit found **0** cross-studio-mismatched historical rows. No code change needed (the sole app writer already complied). Applied **migration-first**. | ✅ |
| **0118** | `0118_intake_terminal_immutability.sql` | **Intake terminal-state immutability** — adds a `BEFORE UPDATE` trigger on `client_intake_forms` so that, for authenticated end-users (service-role exempt), once `status ∈ (submitted, reviewed)` the answers (`responses`) and `submitted_at` are immutable, status cannot regress to `in_progress`, and `reviewed_by` must be the caller's own active practitioner (review attribution immutable once reviewed). Closes a same-tenant clinical-record integrity defect (a member could directly PATCH a submitted/reviewed intake). **Trigger-only**; no schema/policy/grant/data change; no RLS weakening. Draft editing, review, and reissue-based corrections (a NEW intake row) are unaffected — the multi-row model already preserves originals. No code change needed. Applied **migration-first**. | ✅ |
| **0119** | `0119_clinical_record_finalization_phase1.sql` | **Clinical Record — Phase 1: finalization boundary.** Additive `sessions` lifecycle (`record_status` draft/finalized/void, `finalized_at/by`, `record_version`, `current_snapshot_id`) + provenance (`record_origin` native/legacy, `legacy_classification`); a studio-scoped `clinical_finalization_enabled` flag (**default OFF**); an immutable **append-only** `clinical_record_snapshots` artifact (RESTRICT/NO-ACTION FKs — **never cascade-deletes**; UPDATE/DELETE blocked for *all* roles); a deterministic **UTC-canonical** snapshot builder (excludes soft-deleted children, image bytes, and operational `price_paid_cents`; captures practitioner display-name evidence); DB **write-guards** freezing the finalized aggregate — sessions clinical/attribution/soft-delete/lifecycle, child `session_blocks`/`electrolysis_entries`/`laser_entries` INSERT+UPDATE+DELETE, and `treatment_images` INSERT/UPDATE/reassign/soft-delete/hard-delete — with **NO service-role / `auth.uid()` / GUC bypass**; a `practitioners` BEFORE DELETE trigger retaining finalized attribution (deactivation still allowed); and a trusted native-only, flag-enforced, min-charting, compare-and-set, idempotent `finalize_session` RPC (session/snapshot version = 1, no increment). **Purely additive + inert** (every existing/new row is `draft`; guards fire only after an explicit, flag-gated finalize), so **migration-first is safe** (no break window). Legacy: all pre-existing rows → `record_origin='legacy'` via metadata-only default (no physical rewrite); `legacy_classification` deferred to a manual review queue (the historical data has no reliable completion signal). **Scope note (honest):** finalized treatment-image *metadata + attachment relationships* are locked; full content-addressed object immutability is a later photo-integrity phase. No treatment-memory read change; no Stripe/payment/email/SMS/booking change; `price_paid_cents`/`appointment_id`/`treatment_plan_id` stay operational/mutable. **✅ APPLIED to hosted 2026-07-10 (migration-first, additive/inert)** — remote max now 0119; read-only verify confirmed all 59 legacy sessions unchanged (`record_origin='legacy'`, `record_status='draft'`, classification/finalized/snapshot NULL), 0 snapshots, `clinical_finalization_enabled=false` for all studios, all guards/triggers enabled, RESTRICT FKs, Stripe gates 15 PASS, 0 unresolved ops alerts. **PR #399 code MERGED + deployed** (merge `d84180f`, 2026-07-10); flag remains OFF for all studios (production-exercised once on Sam's controlled studio, then disabled — the finalized record stayed locked). | ✅ applied + merged |
| **0120** | `0120_clinical_record_corrections_amendments_phase2.sql` | **Clinical Record — Phase 2: corrections & amendments.** Adds two attributable ways to evolve a FINALIZED record without changing/deleting the original: **amendments** (append-only additions — late note / clarification / late photo — recorded in a new append-only `clinical_record_amendments` table; NEVER overwrite a recorded value; no version/normalized change) and **corrections** (fix a wrong value → new immutable snapshot **version N+1**, `record_version`+1 once, supersede the prior version, preserve all priors). Adds snapshot **lineage** columns (`version_type` original/correction, `supersedes_snapshot_id` RESTRICT, `correction_reason`, `corrected_by` RESTRICT, `corrected_by_display_name`, `corrected_at`) + a lineage CHECK; a dedicated append-only **`clinical_audit_events`** table (PHI-safe — ids + version numbers + reason only); a separate studio flag **`clinical_corrections_enabled`** (**default OFF**). The correction path introduces the codebase's FIRST narrow bypass: a **transaction-local, session-scoped GUC `hone.correction_session_id`** the guard permits ONLY when it equals the exact row's `session_id`, set only inside the SECURITY DEFINER `correct_finalized_session` / `amend_finalized_session_with_image` RPCs (structurally unreachable from PostgREST — a client cannot compose a `SET` + frozen-row write in one transaction; row-scoped; auto-discarded at COMMIT/ROLLBACK). Corrections apply through **typed, allow-listed per-entity appliers** (no arbitrary columns; no studio/client/lifecycle reassignment); rebuild + re-hash + re-validate min-charting on the persisted snapshot; are atomic (FOR UPDATE, compare-and-set, one-winner concurrency, no partial commit). `session_audit` left as-is; treatment-memory reads UNCHANGED; no Stripe/payment/email/SMS/booking change. **Purely additive + inert** (gated by the new flag, default OFF; guards only permit the trusted RPCs), so **migration-first is safe**. Legacy rows remain ineligible. **✅ APPLIED to hosted 2026-07-11 (migration-first, additive/inert)** — remote max now 0120; read-only post-apply verify confirmed: existing snapshot count unchanged (1, the synthetic v1, correctly labeled `version_type='original'`), synthetic record still version 1/finalized/unchanged, 59 legacy sessions unchanged, **0 corrections / 0 amendments / 0 audit events created**, `clinical_corrections_enabled=false` for all studios (and `clinical_finalization_enabled` unchanged), lineage columns + CHECK present, both new tables RLS-on + SELECT-only + append-only + RESTRICT FKs (no cascade), guard permit session-scoped with **no** service-role/`auth.uid()`/role bypass, 3 RPCs SECURITY DEFINER + authenticated-only (appliers revoked), Stripe 15 PASS, 0 ops alerts, verifier `Remote migration max = 0120` PASS. **PR #400 code MERGED + deployed** (merge `6de3b5d`, 2026-07-11); `clinical_corrections_enabled` OFF for all studios — the corrections/amendments **customer workflow is PARKED** and no production correction/amendment has been created. | ✅ applied + merged (dormant) |
| **0121** | `0121_google_calendar_connection_foundation.sql` | **Google Calendar — Phase A (connection & OAuth foundation).** Four studio flags (`google_calendar_connection_enabled` + outbound/inbound/two-way), **all default OFF**; `calendar_connections` (per-practitioner non-secret metadata + sync/health state; member-SELECT RLS; service-role writes; one-per-practitioner + ≤1 studio-calendar-owner-per-studio; same-studio composite FKs); `calendar_connection_secrets` (the ONLY place the encrypted refresh token lives — RLS on + **no** browser policy + explicit REVOKE, so a same-studio peer cannot read another practitioner's credential; `encryption_key_version`; access token never persisted). Additive + **dormant** (nothing reads/writes until the flag is ON + code ships). Applied **migration-first** 2026-07-11. **PR #404 MERGED + deployed** (merge `1bfdf7b`). Subsequently production-exercised on Sam's controlled studio (1 connection created, least-privilege Phase-A scopes, no event scope); all sync flags OFF; Willow not connected. | ✅ applied + merged (dormant) |
| **0122** | `0122_google_oauth_state.sql` | **Google Calendar — Phase A (OAuth state).** `google_oauth_states` single-use OAuth binding: state stored **hash-only**, session nonce **hash-only** (raw nonce is an httpOnly cookie), PKCE verifier **encrypted**, 10-min TTL, `consumed_at` CAS (single-use), same-studio composite FK; **default-deny** (RLS + REVOKE, service-role only). Additive + **dormant**. Applied **migration-first** 2026-07-11 (alongside 0121). **PR #404 MERGED + deployed** (merge `1bfdf7b`). Post-exercise: exactly one state consumed on Sam's studio, none reusable. | ✅ applied + merged (dormant) |
| **0123** | `0123_soft_delete_session_area.sql` | **Willow P1-B — remove an incorrectly-recorded treatment area.** An atomic aggregate soft-delete `SECURITY DEFINER` RPC `soft_delete_session_area(p_session_id, p_block_id, p_reason)` that, in **one transaction**, soft-deletes the block + its block-scoped electrolysis passes + block-scoped `treatment_images` and writes a `session_audit` `area_removed` event; **NO hard delete** (existing per-row soft-delete RLS untouched). `search_path` pinned (`pg_catalog, pg_temp`); EXECUTE **authenticated-only** (anon/public revoked); studio derived from the row via `is_studio_member` + active practitioner from `auth.uid()`; **rejects finalized/void**; requires a ≥10-char reason. Additive (one function). Applied **migration-first** 2026-07-11. **PR #406 MERGED + deployed** (merge `306a473`). The RPC was **NOT** called against real data (0 `area_removed` events) — production data unchanged. | ✅ applied + merged |
| **0124** | `0124_google_calendar_outbound_sync_foundation.sql` | **Google Calendar — Phase B1: dormant outbound-sync schema & queue foundation.** Adds `calendar_event_links` (polymorphic Hone-entity → Google-event mapping; **no** FK to appointments/blocks; same-studio composite FK to `calendar_connections(id, studio_id)` **ON DELETE RESTRICT**; active-entity + active-google-event partial uniques; member-SELECT + **no** browser writes) and `calendar_sync_outbox` (durable at-least-once queue; **four-state** `status` pending/processing/done/dead; deterministic idempotency key under a FULL unique index; `priority` 0..1000; bidirectional claim-metadata CHECK; entity CHECK; **default-deny** — RLS on + REVOKE ALL from browser roles + no policy + service-role only), plus two `SECURITY DEFINER`, service-role-only RPCs `claim_calendar_sync_op` (`FOR UPDATE SKIP LOCKED`, batch 1..25, fixed 5-min lease, stale-at-max → dead reaper) and `record_calendar_sync_result` (token/terminal-state validation, backoff bounded 5..21600s, exhaustion → dead, 500-char error cap). **Additive + DORMANT at the time of apply:** no enqueue path, no drain worker, no trigger enqueues, no outbound-sync UI, no Google API call, no event scope requested; `calendar_event_links` + `calendar_sync_outbox` were empty (0 rows) **at the 2026-07-12 apply — each has held ONE row since the single controlled `event.create` validation of 2026-07-18**; all Google sync flags OFF; Willow not connected. Applied **migration-first** 2026-07-12 (dry-run showed ONLY 0124; post-apply read-only verify confirmed unchanged data + flags, empty tables, RPC service-role-only EXECUTE, 0 triggers on the new tables). **PR #407 MERGED + deployed** (merge `bcccce4`; Vercel prod deploy `wPWQYZgee9QjgFS6QLGEngGrM6Jx` success). **Exercised ONCE under control on 2026-07-18** — the single `event.create` that produced the one row now held in each of `calendar_sync_outbox` and `calendar_event_links`; dormant before and after. | ✅ applied + merged (dormant) |
| **0125** | `0125_google_calendar_outbound_enqueue_activation_boundary.sql` | **Google Calendar — Phase B2.3-a: intent-gated enqueue + claim boundary.** Adds the durable-**intent** enqueue path over the 0124 outbox — the DB trigger records outbound intent only while the INTENT gate holds (studio outbound flag + owner connection + `write_calendar_id`), plus the repair primitives (`repair_bump`, `repair_enqueue_orphan_link_delete`) and the `calendar_sync_queue_health` view the later reconciliation sweep orchestrates. Claim-time HEALTH gate distinct from the enqueue-time INTENT gate; global worker control **default OFF**. **Additive + DORMANT today** (worker flag off; no intent-eligible studio at present). Applied **migration-first** 2026-07-13. **PR #412 MERGED + deployed.** **Exercised ONCE under control on 2026-07-18** — this enqueue path produced the single `calendar_sync_outbox` row (`op_type='event.create'`, `status='done'`). | ✅ applied + merged (dormant) |
| **0126** | `0126_client_clinical_notes.sql` | **Willow — dedicated consultation + skin/hair analysis clinical notes.** Append-only `client_clinical_notes` (studio-scoped, author-attributed). Applied **migration-first** 2026-07-13. **PR (Willow clinical notes) MERGED + DEPLOYED LIVE for all studios (no flag).** | ✅ applied + merged (live) |
| **0127** | `0127_fix_client_clinical_notes_author_insert_policy.sql` | **Willow clinical notes — RLS defense-in-depth fix.** Tightens the `client_clinical_notes` author INSERT policy (author must be the caller's own active practitioner). Policy-only hardening; no schema/data change. Applied **migration-first** 2026-07-13. **MERGED + deployed.** | ✅ applied + merged (live) |
| **0128** | `0128_session_block_areas.sql` | **Willow — multi-area per block.** Session-block treatment-area model enabling multiple recorded areas per block. Applied **migration-first**. **MERGED + deployed.** | ✅ applied + merged |
| **0129** | `0129_atomic_session_block_area_writes.sql` | **Willow — atomic session-block area writes (laterality).** Makes multi-area + laterality writes atomic (one-transaction, no partial commit). Applied **migration-first**. **MERGED + deployed.** | ✅ applied + merged |
| **0130** | `0130_revoke_anon_calendar_charting_rpc_execute.sql` | **Hardening — revoke the residual `anon` EXECUTE on the TWO 0129 multi-area charting RPCs** (`create_session_block_with_areas`, `update_session_block_with_areas`). Grant-only tightening; no schema/data change; hardens (does not weaken). Needed because Supabase `ALTER DEFAULT PRIVILEGES` grants `anon` EXECUTE at create time, so 0129's `revoke … from public` alone was not sufficient — **always revoke from `anon` explicitly**. Applied **migration-first**. **MERGED + deployed.** | ✅ applied + merged |
| **0131** | `0131_google_calendar_dual_destination.sql` | **Google Calendar — Phase B2.4: dual-destination + destination-derived scope.** Replaces the broad `calendar.events` model with a destination contract — **dedicated** (`calendar.app.created`, an app-created "Hone Appointments" calendar) vs **existing-owned** (`calendar.events.owned`) — with NULL-safe CHECKs on the connection destination columns. **Additive + DORMANT.** Applied **migration-first** 2026-07-14. **PR #424 MERGED + deployed** (merge `8a25df6`; Vercel prod deploy `h9b58cLZtJ4w3MMrY5WU959w5tDB` success). **Production-exercised once on Sam's controlled studio:** one "Hone Appointments" destination calendar created 2026-07-14 (grants app.created=1 / events.owned=0 / broad=0), **empty at that time**; **one real event was subsequently created into it on 2026-07-18** during the single controlled outbound validation. All sync flags OFF; Willow not connected. | ✅ applied + merged (dormant) |
| **0132** | `0132_google_calendar_event_link_transitions.sql` | **Google Calendar — Phase B2.3-c1: event-link transitions.** One transactional service-role-only `calendar_event_link_transition` RPC + placeholder-aware `enqueue_calendar_outbound` refresh. **Additive + DORMANT.** Applied **migration-first** 2026-07-16. PR #428 **MERGED** 2026-07-16T14:51:32Z (merge `013a741`). Full apply narrative in [../14_AI_HANDOFF.md](../14_AI_HANDOFF.md). | ✅ applied + merged (dormant) |
| **0133** | `0133_practitioner_move_appointment.sql` | **Practitioner Move appointment — atomic same-record move.** One SECURITY DEFINER RPC `practitioner_move_appointment` (hardened `search_path`, `service_role`-only EXECUTE, active-practitioner check, `FOR UPDATE` lock, `confirmed + future` gate, **optimistic concurrency** on expected `starts_at`/`ends_at`, duration preserved, one-row `UPDATE`, `moved` audit event; does **not** catch `23P01` so a booking conflict rolls the move back). **Additive** — one function, no column/data change, no trigger/Google/Stripe touch. | ✅ applied + merged |
| **0134** | `0134_practitioner_capacity_foundation.sql` | **Practitioner-capacity foundation (PR A).** The additive, **default-OFF** collision/resource-key model that lets a studio run several practitioners in parallel without double-booking a practitioner or a studio-wide resource. Changes **no** booking/assignment behaviour by itself. | ✅ applied + merged (dormant at Willow) |
| **0135** | `0135_practitioner_availability.sql` | **Per-practitioner availability (PR B).** Adds an optional `practitioner_id` dimension to `studio_availability_default` (weekly) and `studio_availability_overrides` (date-specific). `practitioner_id IS NULL` remains the studio-wide fallback — today's behaviour, unchanged. Additive + default-neutral. | ✅ applied + merged |
| **0136** | `0136_practitioner_capacity_booking_flag.sql` | **Separate structural capacity from the booking kill-switch.** 0134 conflated the structural model with booking acceptance; once a studio has legitimate parallel appointments, flipping capacity OFF cannot roll back cleanly. Adds `practitioner_capacity_booking_enabled` as the independent public-booking switch. **FALSE on every studio.** | ✅ applied + merged (**held OFF everywhere**) |
| **0137** | `0137_scoped_blocks_and_breaks.sql` | **Practitioner-scoped timed blocks + recurring breaks.** Optional practitioner scope on one-off timed blocks and recurring break rules/occurrences; full-day blockouts stay studio-wide. Adds the scope-aware reservation synchronizer. | ✅ applied + merged |
| **0138** | `0138_scoped_sources_lock_and_dormancy.sql` | **Scoped-source lock coverage + lock-then-read.** Corrects five engine defects in 0137: DELETE and blockouts bypassed the capacity advisory lock; fixes the canonical lock order (studios row → advisory) across all four source tables. Hardening. | ✅ applied + merged |
| **0139** | `0139_scoped_conflict_lookup_and_rule_guard.sql` | **Recurring-rule guard + scoped conflict lookup.** Closes the bypass where toggling a rule from inactive→active with an unchanged inactive practitioner skipped validation. Hardening. | ✅ applied + merged |
| **0140** | `0140_studio_onboarding.sql` | **First-time studio onboarding (owner onboarding v2).** Additive, **default-OFF** foundation for a guided, resumable first-run experience: welcome email, dashboard wizard, setup-progress card, admin-visible invite/onboarding status. | ✅ applied + merged (enabled on the controlled test studio only) |
| **0141** | `0141_onboarding_invitation_reconciliation.sql` | **Invitation reconciliation + one authoritative consent.** Provisioning and legal acceptance for invited users (new *and* existing Auth accounts) move to sign-in time with exactly one authoritative acceptance event. `handle_new_user()` becomes a NO-OP: **nothing fabricates consent, and nothing activates a membership merely because an Auth user was created.** | ✅ applied + merged |
| **0142** | `0142_internal_booking_command.sql` | **Canonical atomic INTERNAL booking command.** Replaces the direct `appointments` INSERT (which self-assigned the caller, took no capacity lock, ignored the booking flag, and had a TOCTOU window) with one reviewed SECURITY DEFINER transaction. Authorization is **parameter-based** — the server action resolves actor + studio server-side; nothing is trusted from the browser. Superseded by the 0146 v2 command and wrapped by 0147. | ✅ applied + merged |
| **0143** | `0143_move_or_reassign_appointment.sql` | **Atomic MOVE + REASSIGNMENT command.** One same-record transaction that can change an appointment's time, its practitioner, or both, preserving the id and every relationship. Supersedes the time-only 0133 for the internal move surface. | ✅ applied + merged |
| **0144** | `0144_move_target_integrity_and_legacy_wrapper.sql` | **Move final-target integrity + 0133 legacy wrapper.** 0143 validated the target only on a reassignment, so a time-only move could commit a new interval while retaining a now-inactive or ineligible practitioner. Now the **resulting** practitioner is validated on every capacity-ON move. | ✅ applied + merged |
| **0145** | `0145_move_preserve_target_race_fix.sql` | **Remove the time-only move stale-target race.** Both the 0133 wrapper and the move action read the current practitioner *before* the locks were taken, so a concurrent reassignment could silently revert the appointment to a stale practitioner. A NULL target now means "preserve the CURRENT practitioner", resolved under lock. | ✅ applied + merged |
| **0146** | `0146_authoritative_duration_and_availability_validator.sql` | **Authoritative in-DB duration + one shared availability validator.** 0142 trusted a caller-supplied duration — a forged POST could book any length. The v2 command derives duration from the **locked, revalidated service row inside the transaction**; an OWNER-only explicit override (15..360, multiple of 15) is the single sanctioned way to book a non-default length and never bypasses collision/block/break/blockout/pause rules. Security hardening. | ✅ applied + merged |
| **0147** | `0147_internal_booking_legacy_wrapper.sql` | **Close the old 0142 creation-command bypass.** 0142 remained service_role-executable and still trusted a caller-controlled duration, so a stale deployment or second adapter could bypass every v2 guarantee. The old signature is redefined as a thin wrapper around v2. Security hardening. | ✅ applied + merged |
| **0148** | `0148_move_reassign_availability_validator.sql` | **Wire the shared availability validator into move/reassign.** A move onto a closed day or outside the practitioner's hours previously committed silently. Every capacity-ON move now runs `validate_appointment_availability` on the final target and resulting interval; the per-resource GiST exclusion remains the final authority on intervals. | ✅ applied + merged |
| **0149** | `0149_save_weekly_availability_atomic.sql` | **Atomic full-week availability save under the capacity lock.** The weekly save wrote seven independent upserts, so a failure on day 4 left a half-applied week, and it took no capacity lock. `save_weekly_availability` writes all supplied days in one transaction after taking the canonical lock order. | ✅ applied + merged |
| **0150** | `0150_single_row_schedule_writers_locked.sql` | **Lock the single-row schedule writers.** The single-row availability writers and the practitioner-active writer wrote directly from the browser-role client under no capacity lock, so a schedule edit could interleave with a booking that had already validated the old window. Narrow typed SECURITY DEFINER commands now take the canonical lock order. Hardening. | ✅ applied + merged |
| **0151** | `0151_appointment_tenant_consistency.sql` | **Appointment tenant-consistency composite FKs (RC hardening).** 0010 created `appointments.client_id / service_id / practitioner_id` as single-column FKs; 0094 hardened the clinical child tables with composite same-studio FKs but **omitted appointments** — so a member could insert an appointment in their own studio referencing another studio's client/service/practitioner. Closes that gap. Security hardening. | ✅ applied + merged |
| **0152** | `0152_actual_overlap_hard_buffer_soft.sql` | **Actual overlap HARD, configured buffer SOFT.** Fixes the manual-override booking blocker: a close-but-non-overlapping override booking was wrongly rejected by the buffer-expanded GiST exclusion. Actual treatment overlap remains **never bypassable**; the buffer becomes a soft constraint an authenticated internal OWNER override may cross. | ✅ applied + merged (live) |
| **0153** | `0153_service_calendar_color.sql` | **Explicit per-SERVICE calendar colour.** Replaces the djb2 hash-of-service-id colour derivation (unrelated services collided, reading as "duration-based"). Allowed values only: amber, emerald, teal, sky, indigo, violet — **the rose/red family is deliberately excluded**, reserved for allergy / EpiPen / clinical-caution signals. Additive + forward-only; rewrites no appointment rows. | ✅ applied + merged (live) |
| **0154** | `0154_practitioner_notifications_dedupe_key.sql` | **Durable external-event dedupe key for `practitioner_notifications`.** The `setup_intent.succeeded` webhook arm writes a studio notification when a client adds or replaces a card. Stripe may re-deliver an event or emit more than one Event for the same SetupIntent, so the key is scoped to the **mode-scoped SetupIntent**, under a partial UNIQUE. Additive nullable column; **no backfill**. | ✅ applied + merged (live) |
| **0155** | `0155_probe_inventory_chart_linkage.sql` | **Inventory-backed probe-lot linkage.** Makes the charted probe lot a durable, probe-specific, same-studio-safe pointer into `record_keeping_sterile_items` (adds `probe_key` + `session_blocks.probe_inventory_item_id` with a composite same-studio FK, `ON DELETE SET NULL` — pointer-only, frozen snapshot). The legacy `probe_lots` table and `electrolysis_entries.probe_lot_id` stay **dormant** and are neither read nor written. **Nothing is backfilled; no RLS policy added, removed or weakened.** | ✅ applied + merged |
| **0156** | `0156_conditional_numbing_notes.sql` | **Conditional numbing notes.** One nullable `session_blocks.numbing_notes` text column plus both atomic RPCs taught to carry it. **No default, no backfill, no CHECK/length cap, no RLS/policy/trigger change** — a clinical free-text note has no fixed real-world maximum, and the app already trims/normalizes (kept only when `numbing_status='used'`). Rollout was **migration-first** because the new application reads and writes the column. | ✅ applied + merged (live) |
| **0157** | `0157_whole_session_copy_setup.sql` | **Whole-session copy — atomic, idempotent, source-authoritative batch commit + provenance ledger.** One table (`session_copy_operations`) + four SECURITY DEFINER functions with `search_path=""`. The preview is ephemeral; exactly one explicit action reaches the server, which calls the service-role-only `copy_session_setup`. **Additive: no backfill, no existing clinical object mutated.** Applied **2026-07-27T02:01:29Z, BEFORE PR #478 merged.** Full purpose + verified privilege matrix in the header section above. **0 ledger rows — never production-exercised.** | ✅ applied + merged (never exercised) |

### Code-only PRs in this window (the hosted max does **not** move)

These shipped behaviour with **no migration**, so they never advance the migration max:

- **Google Calendar B2.3-b** (PR #426, merge `f664f0f`, 2026-07-15) — reconciliation sweep +
  heartbeat + dead-row alerting + `/api/cron/calendar-reconcile`, orchestrating the existing
  0124/0125 repair RPCs. Deployed **dormant**; CRON_SECRET-protected.
- **Google Calendar B2.3-c2** (PR #429) — authenticated worker-drain route. Deployed dormant.
- **Google Calendar B2.3-c3** (PR #430) — cron schedule registration. Registration did **not**
  activate sync; the worker flag stays off.
- **PR #476** — charting usability polish (collapsed add-block CTA, split chip groups, larger
  notes).
- **PR #473 / #474** — safe in-form "Copy settings"; containment of the earlier unsafe
  whole-session copy (both superseded by 0157 + PR #478).
- **PR #479 — the Phase A charting correction** (merge `3cabdca`): unified
  *Treatment observations & skin response* box, galvanic-intensity retirement,
  *Thermolysis pulse count* relabel, exact `0.733 seconds` display, larger notes.
  **Code-only — no migration, no data operation, no flag change.**

(Numbers not listed in the 0100–0107 band, e.g. 0100/0102/0104, are documented per-PR in
`docs/13` / `docs/14`; all are applied. Production max is **0157**.)

---

## Notes on 0108–0113 *(historical detail — these were the newest six as of 2026-07-10; the production max is now 0157 and the newest six are 0152–0157, covered in the tail table above)*

- **0108 observation chips** — additive; legacy chip data is backfilled from the free-text
  `comments` field **on row edit**, so rows never re-edited retain unstructured chips (a
  known, non-blocking data-quality tail; see the readiness audit).
- **0109 time-format preference** — additive text column, default `12h`; drives client-facing
  time rendering (calendar labels, SMS, emails). Machine values stay 24h.
- **0110 postcare delivery mode** — additive; default `manual` means **no behavior change on
  deploy**. Auto-send is opt-in and fail-soft.
- **0111 client portal access events** — append-only audit log; the table has **no column**
  for any token, URL, IP, email, or clinical/payment value; SELECT-only for studio members;
  inserts only via the app's service-role paths.
- **0112 booking horizon expand** — CHECK-only change; no column add, no default change, no
  data backfill; existing `3/4/6` values remain valid.
- **0113 admin action events** — append-only operator-action audit log; **service-role-only**
  (RLS enabled, no policies + write grants revoked), **no FK** (event survives referenced-row
  deletion), and **no column** for any token, URL, IP, email, or clinical/payment value.
  Applied **migration-first** (before the #374 code merge); reads/writes go only through
  `lib/audit/admin-actions.ts` from `isAdmin`-gated `/admin` code.

## Correcting prior stale statements

Historical per-PR prose in `docs/09`, `docs/13` and `docs/14` was written at a point in time
and contains pending/unapplied language that is now superseded. Those dated entries are
retained as history; they are **not** current state.

Superseded claims you may still encounter in dated material:

- "0096 not yet applied" / "0095 NOT yet applied" / "0093 / 0094 must not be applied until
  approved" — **all applied.**
- "production max is 0112 / 0113 / 0124 / 0132 / 0133 / 0157" — **the production max is 0159.**
- "0133 repo-added, hosted apply pending" — **0133 is applied.**
- "0157 is pending / unapplied / awaiting authorization" — **0157 was applied
  2026-07-27T02:01:29Z**, before PR #478 merged.
- "0159 is in repo but not yet applied" / "hosted max is still 0157" / "0159 needs
  migration-only authorization" / "apply 0159 first" — **0159 was applied
  2026-07-30T13:25:39Z–13:25:43Z** and verified. The signed-record retirement is
  **database-enforced in production now**. PR #482's code and documentation merge/deploy is also
  complete (merged `d77d4434`, deployed 2026-07-30).
- "production max is 0159" / "hosted max 0159, repo max 0160" / "0160 is not applied / pending /
  not authorized" / "apply 0160 first" / "0160 needs migration-only authorization" / "PR #483
  contains an unapplied migration" / "the same-studio lineage defect remains open" — **all
  superseded. `0160` was applied 2026-07-30T17:52:48Z–17:52:51Z and independently verified; the
  production migration max is 0160**, and the lineage defect is database-enforced.
- "`calendar_sync_outbox` and `calendar_event_links` are 0 rows" — each holds **one row**
  from the single controlled Google Calendar validation on 2026-07-18. See
  [capability-register.md](./capability-register.md) §9.

Trust this ledger plus `supabase migration list --linked` — never historical prose, and never
one document as evidence for another.
