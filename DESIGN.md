# Hone — design contract

**Canonical for design decisions.** Subordinate to
[ENGINEERING_STANDARDS.md](./ENGINEERING_STANDARDS.md); where they disagree, the
standards win. [CLAUDE.md](./CLAUDE.md) governs delivery; this file governs what
the product should look like and how it should behave.

This is an **operating contract**, not an argument. It says how Hone must be
designed and what an agent must never do. The evidence and reasoning live in
[docs/reviews/product-wide-design-audit-2026-09.md](./docs/reviews/product-wide-design-audit-2026-09.md)
— *measurements, diagnosis, and a proposed programme* — and are deliberately not
restated here. **That audit is evidence and proposal. It is not authority.**
Nothing in it becomes a rule by being written down; it becomes a rule by
appearing here as a LAW, or in the canonical roadmap as scheduled work.

---

## North star

**Clinical calm, operational speed.**

A practitioner is mid-treatment, gloved, and glancing. The product must be quiet
enough to think beside, and fast enough not to be waited on. Calm is not
emptiness and speed is not density — a surface that says nothing about what
matters most is neither calm nor fast, it is merely undecided.

*(Operator-stated product direction, recorded here. It does not originate in an
earlier document.)*

---

## How to read this file

| Tag | Meaning | May an agent act on it? |
|---|---|---|
| **`[LAW]`** | A durable design outcome. Survives any rewrite of the code that satisfies it. | **Yes — always binding.** |
| **`[CONTRACT]`** | The current Hone mechanism that satisfies a law. Replaceable. | **Yes — use it; do not hand-roll around it.** |
| **`[PILOT]`** | A bounded, falsifiable experiment with a stated question. | Only its stated scope. Never generalise it. |
| **`[PRODUCT AUTHORITY REQUIRED]`** | Not decided. | **No.** Propose; never implement. |

**A CONTRACT may be replaced without weakening its LAW.** When a better mechanism
arrives, the contract row changes and the law does not.

**Never promote a component name into a law.** `Button` is not a law; *"every
control acknowledges immediately"* is. If a law names a file, it has been written
wrongly.

---

## `[LAW]` — the durable rules

**Hierarchy and composition**

1. **Type carries hierarchy before containers do.** Importance is expressed by
   size, weight and spacing first. A border is not a substitute for a decision
   about what matters. A surface where everything is one weight has not been
   designed.
2. **Mobile is recomposed, not compressed.** A phone layout is a different
   composition of the same information, not the desktop one scaled down with
   things hidden.
3. **Density is chosen by input capability, not by screen width.** A fine pointer
   earns tighter targets; a narrow window does not.

**Interaction**

4. **Every control acknowledges immediately.** A press is confirmed before its
   result arrives. A control that has been activated must never look idle.
5. **Every interactive target meets the touch floor wherever the pointer is not
   known to be fine.** The floor travels with the control, not with the page. A
   fine pointer may earn a compact target by **explicit opt-in**, never by
   default — which is LAW 3 applied, not an exception to this one. *An earlier
   draft said "on every pointer"; that contradicted both LAW 3 and the shipped
   `sm` size, and is corrected here.*
6. **Focus must be visible and must survive.** Keyboard focus is always rendered,
   and rendering must not depend on colour the user's system may override.
7. **A user-facing refusal names the condition, never the internal code.** The
   person is told what is true and what they can do. Internal vocabulary —
   status codes, table names, round identifiers — never reaches a practitioner
   or a client.
8. **A control's label may only promise what its command actually delivers.**

**Colour and meaning**

9. **Tone belongs to the system; meaning belongs to the caller.** A primitive owns
   shape, spacing and type. What a state *means* is the caller's to say.
10. **Identity colour is data, never a semantic token.** Practitioner and service
    colours are values the studio chose; they never borrow success/warning/danger.
11. **Clinical caution is a patient-safety distinction, not a styling one.**
    Allergies and cautions are rendered in the clinical-caution treatment and are
    never softened into a general warning tone.

**Motion**

12. **Motion is earned.** It must communicate **state** or **spatial continuity**.
    No entrance decoration, no staggered cards, no motion on high-frequency
    practitioner actions unless it carries meaning. *Which mechanism expresses it
    is a CONTRACT decision, not part of this law.*
