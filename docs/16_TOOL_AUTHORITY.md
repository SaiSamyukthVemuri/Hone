# Tool authority

Which sources of truth may settle a question, and which may only raise one.

This document adds **no process**. It names an ordering the repository already
follows, so that a new tool cannot quietly acquire authority it was never
granted. It is governance only: nothing here runs, gates, or blocks.

**It does not apply to T0/T1 work.** See §7.

---

## 1. The rule

> **Higher tiers always win. Observation proposes; current authority disposes.
> And every claim is bound to the SHA it was made at — a claim whose SHA is not
> the current head is history, not evidence.**

Staleness, not error, is the dominant failure mode. A correct answer read after
its head moved is the most expensive kind of wrong, because it still looks
right. So no tool is trusted on its own account; heads are trusted.

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

Where 1 and 2 disagree, 2 wins for questions about the database: a migration
file states intent, the catalog states fact.

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

## 4. Exact-head evidence

Evidence is **exact-head** when the SHA it was produced against is the SHA now
under consideration. Otherwise it is history, automatically, without argument.

**Invalidation:**

| Event | Invalidates |
|---|---|
| Any code change (including a test-only change) | Stale exact-head review, and any CI or browser evidence taken before it |
| Production moving | Every hosted-state claim pinned to the previous ref |
| A migration apply | Any earlier migration-max claim |
| A new review finding | Any prior clean-review claim at that head |

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
| **One production mover** | Push / merge / apply / deploy | Claim is exclusive. Release states branch, exact head, and evidence state. The successor re-fetches and re-verifies the base before acting: it may have moved. |
| **One migration-number owner** | The next free migration number | Never hard-coded; derived at authoring time. A number is claimed when the file is committed. An applied migration is frozen — a correction is a new migration, never an edit. |
| **One shared-DB owner** | The shared local database stack | Claimed before any reset, because a reset is destructive to every other worktree. Released explicitly; after release, no further reset without re-authorization. |
| **One browser-stack owner** | The local browser/E2E stack and its reserved singleton fixtures | Claimed before a run, released when the last lane exits. Per-worktree ports are derived, not registered; reserved singleton fixtures are shared and cannot be. |

---

## 6. Review and release

**Codex is an independent reviewer, not a source of authority.** One request per
head, after CI settles. Its findings are questions for tier 1 to answer. Silence
from it is not proof of correctness, and a finding from it is not proof of a
defect until tier 1 or 2 confirms one.

**P2 release cutoff.** A confirmed P2 does not ship unresolved without an
explicit, recorded scope call naming who accepted it and why. "Not yet
investigated" is not a scope call.

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
