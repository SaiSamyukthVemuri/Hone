# Product-wide design audit — anti-slop review (2026-09)

**Audit baseline:** `6e264b571c5d2b21358ca95b9ae058835ce2c9b1` — production, merge
of PR #710 `feat/ui-r01-interaction-foundations`, 2026-09-17. At the time of
writing this SHA is also the head of the production branch, so the measurements
below describe production exactly, with no intervening commits.

**Lane:** independent read-only design review. No product code was changed, no UI
was implemented, no roadmap was edited, no production database was queried.

---

## What this document IS, and what it is NOT

This is **evidence and program input**. It is not an approval.

| This document | Status |
|---|---|
| Records what was mechanically measured in production source and in a browser | authoritative for the baseline SHA |
| Interprets those measurements into a diagnosis | reviewer's judgement, open to challenge |
| Restates design direction Hone has **already** approved | pointer only — the cited source stays canonical |
| Proposes a transformation programme (UI-A … UI-J) | **PROPOSED, NOT APPROVED** |
| Names decisions only Sam can make | **OPEN — no decision recorded here** |
| Describes MOTION-01 | **PILOT, NOT SCHEDULED** |

**Nothing in §4, §5 or §6 is an approved product decision.** No Motion library was
added. No Astryx component was added. No UI change was implemented. The canonical
roadmap is unchanged by the commit that introduced this file; if any part of §4
is adopted, that adoption happens in the roadmap, not here.

## How to read this document

Every substantive claim carries one of five classifications:

- **`[MEASURED FACT]`** — mechanically observed from a source census, a compiled-CSS
  browser harness, or a dependency manifest at the baseline SHA. Reproducible;
  see the appendix.
- **`[DESIGN DIAGNOSIS]`** — interpretation supported by those measurements. A
  reasoned reading, not a measurement. Challengeable without disputing the facts.
- **`[APPROVED EXISTING DIRECTION]`** — a design law Hone has already adopted:
  shipped primitives and their documented rulings, the Astryx Option C decision,
  the Emil discipline the repo's own skills encode.
- **`[PROPOSED TRANSFORMATION]`** — future work. Not scheduled, not approved.
- **`[PRODUCT AUTHORITY REQUIRED]`** — a decision Sam has not made. Explicitly
  left open.
- **`[PILOT]`** — deliberately experimental; its deliverable is a ruling, not a
  migration.

---

## §0 METHOD — what was inspected, and what was not

**`[MEASURED FACT]`**

| Method | Status |
|---|---|
| Source census of the baseline tree — 297 `.tsx` files, 75,657 lines — extracted via `git archive` to a scratch directory | **Observed.** Every count in §1 is reproducible from that tree. |
| Compiled-CSS browser harness: the app's real `app/globals.css` compiled by the project's own `@tailwindcss/postcss` 4.3.0, rendering **verbatim class strings lifted from source**, measured in headless Chromium at 390 / 768 / 1280 / 1440 / 1920 | **Observed.** Geometry, computed type metrics, and contrast resolved to sRGB through a canvas so `oklch()` converts correctly before the WCAG ratio is computed. |
| Runtime dependency manifest | **Observed.** |
| The running Hone application, logged in, with real data | **NOT observed.** No dev server was started; the shared local Supabase stack was deliberately left untouched. |
| Typeface rendering | **NOT observed.** Inter and Fraunces are not loaded in the harness, so its screenshots fall back to a serif. **No claim in this document rests on how the type looks** — only on measured size, leading, weight and colour. |
| Production database | **Not queried.** |

The harness measures real class strings through the real stylesheet. It does not
measure real pages with real data, and nothing here should be read as if it did.

---

# §1 MEASURED FACT

## 1.1 Primitive adoption

**`[MEASURED FACT]`** Import counts at the baseline SHA, against the hand-rolled
population each primitive was built to replace:

| Primitive | Files importing it | Competing population |
|---|---|---|
| `components/ui/button` | **10** | **469** raw `<button>` elements |
| `components/ui/control-base` | 8 | 872 `hover:` / 250 `focus:` hand-rolled |
| `components/ui/field` | **3** | **259** `<input>`, 48 `<select>`, 52 `<textarea>` |
| `components/ui/section-label` | **3** | **132 distinct spellings** of the small-caps label |
| `components/ui/status-pill` | **1** | **84 distinct pill spellings** |
| `components/ui/skeleton` | **1** | 4 `animate-pulse` |
| `components/ui/spinner` | 1 | 3 `animate-spin` |

`control-base.ts` records its own founding census: 5,534 `className` usages
resolving to 2,008 distinct literal class strings; 236 button call sites spelled
154 ways; 202 small-caps section labels in 68 spellings; **281 of 399 computable
interactive elements rendering under 44px tall**. The label spellings measured at
this baseline are **132**, up from the 68 that file documents.

## 1.2 Typography

**`[MEASURED FACT]`** **44 distinct type sizes** across `app/` and `components/`.
Eleven are off-ramp arbitrary values used more than 30 times each. The same size
is spelled up to three ways:

| Size | Spellings | Combined uses |
|---|---|---|
| 14px | `text-sm` (1,244) + `text-[14px]` (63) + `text-[0.875rem]` (13) | 1,320 |
| 12px | `text-xs` (906) + `text-[12px]` (69) + `text-[0.75rem]` (20) | 995 |
| 16px | `text-base` (92) + `text-[16px]` (42) + `text-[1rem]` (4) | 138 |
| 15px — **not on the Tailwind ramp at all** | `text-[15px]` (33) + `text-[0.9375rem]` (42) | 75 |
| 11px — not on the ramp | `text-[11px]` | **229** — more than `text-base` |

**`[MEASURED FACT]`** The spellings are **not equivalent**. Measured in the browser:

| Class | Size | Line-height | Ratio |
|---|---|---|---|
| `text-sm` | 14px | **20px** | 1.43 |
| `text-[14px]` | 14px | **21px** | 1.50 |
| `text-xs` | 12px | **16px** | 1.33 |
| `text-[12px]` | 12px | **18px** | 1.50 |