13. **Reduced motion preserves complete comprehension.** Reduced means gentler,
    never absent: the state change still happens, and nothing becomes
    unintelligible because motion was removed.
14. **Interaction timing is consistent across the product, and decided once.** A
    surface does not invent its own timing. *Which scale or API carries that
    consistency is a CONTRACT decision — see contract 8 — not part of this law.*

**System**

15. **No new dependency by default.** A dependency requires a real capability the
    platform cannot adequately express — demonstrated, not asserted.
16. **Hone remains the design authority.** Third-party primitives are adopted
    selectively, on evidence, and conform to these laws. They do not import their
    own.

---

## `[CONTRACT]` — the current mechanisms

These satisfy the laws above **today**. Use them. Do not hand-roll an equivalent
beside them.

| # | Mechanism | Satisfies |
|---|---|---|
| 1 | `components/ui/control-base.ts` — `CONTROL_MIN_TOUCH` (`inline-flex … min-h-[44px]`), `FOCUS_RING`, `CONTROL_COMPACT_FINE_POINTER` (`pointer-fine:min-h-8`) | LAW 6; **LAW 5 partially** — see below |
| 2 | `components/ui/button.tsx` — `Button`, `buttonClasses`. `pending` is a **prop**: it disables the control, sets `aria-busy` and `data-pending`, and — **only when `busyLabel` is supplied** — swaps the visible label | LAW 4 |
| 2b | `components/pending-button.tsx` — `PendingButton`, the **server-action leaf**: `useFormStatus()` + `type="submit"`, wrapping `Button`. **Omit `busyLabel`** for the geometry-stable spinner, which is the recommended default | LAW 4 |
| 2c | `components/pending-link.tsx` — `PendingLink`, `PendingContainerLink`, the **navigation leaf**: `useLinkStatus()`, which must run inside the `<Link>` that owns the navigation. Correct wherever the control **survives its own activation** | LAW 4 |
| 2d | **NAV-ACK-SHELL-HANDOFF** — the *transient-surface* case of 2c, and **bounded to `app/(app)/MobileMenu.tsx` + `app/(app)/GlobalSearch.tsx`**. Where a navigation control lives inside a panel that **intentionally unmounts on activation**, the acknowledgement is hosted on that **same surface's persistent retained root**, driven by a `useTransition()` that outlives the panel | LAW 4 |
| 3 | `components/ui/section-label.tsx` — `SectionLabel` | LAW 1 |
| 4 | `components/ui/status-pill.tsx` — `StatusPill`; primitive owns shape, caller owns meaning | LAW 9 |
| 5 | `components/ui/field.tsx` | LAW 4, 6 |
| 6 | `components/ui/skeleton.tsx` | LAW 4, 13 |
| 7 | `components/confirm-dialog.tsx` — `ConfirmDialog` | LAW 4, 7 |
| 8 | `app/globals.css` duration scale — `--hone-duration-press: 120ms`, `--hone-duration-ui: 180ms`, `--hone-duration-overlay: 240ms` | LAW 14 |
| 8b | **Ordinary state change is expressed in CSS transitions**, and no animation library is installed. This is the current mechanism for LAW 12, not the law itself | LAW 12 |
| 9 | `pointer-fine:` for density; `focus-visible:` not `focus:`; `outline-hidden` not `outline-none` | LAW 3, 6 |
| 10 | `dark:` is remapped to a `.dark` class that is never applied — automatic dark mode is **off by pilot decision** | LAW 16 |

Three notes an agent will otherwise get wrong:

- **`--hone-duration-overlay` is declared and unspent.** It is reserved for the
  drawer/sheet primitive so overlay timing is decided once. Spend it; do not
  introduce a second overlay duration.
- **Contract 1 satisfies LAW 5 only partially, and is marked so deliberately.**
  `CONTROL_MIN_TOUCH` guarantees **height and not width**, so a square icon
  control can satisfy it and still be too narrow; and `buttonClasses`' `sm` size
  composes `CONTROL_COMPACT_FINE_POINTER` (`pointer-fine:min-h-8` = 32px), which
  is a legitimate LAW 3 opt-in but means 44px is not universal even in height.
  **Do not read this row as "the touch floor is solved."** Closing the width half
  is the unresolved control-geometry debt — proposed as UX-04, not scheduled.
