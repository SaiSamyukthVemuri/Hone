---
type: architecture concept
title: UI components and interaction standards
description: How the shared React layer in components/ is built and policed — the server-compatible primitives in components/ui, the client leaf islands for pending submit/navigation, the accessible ConfirmDialog and focus hooks that replaced native dialogs, the CSS-only motion tokens, the DESIGN.md LAW/CONTRACT model, the component and browser tests that pin each rule, and a map from domain component clusters to the wiki pages that own their behaviour.
tags: [ui, components, design-system, accessibility, pending-state, dialogs, eslint, testing]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-02T23:26:41.194Z
sources:
  - id: openwiki-source-9f4bb955ff4b1a8ac130e5cd
    resource: repo://app/globals.css
  - id: openwiki-source-2a353c2558ffb93061d018ab
    resource: repo://components/confirm-dialog.tsx
  - id: openwiki-source-fd2b647aa6e7bc83fd624f65
    resource: repo://components/pending-button.tsx
  - id: openwiki-source-757a552639cd786d161d6ed3
    resource: repo://components/pending-link.tsx
  - id: openwiki-source-4551f3fbe4fd538eff47db72
    resource: repo://components/ui/button.tsx
  - id: openwiki-source-a384c2bc40664948537b2037
    resource: repo://components/ui/control-base.ts
  - id: openwiki-source-425d556fe8efe0267e262f01
    resource: repo://components/use-dialog-keyboard.ts
  - id: openwiki-source-0b5692e47125d5102d4e3845
    resource: repo://components/use-return-focus.ts
  - id: openwiki-source-ca9eabc24825e6ff0edc2967
    resource: repo://DESIGN.md
  - id: openwiki-source-0c67a282b8d5bb26d4942158
    resource: repo://e2e/ui-r01-interaction-foundations.spec.ts
  - id: openwiki-source-bb62e629adad4e423dceb2eb
    resource: repo://e2e/ui05-native-confirm-retirement.spec.ts
  - id: openwiki-source-2fda883e9b76745f69f487f7
    resource: repo://eslint.config.mjs
  - id: openwiki-source-f163b60f9ced94d63967980e
    resource: repo://tests/components/confirm-dialog.test.ts
  - id: openwiki-source-244181ca73da1ace53637b28
    resource: repo://tests/components/ui-foundations.test.ts
  - id: openwiki-source-618c69726c112be85ae88687
    resource: repo://tests/components/ui-r01-interaction-foundations.test.ts
  - id: openwiki-source-aeabbae4d1e75c4c1594a3d0
    resource: repo://tests/components/ui05-native-confirm-retirement.test.ts
generated: { by: "claude-code", at: "2026-10-02T23:26:41.194Z" }
---

# UI components and interaction standards

`components/` holds Hone's shared React layer. It has three kinds of file:

- **`components/ui/`**: server-compatible visual primitives (`Button`, `Field`, `Card`, `StatusPill`,
  `SectionLabel`, `Skeleton`, `Spinner`, `EmptyState`, `PageHeader`) and the shared class fragments in
  [`control-base.ts`](../../components/ui/control-base.ts).
- **Client leaf islands** that need a hook: [`pending-button.tsx`](../../components/pending-button.tsx),
  [`pending-link.tsx`](../../components/pending-link.tsx),
  [`confirm-dialog.tsx`](../../components/confirm-dialog.tsx),
  [`use-dialog-keyboard.ts`](../../components/use-dialog-keyboard.ts) and
  [`use-return-focus.ts`](../../components/use-return-focus.ts).
- **Domain components** beside them, such as charting forms, notes cards, payment cards and the
  waitlist panels (map in §7).

Server actions and database commands own all behaviour. A component renders state, collects input and
reports pending or failed states. It never becomes a write authority.

## 1. Design authority: `DESIGN.md`

[`DESIGN.md`](../../DESIGN.md) is canonical for design decisions and is subordinate to
`ENGINEERING_STANDARDS.md`. It tags every rule:

| Tag | Meaning | May an agent act on it? |
|---|---|---|
| `[LAW]` | durable outcome, e.g. *every control acknowledges immediately* | always binding |
| `[CONTRACT]` | today's mechanism for a law (a file or constant) | use it, do not hand-roll beside it |
| `[PILOT]` | bounded experiment (MOTION-01) | only its stated scope |
| `[PRODUCT AUTHORITY REQUIRED]` | undecided | propose only, never implement |

