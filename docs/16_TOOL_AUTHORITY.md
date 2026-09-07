# Tool authority

Which sources of truth may settle a question, and which may only raise one.

This document adds **no process**. It names an ordering the repository already
follows, so that a new tool cannot quietly acquire authority it was never
granted. It is governance only: nothing here runs, gates, or blocks.

**Its added ceremony does not apply to T0/T1 work** — roles, review mechanics
and evidence stamping. Its truth rules apply to any document that makes the
relevant claim, at any risk tier. See §7.

---

## 1. The rule

> **A claim is settled by the source able to observe it. Observation proposes;
> the matching authority disposes. And every claim is bound to the state it
> actually measured — never to the latest branch head by default.**

**There is no rank among the current-authority sources**, because they do not
answer the same question. Repository source cannot observe a live deployment; a
database catalog cannot observe provider configuration; a health probe cannot
observe what the code says. Asking a source something it structurally cannot see
does not yield a weaker answer, it yields **no** answer — and a ranking would
oblige you to prefer that non-answer over the source that can actually see the
claim. §2 states the matching; §6 applies it to a review finding.

What *is* ordered is **standing**, in three classes: a source that can observe
the claim may settle it, an observation may only raise it, and history may only
suggest where to look. Standing says who may speak; matching says about what.
The two axes are independent, so neither can outrank the other and there is no
precedence loop to resolve.

Staleness, not error, is the dominant failure mode. A correct answer read
against a state it did not measure is the most expensive kind of wrong, because
it still looks right.

The failure to prevent is **silent floating**: evidence measured against one
state being read as though it described another. That is not the same as "the
branch moved". A documentation commit advances the branch and changes neither
the deployed runtime nor the database, so it invalidates neither. Which state a
claim is anchored to is defined in §4.

---

## 2. Which source settles which claim

### CURRENT AUTHORITY — may settle a claim it can observe

Each row names the source that can *see* the claim beside it. **The rows are not
ranked against one another**: a row is authoritative for its own claim and
silent on every other, so two rows can never contradict each other about the
same question.

| Claim | Settled by |
|---|---|
| **Repository / source state** — what the code is | Repository source, read at an identified SHA |
| **Database state of a named instance** — what that database actually holds | Reviewed migration / schema / catalog evidence read from **that** instance, not inferred from a migration file |
| **That the selected lanes passed** | Exact-head CI / test evidence, at one head |
| **Live hosted / provider state** — what is deployed, serving, configured, or fired | Hosted deployment / provider evidence, at a stated time |
| **Reachability or health** | A fresh probe, inside its stated validity window |

**Explicit human production GO is permission, never evidence.** It authorizes an
action. It settles no factual claim in the table above, and no quantity of it
makes an unobserved state observed.

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
human ask a better question of **the source that can observe the claim** — which
for a hosted or provider finding is not repository source.

### HISTORY — may generate a hypothesis, never support a claim

- **Memory**
- **Old handoffs**
- **Old PR descriptions**
- **Archived reports**

...and **anything from the classes above whose `CLAIM_VALIDITY_KEY` has moved**
(§4). A claim drops to history when the state it measured is superseded — not
because some unrelated commit advanced a branch.

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

| Claim | CLAIM_VALIDITY_KEY | INVALIDATED_BY | FRESHNESS |
|---|---|---|---|
| **Runtime behaviour** | The identity of the deployment actually **serving** production | A **successful** deployment or promotion that changes the serving identity | Current while that deployment still serves |
| **Schema / migration state** | The observed instance + its applied migration identity | An apply to *that* instance | Current until that instance is applied to |
| **Mutable data state** — row counts, tenant counts, open-alert counts, current settings | The observed instance + **`observed_at`**, plus any data revision or event that changes with the fact | Ordinary DML, an authorized production write, or any such event | **Point-in-time.** Never current merely because migration max did not move |
| **Hosted — event fact** ("deployment X occurred") | The event identity | Nothing | **Permanently authoritative for the OCCURRENCE claim** — and it proves nothing about current state. See below |
| **Hosted — current config observation** | The config revision read | A config change superseding that revision | Current until superseded |
| **Hosted — health / reachability probe** | The probe + `observed_at` | Expiry of its stated freshness window | **Point-in-time, window must be stated** |
| **Hosted — current deployment identity** | The **resolved deployment ID**, or an alias→deployment mapping observed at a stated instant. **Never an alias alone** | A successful promotion or deployment that changes the resolved target | Current until the resolved target changes |
| **PR review** | The exact PR head SHA | Any push to that PR, including a docs-only one | Current only at that head |
| **Source claim — file-local** ("this file states X") | The **contents of the cited file**. The SHA it was read at is *provenance*, not the key | A change to that file's contents | Current at every SHA where those contents are unchanged |
| **Source claim — scan / absence** ("no direct writer exists", "this forbidden symbol never appears") | The **contents of every path the scan covered**, and the scope must be stated to be checkable | A change to the contents of **any** path in that scope — including one the claim never named, which is exactly how an absence is falsified | Current at every SHA where that whole scope is unchanged |
| **Source claim — behavioural** ("this route is owner-only") | The **contents of the named set of files the behaviour is assembled from** | A change to the contents of **any** member of that set — the cited file is not the whole of it | Current at every SHA where that whole set is unchanged |