- **2d is not a second mechanism, and must not become one.** It is 2c's
  acknowledgement vocabulary — the same mark, the same always-mounted
  `role="status"` region — relocated to the only host that still exists once the
  panel has closed. `useLinkStatus` is a client hook that must run inside the
  `<Link>` subtree, so on a surface that unmounts that subtree on activation,
  2c can paint nothing at all: swapping in `PendingLink` there compiles, ships
  and acknowledges **silently nothing**. 2d exists for exactly that case.
  **Prefer 2c everywhere the control survives its own press**, and do not widen
  2d beyond the two surfaces it names — a product-wide navigation vocabulary is
  UX-03, which is not adopted.

---

## `[PILOT]` — MOTION-01

> **The overlay enter/exit contract, piloted on ONE drawer (`QuickBookDrawer`),
> including a ruling on gesture dismissal.**

**The deliverable is a ruling, not a migration.** It must answer, on one real
surface:

1. Is `@starting-style` plus a small presence hook sufficient for enter *and*
   exit? *(Expected: yes.)*
2. Does phone dismissal need real gesture physics — velocity, damping,
   interruptibility — or does an edge-anchored transition plus a correctly sized
   control suffice? *(Genuinely open.)*

Question 2 is the only thing in this product that could justify **the first
animation dependency in its history**. It is also what decides whether a
third-party bottom-sheet earns adoption: if CSS suffices, that candidate weakens
to a correctness argument already covered elsewhere; if physics is genuinely
needed, MOTION-01's implementation becomes the acceptance criteria. **Either way
the ruling survives its own code.**

**Binding sequencing — MOTION-01 must not start until the control-geometry debt
on the drawer's dismissal affordance is resolved.** *(That work is **proposed**
as UX-04 and is **not scheduled** — see authority item 7. The prerequisite is the
unresolved geometry, not a slice on a plan.)* The drawer close controls are undersized today. Specifying motion
against a dismissal affordance already scheduled to be resized would fix the
wrong geometry and be re-specified immediately.

**Non-goals, explicitly:** no stagger, **no _decorative_ entrance animation**
(page and content entrances stay out of scope — **the overlay's own enter
transition is the deliverable, not a non-goal**), no dashboard motion, no
route-transition motion, no library installed to answer question 1, no migration
of the other overlays.

*This line previously read "no entrance animation", which excluded the very thing
MOTION-01 exists to test. The contradiction was inherited from the audit, found
by review there, and is corrected in both documents.*

The audit records two further motion *candidates*. They are **not** pilots and
**not** scheduled; do not start them.

---

## Authorized work

**UX-01 Quick Wins is AUTHORIZED**, to proceed once its prebuild is reconciled
against current production. Its home is the canonical roadmap §23.6; this is a
pointer, not a second register.

It is stated **here rather than below** because the next section is defined as
*not decided* — recording a decided item inside it would tell an agent both that
UX-01 may proceed and that it may not.

Nothing else **in the UX programme** is authorized. **UX-02 … UX-11 are PROPOSED
and NOT SCHEDULED**, and MOTION-01 remains a **PILOT, not adopted**, with its
sequencing constraint intact.

**NAV-ACK-01 is AUTHORIZED** — a **bounded LAW 4 repair**, by owner product
ruling of 2026-09-18. It sits **outside** the UX programme and must not be
re-recorded as part of it: UX-01's content does not reach these surfaces, which
is precisely why it required a decision of its own.

Its entire scope is:

- `app/(app)/MobileMenu.tsx`
- `app/(app)/GlobalSearch.tsx`
- the minimum tests that prove it, and this bookkeeping

Its mechanism is **contract 2d**, and the defect it repairs is specific: on both
surfaces the activated control is inside a panel that **intentionally unmounts on
activation**, so the acknowledgement had nowhere to live and the only visible
change — the panel vanishing — was caused by the dismissal rather than by the
navigation.

