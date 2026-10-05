# Hone engineering standards

Canonical. `CLAUDE.md` and `CONTRIBUTING.md` point here; they do not restate it.

Hone optimises for **maximum safety per minute of engineering effort**. Security
and speed are both engineering requirements: low-risk work should get faster,
trust-boundary work should keep deep evidence.

Every proposed gate must answer: **what distinct failure class does this catch
that an existing control does not?** No concrete answer, no gate.

---

## 1. Four gates

1. **Correctness** — does it work, and are the business and security invariants
   actually *enforced* rather than merely implied by the UI?
2. **Security + operability** — if it fails in production, will Hone detect it?
   Is the failure truthful? Is recovery safe? Is rollback / fail-closed
   behaviour understood?
3. **Maintainability** — does it leave one current architecture, appropriate
   tests, current comments and docs, least privilege, and no obsolete escape
   hatch?
4. **Speed** — was the minimum justified ceremony used? Did it make future work
   easier rather than adding permanent process?

## 2. Risk tiers

Depth of validation follows risk, not habit.

**T0 — documentation / non-runtime.** Docs, typos, non-runtime comments,
non-behavioural copy. *Validation:* focused checks, normal CI. Does **not**
require a DB reset, a deployment-skew matrix, negative controls, or broad
security review.

**T1 — low-risk UI / local product behaviour.** Layout, styling, display-only
component behaviour. *Validation:* a focused unit or component test, targeted
browser coverage when useful, normal CI. Does **not** automatically require DB
integration, migration review, negative-control campaigns, or cross-command
concurrency review.

**T2 — business workflow / integration.** Booking, sessions, calendar,
notifications, background jobs, rebooking, stateful workflow, external
messaging. *Validation:* behavioural tests, integration coverage where useful,
cross-feature interaction reasoning, observability impact, deployment
considerations where applicable.

**T3 — trust boundary / high risk.** Authentication, authorization, tenancy,
RLS, `service_role`, privileged mutation, payments and Stripe authority,
migrations, destructive operations, security boundaries, sensitive-data
handling, external-side-effect state machines, DB privilege changes.
*Validation, as applicable:* real DB tests, concurrency tests, negative
controls, privilege closure, deployment-skew analysis, independent review,
controlled rollout, production preflight.

**B8-level ceremony is not the default for T0/T1.** Applying it there without
naming a higher-risk failure class is a defect in the process, not caution.

## 3. Automated classification is not semantic proof

Automated risk classification is a baseline, not semantic proof. The classifier
uses deterministic repository signals such as paths and change categories; it
cannot detect higher-risk behavior hidden inside otherwise low-risk-looking
files. Every implementation session and reviewer is expected to perform semantic
risk judgment and escalate when warranted. Automated classification may never be
cited as justification for de-escalating a change whose actual behavior crosses
a higher-risk boundary.

Example: `components/foo.tsx` classifies as T1. If it begins invoking a
destructive or privileged server operation, semantic review must escalate it to
T3. This is an intentional limitation of path-based classification —
`scripts/classify-changes.mjs` will never solve it.

## 4. Proof

**Test hierarchy**, preferred order when behaviour is reasonably testable:
real database behaviour → real server/action behaviour → component behaviour →
browser E2E → source/static contract test.

Source and grep tests are architectural **tripwires**. They are right for
properties like "no direct writer exists" or "this forbidden symbol never
appears", and wrong as a substitute for behavioural proof when the behaviour can
be tested.

**Anti-vacuity.** For an important absence claim — zero writers, no privilege,
no calls, no mutations, no rows, no fallback — also prove the *detector* works:
the scanner finds other known writes, the parser demonstrably reaches the target
file, a fake would permit the forbidden operation if attempted, or a deliberate
mutant turns the intended test RED. Trivial tests need none of this.

**Negative controls.** For critical T3 and selected T2 invariants: deliberately
break the rule, require the intended proof to turn RED, restore exactly. One or
two high-value controls is usually enough. NC1–NC11 campaigns are exceptional,
not routine.

**Green CI is necessary, not sufficient.** CI proves what was encoded;
independent review asks whether the right things were encoded. For appropriate
T3 work: implementation → local proof → CI → independent review → production
preflight → controlled rollout. Do not impose that sequence on T0/T1.

**Portability.** A test must not require full developer git history, developer
caches, machine-global state, local-only files, or network access unless it is
deliberately an integration test. A test that passes only in one developer
checkout is not portable proof.

**Disputed regressions.** Do not say "probably pre-existing." When provenance
materially matters, compare against the exact production SHA. Ordinary PRs do
not need this.

## 5. Design rules for risky work