**Occurrence authority is not current-state authority.** That an event happened
is settled permanently by the evidence of that event, and no later change makes
it un-happen. This is *not* the HISTORY class of §2 — history there means
*superseded* evidence, which may not settle a claim. An event fact is neither
superseded nor current-state evidence; it is authoritative for exactly one
question, **did X occur**, and for no other. It does not show that X is current,
that X is still serving, or that X is healthy now. Each of those is a separate
claim with its own row above.

**A source claim keys on everything it had to read to be true.** Only a
file-local assertion keys on one file. Two common claims do not, and both fail
the same way if they are treated as though they did.

An **absence** claim — the grep tripwire `ENGINEERING_STANDARDS.md` calls an
architectural tripwire, "no direct writer exists" or "this forbidden symbol
never appears" — is falsified by *adding* the symbol somewhere the claim never
mentioned. Its validity key is the **scan scope**, so the scope must be stated;
a tripwire that does not say what it searched cannot say what would invalidate
it.

A **behavioural** claim — "this route is owner-only because it imports an
authorization helper" — is assembled from the route *and* the helper. Editing
only the helper changes the behaviour while leaving the cited file untouched.

In both cases, keying on the cited file alone would leave the claim reading as
current after the thing it described had changed — the silent floating of §1,
reproduced inside the rule meant to prevent it. So each names the scope or set
it depended on, and drops to history when the **contents** of any member of that
scope or set change.

**The SHA is provenance; the contents are the key.** A source observation is
recorded *at* the SHA it was read at, and that SHA is what makes it reproducible
later. It is not what invalidates it. **Two SHAs at which every path in a
claim's relevant set is byte-identical are equivalent for that claim**, so an
unrelated docs commit — or any commit that does not touch the set — leaves the
observation **current** rather than dropping it to history. Keying on the head
SHA instead would invalidate every source claim on every commit, which is
exactly the "never bound to the latest branch head by default" of §1 broken by
the rule written to express it.

Naming the set is therefore not optional. A claim that does not say which paths
it depended on cannot be shown to be unchanged, and what cannot be shown
unchanged is history. The check is mechanical:

```
git diff --quiet <recorded-sha> <current-sha> -- <the claim's paths>
```

Exit 0 means the claim's relevant contents did not move, so the observation
survives the intervening commits and keeps the recorded SHA as its provenance.
Any other exit means it is history until re-measured.

This equivalence is **contents-only**, and it does not extend to the claim types
whose key is an instance, a deployment or an instant. A **PR review** still keys
on the exact head SHA and is invalidated by any push including a docs-only one:
a review is a statement about a whole head, not about a path set, so unchanged
files do not carry it forward.

**`ALIAS_NAME` is not `SERVING_DEPLOYMENT_IDENTITY`.** A promotion retargets a
stable alias rather than renaming it, so `hone.care` can keep its name while the
deployment behind it changes. Keying on the alias would leave the validity key
unchanged across exactly the transition it exists to detect — the same
wrong-fact error corrected for mutable data above. Key on the resolved
deployment ID, or on an alias→deployment mapping with the instant it was
observed.

**Merge is not proof that production moved.** A merge may *initiate* a runtime
transition; only a successful deployment completes one. A merge whose deployment
fails, or never receives traffic, leaves the previous deployment serving — and
evidence about that still-serving runtime remains current.
`docs/production/current-state.md` already separates these states explicitly
(*merged · DB applied · deployed · enabled · production exercised · human
accepted*), and records that a Vercel commit status was "the whole of the
evidence that a production deployment for this head succeeded".

**Schema identity does not vouch for data.** Tenant counts, row counts and
open-alert counts change through ordinary DML with no migration, so the instance
and its applied-migration identity are unchanged while the answer is not.
`current-state.md` already binds such figures to a measurement date and warns
when they were not re-measured; this table states that rule rather than
inventing one.

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
| **One owner per browser destructive resource** | Only the browser/E2E resources that cannot be isolated: destructive operations (a stack reset), reserved **singleton** fixtures, and any suite proven to share a non-isolated mutable resource. **The claim is held per contended resource, not as one global lock** — suites contending on *different* resources do not exclude each other (today: two independent fixed admin identities, below) | Claimed before *those* operations only, released when they finish. **Ordinary isolated E2E runs concurrently and needs no claim.** |

### Ordinary browser runs are not serialized

Concurrent E2E is a supported mode, not a hazard to be coordinated away.
`scripts/worktree-resources.mjs` derives a per-worktree app port, refuses server
reuse unconditionally, and makes an occupied port **fail loudly** rather than
attach to another worktree's server; `e2e/helpers/seed.ts` seeds run-unique
studios, rows and addresses for the fixtures that can carry one. A rule
requiring a claim before every browser run would serialize parallelism the
harness was deliberately built to provide.