Ramp classes carry a tuned line-height; arbitrary classes inherit the 1.5 default.
Eleven of the app's type sizes therefore run a different leading ratio from the
rest, and two blocks of identical-looking 14px text produce different row heights.

**`[MEASURED FACT]`** Weight distribution across 1,398 weight declarations:

| Weight | Count | Share |
|---|---|---|
| `font-medium` (500) | 1,164 | **83%** |
| `font-semibold` (600) | 156 | 11% |
| `font-bold` | 51 | 4% |
| `font-normal` (400) | **27** | **2%** |
| `font-light` | 1 | <1% |

**`[MEASURED FACT]`** Page titles use **five different sizes**: `text-3xl` ×21,
`text-2xl` ×10, `text-xl` ×7, `text-lg` ×2, arbitrary ×6.

**`[MEASURED FACT]`** `app/(app)/clients/[id]/page.tsx` (1,733 lines, the app's
largest page) carries **six `<h2>` at `text-sm font-medium uppercase tracking-wider
text-neutral-500`** and two more at `text-lg font-medium` — two incompatible
heading systems on one page. Measured contrast on white: `neutral-500` = 4.74:1;
`neutral-900` = 17.93:1. The dominant heading system renders section headings at
the same size as body text and in a lighter colour than the body beneath them.

**`[MEASURED FACT]`** `uppercase` appears 428 times — the one typographic device
the app owns, in 132 spellings, across sizes 10/11/12/13/14px, weights none/medium/
semibold, and trackings `tracking-wider` / `[0.1em]` / `[0.12em]` / `[0.14em]`.

## 1.3 Control geometry

**`[MEASURED FACT]`** Heights measured in the harness, identical at every viewport
unless noted:

| Control | Height | Against the 44px floor |
|---|---|---|
| `Button` primitive, md | 44px | meets |
| `Button` primitive, sm | 44px touch / 32px fine pointer | meets by design |
| Dashboard **"Book appointment"** (hand-rolled) | **36px** | under |
| Records "Print / Export" | **38px** | under |
| Common small secondary (`px-3 py-1.5 text-xs`) | **30px** | under |
| **Global primary nav items** (Dashboard / Clients / Calendar / Records) | **36px** | under |

**`[MEASURED FACT]`** In the dashboard header row, a 46px day-nav control sits
beside the 36px primary button — a **10px height delta between two controls in the
same row**, both centre-aligned, sharing neither baseline nor cap height.

**`[MEASURED FACT]`** `text-neutral-400` measures **2.58:1 on white — fails WCAG AA**.
It is the colour the dashboard day navigation paints the **current** day
("Today"), while the *available* days are painted full-strength.

## 1.4 Navigation identity

**`[MEASURED FACT]`** Seven distinct implementations of "switch between sibling
views of this page", measured:

| Surface | Recipe | Height |
|---|---|---|
| Dashboard day nav | joined outlined segments divided by `border-l` | 46px |
| Clients | pill-in-a-well, `rounded-lg` outer / `rounded-md` inner, `py-1.5` | **42px** |
| Calendar | pill-in-a-well, `rounded-md` outer / **`rounded-[5px]`** inner, `py-1` | **38px** |
| Records | full capsules, active = solid black fill | **38px** |
| Settings | underline tabs, `border-b-2`, no fill | 45px |
| Financials | rounded rect, active = solid accent fill; the only one using the UI0 tokens | 44px |
| Client profile | bare text, colour-only active | 44px |

`rounded-[5px]` occurs nowhere else in the product.

**`[MEASURED FACT]`** `aria-current` appears in 10 files. **`app/(app)/layout.tsx`
— the global primary navigation — is not one of them.** The app shell carries no
current-section state, visual or semantic.

**`[MEASURED FACT]`** 18 settings pages under `app/(app)/settings/`.

## 1.5 Surfaces and density

**`[MEASURED FACT]`** 1,190 rounded corners (`rounded-md` ×760, `rounded-lg` ×215,
`rounded-full` ×175, plus arbitrary `[12px]`, `[8px]`, `[5px]`, `[10px]`, `[6px]`)
against **41 shadows** and **3,247 `border` utilities** in the whole app.

**`[MEASURED FACT]`** The literal string
`"rounded-lg border border-neutral-200 p-5 dark:border-neutral-800"` appears
**23 times**. There is **no `Card` primitive** in `components/ui/`. `components/`
holds 58 feature components, ~16 of them named `*-card.tsx`.

**`[MEASURED FACT]`** Per-surface container density:

| Surface | Lines | `rounded-` | `border` | `uppercase` |
|---|---|---|---|---|
| `app/(app)/calendar/[id]/page.tsx` | 1,588 | **32** | **88** | 21 |
| `components/session-payment-prepare-card.tsx` | 1,666 | **35** | **93** | 8 |
| `app/(app)/records/page.tsx` | 1,131 | 29 | 78 | 9 |
| `app/(app)/clients/[id]/page.tsx` | 1,733 | 14 | 37 | 10 |
| **`app/portal/page.tsx`** | 1,129 | **0** | 12 | 20 |
| **`app/book/[slug]/PublicBookForm.tsx`** | 1,248 | **0** | 12 | 14 |

**`[MEASURED FACT]`** 84 distinct `rounded-full` + padding spellings. The capsule
shape is used for **both** non-interactive status display and interactive actions
(e.g. `rounded-full bg-neutral-900 px-4 py-2 … hover:`).

**`[MEASURED FACT]`** 46 `border-dashed` empty-state containers in ~12 spellings.

## 1.6 Overlays

**`[MEASURED FACT]`** 15 hand-rolled overlays carrying `aria-modal` or
`role="dialog"`. No overlay primitive exists.

| Capability | Overlays with it |
|---|---|
| Escape to dismiss | 14 / 15 — **`PostcareSendButton` has none** |
| Focus trap (Tab containment) | **4 / 15** |
| Focus restored to trigger on close | **4 / 15** |
| Initial focus moved into the dialog | **5 / 15** |
| Background scroll lock | **3 / 15** |
| Any enter/exit transition | **4 / 15** |

