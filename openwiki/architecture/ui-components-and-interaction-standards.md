---
type: architecture
title: UI components and interaction standards
description: How Hone's shared React layer in components/ is built and policed — the server-compatible primitives in components/ui and the guard that keeps them hook-free, the client leaf islands for pending submit and navigation, ConfirmDialog and the focus hooks that replaced native dialogs, CSS-only motion tokens, the DESIGN.md LAW/CONTRACT model, the component and browser tests behind each rule, and a map from domain component clusters to the pages that own their behaviour.
tags: [ui, components, accessibility, design-contract, eslint, playwright]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-04T01:59:59.625Z
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
generated: { by: "claude-code", at: "2026-10-04T01:59:59.625Z" }
---

# UI components and interaction standards

`components/` is Hone's shared React layer. It holds three kinds of file:

- **`components/ui/`**: server-compatible visual primitives (`Button`, `Field`, `Card`, `StatusPill`,
  `SectionLabel`, `Skeleton`, `Spinner`, `EmptyState`, `PageHeader`) and the shared class fragments in
  [`control-base.ts`](../../components/ui/control-base.ts);
- **client leaf islands** that need a hook: [`pending-button.tsx`](../../components/pending-button.tsx),
  [`pending-link.tsx`](../../components/pending-link.tsx), [`confirm-dialog.tsx`](../../components/confirm-dialog.tsx),
  [`use-dialog-keyboard.ts`](../../components/use-dialog-keyboard.ts) and
  [`use-return-focus.ts`](../../components/use-return-focus.ts);
- **domain components** beside them (charting forms, notes cards, payment cards, waitlist panels; map in §7).

Server actions and database commands own behaviour. A component renders state, collects input and reports
pending or failed states; it is never a write authority.

## 1. Design authority: `DESIGN.md`

[`DESIGN.md`](../../DESIGN.md) is canonical for design decisions and subordinate to
`ENGINEERING_STANDARDS.md`. It tags every rule:

| Tag | Meaning | May an agent act on it? |
|---|---|---|
| `[LAW]` | a durable outcome, e.g. *every control acknowledges immediately* | always binding |
| `[CONTRACT]` | today's mechanism for a law (a file or constant) | use it; do not hand-roll beside it |
| `[PILOT]` | a bounded experiment (MOTION-01) | only its stated scope |
| `[PRODUCT AUTHORITY REQUIRED]` | undecided | propose only, never implement |

