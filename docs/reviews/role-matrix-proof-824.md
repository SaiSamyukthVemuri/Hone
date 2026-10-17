# Role-matrix proof — #824 team/RBAC

**Status: SPEC. Evidence, never authority.** Nothing here is accepted until the
named test exists and has been run. Where a claim is unproven this document says
so rather than leaving a gap the reader fills in.

Base: `proof/role-matrix-824` off `feat/receptionist-scheduling-824` (`de68b7c7`),
the tip of the #838 stack. Chosen because **production has no receptionist role
at all** — `0216` (membership), `0218` (invitations) and `0220` (scheduling) are
all unmerged, so this proof cannot run on production and a proof that "passed"
there would be proving the absence of a feature.

---

## 1. What the outcome claims, and which limbs are decided

> A studio owner adds an electrologist or a receptionist; each signs in and does
> only their job (own schedule and charts; the front desk books but never sees
> clinical records); and the owner can see who did what.

| Limb | Status | Proven here |
|---|---|---|
| A — receptionist is denied clinical records | DECIDED | yes |
| B — receptionist is denied the client photo surface | DECIDED | yes |
| C — owner sees all (non-vacuity for A and B) | DECIDED | yes |
| D — practitioners **share** client clinical notes across providers | DECIDED (HON-44) | yes — see §5 |

**Limb D is DECIDED and PROVEN.** It was recorded here as
UNPROVEN-BECAUSE-UNDECIDED while the question was open. **HON-44 requires
practitioners to share client clinical notes across providers**, so the
`is_studio_member` read policy is the INTENDED law, not a gap — and the outcome
statement's "own schedule and charts" does **not** extend to notes. §5 cites the
proofs.

**The financial and receptionist restrictions are unchanged by this.** A
receptionist still reads no clinical row, and the owner-only financial surfaces
are untouched; HON-44 settles practitioner-to-practitioner note visibility only.

---

## 2. The denial mechanism, as it actually works

Worth stating because it changes what has to be proved: **the receptionist is
not denied by a receptionist-specific rule.** A receptionist has a membership
row and **no `practitioners` row** (`tests/db/receptionist-foundation.db.test.ts`:
*"has a membership row and NO practitioners row"*). Everything else follows from
that, through two independent planes:

**App plane.** For a page request the **middleware refuses first**:
`lib/supabase/middleware.ts:225-248` sends a receptionist's every non-front-desk
path to `/front-desk` (`NextResponse.redirect`). The route is never entered, so
**no signed URL is minted** — nothing in the page runs.

Behind it, `app/(app)/clients/[id]/images/page.tsx:40` calls
`requirePractitionerWithStudio()`, which resolves an **active practitioner**
membership and otherwise `redirect("/no-access")`
(`lib/supabase/queries.ts:251-278`). That is a real second barrier, and it is
the one that catches a request the middleware does not see — but for an ordinary
navigation it never runs. Measured, not assumed: see §4.7.

**Data plane.** The image actions in `app/(app)/clients/[id]/images/actions.ts`
are the plane a direct server-action POST hits, which is why the proof cannot
stop at the page. The write commands let the **database** derive the
practitioner from `auth.uid()`.

**Consequence for the signing limb:** there are exactly **two** places a signed
URL is minted — `images/page.tsx` (`createSignedUrl` at :119 and :150) and
`images/actions.ts` (`getTreatmentImageSignedUrlAction`, `createSignedUrl` at
:326). Both are server-side.

**The signing action has THREE barriers, in this order**, and naming them
correctly matters — an earlier draft of this spec credited the row read alone,
which would make a future RLS change look like it had broken a denial that
identity still enforces:

1. **Identity (primary).** `getTreatmentImageSignedUrlAction:286` calls
   `getCurrentPractitionerWithStudio()`, the *throwing* variant — correct for a
   server action, where a surrounding try/catch would swallow a redirect. For a
   membership of `none` it throws *"No active practitioner found for the
   signed-in user."* (`lib/supabase/queries.ts:218-220`). A receptionist stops
   here, before any query.
2. **The row read.** Studio-scoped (`.eq("studio_id", studio.id)`), not
   archived, and under RLS. `if (!row) return { ok: false }` — no row, no
   signature.
3. **Path binding.** `validateTreatmentImagePath` rejects a row whose bucket and
   path do not bind to the caller's studio and the row's client, before the
   service-role signer touches storage.