`app/(app)/calendar/PostcareSendButton.tsx` renders `role="dialog"
aria-modal="true"` over a `fixed inset-0` backdrop with no keyboard dismissal and
no focus management. The most completely managed overlay in the repository is
`app/_components/marketing/MobileNav.tsx`.

## 1.7 States, motion and perceived performance

**`[MEASURED FACT]`**

| Signal | Count |
|---|---|
| `loading.tsx` route boundaries in the whole app | **0** |
| `<Suspense>` | 2 |
| `error.tsx` | 1 (the entire `(app)` group) |
| `not-found.tsx` | 0 |
| `<PendingLink>` | **15** |
| plain `<Link>` | **188** |
| `hover:` utilities | **872** |
| `active:` utilities | **24** |
| `focus-visible:` | 34 |
| `focus:` (fires on mouse click too) | **250** |
| `ease-out` in the entire app | **3** |
| explicit `duration-*` | 2 |
| `"use client"` files | **158 of 297 (53%)** |

**`[MEASURED FACT]`** Empty-state copy carries at least six distinct sentences for
one domain fact: "No sessions recorded yet." / "No sessions recorded." / "No
charted treatments yet." / "No charted treatment history yet." / "No treatment
charted yet" / "Not charted yet".

## 1.8 Responsive

**`[MEASURED FACT]`** `<main className="mx-auto max-w-5xl …">` measures **1024px
content width at 1280, 1440 and 1920 viewports alike**.

**`[MEASURED FACT]`** Responsive utilities across 297 files: `sm:` 177, `md:` 128,
`lg:` 81, **`xl:` 0, `2xl:` 0**.

**`[MEASURED FACT]`** No horizontal page overflow was observed at any of the five
measured viewports in the harness.

**`[MEASURED FACT]`** **5 `<table>` elements exist, both files under `/admin`.**
The practitioner app contains none.

**`[MEASURED FACT]`** The calendar carries a genuine phone composition —
`CalendarMobileDayView` + `MobileDayTimeline` — a dedicated day view, not a
stacked week grid. Calendar drag is **drag-to-create only**, mouse-only
(`if (e.pointerType !== "mouse") return;`), with a live pointer-tracking overlay.
There is no drag-to-move.

## 1.9 Anti-slop signature census

**`[MEASURED FACT]`** The classic signatures are largely **absent**:

| Signature | Count |
|---|---|
| gradients (`bg-gradient-*` / `bg-linear-*`) | **0** |
| inline `<svg>` in 297 files | **7** |
| emoji as UI | 26, all of them `✓ ✕ ⚠ ✗` used as text glyphs |
| `backdrop-blur` | 8 |
| `text-center` | 37 |
| shadows | 41 |
| `tabular-nums` | 87 |

**`[MEASURED FACT]`** The "heading + subtitle" template occurs 22 times.

## 1.10 Identity distribution

**`[MEASURED FACT]`** Fraunces and Inter are self-hosted in `app/_fonts/` and
loaded by the root layout on **every** page. `font-fraunces` / `--font-fraunces`
is referenced in 28 files: the marketing surface, `/book`, `/portal`, `/intake`,
`/cancel`, `/reschedule`, `/manage`, `/login`, `/accept-invitation` — and **three
files inside the practitioner app** (`DashboardGreeting`, `OnboardingWizard`,
`settings/data`).

**`[MEASURED FACT]`** `DashboardGreeting` — the one recurring app-side use — is a
client component that returns `null` on the server pass and renders after mount,
at `text-xl` in `text-neutral-500`.

**`[MEASURED FACT]`** Three token systems coexist:

| Surface | Tokens | Display face | Container |
|---|---|---|---|
| Marketing | `paper`/`ink`/`mineral`/`wash`, `--mk-radius-*`, `--mk-shadow-frame` | yes | `.mk-shell`, fluid to 1400px |
| Public client (`/book`, `/portal`, `/intake`) | raw hex (`#6B6B6B`), arbitrary px | **yes** | `max-w-[760px]` |
| Practitioner app | neutral ramp + the UI0 token layer | **no** | `max-w-5xl` (1024px) |

## 1.11 Dependencies

**`[MEASURED FACT]`** Runtime dependencies contain **no animation library**: React
19, Next 15.5.22, Supabase, Stripe, Sentry, PostHog, Resend, pdf-lib, jszip,
sharp, Upstash, Vercel analytics. No framer-motion, no vaul, no radix, no sonner,
no spring library.

---

# §2 DESIGN DIAGNOSIS

## 2.1 The headline — Hone is under-designed, not over-decorated

**`[DESIGN DIAGNOSIS]`** The brief anticipated excess: rounded cards, badges,
gradients, meaningless icons, emoji, decorative microcopy. **The measurements
invert that expectation.** Hone has zero gradients, seven SVGs in the entire
product, 41 shadows, and no illustration filler (§1.9).

Hone does not read as AI-generated because it is gaudy. It reads as AI-generated
because it is **under-decided**: a monochrome, icon-less, motion-less field of
`rounded-md border-neutral-200` boxes holding `text-sm font-medium` text, in which
nothing has been assigned relative importance. 83% of weight declarations are a
single value (§1.2); headings render quieter than their content; seven controls
answer one question seven ways.

The 22 heading-plus-subtitle templates and the 132 spellings of one label are
symptoms of the same absence. **When no system states how much a thing matters,
every author re-answers it locally, and the aggregate reads as machine output.**
That is the defect class, and it is a system problem rather than a taste problem.

## 2.2 Top 10 systemic defects

**`[DESIGN DIAGNOSIS]`** Ranked by user impact × frequency × visual impact ×
cross-product reach. Each rests on the §1 facts cited.

1. **The design system is a library that nothing imports** (§1.1). UI-R01 shipped
   an excellent primitive layer; it was built as an *offer*, not a *migration*. No
   lane owns deleting the 469th hand-rolled button, so each PR adds a 470th
   because copying the neighbouring line is cheaper than importing. **This is the
   root cause of roughly half of the rest — the only defect whose repair stops the
   others recurring.**
