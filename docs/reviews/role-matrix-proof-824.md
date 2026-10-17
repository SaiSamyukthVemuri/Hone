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
| D — a practitioner sees **only their own** schedule and charts | **UNDECIDED** | **no — see §5** |

**Limb D is UNPROVEN BECAUSE UNDECIDED, not because a test was skipped.** It is
with Sam. §5 states the current law exactly.

---

## 2. The denial mechanism, as it actually works

Worth stating because it changes what has to be proved: **the receptionist is
not denied by a receptionist-specific rule.** A receptionist has a membership
row and **no `practitioners` row** (`tests/db/receptionist-foundation.db.test.ts`:
*"has a membership row and NO practitioners row"*). Everything else follows from
that, through two independent planes:

**App plane.** `app/(app)/clients/[id]/images/page.tsx:40` calls
`requirePractitionerWithStudio()`. In `lib/supabase/queries.ts:251-278` that
resolves an **active practitioner** membership and, when there is none,
`redirect("/no-access")` — the invite-only gate. A receptionist therefore never
reaches the page body, so **no signed URL is minted**: the redirect precedes
every storage call.

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
4. **Storage plane.** No `authenticated` policy exists on the
   `treatment-images` bucket, so objects are reachable only by server signing
   (already asserted in `receptionist-foundation.db.test.ts`; re-asserted here
   against this stack so the photo claim does not depend on a different file's
   fixture).

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
   `/clients/<id>/images` lands on `/no-access` — the user-visible half of §2 —
   with no clinical heading, no `img` for the seeded id, and a visible link to
   `/front-desk`, so it is a **role** redirect and not a dead end.

   **The trap, verified by reading the chain rather than assuming it:** there is
   **no receptionist logic in `middleware.ts`**. The denial is
   `requirePractitionerWithStudio()` → `redirect("/no-access")`, and
   `/no-access` then *renders* a front-desk link (it only auto-redirects a
   **practitioner**, to `/dashboard`). Separately, **login** lands a
   receptionist on `/front-desk` because `auth/callback` routes them there. So
   `/front-desk` is the right assertion for the login flow and the **wrong** one
   for a direct navigation — asserting it here would pass while the gate did
   nothing. `e2e/front-desk-booking.spec.ts` asserts `/front-desk` correctly,
   for the login flow; do not copy that expectation into this one.
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

## 5. Limb D — the open decision, stated exactly

Current law, read at `de68b7c7`:

```
create policy "client_clinical_notes_member_select"
  using (public.is_studio_member(studio_id));
```

**Any studio member may read every clinical note in the studio.** Only INSERT is
author-scoped (`client_clinical_notes_author_insert`). So today a practitioner
*does* read another practitioner's notes, by design of this policy.

Therefore "a practitioner sees only their own charts" is **not a missing test —
it is a different product law.** Restricting it would change behaviour for every
existing multi-practitioner studio. The decision is Sam's; this proof neither
implements nor assumes it, and **must not be read as evidence that a
practitioner-to-practitioner boundary exists.**

---

## 6. What this proof will NOT claim

- Nothing about production. Every limb runs against unmerged migrations.
- No claim that the receptionist role is *complete* — only that the boundaries
  asserted above hold on this stack.
- No security-review claim. #851's Codex state block recorded
  `security_review: null`; the same is assumed here unless one is run.
- No performance or load claim. Single synthetic observations.
