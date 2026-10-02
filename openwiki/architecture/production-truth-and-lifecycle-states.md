---
type: governance concept
title: Production truth authorities and lifecycle states
description: How Hone keeps designed, implemented, merged, migration-applied, deployed, enabled, production-exercised and human-accepted states apart, which documents may assert mutable production facts, how to re-derive them, and where those records are already stale or contradict each other.
tags: [production-truth, lifecycle-states, migration-state, documentation-guards, release-records]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-02T20:08:11.217Z
sources:
  - id: openwiki-source-164e2da859b5277df81c7d94
    resource: repo://.github/workflows/ci.yml
  - id: openwiki-source-f07bd6e082ff96434e028ea3
    resource: repo://docs/15_DOCS_MAINTENANCE.md
  - id: openwiki-source-3934c2f87cfed2d7e74c8303
    resource: repo://docs/production/capability-register.md
  - id: openwiki-source-723c675bbe2438236148b868
    resource: repo://docs/production/current-state.md
  - id: openwiki-source-0a7f1727d82c9ac5dce569e4
    resource: repo://docs/production/known-limitations.md
  - id: openwiki-source-f79f369ce2044c952565dcb9
    resource: repo://docs/production/migration-ledger.md
  - id: openwiki-source-25950163322ecb962b98e506
    resource: repo://docs/production/release-changelog.md
  - id: openwiki-source-bed9aa4fdff900b1eb1dd662
    resource: repo://scripts/migration-state.mjs
  - id: openwiki-source-84ee60a98182dfa16e1f3603
    resource: repo://tests/docs/canonical-production-facts.test.ts
  - id: openwiki-source-68fb49d65cba642bd3811eda
    resource: repo://tests/docs/helpers/canonical-facts.ts
  - id: openwiki-source-fbadcd8591b65031efaaedce
    resource: repo://vitest.config.ts
generated: { by: "claude-code", at: "2026-10-02T20:08:11.217Z" }
---

# Production truth authorities and lifecycle states

Hone treats "what is true in production" as a small set of **declared or derived facts with
named authorities**, not as something any document, comment or memory may assert. This page
is the map: which states exist, which file is allowed to say which thing, how the repository
mechanically checks those files, and where they currently disagree.

> **Read this before writing any production claim** into code comments, PR bodies, docs or
> this wiki. A table, migration, route, component or flag existing is never evidence that a
> capability is live.

## 1. The lifecycle vocabulary