2. **Seven answers to one interaction** (§1.4), including an inverted affordance:
   the dashboard paints the day you are on in the disabled colour at 2.58:1, and
   the days you are not on at full strength (§1.3).
3. **Section headings are quieter than their content** (§1.2). With weight
   flattened to one value and heading size collapsed into body size, a long page
   presents an even field of 14px grey with no scannable skeleton.
4. **Seven control heights for two semantic roles** (§1.3), including the flagship
   primary action at 36px and the global nav at 36px, against the team's own
   documented 44px floor.
5. **The practitioner app has no identity; the rest of the product does** (§1.10).
   Hone's brand face speaks to clients and falls silent for the person who lives
   in the product all day — and the one time it speaks, it arrives after hydration
   in grey.
6. **Eleven of fifteen overlays are structurally broken** (§1.6). The public
   marketing site handles focus better than the clinical software.
7. **No motion vocabulary, and touch gets nothing** (§1.7). 848 affordances give a
   mouse user feedback and a touch user none between finger-down and landing.
8. **No loading vocabulary** (§1.7). With zero `loading.tsx`, 173 of 188 links
   acknowledge a click only once the destination has fully rendered.
9. **44 type sizes whose duplicate spellings disagree on leading** (§1.2) — why
   vertical rhythm feels subtly wrong in places nobody can point at.
10. **1024px of content on a 1920px screen, and no wide-screen design at all**
    (§1.8). For software whose core objects are a schedule, a roster, a ledger and
    a log, this is a direct cost — and the marketing site uses the practitioner's
    monitor better than the product does.

## 2.3 Design system map

**`[DESIGN DIAGNOSIS]`**

| System | Verdict | Basis |
|---|---|---|
| Typography | **INCONSISTENT** | §1.2 |
| Spacing | **GOOD, drifting** | `gap-2`/`gap-3`, `px-3`/`py-2` genuinely dominate — a rhythm exists. It erodes at half-steps (`gap-1.5` ×191, `py-1.5` ×124), putting the app on a 2pt rather than 4pt grid. **Not worth a new token; worth a composition rule.** |
| Surfaces | **OVERBUILT + MISSING** | §1.5 — 1,190 corners, a 23× literal card string, no `Card` primitive |
| Controls | **MISSING in practice** | §1.1 — excellent design, ~5% adoption |
| Navigation | **INCONSISTENT + MISSING** | §1.4 — seven dialects, no global current state |
| Forms | **MISSING** | §1.1 — 359 raw form controls, `Field` in 3 files |
| Tables | **MISSING** | §1.8 — none outside `/admin` |
| Dialogs | **MISSING** | §1.6 |
| States | **MISSING** | §1.7 |
| Motion | **MISSING** | §1.7 |
| Responsive | **INCONSISTENT** | §1.8 — calendar genuinely good; nothing above `lg` |
| Colour / tokens | **GOOD, unadopted** | UI0 token layer is well-reasoned and correctly scoped; `text-neutral-400` at 2.58:1 remains in use |

## 2.4 Anti-slop scorecard

**`[DESIGN DIAGNOSIS]`**

| Surface | What feels generic | System cause |
|---|---|---|
| Dashboard | 30px title over an 18px section head; 46px control beside a 36px button; current day greyed to look disabled | No page-header contract; primary action hand-rolled; disabled colour used for an active state |
| Calendar (week) | Toolbar and view toggle are a third tab dialect; grid chrome competes with appointments | Tab concept absent |
| **Calendar (mobile)** | **Best surface in the product** | A real mobile composition was designed, not derived |
| Appointment detail | 32 rounded boxes, 88 borders, 21 uppercase labels on one page | Every sub-feature shipped its own card |
| Clients list | 42px pill-in-a-well over a plain list; no columns | Tabs dialect #2; rows not table |
| Client profile | Six headings smaller and lighter than their content; two heading systems | Sections became cards to compensate for invisible headings |
| Forms | 259 raw inputs each re-deciding padding and focus | `Field` unadopted; 250 `focus:` rules |
| Charting / session | Nested cards inside cards | The composition unit is "a card" |
| Waitlist | Own panel vocabulary | Newest surface copied the newest neighbour |
| Notifications | `text-3xl` title over `text-xs` uppercase amber h2 | Heading scale absent |
| Settings (18 pages) | Underline tabs unlike every other tab; each page re-invents its rhythm | No page template |
| **Booking / Portal / Intake** | **Least generic surfaces in the repo** | Art-directed; they simply don't share the app's tokens (raw hex) |
| Modals & drawers | Appear instantly; ~30px Close controls | 15 independent implementations |
| Empty states | 46 dashed boxes; six sentences for one fact | No empty-state component, no copy system |

---

# §3 APPROVED EXISTING DIRECTION

**`[APPROVED EXISTING DIRECTION]`** These are **already** Hone's rules. This audit
restates them only to show what the proposals in §4 must conform to. Each cited
source remains canonical; where this summary and the source disagree, the source
wins.

1. **The UI0 / UI-R01 primitive layer and its documented rulings.**
   `components/ui/control-base.ts` and `components/ui/button.tsx` — the 44px
   interaction floor travelling with `inline-flex`; `pointer-fine:` rather than a
   width breakpoint for density; `focus-visible:` not `focus:`; `outline-hidden`
   not `outline-none` for forced-colors survival; **there is no universal press
   class** and a control must be classified into a family first; the
   geometry-stable pending form.
2. **Semantic tokens own tone; callers own meaning.** `status-pill.tsx`: the
   primitive owns shape, spacing and type; the caller owns what a status means.
   Practitioner/service identity colours are DATA and are never routed through
   semantic tokens.
3. **Clinical caution is a patient-safety distinction, not a styling one.**
   Allergies and cautions render rose, never amber.
4. **Interaction timing is already decided.** `--hone-duration-press: 120ms`,
   `--hone-duration-ui: 180ms`, `--hone-duration-overlay: 240ms` — the last
   declared and **unspent**, explicitly *"Reserved for the Drawer/Sheet primitive
   in UI2 … so overlay timing is decided once."*
