# MULTI-STAGE-BUILDER (REHEARSAL, never merge; PREPARATION ONLY / HELD)

`build.py SPEC.json OUTDIR` turns an **ordered list of migration files** into reviewed online stage packages: one per
step, for every VALID way to drop steps (so a step can be dropped without a rebuild). Sam decided D2-A: below-head
files apply with `--include-all`, only ever inside the bundle guard below. D2-B (renumbered copies) is not supported. Nothing here connects to anything: no hosted call, no token, no database.

## What it emits, per step k

| Artefact | Content |
|---|---|
| bundle `migrations-stage<S>.tar` + `MIGRATIONS-stage<S>.sha256` | the hosted set + steps 1..k (the bundle is the control), exact file count, sha256 pins |
| stage conf `runner/stages/<S>.conf` | pins the apply, reconcile and read-back scripts for the one-command runner |
| `s1-apply-<S>-online.sh` | one dry run that must list **exactly** step k; one push; `--include-all` only when step k is below the hosted max |
| `window-s1read-<S>.sh` | the read-back between steps (history first, then the migration's content checks) |
| `s1-reconcile-<S>-online.sh` | archives the APPLY-STATE marker from read-back evidence (ALL) so the next step may start |
| `EXPECT.json` | history before and after: rows, max, md5 of the sorted version list, versions present, absent list |
| `PLAN.json`, `SEQUENCE.md` | the whole ordered plan |

One runner invocation per migration. A single push of N files cannot roll back the files already applied
(`multi-stage-push-rehearsal.sh` section B6 shows it with the real CLI).

## Package P1 and the stage-drop rules

`spec/p1.json`: 0254, 0258, 0272 (placeholder: General's file does not exist yet), 0266, 0271. Rules (OPS release plan
2026-10-30, enforced by `rule_violation` in the builder and by the generated `plan-check.sh`):

1. dependency closure: dropping 0258 drops 0272 and 0266;
2. 0258 is never planned without 0272 immediately after it;
3. 0266 needs 0258 and 0272 earlier in the plan (or already hosted);
4. 0254 and 0271 are independent.

That leaves 12 valid plans (13 stage packages). A stage package is named `<ver>-b<hex>` (a bitmask, in the spec's step order, of the steps applied before it; SEQUENCE.md and EXPECT.json list the versions), so
dropping a step changes which package a later step uses, never the package itself. Ids are at most 16 characters because the reviewed runner refuses a longer manifest STAGE; build.py refuses any id over 16 and `runner-validate.sh` runs every manifest through the real runner up to the driver. `plan-check.sh VERSION...` refuses a
rule-breaking plan, refuses an order no package was built for, and prints the stage ids to run.

## Step 1 is Team's real v2 package, adopted unchanged

`spec/p1.json` marks 0254 `adopt`: the reviewed package `team/stage-0254a-v2` is copied into `adopted/0254a/` and emitted **byte for
byte** (apply `cecb27bd`, runner, run.exp, conf with its six PROMPT lines, read-backs, installer). The builder re-checks every file
against the package's own `SHA256SUMS.txt`, the apply against the pinned sha and its `HEAD_SHA` (464ac549), and refuses to adopt
anywhere but step 1 on the hosted set. Nothing in step 1 is generated, so the combined rehearsal runs the real v2 apply (all six prompts:
approve, token, password, approve2, token, password), not a stub of it. Only the CLI and the read-back are test stand-ins (see Stated limits).

**V5, bundles are built from bytes.** Every bundle is the 247 hosted files (the production tree) plus the sealed target(s), assembled by
`build.py` from file bytes in the GNU tar format Team's package uses. The adopted step's tar is rebuilt and must equal Team's
`migrations-stage0254a.tar` (sha256 cb781e43...), so merging #1226 (the carrier PR) is not needed mid-session. Each later bundle is the
previous bundle plus its one target, no carrier merge involved either.

## The runner's bundle guard (every step)

Each apply script embeds the exact reviewed allowlist (file name and sha256 of every migration in its bundle) and checks:
bundle and list sha256, count, strictly ascending names, the list equal to the embedded allowlist (an extra, missing,
renamed or changed migration of ANY number stops the run), every tar entry against the list, every extracted file's
sha256, the pending file against its sealed sha, and 0257 plus every earlier step pinned by name and sha256. The history
(rows, max, the exact version set by md5) is read and must match BEFORE the push, and again AFTER it (the read-back).
`--include-all` appears only on the dry run and the push of a step below the hosted max, after all of those gates.

## How the scripts are made

Every script is the **reviewed 0254-after-0257 online script** (`templates/`, pinned by sha256 in `build.py`) with
declared exact-literal substitutions. Each substitution asserts its match count, so a template that drifted fails the
build rather than producing a script nobody reviewed. The history gate is generic: `applied_count`, `hosted_max`,
`list_md5` (the md5 of the sorted version list, which pins exactly which versions are present) and `rows_<ver>`.

## Gate packs: what the builder cannot supply

The migration-specific content gates (the preflight against the objects the migration touches, the table/lock reads and
the content read-back) belong to the migration's own review. A step may name a `gate_pack` (`gate-packs/<ver>/pack.json`
with `requires_before_max`: the hosted max it was reviewed at). A pack placed at a different position is **refused**.

A step with no pack gets a **history-only** gate. The plan, the README and the installer flag it loudly as
**CONTENT GATES MISSING: not production-ready**. Only 0254 has a pack; 0258, 0272, 0266 and 0271 do not.

## Checks

- `builder-check.sh SPEC`: deterministic output, refusals (duplicate, wrong hosted directory, stale gate pack, bad name,
  template drift), content-gate flags.
- `seq-check.sh PKG HOSTED`: the generated scripts as real text against a stateful stub CLI, the whole sequence, and the
  negative controls (extra file, missing file, wrong sha, out-of-order step, failure at step k).
- `scripts/ci/multi-stage-push-rehearsal.sh PKG`: the real pinned CLI v2.102.0 on a disposable PostgreSQL.

## Stated limits

- Stand-in database and synthetic migration bodies carrying the real file names; the sealed bytes are covered by the
  sealed-sha gate, not by the CLI rehearsal.
- The read-back script is a stub in `seq-check.sh` (it needs the real database's content results); the real generated
  read-back is checked for syntax and its history assertion only.
- 0272 is a placeholder with a synthetic body until General supplies the file; replacing it and re-running the builder adds its stages.
- CI runners (macOS arm64 and Linux), not a local stack.

## P1 v2 (`spec/p2.json`, `spec/p2x.json`): the real files, on the hosted set AFTER 0254

Sam is applying 0254 separately, so P2 builds the remaining steps on a hosted set of **248 files** (the checkout's 247 plus 0254, sha `77f34d5c`),
declared as `hosted.extra` (name and sha256 mandatory). Steps: 0258 `12c8109d`, 0272 `d3805343`, 0266 `5fe2965c` (all #1227 head 51f82f46, in `spec/sealed-v2/`
for 0272 and 0266), 0271 `5985d3a0` (#1275); `p2x` adds the droppable 0253, 0255, 0256 (below head, `--include-all`).

**Insurance R5.** Every step's `sha256` is mandatory (the builder refuses a step without one), and the hosted block must carry `dir_sha256`: the sha256 of
`name + " " + sha256(file)` for EVERY hosted file in order (the extras included). A count and a max are no longer the pin. `builder-check.sh` has three
negative controls (no step sha, no dir hash, a wrong dir hash). The pin is NOT final until OPS confirms the hosted read-back after 0254's apply and Privacy/Insurance
finish re-reviewing 0258/0272/0266 (a changed file means a new sha and a re-pin).

0272 has no content pack (no reviewer-stated post-apply checks): history-only, flagged CONTENT GATES MISSING. 0266's pack now also asserts search_path on all five of its
functions (G1) and that the audit identity sequence is granted to no API role (G6). 0258's pack still does not assert search_path (0272 changes it afterwards).
seq-check's full negative-control suite (B7f/g, rule tests) is written for the adopted 0254 step 1, so P2 runs the combined sequences (`ONLY_A=1`) and the real-stack gate job.

## 0256 gate pack (`gate-packs/0256`, `spec/p256.json`; scratch, Insurance PEER-0256-SQL)

0256 (below head, include-all) redefines `create_public_appointment_for_new_client` and `_v2` so an ordinary public booking never adopts an active client. The pack asserts the two functions' bodies and grants
(the reviewer-stated checks): PRE, both functions are still exactly the latest prior definitions (0228 and 0225, by md5 of the stored source, derived from the files), grants are service_role only, and the refusal is absent;
POST, both are SECURITY DEFINER with search_path `pg_catalog, public, pg_temp`, executable by service_role only, no new overload, the stored bodies equal the sealed 0256 bodies and carry the refusal at both places.
The behaviour itself (refuses an active email writing nothing, the race, an invitation still adopts) is the carrier's DB test; a stored body equal to the sealed one makes the hosted function the tested one.