The laws are in [§ LAW](../../DESIGN.md#law--the-durable-rules), the mechanisms in
[§ CONTRACT](../../DESIGN.md#contract--the-current-mechanisms) and the prohibitions in
[§ What an agent must never do](../../DESIGN.md#what-an-agent-must-never-do): no new design dependency, no
hand-rolled control beside a primitive, no promotion of a proposal or review comment into a law.

**Lifecycle of the rules themselves.** The MOTION-01 pilot is specified but gated: it must not start until
the drawer's dismissal geometry is resolved, and that prerequisite is recorded as proposed, not scheduled.
Read contract rows as **implemented** mechanisms; read pilot and authority items as **designed or
undecided**, never as shipped.

## 2. The primitive layer (`components/ui/`)

**Boundary rule.** No file in `components/ui/` may declare `"use client"`, use `useState`, `useEffect`,
`useRef`, `useTransition` or `useFormStatus`, or import `clsx`, `cva`, `tailwind-merge` or a motion library.
`tests/components/ui-foundations.test.ts` enforces it, so a server-rendered clinical page never hydrates
because it uses a button. When a component needed a hook, it moved out of `components/ui/` and the guard
stayed as it was; that is why `PendingButton`, `PendingLink` and the dialog hooks live one level up.

**Touch floor** ([`control-base.ts` L33-L55](../../components/ui/control-base.ts#L33-L55)):

- `CONTROL_MIN_TOUCH` ships `inline-flex` together with `min-h-[44px]`, because `min-height` has no effect
  on an inline box.
- `CONTROL_COMPACT_FINE_POINTER` relaxes the height to 32px only under `(pointer: fine)`, never behind a
  width breakpoint: a tablet in portrait is still a thumb.

**Focus** ([L57-L87](../../components/ui/control-base.ts#L57-L87)): `FOCUS_RING` is `focus-visible:` only,
with a 2px ring and offset that changes geometry rather than relying on colour. It uses `outline-hidden`,
not `outline-none`: Tailwind v4's `outline-hidden` leaves a transparent outline that forced-colors mode
repaints, while the ring itself is a `box-shadow` that forced-colors mode removes. The test proves this
against CSS compiled by the installed Tailwind, not against the class spelling.

**`Button`** ([`button.tsx` L103-L194](../../components/ui/button.tsx#L103-L194)):

- `type` defaults to `"button"`, so a bare button cannot submit a form by accident.
- `pending` is a **prop**. It disables the control and sets `aria-busy` and `data-pending`. With
  `busyLabel` it swaps the label; without it the label stays in flow at `opacity-0` under a centred
  spinner, so the box and the accessible name do not change.
- `buttonClasses()` styles a `next/link` `<Link>` as a button without a polymorphism dependency.

**Press acknowledgement.** Every variant has a pressed colour distinct from its hover colour, so a press is
visible on touch, where `:hover` never fires, and under reduced motion
([`button.tsx` L32-L48](../../components/ui/button.tsx#L32-L48)). `LEAF_CONTROL_PRESS` adds only a 0.98
scale; `SURFACE_PRESS` is a background change for neutral surfaces only
([`control-base.ts` L101-L165](../../components/ui/control-base.ts#L101-L165)).

## 3. Pending state: the client leaves

| Leaf | Hook | Use when |
|---|---|---|
| `PendingButton` | `useFormStatus()` inside the `<form>` | a server-action submit; renders `Button type="submit"` with `pending` |
| `PendingLink` / `PendingContainerLink` | `useLinkStatus()` inside the owning `<Link>` | a navigation whose control survives its own press |
| Shell handoff (DESIGN contract 2d) | `useTransition()` on a retained root | only `app/(app)/MobileMenu.tsx` and `app/(app)/GlobalSearch.tsx`, whose panels unmount on activation |

**The duplicate-submit guard is not advisory.** The browser proof issues two raw activations before
waiting for `aria-busy` and counts the real server-action POSTs: a rapid second activation must not reach
the server ([`pending-button.tsx` L30-L84](../../components/pending-button.tsx#L30-L84),
[`ui-r01-interaction-foundations.spec.ts` L290-L346](../../e2e/ui-r01-interaction-foundations.spec.ts#L290-L346)).
It is a UI guard; server commands still own idempotency.

**`PendingLink` is presentation only.** It reads Next's navigation state and paints a mark and a live
region; it starts no navigation and adds no Suspense boundary. A group-level `loading.tsx` was tried and
withdrawn because it stalled query-only navigations
([`pending-link.tsx` L10-L60](../../components/pending-link.tsx#L10-L60)).

## 4. Dialogs and focus

**Native dialogs are banned by lint.** `eslint.config.mjs` rejects `confirm`, `alert` and `prompt` in
`app/**` and `components/**` both as globals (`no-restricted-globals`) and as receiver-qualified calls such
as `window.confirm` (the local `hone-dialog/no-native-dialog-receiver` rule). Flat config *replaces* a
rule's options rather than merging them, so the financials block repeats the dialog restrictions
([L12-L33](../../eslint.config.mjs#L12-L33), [L254-L308](../../eslint.config.mjs#L254-L308),
[L340-L367](../../eslint.config.mjs#L340-L367)). `tests/components/ui05-native-confirm-retirement.test.ts`
lints a matrix of native forms and legitimate bindings through the real config
([L219-L246](../../tests/components/ui05-native-confirm-retirement.test.ts#L219-L246)).

**`ConfirmDialog`** replaced `window.confirm`, which iOS Safari can suppress silently (a suppressed confirm
returns `false`, so the action never runs) ([L1-L60](../../components/confirm-dialog.tsx#L1-L60)). It is
presentational and never calls a server action; the caller owns `pending`, `error`, `onConfirm` and
`onCancel` ([L81-L211](../../components/confirm-dialog.tsx#L81-L211)). It provides:

- `role="alertdialog"` with `aria-modal` and labelled title and description;
- focus moved in on open and restored to the opener on close;
- a Tab trap;
- Escape and backdrop close **only while idle**, so an in-flight request is never abandoned;
- both buttons disabled while pending, at a 44px minimum;
- a caller-supplied error in an alert region.

**Two shared hooks:**

- [`useDialogKeyboard`](../../components/use-dialog-keyboard.ts#L14-L60) gives every other in-app modal the
  same contract: focus in, restore on close, a Tab trap, and Escape suppressed while busy
  ([L83-L138](../../components/use-dialog-keyboard.ts#L83-L138)). It exists because two `aria-modal` panels
  had declared themselves modal and implemented none of it.
- [`useReturnFocus`](../../components/use-return-focus.ts#L13-L77) handles a **confirmed action that removes
  its own opener** (archiving a portal message, removing a client tag or a plan stage). On success only it
  moves focus to an anchor that survives; cancel and failure keep `ConfirmDialog`'s own restoration.
  `e2e/ui05-native-confirm-retirement.spec.ts` proves both paths in a browser
  ([L116-L170](../../e2e/ui05-native-confirm-retirement.spec.ts#L116-L170)).

## 5. Motion and timing

- Timing is decided once in `app/globals.css`: `--hone-duration-press: 120ms`, `--hone-duration-ui: 180ms`
  and a reserved `--hone-duration-overlay: 240ms` ([L122-L169](../../app/globals.css#L122-L169)).
- `PRESS_TRANSITION` and `UI_TRANSITION` are CSS marker classes; no animation library is installed
  ([`control-base.ts` L89-L95](../../components/ui/control-base.ts#L89-L95)).
- Under `prefers-reduced-motion` the markers collapse to **1ms, not 0**, and skeleton pulses stop. The state
  change still happens.

## 6. How the rules are proved

| Layer | File(s) | What it proves |
|---|---|---|
| Primitive render and source | `tests/components/ui-foundations.test.ts` | the 44px floor per variant and size, focus-visible only, the forced-colors fallback in compiled CSS, client-boundary and dependency guards |
| Interaction foundations | `tests/components/ui-r01-interaction-foundations.test.ts` | distinct pressed colours, the scale-only leaf layer, reduced-motion acknowledgement, a spinner that cannot resize a control |
| Dialog source contract | `tests/components/confirm-dialog.test.ts` | roles, opener capture, focus trap, idle-gated dismissal, disabled-while-pending, the alert region |
| Native-dialog retirement | `tests/components/ui05-native-confirm-retirement.test.ts` | every native form in the matrix rejected and every legitimate binding accepted, through the real ESLint config |
| Browser | `e2e/ui-r01-interaction-foundations.spec.ts`, `e2e/ui05-native-confirm-retirement.spec.ts`, `e2e/perceived-speed.spec.ts` | real press, pending, double activation, focus and mobile-viewport behaviour |

Most `tests/components/*` files are **source tests** that pattern-match component text. They are tripwires,
not behavioural proof (see [Source, docs and security guard tests](../testing/source-docs-and-security-guards.md)):
moving `ConfirmDialog`'s focus logic into `useDialogKeyboard`, for example, would break
`confirm-dialog.test.ts` without changing behaviour.

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

`app/_components/` holds route-private components outside this layer, mostly for the public marketing site.