So the executable claims are: barrier 1 is pinned by source contract (§3.5-3.7)
and shown in the browser (§4.7); barrier 2 is proven in the database (§3.1).
**Denial at the minting step, never "the link is not on the page".**

---

## 3. Server-side tests (no build required; run on my own stack)

New file `tests/db/receptionist-photo-denial.db.test.ts`:

1. **The row read yields nothing.** As the receptionist, select
   `treatment_images` for the seeded client: zero rows. This is what makes
   `getTreatmentImageSignedUrlAction` unable to reach `createSignedUrl`.
2. **The write commands refuse.** `upload`, `note` and `archive` commands,
   called with the receptionist's identity, refuse — the practitioner is derived
   from `auth.uid()` and the receptionist has no practitioners row.
3. **NON-VACUITY (limb C).** The **owner** sees those same seeded rows and can
   reach the same commands. Without this, "the receptionist sees nothing" is
   indistinguishable from "there was nothing to see" — the control that
   `receptionist-foundation.db.test.ts` already gets right with *"the denial is
   not vacuous: the OWNER sees the seeded clinical rows"*.
4. **Storage plane — RLS BEHAVIOUR, not a policy-role count.** As the
   receptionist, select a seeded `storage.objects` row in the studio's folder:
   zero rows.

   **An earlier version counted policy roles instead** (`no authenticated
   policy may exist on storage.objects`) and that assertion was wrong in both
   directions, per Codex P2 4301919095: a leaking policy declared `TO public`
   has `roles = {public}` and would have **passed** it, while `0092`'s *safe*
   policy — `"treatment_images_objects: members select" … to authenticated
   using (bucket_id = 'treatment-images' and is_studio_member(folder[1]))`,
   created conditionally at `0092_treatment_images.sql:113-119` — would make it
   **fail** on any stack where the migration role can install it. It passed on
   my stack only because that creation was skipped there. Predicates decide
   access; role names do not.

   The receptionist's denial holds either way (`is_studio_member` is false for a
   non-practitioner, and with no authenticated policy nothing is readable). The
   **owner's** read is asserted only where that conditional policy actually
   installed, and the test says so rather than claiming a guarantee the stack
   may not provide.

   **MEASURED, under CI's exact conditions** (`supabase start -x studio,imgproxy,
   realtime,edge-runtime,logflare,vector,storage-api`):

   * `storage.objects` and `storage.buckets` **do exist**, and the
     `treatment-images` bucket is present — the storage *schema* comes from the
     database image, so excluding `storage-api` does not remove it. This is what
     makes the behavioural test runnable in a lane with no storage service.
   * **`0092`'s conditional policy did NOT install** — zero policies on
     `storage.objects`. So on this stack, and in CI, the owner case takes the
     **honestly-skipped** branch: it asserts that the owner reads nothing either,
     and states that the receptionist's denial is real but **not
     distinguishing** there.
   * Therefore the storage limb's non-vacuity is **NOT established in CI**. It
     is established only on a stack whose migration role can install that
     policy. The suite reports which case it is in; it never claims the stronger
     one.

   **Negative control, measured:** with a leaking `create policy … for select to
   public using (true)` on `storage.objects`, the receptionist's read returns the
   object and this test **fails**. The assertion it replaced — counting policies
   whose roles include `authenticated` — saw **0** under that same leak and would
   have **passed**. That is the defect Codex named, demonstrated rather than
   argued.

Source-contract test `tests/source-guards/photo-signing-sites.test.ts`:

5. **The minting sites stay two.** Pin that `createSignedUrl` for treatment
   images appears only in `images/page.tsx` and `images/actions.ts`. A third
   call site added later would silently bypass the reasoning in §2, and no
   runtime test would notice.
6. **The page keeps the redirecting guard.** Pin `requirePractitionerWithStudio`
   in `images/page.tsx` — not the throwing backstop, which a surrounding
   try/catch can swallow, and which does not gate a page at all.

---

## 4. Browser proof (needs the heavy-run slot)

New spec `e2e/receptionist-role-matrix.spec.ts`, on my own isolated stack,
paired guard on, `Hone-0162` untouched:

7. **Rendered denial.** Signed in as the receptionist, navigating to
   `/clients/<id>/images` is redirected to **`/front-desk`**, with no clinical
   heading rendered on the way past. The assertion walks the redirect chain back
   to its origin, so it cannot pass by the page simply never having moved.

   **The enforcing layer is the MIDDLEWARE, not the page guard.**
   `lib/supabase/middleware.ts:225-248`: *"a receptionist has NO practitioners
   row, so they arrive here with zero memberships. They may reach `/front-desk`
   and nothing else: every other path is sent to `/front-desk`"* —
   `NextResponse.redirect(deskUrl)`. Note that `middleware.ts` itself only
   **delegates** there; the receptionist branch is not in that file, which is
   why grepping it alone is misleading.

   So `requirePractitionerWithStudio()` → `/no-access` is a **second barrier
   that never runs for this request**, and that makes the denial *stronger* than
   a page-level refusal: the route is never entered, so nothing in it can mint a
   signed URL. `e2e/front-desk-booking.spec.ts` asserts `/front-desk` too, and
   **that expectation is correct** — for direct navigation as well as for login.

   **An earlier draft of this document claimed the opposite** (that `/no-access`
   was correct and `/front-desk` would be a false pass). That was wrong, it was
   corrected by running the spec, and it is recorded here because a proof
   document that misidentifies the enforcing layer teaches the next author to
   write the wrong assertion.

8. **Rendered clinical denial.** The same for a clinical record route.
9. **Owner sees it (non-vacuity, in the browser).** The owner reaches the same
   URLs and sees the seeded content, so the receptionist result is a denial and
   not a broken fixture.
10. **The front desk still works.** The receptionist can still book — the
    outcome is "does only their job", not "is locked out". `e2e/front-desk-booking.spec.ts`
    already covers the positive path; this proof must not contradict it.

**A browser assertion will not be used for the signing claim.** Per
[the recorded trap] a "no overflow"-style DOM assertion cannot fail inside a
clipped ancestor, and by the same logic an absent link proves nothing about
whether a URL could be minted. §3 carries that claim.

---

## 5. Limb D — DECIDED by HON-44, and already proven

**The product requirement (HON-44): practitioners share client clinical notes
across providers.** So the law below is intended, and a
practitioner-to-practitioner boundary is explicitly NOT wanted:

```sql
create policy "client_clinical_notes_member_select"
  on public.client_clinical_notes for select to authenticated
  using (public.is_studio_member(studio_id));