5. **Reduced motion means gentler, not absent.** Primitives collapse to 1ms rather
   than losing their state change; the skeleton stops pulsing.
6. **Automatic dark mode is off by pilot decision** (Chloe, Willow Electrolysis).
   The `dark:` variant is remapped to a `.dark` class that is never applied.
7. **Astryx is settled at Option C — selective adoption**, limited to approved
   generic primitives (Dialog / AlertDialog / BottomSheet / DropdownMenu, plus a
   previously-approved candidate where evidence supports it). Hone remains design
   authority. The pilot is not to be restarted and nothing is installed
   speculatively.
8. **The Emil discipline**, as encoded in `.agents/skills/`: animate by frequency
   (100+/day → never); every animation needs a stated purpose; `ease-out` for
   enter/exit and never `ease-in`; UI motion under 300ms; never animate from
   `scale(0)`; transitions over keyframes for interruptible UI; only `transform`
   and `opacity`.
9. **Marketing's thesis is "quiet precision"**, and marketing already learned that
   scroll-gated reveals can leave sections stuck invisible — `Reveal` is now a
   plain wrapper.
10. **No new dependency by default.** `control-base.ts`: *"Hone ships no clsx, no
    tailwind-merge, no cva, and this layer does not change that."*

---

# §4 PROPOSED TRANSFORMATION — **NOT APPROVED**

Everything in this section is a recommendation for a future programme. None of it
is scheduled. None of it is a decision.

## 4.0 Proposed doctrine — **`[PROPOSED TRANSFORMATION]`**

> **Hone is a quiet instrument, not a dashboard.**

Three commitments, none decorative. The proposal is not to *add* identity but to
let in the identity Hone already owns.

1. **Type carries hierarchy. Line carries structure. Boxes carry almost nothing.**
   Hone is already hairline-delimited (3,247 borders, 41 shadows — §1.5). Make it
   deliberate: a rule plus a weight change should do the work a `rounded-lg border
   p-5` card does today. A container earns its border only when it groups the
   otherwise-ambiguous, or is independently actionable. The proof Hone can already
   do this is inside Hone — `/portal` and `/book` render zero rounded corners.
2. **The identity is Fraunces + Inter, and the practitioner is entitled to it.**
   Fraunces is already loaded on every page at no marginal cost. Proposed scope:
   page identity and significant numerals only — not body, not labels, not
   decoration.
3. **Calm is unhurried, not empty. Precision is aligned, not sparse.** Density is a
   clinical virtue; a practitioner scanning a day should see *more* per screen than
   a marketing visitor, not less.

*One rule, one weight change, one column of aligned numerals — and no box at all.*

## 4.1 Transformation families — **`[PROPOSED TRANSFORMATION]`**

| # | Family | Intent |
|---|---|---|
| 1 | **PRIMITIVE-ADOPTION** | Convert call sites; add a guard that fails a new raw `<button>` carrying `rounded-*` + `px-*`. Precondition for 3, 4 and 7 to *stay* fixed. |
| 2 | **PAGE-HIERARCHY** | One page-header contract; four heading tiers; fix the inversion where `<h2>` is smaller and lighter than its body; five `<h1>` sizes → one. |
| 3 | **CONTROL-GEOMETRY** | Collapse 30/36/38/42/44/45/46 to two boxes using the existing `CONTROL_MIN_TOUCH` + `CONTROL_COMPACT_FINE_POINTER` pair. |
| 4 | **NAVIGATION-IDENTITY** | One tab/segment primitive, two variants; retire seven dialects; add the global current-section state; fix the day-nav inversion. |
| 5 | **SURFACE-SIMPLIFICATION** | Classify every surface NEEDS CONTAINER / GROUPING ONLY / TYPOGRAPHY ONLY / SHOULD BE FLAT, then convert. |
| 6 | **MODAL-QUALITY** | One overlay, correct once: focus trap, initial focus, restore, Escape, scroll lock, origin-correct transition. Migrate 15. |
| 7 | **STATE-DESIGN** | One empty-state component; skeletons whose geometry matches eventual content; `loading.tsx` on slow routes; one sentence per fact. |
| 8 | **MOTION / PERCEIVED-SPEED** | Press acknowledgement everywhere (touch parity); route-level pending paint; overlay enter/exit. Nothing decorative. |
| 9 | **DENSITY & CANVAS** | Widen the working canvas above `lg`; a genuine table/column convention; progressive collapse of repeated labels. |
| 10 | **IDENTITY-RETURN** | Fraunces for page identity and numerals; harvest the `/portal` composition into tokens instead of raw hex. |

## 4.2 Proposed sequence UI-A … UI-J — **`[PROPOSED TRANSFORMATION]`**

**This sequence begins after the currently-owned UI-R02 / UI-02 / UI-03 / UI-04 /
UI-05 work. Nothing in this audit justifies rewriting an active PR.**

Ordering principle: **adoption before expression, correctness before composition**,
and no surface work on a page whose heading scale is about to move underneath it.

| Slice | Family | Why here |
|---|---|---|
| **UI-A** | Quick wins (§4.3) | Single-file, high visibility; proves the adoption path on real surfaces |
| **UI-B** | Primitive-adoption + guard | Must precede everything; later slices are cheaper with one button, and pointless if a 470th keeps appearing behind them |
| **UI-C** | Navigation-identity | Seven dialects → one, while the adoption machinery is warm; the change a user notices first |
| **UI-D** | Control-geometry | Mechanical once UI-B exists; clears the touch-floor debt and same-row clashes |
| **UI-E** | Page-hierarchy | After controls, because heading scale changes what surrounding controls must weigh |
| **UI-F** | Surface-simplification | **Only safe once headings are strong enough to replace containers.** Before UI-E this would flatten pages into no hierarchy at all |
| **UI-G** | Modal-quality (Astryx Dialog / Sheet) | No dependency on the type/surface chain — may run in parallel with UI-E/UI-F. Carries correctness debt, so must not slip behind cosmetics |
| **UI-H** | State-design | Needs surface and heading vocabulary to exist so empty/error states inherit rather than invent a twelfth dashed box |
| **UI-I** | Motion / perceived-speed | Motion should express a composition that has settled |
| **UI-J** | Density & canvas, then Identity-return | Both need product authority (§5). Identity-return is last not because it matters least — it may matter most — but because Fraunces lands best on resolved hierarchy |

