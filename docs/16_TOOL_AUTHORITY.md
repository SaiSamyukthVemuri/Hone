# Tool authority

Which sources of truth may settle a question, and which may only raise one.

This document adds **no process**. It names an ordering the repository already
follows, so that a new tool cannot quietly acquire authority it was never
granted. It is governance only: nothing here runs, gates, or blocks.

**It does not apply to T0/T1 work.** See §7.

---

## 1. The rule

> **Higher tiers always win. Observation proposes; current authority disposes.
> And every claim is bound to the state it actually measured — never to the
> latest branch head by default.**

Staleness, not error, is the dominant failure mode. A correct answer read
against a state it did not measure is the most expensive kind of wrong, because
it still looks right.

The failure to prevent is **silent floating**: evidence measured against one
state being read as though it described another. That is not the same as "the
branch moved". A documentation commit advances the branch and changes neither
the deployed runtime nor the database, so it invalidates neither. Which state a
claim is anchored to is defined in §4.

---

## 2. Canonical authority order

### CURRENT AUTHORITY — may settle a question

1. **Repository source at an identified SHA.** What the code is.
2. **Reviewed migration / schema / catalog evidence.** What the database
   actually holds — read from the catalog, not inferred from a migration file.
3. **Exact-head CI / test evidence.** That the selected lanes passed, at one head.
4. **Hosted deployment / provider evidence.** That something was deployed, served
   or fired, at a stated time.
5. **Explicit human production GO.** Permission. Never evidence.

**Database claims must name their target.** There is no blanket "catalog beats
source" rule, because a catalog describes *one instance* and cannot speak for a
different one. Every database claim states three things:

```
TARGET         = which database is being claimed about
STATE/REVISION = which state of it
EVIDENCE       = what was read, and from where
```

| TARGET | Authoritative evidence |
|---|---|
| **Repository-intended database state** | `supabase/migrations/**` at the reviewed repository SHA. A production or local catalog describes a different instance and does **not** override it. |
| **Observed local database instance** | The catalog of *that* local instance, at the stated time. |
| **Observed production database instance** | The hosted production catalog, or linked migration evidence, at the stated time. |
| **Next repository migration number** | The repository migration set, derived. **Never** a production catalog — production lags the repository by design. |

Catalog precedence applies **only** to claims about the instance actually
observed. This is the ordering `CLAUDE.md` §2 already uses: repository state is
*derived* from `supabase/migrations/*.sql`; hosted state is *declared* in
`docs/production/migration-state.json`. The two answer different questions and
neither overrides the other.

### OBSERVATION / REVIEW — may raise a question, never settle one

- **Codex** — independent exact-head reviewer.
- **security-guidance** — advisory classification of concern.
- **native blast-radius analysis** — reachability and impact scoping.
- **Archify** — structural representation at a pinned SHA.

None of these may block a merge on its own authority. Each exists to make a
human ask a better question of tier 1.

### HISTORY — may generate a hypothesis, never support a claim

- **Memory**
- **Old handoffs**
- **Old PR descriptions**
- **Archived reports**

...and **anything from the tiers above whose head has moved**.

---

## 3. Two boundaries that are absolute

**Memory is never current authority.** Memory records what was believed, when.
It may point at where to look. It may never be cited as evidence that something
is true now, and it is never "refreshed into authority" — re-reading a memory
does not promote it. If it names a file, function or flag, confirm that still
exists before acting.

**Architecture observation is never current authority.** A diagram, a call
graph, or a blast-radius report describes a structure as it was at a pinned SHA.
A rendered arrow is not an enforced constraint, and an absence in a graph is not
proof of absence in the system — only proof that the tool did not see it.

---

## 4. Claim validity

Every claim carries a **validity key** — the identity of the state it measured.
A claim is current while its validity key still describes the thing being
asked about, and becomes history when that key moves. The key is **not** the
latest branch head; different claims have different anchors.

| Claim | CLAIM_VALIDITY_KEY | Moved by |
|---|---|---|
| Runtime behaviour | The runtime-bearing application SHA / deployment | A merge that changes deployed files, or a deploy |
| Database state | The observed database instance + its applied migration identity | An apply to *that* instance |
| Provider / hosted state | The provider observation + its timestamp and config identity | Time, or a config change |
| PR review | The exact PR head SHA | Any push to that PR, including a docs-only one |
| Source claim | The source SHA | Any commit touching the cited source |

**A docs-only commit does not invalidate a still-current deployment or database
observation.** The branch advancing is not, by itself, a change of runtime or of
schema. `docs/production/current-state.md` already works this way — it pins
*"the last runtime-bearing baseline, not its own documentation commit"*, and
records branch merges that were documentation, CI and tests only as **not**
moving that baseline. This document follows that practice rather than
contradicting it.