**NAV-ACK-01 does NOT adopt UX-03 Navigation Identity**, which remains PROPOSED
and NOT SCHEDULED. It creates **no product-wide navigation authority**: no global
route-progress indicator, no shell-level navigation provider, no global
navigation vocabulary, and no licence to convert the product's other links.
Generalising this mechanism is UX-03's decision to make, and it has not been
made.

---

## `[PRODUCT AUTHORITY REQUIRED]` — open, and not an agent's call

None of these is decided. None may be smuggled into a polish PR.

1. **Does the authenticated product app adopt Fraunces?**
   `FRAUNCES_PRODUCT_APP = PRODUCT_AUTHORITY_REQUIRED / EXPERIMENT`.
   **This file does not instruct product work to introduce Fraunces**, and no
   agent may do so until a dedicated typography-identity decision proves it.
   Marketing retains its existing typography identity; that is not precedent for
   the product app.
2. Does the working canvas widen beyond its current maximum?
3. Does Hone adopt a table convention, and what does a table become on a phone?
4. How far does container → rule conversion go on clinical surfaces? A wrongly
   flattened caution block is a patient-safety regression, not a style one.
5. Does the client-profile heading scale change?
6. Are the inert `dark:` utilities retired? Mechanically safe, but it forecloses
   the class-based theme the token layer was built to enable.
7. **Is any of UX-02 … UX-11 adopted, and in what order?** They remain
   **PROPOSED and NOT SCHEDULED**, carrying no implementation authority.
   **Appearing in the sequence never authorizes a stage** — a later slice does not
   become startable because the one before it shipped. Adoption belongs in the
   canonical roadmap, not in a review document and not here. *(UX-01 is **not**
   part of this question — it is authorized; see "Authorized work" above.)*

   | Slice | Family |
   |---|---|
   | **UX-01** | Quick Wins |
   | **UX-02** | Primitive Adoption + anti-regression |
   | **UX-03** | Navigation Identity |
   | **UX-04** | Control Geometry |
   | **UX-05** | Page Hierarchy |
   | **UX-06** | Surface Simplification |
   | **UX-07** | Modal Quality / Astryx |
   | **UX-08** | State Design |
   | **UX-09** | Motion / Perceived Speed |
   | **UX-10** | Density / Canvas |
   | **UX-11** | Identity Return |

   *The audit records this programme as `UI-A … UI-J` — ten slices. It is
   renamed here because that shorthand collides with the shipped `UI-01x` and
   `UI-Rxx` families (`UI-D` and `UI-G` in particular shadow `UI-01D` and
   `UI-01G`, which are different work). The audit's `UI-J` bundled density,
   canvas and identity-return; that is split into **UX-10** and **UX-11** here,
   because identity-return is where the Fraunces decision (item 1) would land and
   it should not be buried inside a density slice. Mapping: A→01, B→02, C→03,
   D→04, E→05, F→06, G→07, H→08, I→09, J→10 + 11.*
8. Does MOTION-01 run, and when?
9. **Is an explicit exception to the transform/opacity-only motion rule granted
   for the `<details>` disclosure transition?** The audit proposes
   `interpolate-size: allow-keywords` + `::details-content` + `transition:
   height` for the 42 `<details>` across 25 files — the highest-frequency
   spatial break in the product. **`transition: height` animates a
   layout-and-paint property**, which the approved motion direction forbids, and
   the native disclosure path has no `transform`/`opacity` equivalent — so it
   cannot be resolved by technique. Until granted, that work is **not** ordinary
   stylesheet work.

---

## What an agent must never do

- Add a design dependency because a component would be convenient.
- Introduce Fraunces into the authenticated app (item 1 above).
- Start MOTION-01 while the drawer's control geometry is still unresolved.
- Treat the audit's proposals as approved work, or its sequence as scheduled.
- Hand-roll a control beside an existing primitive because copying the
  neighbouring line is cheaper than importing.
- Animate a high-frequency practitioner action for decoration.
- Show an internal code, identifier or status string to a practitioner or client.
- Soften a clinical caution into a general warning tone.
- Add a second way to express something this file already has one way to express.

---

## Changing this file

A **CONTRACT** row changes when the mechanism changes — ordinary work, and the
law above it is untouched.

A **LAW** changes only by an explicit product decision, recorded as such. An
agent may propose one; an agent may not promote a recommendation, a measurement
or a review comment into a law.