**Port isolation is not database isolation, and run-uniqueness is a property of
the fixture rather than of the harness.** `worktree-resources.mjs` says so
itself — worktrees share one local Supabase stack and it "widens exactly one
integer and nothing else". The exceptions are therefore the fixtures that
*cannot* be run-scoped: `e2e/helpers/local-env.ts` allowlists exactly two admin
addresses, so `e2e@harness.local` and `e2e-operator@harness.local` are **fixed
identities** that every run must share. `e2e/quick-import.spec.ts` deactivates
the first address's practitioner rows in **every** studio — the statement
carries no `studio_id` predicate — before re-adding one, while
`seedOperatorAuthUser()` check-then-creates the second and then asserts it holds
no practitioner row. Concurrent runs therefore collide however far apart their
ports are: that is a demonstration, not a suspicion, and it is what the class
below is for.

**The two identities are independent, and so are their locks.**
`quick-import.spec.ts` touches only `e2e@harness.local`; `new-studio-wizard` and
`welcome-email-admin` touch only `e2e-operator@harness.local` — deliberately, as
`quick-import.spec.ts` records at its own definition. So `new-studio-wizard` and
`welcome-email-admin` exclude each other and `quick-import` excludes another
`quick-import`, but `quick-import` and `new-studio-wizard` may run at the same
time. Collapsing the two into a single lock because both are "fixed-identity
specs" would serialize runs that do not contend — the very over-serialization
this section exists to refuse, re-introduced one level down.

What still needs exclusive coordination is only what isolation cannot cover: a
destructive reset, a **reserved singleton** fixture that is shared by
construction, and any suite *demonstrated* to touch a non-isolated mutable
resource — the fixed-identity specs above are the currently known members of that
last class, under **two** independent identity locks rather than one.
"Demonstrated" is the bar — a suspicion is not a claim, and naming a member here
is a statement about those specs as they stand, not a standing licence to
serialize a suite on suspicion.

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
head, after CI settles. Its findings are questions for current
authority to answer. Silence from it is not proof of correctness, and a finding
from it is not proof of a defect until the authority *able to observe that
claim* confirms one.

**A review finding is an observation until it is adjudicated** — and it is
adjudicated by **the current-authority source capable of observing that
particular claim**. Repository source cannot confirm a live deployment identity;
a database catalog cannot confirm provider configuration or reachability.

This is **§2's matching applied to a finding, not a second rule**: the table
below selects the same observer §2 does, for the same reason. There is no rank
to fall back on if the match is inconvenient, because §1 does not define one.

| Claim | Settled by |
|---|---|
| Source claim | Repository source at the identified SHA |
| Database schema / data claim | The matching observed instance — catalog or query |
| Hosted deployment claim | Deployment / provider evidence |
| Health or reachability claim | A fresh probe, inside its stated validity window |

Human GO governs **actions**; it is not factual evidence about any of these.

How a confirmed finding is then dispositioned at release is governed by the
applicable engineering and release standard — **this document does not set that
standard and does not introduce one.**

> **DEFERRED_STANDARDS_CHANGE.** An earlier draft of this file carried a
> universal P2 release cutoff. It was removed: it was a new release gate, and
> `ENGINEERING_STANDARDS.md` §6 requires a new gate to name the distinct failure
> class it catches and to satisfy *pain before platform*. An authority-ordering
> document is the wrong vehicle to invent one. If Hone wants a permanent P2
> release standard, it belongs in a reviewed change to
> `ENGINEERING_STANDARDS.md` with that justification supplied.

---

## 7. T0 / T1 — ceremony is exempt, truth is not

**Exempt at T0/T1 — the added ceremony:**

```
T0 — docs / non-runtime:   the docs lanes CI already selects. Nothing else.
T1 — low-risk UI / local:  typecheck, lint, and the checks ci:plan selects.
                           No role claim. No reviewer. No evidence stamp.
```

**Not exempt at any tier — the truth rules.** Whenever a document makes a claim
about a deployment, a database, or a provider, it names `TARGET`,
`STATE/REVISION` and `EVIDENCE`, and it distinguishes CURRENT from HISTORY —
regardless of the risk tier of the change that writes it.

This distinction is load-bearing, not pedantic. A production reconciliation or a
migration apply record is **T0** by path classification, and is exactly the kind
of document that carries deployment and database claims. Exempting it from the
truth rules because it is low-risk would exempt the very artifacts those rules
exist for, and would let a stale handoff be cited as current authority.

A one-line UI edit acquires no paperwork from this, because it makes no such
claim.

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
| **Existing repository memory** | **Hardening** | History class, always. §3 applies without exception. |
| **Codex** | **Adopted — independent reviewer** | Observation class. Cannot block on its own authority. |
| **security-guidance** | **Provisional** | Advisory only. It must extend the single existing change classifier rather than become a second one, and its document must stay bound to that classifier by a parity check. |