```

(`0126_client_clinical_notes.sql:146-149`. Only INSERT is author-scoped, via
`client_clinical_notes_author_insert`, so authorship is still attributed even
though reading is shared.)

**NO NEW TEST WAS WRITTEN, because all three claims are already proven** — and a
second copy would add no evidence while creating another place to keep true.
Each is cited by file and test name so a reviewer can verify in seconds:

| Claim | Proof |
|---|---|
| A practitioner reads **another** practitioner's note in the same studio | `tests/db/client-clinical-notes.db.test.ts:43` — *"an active practitioner records a consultation note; studio member reads it"*. The author is `a`; the reader is `aMember`, a **second** member of the same studio. Asserts `rowCount` 1 and the note's kind. |
| **Another studio's** practitioner cannot | same file, `:185` — *"studio B cannot READ studio A's notes (member SELECT is studio-scoped)"*. Asserts `rowCount` 0, with the test's own note that this is RLS filtering rather than a broken query. |
| A **receptionist** still cannot | `tests/db/receptionist-foundation.db.test.ts:172` — *"reads ZERO rows of S from EVERY public table that carries a studio_id"*. Generic over `information_schema` and asserting the table set exceeds 40, so `client_clinical_notes` is covered **by construction** rather than by being listed. |

**Non-vacuity is structural here, not bolted on.** The first row IS the positive
case that makes the second row's zero-rows meaningful — same table, same policy,
same suite. The receptionist row carries its own control at
`receptionist-foundation.db.test.ts:196`, *"the denial is not vacuous: the OWNER
sees the seeded clinical rows"*.

**Observed on this branch**: #904's `db integration (local supabase)` lane
passed green at `91166815`, and that lane applies the full migration chain from
scratch and runs both cited files. So these are not inherited claims read from
another tree — they executed here.

---

## 6. What this proof will NOT claim

- Nothing about production. Every limb runs against unmerged migrations.
- No claim that the receptionist role is *complete* — only that the boundaries
  asserted above hold on this stack.
- No security-review claim. #851's Codex state block recorded
  `security_review: null`; the same is assumed here unless one is run.
- No performance or load claim. Single synthetic observations.
