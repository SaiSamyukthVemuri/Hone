# Hone — IDOR / BOLA / object-authorization audit

**Audit base:** `8e1e50098e1a91fc53464bd5b61d2777c6357ef3` (production)
**Branch:** `security/idor-bola-audit`
**Worktree:** `/srv/hone/worktrees/security-idor-bola-audit`
**Method:** static census → live-database ground truth → behavioural negative controls with mutation proof
**Scope:** audit-first. No runtime fix was written. No migration was added or edited.

---

## 1. Executive verdict

**No P0. No P1.** I could not construct a cross-tenant read or write, a same-tenant
wrong-client clinical mutation, a cross-object payment action, or a service-role
IDOR against this tree.

The reason is structural rather than incidental. Hone does not authorize objects by
`id` at the application edge and hope RLS catches the rest. It pushes the whole
relationship into a small number of database **commands**, each of which re-derives
the actor from `auth.uid()` and re-proves the parent chain before writing. I verified
this against a real migrated database rather than by reading SQL text:

> **All 38 SECURITY DEFINER functions that a browser role can execute resolve their
> actor from `auth.uid()` — directly or through a helper. Zero exceptions.**
> Only 3 are reachable by `anon`, and all three are membership predicates that can
> only answer "no" when `auth.uid()` is NULL.

The two findings below are **P2 coverage defects, not live vulnerabilities**. Both
concern the repository's ability to *detect* a future regression of the exact class
it has already suffered twice (0129, 0164). The current state is correct; the
tripwire meant to keep it correct does not cover most of the surface it names.

| | |
|---|---|
| Object reference points censused | **118** |
| Service-role call sites | **202** across 96 files (264 query chains parsed) |
| Behavioural paths tested (new) | **17**, all passing, 6 proved load-bearing by mutation |
| P0 / P1 / P2 / P3 | **0 / 0 / 2 / 4** |

---

## 2. Object-reference census (Phase 1)

Every externally influenced identifier that crosses an authorization boundary.

| Ingress | Count | Notes |
|---|---|---|
| App Router dynamic segments | 12 | 6 are `[token]` routes (see §6) |
| Distinct FormData id keys | 29 | `client_id`, `session_id`, `attempt_id`, `entry_id`, `note_id`, `plan_id`, `image_id`… |
| Distinct RPC id arguments (`p_*_id`) | 41 | the command layer's parameters |
| Distinct typed server-action input ids | 36 | `input.imageId`, `input.blockId`, `input.sessionId`… |
| **Total distinct reference points** | **118** | |
| Route handlers | 11 | 5 cron, 2 Google, 1 Stripe webhook, 1 Twilio, 1 auth callback, 1 calendar feed |
| Server-action modules | 70 | |
| Files reading `searchParams` | 25 | none used as an authorization key (see §10) |

**Ingress classes and how each is resolved:**

| Class | Resolution | Verdict |
|---|---|---|
| Route `[id]` + `[sessionId]` | page re-proves `studio → client → session` before any child read | SAFE |
| FormData object ids | passed to a DB command that re-proves lineage | SAFE |
| FormData *context* ids (payment) | explicitly **untrusted**; used only for `revalidatePath` | SAFE |
| `[token]` routes | object is **derived from the token hash**; no id is accepted | SAFE by construction |
| Storage paths | server-constructed; a client path is never signed | SAFE |
| Stripe/webhook identifiers | correlated to Hone rows by provider id, never by browser input | SAFE |
| RPC arguments | the command re-derives the actor from `auth.uid()` | SAFE (proved, §4) |

---

## 3. Service-role census (Phase 3)

202 `createAdminClient()` call sites across 96 files. I parsed 264 query chains and
classified each by predicate.

| | |
|---|---|
| Chains carrying a tenant/owner predicate | 142 |
| Chains without one, **individually reviewed** | 122 |
| Genuine findings | **0** |

The 122 resolve into five legitimate shapes:

1. **Token-hash lookups** (`cancel`, `manage`, `reschedule`, `calendar-feed`,
   `portal/verify`) — the row IS the authorization result. There is no id to forge.