What is forbidden is the opposite error: reading evidence against a state it did
not measure. A review at one PR head says nothing about the next; a catalog read
of one instance says nothing about another.

A cancelled or timed-out lane is **not** green. It is `UNKNOWN`, and the honest
next step is to check what it completed before concluding anything about the
diff.

---

## 5. Single-owner roles

Four resources cannot be shared. One owner each, claimed explicitly, released
explicitly. **Every handoff states the exact head**, because the head — not the
claim — is what decays.

| Role | Owns | Handoff |
|---|---|---|
| **One production mover** | Only operations that can actually move production state — see below | Claim is exclusive **for those operations only**. Release states branch, exact head, and evidence state. The successor re-fetches and re-verifies the base before acting: it may have moved. |
| **One migration-number owner** | The next free migration number | Never hard-coded; derived at authoring time. A number is claimed when the file is committed. An applied migration is frozen — a correction is a new migration, never an edit. |
| **One shared-DB owner** | The shared local database stack | Claimed before any reset, because a reset is destructive to every other worktree. Released explicitly; after release, no further reset without re-authorization. |
| **One browser-stack owner** | The local browser/E2E stack and its reserved singleton fixtures | Claimed before a run, released when the last lane exits. Per-worktree ports are derived, not registered; reserved singleton fixtures are shared and cannot be. |

### What counts as moving production

**Serialized** — these can change what production is or runs:

- merging to the auto-deploying production branch (the merge is the deploying
  act: *"Merge the PR only after verification passes. Vercel deploys the
  production branch HEAD."*);
- an explicit production deploy or promotion;
- a production migration apply;
- any other provider or hosted activation that changes production.

**Not serialized** — these cannot move production on their own:

- pushing a feature branch;
- updating a pull request;
- preview deploys;
- ordinary local commits.

Conflating these would make every unrelated feature push an exclusive
production operation, and would obscure which act actually needs production
authorization. Per-change authorization for production writes, and exact-head
authorization for merge, remain as `CLAUDE.md` already states them. A
non-serialized action that *independently* mutates a shared production resource
is serialized by that fact, not by being a push.

---

## 6. Review

**Codex is an independent reviewer, not a source of authority.** One request per
head, after CI settles. Its findings are questions for tier 1 to answer. Silence
from it is not proof of correctness, and a finding from it is not proof of a
defect until tier 1 or 2 confirms one.

**A review finding is an observation until it is adjudicated.** Codex, guidance
and analysis output are candidate defects, not defects; they become findings
with a disposition only once tier 1 or 2 confirms one. How a confirmed finding
is then dispositioned at release is governed by the applicable engineering and
release standard — **this document does not set that standard and does not
introduce one.**

> **DEFERRED_STANDARDS_CHANGE.** An earlier draft of this file carried a
> universal P2 release cutoff. It was removed: it was a new release gate, and
> `ENGINEERING_STANDARDS.md` §6 requires a new gate to name the distinct failure
> class it catches and to satisfy *pain before platform*. An authority-ordering
> document is the wrong vehicle to invent one. If Hone wants a permanent P2
> release standard, it belongs in a reviewed change to
> `ENGINEERING_STANDARDS.md` with that justification supplied.

---

## 7. T0 / T1 — this document does not apply

None of the above adds a step to low-risk work.

```
T0 — docs / non-runtime:   the docs lanes CI already selects. Nothing else.
T1 — low-risk UI / local:  typecheck, lint, and the checks ci:plan selects.
                           No role claim. No reviewer. No evidence stamp.
```

Escalate when the *behaviour* crosses a higher boundary. Path classification
cannot see what a file does, so it may raise a tier and may never lower one.

`ENGINEERING_STANDARDS.md` §6 is *pain before platform*. If following this
document adds ceremony to a T1 change, the document is being misapplied.

---

## 8. Tool status

Status is recorded here because a rejected or provisional tool that leaves no
record gets silently re-proposed later. Adoption state itself lives in the pull
request that changes it; this table states the **standing constraint**.

| Tool | Status | Constraint |
|---|---|---|
| **Graphify** | **Rejected — current implementation** | Its reachability answers cannot be falsified across the boundaries that carry this system's real edges. Not to be re-proposed without that gap closed. |
| **Native blast-radius analysis** | **Pilot — not authority** | May scope work. May not be cited as evidence of impact or of absence. |
| **Archify** | **Pilot passed provisionally; adoption contract pending** | Not citable as evidence until its adoption contract lands. A pinned SHA is what makes a diagram checkable. |
| **Claude-Mem** | **Not adopted** | — |
| **Existing repository memory** | **Hardening** | History tier, always. §3 applies without exception. |
| **Codex** | **Adopted — independent reviewer** | Observation tier. Cannot block on its own authority. |
| **security-guidance** | **Provisional** | Advisory only. It must extend the single existing change classifier rather than become a second one, and its document must stay bound to that classifier by a parity check. |
