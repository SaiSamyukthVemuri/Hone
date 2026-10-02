---
type: governance concept
title: Production truth authorities and lifecycle states
description: How Hone keeps designed, implemented, merged, migration-applied, deployed, enabled, production-exercised and human-accepted states apart, which documents may assert mutable production facts, how to re-derive them, and where those records are already stale or contradict each other.
tags: [production-truth, lifecycle-states, migration-state, documentation-guards, release-records]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-02T22:34:57.394Z
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
generated: { by: "claude-code", at: "2026-10-02T22:34:57.394Z" }
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
[`docs/production/capability-register.md` § Status vocabulary](../../docs/production/capability-register.md#status-vocabulary).
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
  ([register § Status vocabulary](../../docs/production/capability-register.md#status-vocabulary);
  [current-state](../../docs/production/current-state.md)).
- **Usage is not acceptance.** `current-state.md` §15 lists features that are deployed and in
  some cases heavily exercised, yet still lack human acceptance; it explicitly forbids inferring
  acceptance from usage ([current-state § 15. Human acceptance still pending](../../docs/production/current-state.md#15-human-acceptance-still-pending)).
- **Merged is not deployed, and green CI is neither.** An open PR is never production; the
  durable test for "shipped" is ancestry of the production head, not a recorded SHA
  ([current-state § Open pull requests are not production](../../docs/production/current-state.md#open-pull-requests-are-not-production)).
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
([§ How to re-verify this document](../../docs/production/current-state.md#how-to-re-verify-this-document)):

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
fossil" ([§ How to re-verify this document](../../docs/production/current-state.md#how-to-re-verify-this-document)). Running any of
steps 2–4 is production access and is out of scope for routine agent work unless the operator
explicitly authorizes it.

## 4. Tenant classes

`current-state.md` §0 is the canonical classification of every production tenant
([§ 0. Tenant register](../../docs/production/current-state.md#0-tenant-register--real-controlled-test-synthetic)). Agents should reason in
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
  ([current-state § 2. Whole-session copy](../../docs/production/current-state.md#2-whole-session-copy)) — every dimension
  stated separately.
- **The durable new-client waitlist** is recorded as a *dated activation bound*, not a current
  posture, because persisted rows outlive the env flag that enabled them
  ([current-state § WAIT-02B Stage B1](../../docs/production/current-state.md#wait-02b-stage-b1--disclosure-shipped-and-since-acted-on-shipped--activation-taken);
  [guard L951-L998](../../tests/docs/canonical-production-facts.test.ts#L951-L998)).
- **NEW-CLIENT-MODE-01 (migration `0204`)** is recorded as *applied before deploy*, one studio
  persisted, the remaining studios unstamped and still governed by the env bridge **at that
  reading**, and several activation steps explicitly UNKNOWN rather than inferred
  ([current-state § NEW-CLIENT-MODE-01 release](../../docs/production/current-state.md#new-client-mode-01-release--what-actually-happened-on-2026-10-01)). See
  [New-client admission mode](../waitlist/new-client-admission-mode.md).

## 7. Contradictions and open questions

These are recorded as found on 2026-10-02 against branch `feat/openwiki-01` (head `b78a35a9`,
based on the production branch at `a98c0c85`). They are **not** reconciled here.

1. **`current-state.md`'s runtime pin is behind the production branch, by its own admission.**
   The reconciliation header pins `410e5039` (merge of #745) as both branch head and last
   runtime-bearing head at the 2026-09-21 sync
   ([§ Reconciliation header](../../docs/production/current-state.md#reconciliation-header)); the NEW-CLIENT-MODE-01 subsection
   then states production advanced past that pin (#773, #778, #777) and deliberately does not
   re-pin ([§ NEW-CLIENT-MODE-01 release](../../docs/production/current-state.md#new-client-mode-01-release--what-actually-happened-on-2026-10-01)).
   *Observation from this OpenWiki run (not a repository fact):* `git log --first-parent --merges
   410e5039..a98c0c85` lists 23 merges, and `git diff --name-only 410e5039 HEAD` includes files
   under `app/`, `lib/` and `components/`. Rule A3 asserts that nothing runtime-bearing changed
   since the pin, so it is **expected to fail on a full clone** until the document is re-pinned.
   The guard was not executed in this run (the worktree has no `node_modules`), and CI cannot
   observe the failure because Rule A skips on shallow checkouts (§5).
2. **Reconciliation dates differ across the canonical set.** `current-state.md` is a
   2026-09-20/21 sync with a 2026-10-01 release addendum; `capability-register.md` was reconciled
   2026-08-27 ([`capability-register.md`](../../docs/production/capability-register.md)); `known-limitations.md`
   records limitations verified as of 2026-08-27
   ([`known-limitations.md`](../../docs/production/known-limitations.md)); the ledger's current block is
   2026-10-01. A status present in the newest record may be absent or older in the register.
3. **`docs/15_DOCS_MAINTENANCE.md` contradicts the canonical record.** Its "How to avoid false
   claims" list (written 2026-07-27) still bans saying *"Whole-session copy is
   production-exercised"* and states the production migration max as `0157` "today"
   ([§ How to avoid false claims](../../docs/15_DOCS_MAINTENANCE.md#how-to-avoid-false-claims)), while `current-state.md` records
   whole-session copy as PRODUCTION EXERCISED with dated counts
   ([§ 2. Whole-session copy](../../docs/production/current-state.md#2-whole-session-copy),
   [§ 15. Human acceptance still pending](../../docs/production/current-state.md#15-human-acceptance-still-pending)) and the derived state is far
   above `0157`. That file is not among the documents the guard reads
   ([guard L404-L408](../../tests/docs/canonical-production-facts.test.ts#L404-L408),
   [L940-L949](../../tests/docs/canonical-production-facts.test.ts#L940-L949)).
4. **WAIT activation: "next work" vs "already taken".** `current-state.md` §16 item 5 still lists
   *WAIT-02B Stage B2 (activation)* as next work whose "authorization is not granted"
   ([§ 16. Next work](../../docs/production/current-state.md#16-next-work)), while L25 records that
   activation **was taken on or before 2026-08-25** and that the open item is only the missing
   governance record ([known-limitations § L25](../../docs/production/known-limitations.md#l25--the-durable-new-client-waitlist-is-deployed-dark-its-table-would-hold-prospect-pii-the-public-privacy-policy-does-not-disclose)).
   The guard's "pre-cutover instruction" rule matches specific enable / cutover /
   "before migration" phrasings
   ([L1191-L1229](../../tests/docs/canonical-production-facts.test.ts#L1191-L1229)), none of
   which item 5 uses, so it stays green.
5. **Tenant register count is stale.** The header and §0 classify **six** studios from a
   2026-08-23 measurement ([§ Reconciliation header](../../docs/production/current-state.md#reconciliation-header)), while the
   2026-10-01 `0204` apply record counts **seven** studio rows
   ([ledger § Current state](../../docs/production/migration-ledger.md#current-state-verified-2026-10-01-post-0204-apply-0204-applied-repo--hosted)) and `current-state.md` itself
   refers to "the other six" beside the one persisted studio
   ([§ NEW-CLIENT-MODE-01 release](../../docs/production/current-state.md#new-client-mode-01-release--what-actually-happened-on-2026-10-01)). One studio row is therefore not
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
