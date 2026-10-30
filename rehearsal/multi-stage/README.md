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

That leaves 12 valid plans (13 stage packages). A stage package is named `<ver>-after-<versions applied before>`, so
dropping a step changes which package a later step uses, never the package itself. `plan-check.sh VERSION...` refuses a
rule-breaking plan, refuses an order no package was built for, and prints the stage ids to run.

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