The laws are in [§ LAW](../../DESIGN.md#law--the-durable-rules), the current mechanisms in
[§ CONTRACT](../../DESIGN.md#contract--the-current-mechanisms), and the prohibitions in
[§ What an agent must never do](../../DESIGN.md#what-an-agent-must-never-do). The prohibitions are: no new
design dependency, no hand-rolled control beside a primitive, no internal codes shown to users, and no
softening of clinical cautions.

**Lifecycle of the rules themselves.** The MOTION-01 pilot is specified but gated. It must not start
until the drawer's dismissal geometry is resolved, and that work (UX-04) is *proposed, not scheduled*.
Read DESIGN.md's contract rows as **implemented** mechanisms. Read its pilot and authority items as
**designed or undecided**, never as shipped.

## 2. The server-compatible primitive layer (`components/ui/`)

**Boundary rule.** No file in `components/ui/` may declare `"use client"`, use `useState`, `useEffect`,
`useRef`, `useTransition` or `useFormStatus`, or import `clsx`, `cva`, `tailwind-merge` or a motion
library. `tests/components/ui-foundations.test.ts` enforces this, so a server-rendered clinical page
never hydrates just because it uses a button. Whenever a needed hook would break this rule, the
component moved out of `components/ui/` and the guard stayed as it was. That is why `PendingButton`,
`PendingLink` and the dialog hooks live one level up.

**Touch floor and density** ([`control-base.ts`](../../components/ui/control-base.ts#L33-L55)):

- `CONTROL_MIN_TOUCH` is `inline-flex … min-h-[44px]`. The `inline-flex` must ship with the min-height,
  because `min-height` has no effect on an inline box.
- `CONTROL_COMPACT_FINE_POINTER` relaxes the height to 32px only under `(pointer: fine)`, never behind a
  width breakpoint, because a tablet in portrait is still a thumb.
- DESIGN.md marks this as satisfying the touch-floor law **only partially**. It guarantees height, not
  width, and the `sm` button size is a compact opt-in.

**Focus** ([`control-base.ts`](../../components/ui/control-base.ts#L57-L87)):

- `FOCUS_RING` is `focus-visible:` only, with a 2px ring and offset that changes geometry rather than
  relying on colour alone.
- It uses `outline-hidden`, not `outline-none`. Tailwind v4's `outline-hidden` keeps a transparent
  outline that forced-colors mode repaints. The ring itself is a `box-shadow`, which forced-colors mode
  removes.
- The test proves this against CSS compiled by the installed Tailwind, not against the class spelling.

**`Button`** ([`button.tsx`](../../components/ui/button.tsx#L103-L194)):

- `type` defaults to `"button"`, so a bare button cannot submit a form by accident.
- `pending` is a **prop**. It disables the control, sets `aria-busy` and `data-pending`, and either:
  - swaps in `busyLabel` (the older, width-changing form), or
  - keeps the label in flow at `opacity-0`, so the box and accessible name survive, and centres a
    spinner over it. This is the geometry-stable default.
- `buttonClasses()` styles a `next/link` `<Link>` as a button without a polymorphism dependency. It
  must never be applied inside another interactive element.

**Press acknowledgement.**

- Each variant has a pressed (`active:`) colour distinct from its hover colour, so a press is visible
  on touch, where `:hover` never fires, and when motion is reduced.
- `LEAF_CONTROL_PRESS` adds only a 0.98 scale.
- `SURFACE_PRESS` is a background change for neutral surfaces. It is wrong on filled controls, where it
  would paint white text on near-white.
- No universal press class exists. The one that tried was retired
  ([`control-base.ts`](../../components/ui/control-base.ts#L101-L165)).

## 3. Pending state: the client leaves

| Leaf | Hook | Use when |
|---|---|---|
| `PendingButton` | `useFormStatus()` inside the `<form>` | a server-action submit; it renders `Button type="submit" pending={…}` |
| `PendingLink` / `PendingContainerLink` | `useLinkStatus()` inside the owning `<Link>` | a navigation whose control survives its own press (label vs layout content) |
| NAV-ACK shell handoff (DESIGN contract 2d) | `useTransition()` on a retained root | only `app/(app)/MobileMenu.tsx` and `app/(app)/GlobalSearch.tsx`, whose panels unmount on activation |

**Duplicate-submit guard.** `PendingButton`'s disable is not advisory
([`pending-button.tsx`](../../components/pending-button.tsx#L30-L84)). The browser proof issues two raw
pointer activations before waiting for `aria-busy`, then counts the real POSTs to the server-action
route. A rapid second activation must not reach the server
([`ui-r01-interaction-foundations.spec.ts` L290-L346](../../e2e/ui-r01-interaction-foundations.spec.ts#L290-L346)).
This is a UI guard. Server commands still own idempotency.

**`PendingLink` is presentation only.** It reads Next's navigation state and paints a mark and a live
region. It starts no navigation and adds no Suspense boundary. A group-level `loading.tsx` was tried
and withdrawn: it stalled query-only navigations such as dashboard day switching, and the transition
never committed ([`pending-link.tsx`](../../components/pending-link.tsx#L10-L60)).
`e2e/perceived-speed.spec.ts` proves the acknowledgement on the tapped control, on desktop and phone.

## 4. Dialogs and focus

**Native dialogs are banned by lint.** `eslint.config.mjs` rejects `confirm`, `alert` and `prompt` in
`app/**` and `components/**`, in two ways:

- **as globals**, through `no-restricted-globals`;
- **as receiver-qualified calls** (`window.confirm`, computed and parenthesised forms, type-erased
  wrappers), through a local `hone-dialog/no-native-dialog-receiver` rule.

Flat config *replaces* a rule's options rather than merging them. So the financials subtree has its own
block carrying both its ESM restrictions and the dialog set, and the general block ignores that subtree
([`eslint.config.mjs`](../../eslint.config.mjs#L12-L33),
[L254-L308](../../eslint.config.mjs#L254-L308), [L340-L367](../../eslint.config.mjs#L340-L367)).
`tests/components/ui05-native-confirm-retirement.test.ts` proves, against the effective config, that
every native form is rejected and every legitimate binding stays legal.

**`ConfirmDialog`** ([`confirm-dialog.tsx`](../../components/confirm-dialog.tsx#L1-L60)) replaced
`window.confirm`, which iOS Safari can suppress silently. A suppressed confirm returns `false`, so the
mutation never runs. The component is presentational only and never calls a server action. The caller
owns `pending`, `error`, `onConfirm` and `onCancel`. It provides:

- `role="alertdialog"` with `aria-modal` and labelled title and description;
- focus moved in on open and restored to the opener on close;
- a Tab trap, parking focus on the panel when every control is disabled mid-submit;
- **Escape and backdrop close only while idle**, so an in-flight request is never abandoned;
- both buttons disabled while pending, at a 44px minimum;
- a caller-supplied, curated error in an assertive alert region.

**Two shared hooks:**

- [`useDialogKeyboard`](../../components/use-dialog-keyboard.ts#L5-L60) gives every other in-app modal
  the same keyboard contract: focus in, restore on close, idle-gated Escape and a trap. It exists
  because two `aria-modal` panels had declared themselves modal and implemented none of it.
- [`useReturnFocus`](../../components/use-return-focus.ts#L5-L77) handles the case `ConfirmDialog`
  cannot: a **confirmed action that removes its own opener**, for example archiving a portal message,
  removing a client tag or removing a treatment-plan stage. On success only, `arm()` moves focus to an
  anchor that survives (`tabIndex={-1}`). Cancel and failure keep the dialog's own restoration.
  `e2e/ui05-native-confirm-retirement.spec.ts` proves both paths in a real browser.

## 5. Motion and timing

- Timing is decided once, in `app/globals.css`: `--hone-duration-press: 120ms`,
  `--hone-duration-ui: 180ms`, and a reserved `--hone-duration-overlay: 240ms`.
- `PRESS_TRANSITION` / `UI_TRANSITION` are CSS marker classes. No animation library is installed
  ([`globals.css`](../../app/globals.css#L122-L165)).
- Under `prefers-reduced-motion` the markers collapse to **1ms, not 0**, and skeleton pulses stop. The
  state change still happens, and buttons keep their colour press step.
- Automatic dark mode is off: the `dark:` variant maps to a `.dark` class that is never applied.

## 6. How the rules are proved

| Layer | File(s) | What it proves |
|---|---|---|
| Primitive render and source | `tests/components/ui-foundations.test.ts` | 44px floor per variant/size, focus-visible only, forced-colors fallback in compiled CSS, `busyLabel` semantics, client-boundary and dependency guards |
| Interaction foundations | `tests/components/ui-r01-interaction-foundations.test.ts` | distinct pressed colours, leaf layer is scale-only, reduced-motion keeps acknowledgement, spinner cannot resize a control |
| Dialog source contract | `tests/components/confirm-dialog.test.ts` | roles, opener capture, focus trap, idle-gated dismissal, disabled-while-pending, alert region |
| Native-dialog retirement | `tests/components/ui05-native-confirm-retirement.test.ts` | ESLint rejects 17/17 native forms and 0/12 legitimate bindings are flagged; the lint target set covers every product file |
| Browser | `e2e/ui-r01-interaction-foundations.spec.ts`, `e2e/ui05-native-confirm-retirement.spec.ts`, `e2e/perceived-speed.spec.ts`, `e2e/ui0*-*.spec.ts` | real press, pending, double-activation, focus and mobile-viewport behaviour |

Most `tests/components/*` files are **source tests**: they pattern-match component text. They are
tripwires, not behavioural proof (see [Source, docs and security guard tests](../testing/source-docs-and-security-guards.md)).
Several comments say so explicitly. For example, moving `ConfirmDialog`'s focus logic into
`useDialogKeyboard` would break `confirm-dialog.test.ts` without changing behaviour.

## 7. Domain component map

| Cluster (under `components/`) | Behaviour is documented in |
|---|---|
| `log-electrolysis-entry-form.tsx`, `log-laser-entry-form.tsx`, `entry-row.tsx`, `multi-area-*`, `area-picker.tsx`, `body-map-area-picker.tsx`, `chip-selector.tsx`, `selected-observations.tsx`, `probe-picker.tsx`, `probe-lot-select.tsx`, `copy-draft-card.tsx`, `session-timeline.tsx` | [Sessions, blocks and entries](../treatment-memory/sessions-blocks-and-entries.md), [Probes and record keeping](../treatment-memory/probes-settings-and-record-keeping.md) |
| `last-treatment-memory-card.tsx`, `last-session-summary.tsx`, `last-visit-card.tsx`, `before-today-card.tsx`, `appointment-prep-memory-card.tsx`, `clinical-unavailable-notice.tsx` | [Treatment memory reads](../treatment-memory/memory-reads-and-point-of-care.md) |
| `treatment-intelligence-card.tsx` | [Treatment Intelligence summary](../treatment-memory/treatment-intelligence-summary.md) |
| `clinical-notes-*.tsx`, `client-pinned-notes-card.tsx`, `pinned-notes-readonly.tsx`, `client-personal-notes-editor.tsx`, `consultation-notes-card.tsx` | [Clinical, pinned and personal notes](../treatment-memory/clinical-notes-and-client-notes.md) |
| `treatment-plan*.tsx`, `treatment-schedule-editor.tsx`, `treatment-time-card.tsx` | [Treatment plans and treatment time](../treatment-memory/treatment-plans-and-treatment-time.md) |
| `client-form.tsx`, `client-search.tsx`, `client-tags-card.tsx`, `client-budget-card.tsx`, `client-birthday-card.tsx`, `client-appointment-timeline.tsx`, `profile-tab*.ts(x)` | [Client records and profile](../clients/client-records-and-profile.md) |
| `payment/`, `payment-method-card.tsx`, `checkout-button.tsx`, `quick-checkout-modal.tsx`, `appointment-checkout-cell.tsx`, `appointment-settlement-controls.tsx`, `session-payment-prepare-card.tsx` | [Card on file, checkout and payment proof](../payments/card-on-file-checkout-and-payment-proof.md) |
| `intake/`, `intake-consent-record-viewer.tsx`, `signed-consent-viewer.tsx`, `consent-signatures-card.tsx`, `portal-messages-card.tsx` | [Intake forms and review](../portal/intake-forms-review-and-assisted-intake.md), [Client portal](../portal/client-portal-intake-and-consent.md) |
| `waitlist/` | [New-client admission mode](../waitlist/new-client-admission-mode.md), [Invitation lifecycle](../waitlist/entries-and-invitation-lifecycle.md) |

`app/_components/` holds route-private components outside this layer, mostly for the public marketing site
(`app/_components/marketing/`).