2. **Server-resolved ids** — `.eq("id", resolved.appointment_id)` where `resolved`
   came from the token lookup above. The id never touched the browser.
3. **Provider-correlated rows** — Stripe `payment_intent`/`charge` ids and Twilio
   message ids arriving on a signature-verified webhook.
4. **Admin console** (`/admin/**`) — separately gated, operator-only.
5. **Cron/worker claims** — `claim_*` commands invoked by scheduled routes.

**Money paths, specifically** (Phase 6 #7). I traced whether one session/client can
cause a payment action for another by substituting an id:

- `executeSessionPaymentChargeAction` — the form's `client_id`/`session_id` are
  documented as untrusted and used **only** for `revalidatePath`; the session is read
  from the attempt ROW, studio-scoped (`payment-actions.ts:477-487`).
- `sendPaymentChargeReceipt` — the recipient is derived from `attempt.client_id`,
  never from a route/form client. Substituting an attempt id sends *that* attempt's
  receipt to *that* attempt's own client. No cross-client disclosure.
- `refundPaymentChargeAttempt` — loads by id, then explicitly refuses
  `attempt.studio_id !== args.studioId`, **and** re-checks owner role inside the
  helper so a future caller cannot move money as a non-owner.

---

## 4. RLS / database boundary matrix (Phase 4)

Measured against a freshly migrated local database (0001 → 0191, 190 migrations,
92 tables, 458 public functions), not inferred from SQL text.

| Property | Result |
|---|---|
| Tables with RLS enabled | **92 / 92** |
| Live RLS policies | 87 across 50 tables |
| Policies naming `anon` | 2 — both INSERT-only on public marketing tables (`waitlist`, `demo_requests`) |
| Policies that are `using(true)` with no tenant predicate | **0** |
| Bare-column subquery comparisons (the 0126→0127 tautology class) | **0 surviving** |
| RLS-enabled tables with no policy | 42 — deny-all by default, reached only through commands |
| SECURITY DEFINER functions | 207 |
| …executable by `anon` (non-trigger) | **3** — `is_studio_member`, `is_studio_owner`, `session_is_visible` |
| …executable by `authenticated` (non-trigger) | 38 |
| …of those, **not** resolving the actor from `auth.uid()` | **0** |

**The choke point.** Nearly the whole clinical surface funnels through one function:

```sql
assert_session_writable(p_session_id, p_client_id) returns uuid
```

It requires `auth.uid()`; finds the session *and* proves the caller is an active
practitioner **of that session's own studio** (derived from the row, never passed in);
then requires `p_client_id` to equal the session's actual `client_id`. One generic
message covers "no such session", "another studio's session" and "not a practitioner",
so the error channel reveals nothing. `search_path` is pinned to `''`.

It is revoked from `public`, `anon`, `authenticated` **and** `service_role` — it is
callable only from inside the commands that delegate to it, never directly.

The composite-FK point from the mission brief is handled correctly: clinical tables
carry `(client_id, studio_id) → clients(id, studio_id)` composite foreign keys, which
prove same-studio structure. The repo does **not** mistake that for same-client
lineage — that is what the explicit `p_client_id` predicate is for.

---

## 5. Same-studio wrong-parent results (Phase 2 cases C, G, H)

This is the case RLS cannot close: every row involved is inside the caller's own
tenant, so a studio-scoped policy admits all of them. Only an explicit parent
predicate refuses. **Proved behaviourally, as a real `authenticated` caller.**

| Attack | Result |
|---|---|
| `set_next_session_note(A.session, A.otherClient)` | REFUSED — *"Session does not belong to that client"*; note unchanged |
| `set_session_price(A.session, A.otherClient)` | REFUSED; `price_paid_cents` still NULL |
| `soft_delete_session(A.session, A.otherClient)` | REFUSED; `deleted_at` still NULL |
| `archive_treatment_image(A.image, A.otherClient)` | NULL (generic); `deleted_at` still NULL |
| `set_treatment_image_note(A.image, A.otherClient)` | NULL (generic); note still NULL |
| clinical-note revision superseding another client's note | REFUSED by the 0126 trigger; victim note still un-superseded |
| **Baseline — same command, correct parent** | **SUCCEEDS** (proves the refusals are not blanket failure) |

The session commands refuse via `assert_session_writable`; the image commands via
their own `(id, studio_id, client_id, not-archived)` scoping inside 0168's RPCs; the
clinical note via the 0126 `BEFORE INSERT` trigger, which requires the superseded row
to match on **client, studio and kind** and runs as INVOKER so RLS hides other tenants.

---

## 6. Cross-studio results (Phase 2 case E)

Acting as a legitimate, active **owner** of studio A, submitting studio B's ids:

| Attack | Result |
|---|---|
| Write a clinical note onto B's session | REFUSED — *"not found or not writable"*; B's note unchanged |
| Soft-delete B's session | REFUSED; `deleted_at` still NULL |
| Archive B's treatment photo | NULL; `deleted_at` still NULL |
| Record a settlement against B's completed appointment | REFUSED; **zero** settlement rows created |
| Read B's session / client / image through RLS | **0 rows** for all three |

**Token surfaces are structurally immune.** `/cancel`, `/manage`, `/reschedule`,
`/intake`, `/portal/verify` and `/calendar-feed` accept **no object id at all**. The
raw token is hashed and matched against a stored `*_token_hash`; the object is the
*result* of that lookup. Magic links additionally carry `expires_at` and a conditional
single-use `consumed_at` stamp. There is nothing to substitute.

**Answering Phase 6 #6 directly:** possession of an invitation/proof token does not
expose an internal entry id, studio id, client id or contact hash — the raw token is
discarded after hashing and the resolved ids stay server-side.

---

## 7. Tested object matrix

Legend: ✅ proved behaviourally in this audit · ▣ proved by an existing suite ·
▢ reviewed by reading, not executed.

| Object family | A own | B ghost | C wrong client | D wrong practitioner | E other studio | F archived | G forged parent | H foreign child |
|---|---|---|---|---|---|---|---|---|
| sessions | ✅ | ✅ | ✅ | ▣ | ✅ | ▣ | ✅ | ✅ |
| session blocks / entries | ▣ | ▣ | ▣ | ▣ | ▣ | ▣ | ▣ | ▣ |
| treatment photos | ✅ | ✅ | ✅ | ▣ | ✅ | ✅ | ✅ | ✅ |
| clinical notes | ✅ | ▢ | ✅ | ▢ | ▣ | ▢ | ✅ | ✅ |
| appointment settlements | ▢ | ▢ | ▢ | ▣ | ✅ | ▢ | ✅ | ▢ |
| payment attempts / receipts / refunds | ▢ | ▢ | ▢ | ▣ | ▢ | ▢ | ▢ | ▢ |
| clients | ✅ | ▢ | n/a | ▢ | ✅ | ▣ | n/a | n/a |
| pinned / personal notes | ▢ | ▢ | ▢ | ▢ | ▢ | ▢ | ▢ | ▢ |
| waitlist entries / invitations | ▢ | ▢ | ▢ | ▣ | ▣ | ▢ | ▢ | ▢ |
| services / practitioners | ▢ | ▢ | n/a | ▢ | ▢ | ▢ | n/a | n/a |
| portal messages / replies | ▢ | ▢ | ▢ | n/a | ▢ | ▢ | ▢ | ▢ |
| intake forms | ▢ | ▢ | ▢ | ▢ | ▣ | ▢ | ▢ | ▢ |
| storage objects | ▢ | ▢ | ▢ | ▢ | ▢ | ▢ | ▢ | ▢ |
| calendar integrations | ▢ | ▢ | n/a | ▢ | ▢ | ▢ | ▢ | ▢ |

---

## 8. Findings

### P0 — none
### P1 — none

---

### P2-01 — the grant guard cannot see 37 of the 39 commands it exists to protect

| | |
|---|---|
| **ID** | P2-01 |
| **Severity** | P2 — missing regression coverage with a credible path |
| **Object** | every browser-callable SECURITY DEFINER command |
| **Entry point** | `tests/security/clinical-rpc-grant-guard.test.ts` |
| **Attack** | a future migration adds a command gated by a *helper* and omits the by-name revokes; nothing fails |
| **Authorization expected** | every authenticated-only command revokes EXECUTE from `public`, `anon`, `service_role` by name |
| **Authorization actual** | enforced for **2 of 39** live commands |
| **Real repro** | **yes — proved on the live local database** |
| **Data impact** | none today; the live ACL is correct (§4) |

**Root cause.** The guard's coverage predicate is a literal text match:

```js
requiresAuthUid: /if\s+auth\.uid\(\)\s+is\s+null\s+then/i.test(body)
```

Only a command with that **inline** guard is checked. But almost every command in
this repo delegates its actor check to a helper — `assert_session_writable`,
`session_actor_practitioner`, `is_studio_member`, `own_practitioner_in_studio`. Those
are *better* designs, and they all fall outside the guard.

Of 39 live `authenticated`-callable definer commands, **37 are invisible to it**,
including `record_appointment_settlement`, `waive_appointment_fee`,
`supersede_appointment_settlement`, `soft_delete_session` and every `set_session_*`.

Its revoke *detection* is also literal-only, so it cannot see the `DO`-block
`format()` loops used by 0134/0136/0137/0138/0140/0141/0150/0173/0178.

**The risk is live, not theoretical.** I created a definer function the way a
migration would, with no revokes, and executed it as `anon`:

```
ACL: {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
set role anon; select public._audit_probe_newcmd(...);  ->  reached
```

(Probe dropped; zero remaining.) `ALTER DEFAULT PRIVILEGES` for `postgres` in `public`
does grant EXECUTE to `anon`, exactly as CLAUDE.md states.

**Minimum safe fix.** Replace the textual predicate with the *live* invariant — the
set of `anon`-executable non-trigger definer functions must equal a pinned allowlist.
**Already written and passing** as `tests/db/idor-bola-object-authority.db.test.ts`
(§13). No runtime change required.

---

### P2-02 — the 0150 revoke assertion cannot fail

| | |
|---|---|
| **ID** | P2-02 |
| **Severity** | P2 |
| **Object** | the eight 0150 single-row schedule writers |
| **Entry point** | `tests/migrations/0150-single-row-schedule-writers-locked.test.ts:47-52` |
| **Attack** | add a 9th command to 0150, omit it from the revoke array — the test still passes |
| **Real repro** | yes (by inspection; the assertion is inert by construction) |
| **Data impact** | none today — the DO-block does revoke all eight correctly |

**Root cause.** The assertion interpolates a role but leaves `%s` unsubstituted:

```js
expect(SQL).toMatch(new RegExp(`revoke execute on function %s from ${role}`));
```

It passes only because the migration literally contains
`execute format('revoke execute on function %s from public', fn)`. So the test proves
*"the file contains a format() template of roughly this shape"* — never which
functions are in the loop's array. A command added to the file but omitted from the
array is undetectable.

This one cost me a false positive worth recording: the 0150 header states *"browser
roles are revoked"* while the file contains **zero** line-anchored grant/revoke
statements. I nearly filed it as a P1 anonymous-write finding. The revokes are real —
they are applied dynamically. **Static reading of this repository's ACLs is unsound in
both directions; only the live database is authoritative.**

**Minimum safe fix.** Assert the live privilege state (P2-01's fix covers it), or at
minimum assert the loop array contains every function the file defines.

---

### P3 findings

| ID | Finding | Why it is only P3 |
|---|---|---|
| **P3-01** | `supersedes_note_id` is passed from FormData into the insert with **no application-layer validation** (`clinical-notes-actions.ts:196`) | Fully closed by the 0126 trigger (proved in §5), but it is single-layered — every sibling path validates at both layers |
| **P3-02** | `getTreatmentImageSignedUrlAction` scopes by `id + studio_id` but **not** the route client, so any same-studio image can be signed | Consistent with the studio-wide roster model and grants no access a practitioner lacks by navigation — but it is asymmetric with `archiveTreatmentImageAction`, which deliberately **does** enforce client scope |
| **P3-03** | `revalidatePath(\`/clients/${clientId}/sessions/${sessionId}\`)` builds a cache path from unvalidated form input | Cache-invalidation only, template-constrained to `/clients/**`; no data crosses |
| **P3-04** | `removeClientPinnedNoteAction` deletes without a `.select("id")` row-affected check | Fails **closed** (deletes nothing); only the success message is imprecise |

---

## 9. Missing behavioural-test inventory

Before this audit: 25 of 149 DB suites seeded a second studio; 13 exercised a second
client in the same studio. The deeper gap was *how*: most drive their command through
`adminQuery` — the **service-role** connection — which bypasses RLS and never
exercises the actor gate at all.

Still untested behaviourally after this audit (▢ rows in §7), in priority order:

1. **Payment attempts / receipts / refunds** — reviewed by reading only. The
   wrong-object substitution case (`attempt_id` from another session) deserves a real
   two-client proof, especially `sendPaymentChargeReceiptAction`.
2. **Appointment settlements, cases C/G/H** — I proved case E only.
3. **Storage plane** — no test attempts to sign or fetch a forged/cross-tenant
   storage path against a running storage service.
4. **Portal messages/replies across two portal-authenticated clients** — the code is
   correct on inspection; no behavioural proof exists.
5. **Waitlist invitations, wrong-entry substitution** — owner-gated commands are well
   covered; recipient-side entry/invitation pairing is not.
6. **Intake forms, cases C/G/H.**
7. **Pinned / personal notes** — app-layer scoping only; no DB command backstop.

---

## 10. Areas proven safe, and why

- **Clinical charting** — one choke point (`assert_session_writable`) proves
  `studio → client → session`, and 0094 proves `block ∈ session` and
  `entry ∈ block ∈ session`, so validating session∈client makes the whole chain
  client-correct. Mutation-proved (§13).
- **Treatment photos** — upload validates client∈studio, block∈studio **and** derives
  the session *from the block* so a mismatched pair cannot be stored; a 0093 trigger is
  the structural backstop; the signer refuses any path not binding to the row's
  studio+client; the bucket is private and no client-supplied path is ever signed.
- **Token routes** — no object id is accepted; the object is derived from the token
  hash. IDOR is not merely blocked, it is unexpressible.
- **Money movement** — form context ids are explicitly untrusted; execution reads the
  attempt row; refund re-checks studio *and* owner role; receipts derive the recipient
  from the row.
- **Tenant identity** — always server-derived from the auth session; the selected-studio
  cookie is **re-validated** against the user's membership rows on every read, never
  trusted as a scope.
- **RLS** — 92/92 tables enabled, no tautologies, no permissive policies, `anon`
  reaches only two INSERT-only marketing tables.
- **`searchParams`** — 25 files read them; none uses one as an authorization key. The
  one that looks dangerous, `?chart=<blockId>`, is validated against the already-authorized
  session's live blocks and grants no access.

---

## 11. Areas NOT proven safe

Not "suspected unsafe" — **unproven**, and honestly labelled:

1. **Payments** — reviewed thoroughly by reading; no behavioural negative control
   written. This is the largest residual.
2. **Storage plane at runtime** — path *construction* and *validation* are proved by
   unit tests; no test exercises the real storage service with a forged path.
3. **Google Calendar / Twilio / Stripe webhook correlation** — I confirmed ids are
   provider-correlated and signature-gated, but did not attack them.
4. **`/admin/**`** — operator console, separately gated; audited only for shape.
5. **Cron routes** — authorization is a shared secret, not an object reference; out of
   this audit's frame.
6. **Concurrency** — every finding here is single-request. Interleaved
   authorize-then-mutate races were not attacked.
7. **Hosted production state** — never queried, per the brief. Everything above is
   true of the migration chain at `8e1e5009`; hosted max is declared in
   `docs/production/migration-state.json` and was not consulted.

---

## 12. Recommended repair order

1. **P2-01** — adopt the live-ACL invariant test. The file is written and passing;
   it needs a decision to keep it, not new work.
2. **P2-02** — fix or delete the inert `%s` assertion in the 0150 migration test. A
   test that cannot fail is worse than no test: it reads as coverage.
3. **P3-01** — add the `supersedes_note_id` parent check at the app layer for
   symmetry with every sibling path (the DB already refuses).
4. **§9 item 1** — write the payment wrong-object behavioural control.
5. **P3-02/03/04** — hardening only; batch them.

Nothing here blocks a release. No runtime change is required to close P2-01 or P2-02.

---

## 13. Exact negative controls used

**File:** `tests/db/idor-bola-object-authority.db.test.ts` (new, 407 lines, 17 tests).
Run: `npx vitest run --config vitest.db.config.ts tests/db/idor-bola-object-authority.db.test.ts`

Fixtures: studio A + studio B (each an active owner, backed by a local `auth.users`
row), a second client inside studio A, one session per studio, one treatment photo per
studio, one completed appointment in B. Every caller is a **real `authenticated`
session** via the harness's `asUser` (`set local role authenticated` +
`request.jwt.claims`) — the same way PostgREST presents a logged-in user.

**Result: 17/17 passing** against a pristine 0001→0191 chain.

The full DB lane was re-run with this file included: **150/150 files · 2713/2713
tests · 0 failures** (391s). Typecheck and lint are clean. Nothing regressed.

### Mutation proof — the controls are not vacuous

Each guard was mutated on the local database, the suite re-run, then restored and
verified byte-identical.

| # | Mutation | Tests turned RED |
|---|---|---|
| M1 | removed the `p_client_id` check from `assert_session_writable` | **3** — all same-studio wrong-client session tests |
| M2 | `grant execute on set_next_session_note to anon` | **1** — the ACL allowlist tripwire |
| M3 | removed both `t.client_id = p_client_id` predicates from `archive_treatment_image` | **1** — wrong-client photo archive |
| M4 | removed the cross-client rule from the 0126 clinical-note trigger | **1** — cross-client supersede |

M1 leaving the cross-tenant tests green is itself informative: those are closed by a
*different* limb (studio membership), exactly as designed.

A first attempt at M3 targeted an unaliased predicate and silently failed to apply; the
resulting all-green run proved nothing and was **discarded, not reported**. The
corrected mutation is the one recorded above.

### Database handling

All mutations were `CREATE OR REPLACE` against an **ephemeral local container**. No
migration file was edited at any point — `git diff` over `supabase/migrations/` is
empty, and `supabase/config.toml` is unchanged. Mid-audit a system-level event removed
my container (and two other lanes'); I restarted, re-reset to a pristine chain, and
re-ran the suite clean before recording any result.

---

## 14. Explicit limits of this audit

- **Static SQL reading is unsound here.** Nine migrations apply grants through
  `DO`/`format()` loops. Every ACL claim in this report comes from
  `has_function_privilege` against a live migrated database.
- **`auth.uid()` reachability is computed transitively** over the function call graph
  (fixpoint over "body mentions another public function"). A command that resolved its
  actor by some means naming no function would be misclassified. I found none.
- **Read-only on the app layer.** I proved the DB commands behaviourally; the
  TypeScript action layer was audited by reading, not by executing HTTP requests.
- **No production, no hosted database, no real Stripe/Resend/Twilio, no real client
  data.** Local stack only, enforced by the harness's non-localhost refusal.
- **Single-request reasoning.** No concurrency or TOCTOU attacks.
- **Not a cryptographic review** of token generation, and not an authentication audit
  (session fixation, JWT handling). Object authorization only.
- **`e2e-fault/[case]`** was noted and not pursued — it is a test-only fault-injection
  route.
- **Point-in-time.** True of `8e1e5009`. The P2s exist precisely because the repo
  cannot currently re-prove this automatically.