**UI-G is the only slice with no dependency on the UI-B → UI-C → UI-D → UI-E →
UI-F spine.** Everything else is serial deliberately.

## 4.3 Quick wins — **`[PROPOSED TRANSFORMATION]`**

| # | Change | Why it pays |
|---|---|---|
| 1 | Fix the dashboard day-nav active state | Corrects an inverted affordance on the most-visited surface, and an AA failure |
| 2 | Give the global nav a current-section state | The top-level "where am I?" is currently unanswered on every page |
| 3 | Move dashboard "Book appointment" and Records "Print / Export" onto `Button` | Removes the 10px same-row clash; two flagship actions reach the floor; demonstrates the primitive |
| 4 | Add Escape + initial focus to `PostcareSendButton` | It is currently a modal a keyboard user cannot dismiss |
| 5 | Delete `rounded-[5px]`; align Calendar and Clients toggles | Two near-duplicates become one; removes an off-system radius |
| 6 | Replace the 15px and 14px arbitrary clusters with ramp classes | Removes the dual-leading defect in the largest off-ramp cluster |
| 7 | `loading.tsx` on the three slowest routes | Turns a blank interval into an acknowledged one; no visual redesign |
| 8 | Promote `SectionLabel` into the three byte-identical private copies `control-base.ts` already names | Proves adoption on files that already agreed on the design |

## 4.4 Astryx adoption map — **`[PROPOSED TRANSFORMATION]`**, within the approved Option C boundary

| Candidate | Proposed verdict | Evidence |
|---|---|---|
| **Dialog / AlertDialog** | **ADOPT** | §1.6 — 15 overlays, 11 without focus trap or restore, 1 without Escape |
| **BottomSheet** | **ADOPT** | Five calendar drawers are desktop right-edge drawers reused unchanged on phones, with no transition and no scroll lock. **Conditional on the MOTION-01 ruling (§6.4).** |
| **DropdownMenu** | **ADOPT, narrow** | Only two true menus exist. Low volume — adopt for correctness, not reach |
| **Tabs / SegmentedControl** | **ADOPT — strongest evidence of any candidate** | §1.4 — seven dialects, seven heights, three under the floor, one inverted. This is the previously-approved fourth candidate and the census now justifies it more than anything else |
| Button | **DO NOT ADOPT** | Hone's is better-reasoned and encodes Hone-specific rulings (§3.1). The problem is adoption, not design |
| Card / Surface | **DO NOT ADOPT** | Hone's answer should be *fewer* containers; importing a Card would legitimise the defect |
| Toast | **NOT YET** | No evidence gathered; the app has no toast concept. Do not introduce one to fill a gap nobody reported |
| Table | **NOT YET** | Blocked behind the table/responsive ruling (§5.3) |

## 4.5 Before / after — **`[PROPOSED TRANSFORMATION]`**

| Family | Before | After |
|---|---|---|
| PRIMITIVE-ADOPTION | Every surface re-derives what a button is | There is one button; a control's height is never a local decision |
| PAGE-HIERARCHY | An even field of 14px grey; headings quieter than contents | A page has a shape readable at arm's length |
| CONTROL-GEOMETRY | A 46px control beside a 36px button, sharing no baseline | Every control in a row is the same height; a thumb never misses |
| NAVIGATION-IDENTITY | Six pages, six tab languages, no global "you are here" | One way to switch views; the product always answers where am I / what can I do / how do I get back |
| SURFACE-SIMPLIFICATION | A stack of independently generated rectangles — 32 on one page | A continuous document with hairlines where meaning changes |
| MODAL-QUALITY | Overlays pop into existence, leak Tab, drop focus to `<body>` | Overlays arrive from where they were summoned and restore what they interrupted |
| STATE-DESIGN | 46 dashed boxes, six sentences for one fact | Absence looks intentional and says one thing |
| MOTION / SPEED | 872 hover states, 24 press states | Every press acknowledged; nothing animates that happens a hundred times a day |
| DENSITY & CANVAS | 1024px of content on a 1920px monitor | The practitioner's screen is used; a ledger is scannable by column |
| IDENTITY-RETURN | The typeface greets clients and goes quiet for the practitioner | Recognisably Hone on every screen, from type and spacing alone |

---

# §5 PRODUCT AUTHORITY REQUIRED

**`[PRODUCT AUTHORITY REQUIRED]`** Decisions Sam has not made. **No decision is
recorded here and none should be inferred from this document's existence.** None
of these may be smuggled into a polish PR.

1. **Does the practitioner app get Fraunces?** The identity decision, and the
   highest-leverage single change available. Not a reviewer's call.
2. **Does the working canvas widen above `max-w-5xl`?** Changes every page's line
   length at once and interacts with the calendar grid and every e2e viewport
   assumption. Needs a deliberate desktop composition, not a number change.
3. **Does Hone adopt a table convention?** Better for roster, ledger and records —
   but it opens a new responsive problem (what a table becomes on a phone) and a
   new primitive.
4. **How far does card → rule conversion go on clinical surfaces?** Removing
   containers changes what reads as clickable. On appointment detail and client
   profile this touches clinical information grouping; a wrongly-flattened caution
   block is a patient-safety regression, not a style one (§3.3).
5. **Does the client-profile heading scale change?** 1,733 lines, two competing
   heading systems, the densest clinical surface in the app.
6. **Are the ~1,100 inert `dark:` utilities retired?** Mechanically safe to remove,
   but it forecloses the class-based theme the token layer was designed to enable
   (§3.6). Real cleanliness payoff either way.