**Cross-system review (stateful T2/T3).** Ask: *what other command or workflow
can modify this object while this operation is in flight?* Consider payments,
cancellation, rescheduling, appointment repair, sessions, postcare, calendar
sync, deletion, background jobs and external providers. Individually correct
systems still interact.

**External side effects.** External provider truth is not the same as Hone
persisted truth. Prefer **claim → external side effect → settle**. Do not
automatically retry an uncertain provider-success state when the retry could
duplicate the external action.

**Database authority.** UI explains, the application orchestrates, the database
enforces where appropriate. `service_role` is transport privilege, not
permission to invent business truth. Boundary migrations follow: introduce the
governed command → migrate callers → prove old writers are zero → revoke the old
privilege. Adding a command without closing the obsolete escape hatch is not
boundary completion unless the exception is explicitly temporary.

**Deployment skew.** For DB/app contract changes, consider old app + old DB, new
app + old DB, old app + new DB, new app + new DB, and choose rollout order
intentionally. Skip this when the change cannot produce skew.

**One canonical owner per fact.** Historical artifacts own historical
invariants, never mutable future facts — a historical migration test does not
own future migration numbers. Avoid several docs or tests independently
restating the same mutable state.

**Comments match current architecture.** Architecture-changing work removes
stale comments describing the retired design. Code, tests and comments tell one
current story.

**Observability.** Hone already has observability infrastructure; the answer is
never "add Sentry". For meaningful T2/T3 work ask: what existing telemetry
proves this works, what detects failure, could that telemetry carry sensitive
information, does this affect an SLO or actionable alert, and is recovery
understood? Formal SLOs, alert thresholds, runbooks, release health, synthetic
monitoring, incident severity and postmortems are future maturity, not current
requirements.

## 6. Pain before platform

Pain before platform. Before adding new internal engineering automation or
process infrastructure, identify at least two concrete occasions where the
missing capability caused meaningful wasted engineering time, risk, or a real
defect.

Record candidate occasions when they happen in the originating PR under
`Engineering friction / repeated manual work`. At the Engineering OS
re-evaluation checkpoint, use those recorded PR examples as evidence rather than
reconstructing pain from memory.

**Foundational exceptions.** The two-occurrence requirement does not apply to
secret scanning, authentication / authorization enforcement, credential or key
protection, or migration-integrity controls. That list is exhaustive. Anything
outside it claiming an exception must state, in one explicit sentence in the PR,
(1) the failure class and (2) why waiting for two observed occasions would
create unacceptable risk.

## 7. Re-evaluation

After 5–10 substantive PRs spanning at least two risk tiers, review the actual
`Engineering friction / repeated manual work` evidence recorded in those PRs and
ask: what did engineers or Claude repeatedly reconstruct manually? What consumed
meaningful time? What caused avoidable errors? What did classification
repeatedly miss? Which process steps added little value? Did low-risk PRs get
faster? Did high-risk PRs keep the right safeguards?

Only repeated, evidenced pain earns new process or tooling.

## 8. Delivering a pull request

`npm run eng -- shepherd <pr>` OBSERVES a pull request at its exact head and
recommends one next step - CANDIDATE_READY_FOR_HUMAN_REVIEW, WAITING,
ACTION_RECOMMENDED, BLOCKED, ESCALATE or CLOSED; `--watch` polls, bounded, until
that changes. Read it instead of reconstructing delivery state from screenshots,
but its output is **advisory** until an explicit authority re-entry decision
(`docs/decisions/eng-loop-01-observation-only.md`). The delivery rules stay with
people and the existing release procedure:

- **History is only ever added to.** New commits go on top; production comes in
  with a normal merge commit. Never rebase, amend, squash or force-push, and
  never merge a PR from a loop. The shepherd only reads.
- **New commits invalidate exact-head review.** Only a trusted Codex verdict for
  the current exact head counts; one for any other head - including the head
  before a production refresh - is stale.
- **No state the shepherd reports is authorization.**
  CANDIDATE_READY_FOR_HUMAN_REVIEW means every mechanical check holds at the
  head; the merge decision stays the operator's. Neither green CI nor that state
  authorizes a merge.
- **UNKNOWN never counts as clean.** A surface that cannot be read, or reads
  malformed, keeps a PR from candidacy; it is reported, never defaulted.
- **External checks can only hold a PR back.** CI is the latest Actions run for
  the exact head; an external check or status (Vercel's, say) that fails or is
  pending holds the PR, but a passing one never makes it a candidate.
- **The §7.4 stop law binds people, not the tool.** The shepherd recommends
  ESCALATE when consecutive P0-P2 review rounds or red CI heads pass the tier's
  repair budget; the operator decides what follows.
- **Root-cause families stay a human judgement.** With two or more fresh
  findings, that check is owed before any patch; no tool makes it.