The status words are defined once, in
<!-- openwiki: broken internal link [../../docs/production/capability-register.md#L65-L87] heading anchor "L65-L87" does not exist in "../../docs/production/capability-register.md". Fix the href or restore the target, then delete this comment. -->
[`docs/production/capability-register.md` § Status vocabulary](../../docs/production/capability-register.md#L65-L87).
They are **independent dimensions**; a capability normally holds several at once.

| Status | Meaning (paraphrased from the register) | Typical evidence |
|---|---|---|
| Designed | A reviewed design exists; no claim that code exists. | design doc / decision record |
| Implemented | Code exists in the repository. | source + tests at a commit |
| Merged | On the production branch `claude/build-hone-saas-hOex7`. | `git merge-base --is-ancestor <commit> <production-head>` |
| DB applied | Its migration is applied to the hosted production database. | `migration-state.json` + ledger apply record |
| Deployed | Part of the Vercel production build serving the product. | deployment record for the exact SHA |
| Enabled | A runtime gate (studio flag / env / config) permits it to run. | dated read of the gate |
| Production exercised | It ran against production data at least once, with a row, log line or recorded operation. | dated read-only query / record |
| Human accepted | The operator who asked for it has used it and confirmed it. | explicit statement from that person |
| Dormant / Held / Deferred | Deployed-but-unable-to-act / blocked by a server-side gate pending approval / out of scope by product decision. | register row |
| Retired | **Terminal**: permanently removed and the database enforces that it cannot be enabled. | constraint / revocation in a migration |

Rules that follow from the vocabulary:

- **Never write "live".** The register's bar for *Production exercised* is a row, a log line or
  a recorded operation, not the existence of a code path
<!-- openwiki: broken internal link [../../docs/production/capability-register.md#L85-L87] heading anchor "L85-L87" does not exist in "../../docs/production/capability-register.md". Fix the href or restore the target, then delete this comment. -->
  ([register L85-L87](../../docs/production/capability-register.md#L85-L87);
<!-- openwiki: broken internal link [../../docs/production/current-state.md#L10-L14] heading anchor "L10-L14" does not exist in "../../docs/production/current-state.md". Fix the href or restore the target, then delete this comment. -->
  [current-state L10-L14](../../docs/production/current-state.md#L10-L14)).
- **Usage is not acceptance.** `current-state.md` §15 lists features that are deployed and in
  some cases heavily exercised, yet still lack human acceptance; it explicitly forbids inferring
<!-- openwiki: broken internal link [../../docs/production/current-state.md#L1142-L1163] heading anchor "L1142-L1163" does not exist in "../../docs/production/current-state.md". Fix the href or restore the target, then delete this comment. -->
  acceptance from usage ([current-state L1142-L1163](../../docs/production/current-state.md#L1142-L1163)).
- **Merged is not deployed, and green CI is neither.** An open PR is never production; the
  durable test for "shipped" is ancestry of the production head, not a recorded SHA
<!-- openwiki: broken internal link [../../docs/production/current-state.md#L138-L180] heading anchor "L138-L180" does not exist in "../../docs/production/current-state.md". Fix the href or restore the target, then delete this comment. -->
  ([current-state L138-L180](../../docs/production/current-state.md#L138-L180)).
- **Retired is not dormant.** The signed/finalized clinical-record system is retired and
  database-enforced; nothing can re-enable it (see
  [Sessions, blocks and entries](../treatment-memory/sessions-blocks-and-entries.md)).

## 2. The authority map

| Fact | Single authority | Who may restate it | Mechanism |
|---|---|---|---|
| Hosted migration max and apply instant | [`docs/production/migration-state.json`](../../docs/production/migration-state.json) (`hosted_migration_max`, `hosted_applied_at`, `hosted_applied_at_precision`, `hosted_note`, append-only `$comment`) | Only the ledger's `## Current state` block | Declared by the person who performed the apply, in the same change that records it |
| Repository migration max, total, next free number, pending set | **Derived** by [`scripts/migration-state.mjs`](../../scripts/migration-state.mjs) (`npm run migration:state`) | Nobody — re-derive | Filename scan of `supabase/migrations/` |
| Narrative apply evidence (checksums, ACL readings, what an apply does *not* mean) | [`docs/production/migration-ledger.md`](../../docs/production/migration-ledger.md) | — | Append a new "Current state", demote the old one to "Previous state" |
| Production branch head, last runtime-bearing head, tenant classification, open-PR set | [`docs/production/current-state.md`](../../docs/production/current-state.md) | Nobody else may pin the runtime SHA | Dated reconciliation ("PROD-TRUTH" class change) |
| Per-capability status matrix | [`docs/production/capability-register.md`](../../docs/production/capability-register.md) | — | Defers SHA and tenancy to `current-state.md` |
| Residual limitations (`L1`…`L33`) | [`docs/production/known-limitations.md`](../../docs/production/known-limitations.md) | — | Closed by evidence on the limitation's own heading, never by deletion |
| What shipped in a wave | [`docs/production/release-changelog.md`](../../docs/production/release-changelog.md) | — | Rows keep their THEN-state wording; only the preamble is kept current |

**Not authorities:** `docs/14_AI_HANDOFF.md` (its own headings mark it point-in-time),
`docs/reviews/**`, audit packs under `docs/audits/**` (excluded from this wiki by
`.openwikiignore`), code comments, PR descriptions, and any agent memory. They may tell you
*where to look*; they never establish a current value.

### How migration state is derived and declared

`scripts/migration-state.mjs` is deliberately split in two:

- **Derived repository state.** It scans `supabase/migrations/*.sql`, throws on any filename
  that is not `NNNN_snake_case.sql`, throws on duplicate versions, and computes the max, the
  total and the next free number, skipping the permanently unused slot `0158`
  ([L42-L98](../../scripts/migration-state.mjs#L42-L98), [L140-L179](../../scripts/migration-state.mjs#L140-L179)).
- **Declared hosted state.** It reads `migration-state.json`, requires the three keys
  `hosted_migration_max` / `hosted_applied_at` / `hosted_note`, requires a four-digit max, and
  accepts `hosted_applied_at` only as `null` or an ISO date/instant
  ([L100-L135](../../scripts/migration-state.mjs#L100-L135)). `null` is legitimate: the hosted
  `schema_migrations` table has no timestamp column, so recent applies record an
  operator-observed client-side window in `hosted_applied_at_precision` instead of inventing a
  server instant.
- **Pending** is every repository version above the declared hosted max; `repo_equals_hosted`
  is a plain numeric comparison ([L152-L175](../../scripts/migration-state.mjs#L152-L175)). A
  repository max *above* hosted is the normal state of a migration-first change in flight; a
  hosted max above the repository (a remote-only migration) is what the docs guard forbids.

See [Migrations and hosted migration state](../operations/migrations-and-hosted-state.md) for
numbering and authoring rules, and
[Migration-first rollout and production safety](../operations/migration-first-rollout-and-production-safety.md)
for the apply sequence.

## 3. How to re-derive production state

`current-state.md` ends with an explicit re-verification recipe and a **source-of-truth
order** that puts existing documentation last
<!-- openwiki: broken internal link [../../docs/production/current-state.md#L1191-L1244] heading anchor "L1191-L1244" does not exist in "../../docs/production/current-state.md". Fix the href or restore the target, then delete this comment. -->
([L1191-L1244](../../docs/production/current-state.md#L1191-L1244)):

1. production Git graph (branch head via `gh api …/branches/claude/build-hone-saas-hOex7`);
2. Vercel deployment record for the exact SHA;
3. `supabase migration list --linked` (after confirming the gitignored
   `supabase/.temp/project-ref` names the intended project);
4. read-only production queries — `supabase db query --linked`, **never** `db execute`;
5. code and migrations at the exact production SHA;
6. merged PR metadata and CI;
7. deployment / runbook reports;
8. existing documentation, *as claims to verify, never as evidence*.

Every production count must carry an **as-of stamp and a tenant scope**; a bare number is "a
<!-- openwiki: broken internal link [../../docs/production/current-state.md#L1196-L1211] heading anchor "L1196-L1211" does not exist in "../../docs/production/current-state.md". Fix the href or restore the target, then delete this comment. -->
fossil" ([L1196-L1211](../../docs/production/current-state.md#L1196-L1211)). Running any of
steps 2–4 is production access and is out of scope for routine agent work unless the operator
explicitly authorizes it.

## 4. Tenant classes

`current-state.md` §0 is the canonical classification of every production tenant
<!-- openwiki: broken internal link [../../docs/production/current-state.md#L182-L217] heading anchor "L182-L217" does not exist in "../../docs/production/current-state.md". Fix the href or restore the target, then delete this comment. -->
([L182-L217](../../docs/production/current-state.md#L182-L217)). Agents should reason in
**classes**, never copy the names or counts:

- **Real customer** — the single live pilot studio. Only its rows are customer activity.
- **Controlled test** — a validation studio; identified by its flags (practitioner capacity,
  onboarding v2 and Google Calendar connection all enabled), not by its name.
- **Synthetic** — a *sanctioned synthetic tenant inside the production database* with generated,
  privacy-safe rows. Its rows are never customer activity, and the migration ledger verifies at
  each apply that it was preserved.
- **Empty** tenants.

"Non-synthetic" is **not** "real customer": subtracting the synthetic tenant still leaves the
controlled-test studio in the total. All-tenant totals may be quoted only when labelled as
including synthetic rows.

## 5. The guard that enforces all of this

[`tests/docs/canonical-production-facts.test.ts`](../../tests/docs/canonical-production-facts.test.ts)
(≈3,460 lines) turns the rules above into assertions. Its shared vocabulary lives in
[`tests/docs/helpers/canonical-facts.ts`](../../tests/docs/helpers/canonical-facts.ts): the
**only** exemption mechanism is an explicit
`<!-- canonical-facts:ignore-start reason=… -->` … `<!-- canonical-facts:ignore-end -->` frozen
region; everything outside it is treated as current prose
([helper L13-L34](../../tests/docs/helpers/canonical-facts.ts#L13-L34)).

| Rule family | What it pins | Lines |
|---|---|---|
| No hard-coded current migration state | `current-state`, `capability-register`, `known-limitations` state no current max or next-free number; the changelog preamble states no current max or head | [L418-L468](../../tests/docs/canonical-production-facts.test.ts#L418-L468) |
| Ledger agrees with the record | The ledger's current block states the declared hosted max and derived repo max; the relationship is **PARITY or MIGRATION-FIRST PENDING**, never anything else | [L470-L746](../../tests/docs/canonical-production-facts.test.ts#L470-L746) |
| Synthetic rows | Every tenant classified; real-customer figures come from the real-customer row, not a subtraction | [L812-L885](../../tests/docs/canonical-production-facts.test.ts#L812-L885) |
| Durable waitlist activation | Recorded as a **dated bound** ("WAS activated at every measured instant") with a dated non-zero row count; no canonical doc may still call it dark/dormant/zero-rowed | [L921-L1000](../../tests/docs/canonical-production-facts.test.ts#L921-L1000) |
| Apply history | `$comment` in `migration-state.json` is an append-only array of dated entries | [L1356-L1418](../../tests/docs/canonical-production-facts.test.ts#L1356-L1418) |
| Rule A (SHAs) | Every SHA in `current-state.md` resolves; the runtime pin is an ancestor of `HEAD`; **nothing runtime-bearing changed since the pin**, judged by `scripts/classify-changes.mjs` minus non-shipping roots | [L1650-L1825](../../tests/docs/canonical-production-facts.test.ts#L1650-L1825) |
| Rule A4 | Only `current-state.md` may contain a commit SHA; the register and limitations must reference it instead | [L2820-L2848](../../tests/docs/canonical-production-facts.test.ts#L2820-L2848) |
| Rule F | Open PRs are declared, carry a non-production state word, and none of them has actually merged | [L2850-L2979](../../tests/docs/canonical-production-facts.test.ts#L2850-L2979) |
| Rule G | `current-state.md` says it is not evidence for itself and orders documentation last | [L2981-L3000](../../tests/docs/canonical-production-facts.test.ts#L2981-L3000) |
| Rules H, D0, D+ | Ledger states a current max only under `## Current state`; limitation ids are unique; open limitations persist and closed ones stay labelled | [L3048-L3230](../../tests/docs/canonical-production-facts.test.ts#L3048-L3230) |

### Where the guard actually runs — and where it silently does not

- It is an ordinary Vitest file, so it runs in `npm test` (the unit config includes
  `tests/**/*.test.ts` and excludes only `tests/db/**`;
  [`vitest.config.ts` L40-L46](../../vitest.config.ts#L40-L46)).
- **Rule A needs real history.** It records its environment (`no-git`, `shallow (A-rules
  SKIPPED)`, `full history (A-rules ENFORCED)`) and skips on a shallow clone
  ([L1650-L1666](../../tests/docs/canonical-production-facts.test.ts#L1650-L1666)).
- In CI only the change-detection job checks out with `fetch-depth: 0`
  ([`ci.yml` L105-L122](../../.github/workflows/ci.yml#L105-L122)); the `validate` job that runs
  `npm test` uses the default shallow checkout
  ([L281-L284](../../.github/workflows/ci.yml#L281-L284), [L321](../../.github/workflows/ci.yml#L321)),
  so **Rule A is skipped in CI** and enforces only on full local clones.
- `validate` is skipped entirely when the classifier reports `docs_only`
  ([`ci.yml` L228-L232](../../.github/workflows/ci.yml#L228-L232)). A diff consisting only of
  Markdown under `docs/` therefore runs **none** of these guards in PR CI. (Running the guard
  locally before pushing is the only enforcement for such a diff.)

## 6. Lifecycle states in practice — worked examples

- **Whole-session copy** is recorded as *DB applied · merged · deployed · enabled ·
  production exercised · human acceptance pending*
<!-- openwiki: broken internal link [../../docs/production/current-state.md#L372-L374] heading anchor "L372-L374" does not exist in "../../docs/production/current-state.md". Fix the href or restore the target, then delete this comment. -->
  ([current-state L372-L374](../../docs/production/current-state.md#L372-L374)) — every dimension
  stated separately.
- **The durable new-client waitlist** is recorded as a *dated activation bound*, not a current
  posture, because persisted rows outlive the env flag that enabled them
<!-- openwiki: broken internal link [../../docs/production/current-state.md#L738] heading anchor "L738" does not exist in "../../docs/production/current-state.md". Fix the href or restore the target, then delete this comment. -->
  ([current-state L738](../../docs/production/current-state.md#L738);
  [guard L951-L998](../../tests/docs/canonical-production-facts.test.ts#L951-L998)).
- **NEW-CLIENT-MODE-01 (migration `0204`)** is recorded as *applied before deploy*, one studio
  persisted, the remaining studios unstamped and still governed by the env bridge **at that
  reading**, and several activation steps explicitly UNKNOWN rather than inferred
<!-- openwiki: broken internal link [../../docs/production/current-state.md#L105-L136] heading anchor "L105-L136" does not exist in "../../docs/production/current-state.md". Fix the href or restore the target, then delete this comment. -->
  ([current-state L105-L136](../../docs/production/current-state.md#L105-L136)). See
  [New-client admission mode](../waitlist/new-client-admission-mode.md).

## 7. Contradictions and open questions

These are recorded as found on 2026-10-02 against branch `feat/openwiki-01` (head `b78a35a9`,
based on the production branch at `a98c0c85`). They are **not** reconciled here.

1. **`current-state.md`'s runtime pin is behind the production branch, by its own admission.**
   The reconciliation header pins `410e5039` (merge of #745) as both branch head and last
   runtime-bearing head at the 2026-09-21 sync
<!-- openwiki: broken internal link [../../docs/production/current-state.md#L23-L30] heading anchor "L23-L30" does not exist in "../../docs/production/current-state.md". Fix the href or restore the target, then delete this comment. -->
   ([L23-L30](../../docs/production/current-state.md#L23-L30)); the NEW-CLIENT-MODE-01 subsection
   then states production advanced past that pin (#773, #778, #777) and deliberately does not
<!-- openwiki: broken internal link [../../docs/production/current-state.md#L105-L120] heading anchor "L105-L120" does not exist in "../../docs/production/current-state.md". Fix the href or restore the target, then delete this comment. -->
   re-pin ([L105-L120](../../docs/production/current-state.md#L105-L120)).
   *Observation from this OpenWiki run (not a repository fact):* `git log --first-parent --merges
   410e5039..a98c0c85` lists 23 merges, and `git diff --name-only 410e5039 HEAD` includes files
   under `app/`, `lib/` and `components/`. Rule A3 asserts that nothing runtime-bearing changed
   since the pin, so it is **expected to fail on a full clone** until the document is re-pinned.
   The guard was not executed in this run (the worktree has no `node_modules`), and CI cannot
   observe the failure because Rule A skips on shallow checkouts (§5).
2. **Reconciliation dates differ across the canonical set.** `current-state.md` is a
   2026-09-20/21 sync with a 2026-10-01 release addendum; `capability-register.md` was reconciled
<!-- openwiki: broken internal link [../../docs/production/capability-register.md#L7] heading anchor "L7" does not exist in "../../docs/production/capability-register.md". Fix the href or restore the target, then delete this comment. -->
   2026-08-27 ([L7](../../docs/production/capability-register.md#L7)); `known-limitations.md`
   records limitations verified as of 2026-08-27
<!-- openwiki: broken internal link [../../docs/production/known-limitations.md#L1-L12] heading anchor "L1-L12" does not exist in "../../docs/production/known-limitations.md". Fix the href or restore the target, then delete this comment. -->
   ([L1-L12](../../docs/production/known-limitations.md#L1-L12)); the ledger's current block is
   2026-10-01. A status present in the newest record may be absent or older in the register.
3. **`docs/15_DOCS_MAINTENANCE.md` contradicts the canonical record.** Its "How to avoid false
   claims" list (written 2026-07-27) still bans saying *"Whole-session copy is
   production-exercised"* and states the production migration max as `0157` "today"
<!-- openwiki: broken internal link [../../docs/15_DOCS_MAINTENANCE.md#L117-L148] heading anchor "L117-L148" does not exist in "../../docs/15_DOCS_MAINTENANCE.md". Fix the href or restore the target, then delete this comment. -->
   ([L117-L148](../../docs/15_DOCS_MAINTENANCE.md#L117-L148)), while `current-state.md` records
   whole-session copy as PRODUCTION EXERCISED with dated counts
<!-- openwiki: broken internal link [../../docs/production/current-state.md#L372-L374] heading anchor "L372-L374" does not exist in "../../docs/production/current-state.md". Fix the href or restore the target, then delete this comment. -->
   ([L372-L374](../../docs/production/current-state.md#L372-L374),
<!-- openwiki: broken internal link [../../docs/production/current-state.md#L1151-L1155] heading anchor "L1151-L1155" does not exist in "../../docs/production/current-state.md". Fix the href or restore the target, then delete this comment. -->
   [L1151-L1155](../../docs/production/current-state.md#L1151-L1155)) and the derived state is far
   above `0157`. That file is not among the documents the guard reads
   ([guard L404-L408](../../tests/docs/canonical-production-facts.test.ts#L404-L408),
   [L940-L949](../../tests/docs/canonical-production-facts.test.ts#L940-L949)).
4. **WAIT activation: "next work" vs "already taken".** `current-state.md` §16 item 5 still lists
   *WAIT-02B Stage B2 (activation)* as next work whose "authorization is not granted"
<!-- openwiki: broken internal link [../../docs/production/current-state.md#L1176-L1178] heading anchor "L1176-L1178" does not exist in "../../docs/production/current-state.md". Fix the href or restore the target, then delete this comment. -->
   ([L1176-L1178](../../docs/production/current-state.md#L1176-L1178)), while L25 records that
   activation **was taken on or before 2026-08-25** and that the open item is only the missing
<!-- openwiki: broken internal link [../../docs/production/known-limitations.md#L452-L475] heading anchor "L452-L475" does not exist in "../../docs/production/known-limitations.md". Fix the href or restore the target, then delete this comment. -->
   governance record ([known-limitations L452-L475](../../docs/production/known-limitations.md#L452-L475)).
   The guard's "pre-cutover instruction" rule matches specific enable / cutover /
   "before migration" phrasings
   ([L1191-L1229](../../tests/docs/canonical-production-facts.test.ts#L1191-L1229)), none of
   which item 5 uses, so it stays green.
5. **Tenant register count is stale.** The header and §0 classify **six** studios from a
<!-- openwiki: broken internal link [../../docs/production/current-state.md#L36] heading anchor "L36" does not exist in "../../docs/production/current-state.md". Fix the href or restore the target, then delete this comment. -->
   2026-08-23 measurement ([L36](../../docs/production/current-state.md#L36)), while the
   2026-10-01 `0204` apply record counts **seven** studio rows
<!-- openwiki: broken internal link [../../docs/production/migration-ledger.md#L38] heading anchor "L38" does not exist in "../../docs/production/migration-ledger.md". Fix the href or restore the target, then delete this comment. -->
   ([ledger L38](../../docs/production/migration-ledger.md#L38)) and `current-state.md` itself
   refers to "the other six" beside the one persisted studio
<!-- openwiki: broken internal link [../../docs/production/current-state.md#L133] heading anchor "L133" does not exist in "../../docs/production/current-state.md". Fix the href or restore the target, then delete this comment. -->
   ([L133](../../docs/production/current-state.md#L133)). One studio row is therefore not
   classified by the canonical tenant register.

## 8. Agent checklist

- Derive repository migration facts with `npm run migration:state`; never type a migration
  number as current truth anywhere.
- Treat any production count, flag value, health reading or provider state as **dated**; quote
  its authority and its date, or don't quote it.
- Before calling something shipped, check commit ancestry against the production branch head
  you just re-read; before calling it exercised, find the dated record; before calling it
  accepted, find the person's explicit statement.
- When two authorities disagree, write down both and the dates — do not pick one.
- Never copy tenant names, counts, record ids, deployment ids, project refs or env values into
  code, docs or this wiki.