7. **Is the UI-A … UI-J sequence adopted at all, and in what order?** §4.2 is a
   recommendation. Adoption belongs in the canonical roadmap, not in this file.
8. **Does MOTION-01 run, and when?** See §6.

---

# §6 PILOT — Motion Adoption Map

**`[PILOT]`** Spatial discontinuity is assessed separately from visual-design
defect. A surface that merely feels unfinished is **not** a motion candidate; most
of what §2 found is fixed by type, geometry and containers, not by movement.

## 6.1 Two facts that set the bar

**`[MEASURED FACT]`** Hone ships **no animation library** (§1.11). Any candidate
genuinely needing an engine is proposing **the first animation dependency in the
product's history**.

**`[APPROVED EXISTING DIRECTION]`** `--hone-duration-overlay: 240ms` is already
declared and unspent, explicitly reserved for the Drawer/Sheet primitive (§3.4).
Motion work should spend that token, not re-litigate it.

**`[DESIGN DIAGNOSIS]`** Therefore the default answer is CSS, and the burden of
proof sits on motion.

## 6.2 Classification

### MOTION_CANDIDATE — 2

**Candidate 1 — Overlay / drawer enter and exit, and its dismissal gesture.**
*Surfaces:* `QuickBookDrawer`, `QuickBlockDrawer`, `TimedBlockEditDrawer`,
`AppointmentPreviewDrawer`, `DragActionChooser`, plus `TreatmentImagesManager`,
`DoneChartingButton`, `quick-checkout-modal`.

- **Current discontinuity** `[MEASURED FACT]`: 4 of 15 overlays carry any
  transition (§1.6). `AppointmentPreviewDrawer` is a right-edge panel
  (`max-w-sm`, 384px — on a 390px phone it covers the day being read) that
  materialises fully formed in place. Nothing says it came from the right edge,
  so nothing says it returns there — which is `[DESIGN DIAGNOSIS]` precisely why
  its dismissal is a ~30px corner button rather than a gesture. `DragActionChooser`
  is the sharpest instance: a live pointer-tracked rectangle is replaced by a
  chooser appearing elsewhere, with no connection to the shape just drawn.
- **Why CSS is / is not enough**: **Enter — CSS is enough** (`@starting-style` +
  a transform/opacity transition on the existing token). **Exit — CSS alone
  cannot**: these are conditionally mounted React subtrees, so the node is removed
  before a transition can run; this needs a presence mechanism, which is a **~25-line
  hook**, not an engine. **Gesture dismissal — CSS cannot**, and this is the only
  genuine engine case in the product: pointer capture, velocity, boundary damping,
  multi-touch rejection, and critically **interruptibility** (a spring retains
  velocity when a user reverses mid-drag; a CSS transition restarts from zero).
- **Motion benefit**: spatial continuity, and a discoverable exit — a sheet that
  rises from an edge teaches the gesture that dismisses it, which is a better fix
  for a 30px Close button than enlarging it.
- **Frequency**: high. `QuickBookDrawer` is the primary booking path. *(Inferred
  from the surface's role in the code — no usage telemetry was consulted.)* Per the
  Emil frequency rule, high frequency means **reduce, don't remove**.
- **Reduced motion**: opacity only, no transform, at the 1ms collapse `globals.css`
  already applies. The overlay must still appear and disappear distinctly.
- **Expected client cost**: enter + exit **0 KB** (CSS + local hook). Gesture
  physics: the first animation dependency, or a hand-rolled velocity
  implementation — which is what the Astryx BottomSheet candidate exists to avoid
  re-deriving.
- **Pilot priority**: **1 — recommended for MOTION-01.**

**Candidate 2 — Service reorder** (`app/(app)/settings/services/ServiceOrderList.tsx`).

- **Current discontinuity** `[MEASURED FACT]`: "Move to top" on the 6th of 8
  services re-renders with that row at position 1 instantly. The row teleports.
  `[DESIGN DIAGNOSIS]` The practitioner must re-read the "Position N of M" caption
  to confirm the right service moved — the residue of a defect the file's own
  header records (*"Chloe: 'Move up / Move down feels strange; the service I want
  first cannot reliably reach the top'"*). The arithmetic was fixed; the
  **legibility of the move** was not.
- **Why CSS is / is not enough**: CSS cannot transition a positional change of
  reordered array children. But this is the clean FLIP case and needs no engine —
  rows are keyed by `row.id` and reordered via `useOptimistic`, so **the DOM nodes
  persist**; they are only reparented. Measure, reorder, invert with a transform,
  play via WAAPI `element.animate()`. ~30 lines, zero dependency.
- **Motion benefit**: the practitioner *sees* which row moved and how far, instead
  of deriving it from a caption.
- **Frequency**: rare — a settings-level action. Rare actions can afford motion;
  they also cannot justify much investment.
- **Reduced motion**: no animation; reorders instantly as today. Nothing is lost —
  "Position N of M" is already text.
- **Expected client cost**: 0 KB, one file, one route.
- **Pilot priority**: **2.** Genuine, self-contained, immune to every pending
  decision — but one low-traffic surface, and it generalises to nothing else,
  because this is Hone's only reorder.

### CSS_ONLY — no engine, no pilot; ordinary UI slices

| Surface | Discontinuity | CSS answer |
|---|---|---|
| **53 `<details>` across 27 files** | Opening a long block snaps content below it down the page — a real context break, and **the highest-frequency one in the product** | `interpolate-size: allow-keywords` + `::details-content` + `transition: height`. Native and progressive; unsupported browsers keep today's instant behaviour. **Not a motion candidate — a stylesheet change.** |
| **848 hover-only affordances** | On touch, nothing acknowledges a press | `active:` colour step + existing `hone-transition-press`. Already solved inside `Button`; an **adoption** problem |
| Tab / segment active-state change | Abrupt colour swap | Colour transition on the existing 180ms token |
| Pending → committed control states | Geometry jumps when a label swaps width | Already solved by `Button`'s geometry-stable pending form |
| Skeletons, focus ring | — | `.hone-skeleton` and `FOCUS_RING` exist |

### NO_MOTION — explicitly rejected

| Candidate | Why rejected |
|---|---|
| **Move-appointment "teleport"** | See §6.3 |
| Day navigation (`?day=`), week↔month switch, route changes | Frequent, and the actual defect is *no pending acknowledgement* (§1.7). Animating a route change makes a slow navigation feel slower. Fix perceived speed; do not decorate it |
| Client-profile tab switch | Done tens of times a day. Emil's rule: remove or drastically reduce. The existing pending treatment is already correct |
| `NowLine` | A clock hand advancing a pixel a minute. Continuous, unwatched, invisible |
| Notification badge count | A number changing. Motion would draw attention to a count nobody asked to be alerted about |
| `GlobalSearch` open | Frequently keyboard-initiated. Raycast precedent: no animation, ever |
| Dashboard/card entrance, fade-up-on-load, staggered lists | The dashboard is opened dozens of times a day; an entrance animation taxes every one. Marketing already learned this (§3.9) |
| Any motion added to make Hone feel "premium" | Not a purpose. Hone is under-decided, not under-animated; movement cannot supply hierarchy typography has not established |

## 6.3 Why Move Appointment was REJECTED as a motion candidate

**`[DESIGN DIAGNOSIS]`, resting on `[MEASURED FACT]`.** This was the obvious
candidate — an appointment vanishes from one position and reappears elsewhere,
which reads as the product's clearest spatial discontinuity. **It fails on
evidence.**

1. **The destination is frequently off-screen.** `MoveAppointmentDialog` offers an
   unbounded `<input type="date">` with `min={todayLocal}` and **no `max`**. A move
   may land on any future date, commonly outside the visible week. There is no
   on-screen target to animate toward, and motion toward a target that does not
   exist shows nothing.
2. **The node does not survive the commit.** Confirmation runs through
   `router.refresh()`, which destroys and recreates the server-rendered tree. No
   CSS transition can bridge two distinct DOM nodes; the only mechanisms that
   could are a View Transition (not enabled — `next.config.ts` declares no
   `experimental.viewTransition`) or a layout-animation engine, which reintroduces
   the dependency question for a case that fails point 1 anyway.
3. **It is the wrong diagnosis.** The practitioner's actual problem after a move is
   *"where did it go, and did it land where I meant?"* That is an **orientation**
   problem, not a spatial-continuity one. The fix is telling them where it landed
   and offering to navigate there.

**Reclassified to STATE-DESIGN (family 7).** Recording this rejection matters as
much as the selection: it is the case where the intuitive answer and the evidence
disagree.

## 6.4 MOTION-01 — the recommended pilot

> **`[PILOT]` MOTION-01 = the overlay enter/exit contract, piloted on ONE drawer
> (`QuickBookDrawer`), including a ruling on gesture dismissal.**

**Why QuickBookDrawer was selected over the reorder:**

1. It is the **only** candidate satisfying the interruptible-gesture criterion —
   the sole justification for a motion *engine* in this product.
2. It sits on the **primary booking path**, not a settings backwater.
3. It **spends a timing token the team has already reserved** for exactly this
   purpose (§3.4), rather than inventing one.
4. It is the one place where the answer **changes what Hone installs**.

**The deliverable is a RULING, not a migration.** MOTION-01 must answer, with a
working implementation on one real surface:

1. Is `@starting-style` + a ~25-line presence hook sufficient for enter *and* exit?
   *(Expected: yes.)*
2. Does phone dismissal need real gesture physics — velocity, damping,
   interruptibility — or does an edge-anchored transition plus a properly sized
   control suffice? *(Genuinely open.)*

**Why this is not throwaway work.** MOTION-01 is the **precondition for UI-G**.
Question 2 is exactly what decides whether Astryx BottomSheet earns its place
(§4.4): if CSS and a hook suffice, the sheet candidate weakens to a
correctness-only argument already covered by Dialog/AlertDialog; if gesture
physics is genuinely needed, Astryx is confirmed and MOTION-01's implementation
becomes its acceptance criteria. **Either way the ruling survives**, even if the
pilot's code is later replaced by the adopted primitive.

**Explicit non-goals.** No stagger. No entrance animation. No dashboard motion. No
route-transition motion. No library installed to answer question 1. No migration
of the other fourteen overlays.

### Sequencing constraint — binding on the pilot

> **MOTION-01 MUST NOT START BEFORE UI-D (Control-geometry).**

The drawers' Close controls measure ~30px today (§1.3, §1.6). Specifying motion
against a dismissal affordance that is already scheduled to be resized would fix
the wrong geometry, and would have to be re-specified immediately afterwards.

---

## Appendix — reproduction

- **Baseline tree:** `git archive 6e264b57 | tar -x -C <scratch>/baseline`
- **CSS:** the project's own `@tailwindcss/postcss` 4.3.0 compiling the baseline
  `app/globals.css`, with `@source` pointed at the baseline `app/` and
  `components/` so the real utility set is generated
- **Measurement:** `playwright-core` with the repo's bundled Chromium; five
  viewports (390 / 768 / 1280 / 1440 / 1920); computed styles read via
  `getComputedStyle`; contrast resolved through a 1×1 canvas so `oklch()` values
  convert to sRGB before the WCAG ratio is computed
- **Source counts:** `grep`/`find` over the baseline `app/` and `components/`
  trees; every figure in §1 is reproducible from that tree alone

### Known-red at this baseline, and NOT caused by this document

`[MEASURED FACT]` `tests/docs/canonical-production-facts.test.ts` carries **three
pre-existing failures on pristine `6e264b57`**, measured before this file was
written:

- RULE A — A3: nothing newer than the pinned SHA changes the runtime
- RULE X — A5: the recorded Current Git branch HEAD equals the real production ref
- RULE F: no DECLARED-OPEN PR has actually merged (offending: 647)

These are production-state drift inherited by every branch off production. They
are deliberately **not** repaired here: a docs-only design review is the wrong
vehicle for a production-facts refresh, and repairing them in passing would hide
the drift rather than resolve it.
