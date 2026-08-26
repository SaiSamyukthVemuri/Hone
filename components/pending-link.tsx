"use client";

import Link, { useLinkStatus } from "next/link";
import type { ComponentProps, ReactNode } from "react";

import { PRESS_TRANSITION, cx } from "./ui/control-base";

// A <Link> that acknowledges the tap immediately (UI-01).
//
// THE PROBLEM
// -----------
// Production had no pending presentation anywhere in the authenticated app. A
// <Link> click starts a React transition that keeps the OLD page mounted, fully
// painted and fully interactive, until the new RSC payload arrives. Nothing on
// screen changes. Chloe taps, reads the same screen for a few hundred
// milliseconds, and the app appears dead.
//
// WHY NOT A ROUTE `loading.tsx`
// ----------------------------
// Because it cannot serve this surface, and — measured on this branch — it
// breaks it. Two separate reasons, both load-bearing:
//
//   1. STRUCTURAL. `/dashboard?day=A` -> `?day=B` changes only the query, so
//      the segment is unchanged, React reuses the tree, and no route fallback
//      ever renders. The same is true of the practice-snapshot period pills and
//      the calendar toolbar. A route boundary is silent on all of them.
//
//   2. MEASURED. A group-level app/(app)/loading.tsx was built for the OTHER
//      half of UI-01 (segment changes) and withdrawn: placed above a segment
//      that is also reached by query-only navigation, it stalls that navigation
//      outright — the transition never commits, the URL never updates, and the
//      pending state never clears. Two of three pre-existing
//      dashboard-day-navigation tests failed; removing the boundary and
//      changing nothing else made all of them pass. That half needs
//      architecture review, and this file is not it.
//
// So this is not a redundant second mechanism competing with a boundary. It is
// the only thing that can speak for a query-only navigation, and it is proved
// against one: e2e/perceived-speed.spec.ts.
//
// PRESENTATION ONLY. `useLinkStatus` reports Next's own navigation state; this
// component reads it and paints. It starts no navigation, holds no state of its
// own, adds no Suspense boundary, registers no click handler, and cannot claim
// anything about the destination beyond "the request you asked for is in
// flight". That is also why it is safe where a boundary was not.
//
// WHY "use client" IS UNAVOIDABLE HERE
// ------------------------------------
// `useLinkStatus` is a client hook and must run inside the subtree of the
// <Link> that owns the navigation. It is a LEAF island: it imports next/link
// and one class helper, nothing else. The dashboard keeps rendering on the
// server and only these small anchors hydrate.
//
// It lives HERE and not in components/ui/ deliberately: that directory is the
// server-compatible primitive layer, and #609 guards it against exactly this
// (no "use client", no stateful hook). A visual foundation must never be the
// reason a server-rendered clinical page starts hydrating.
//
// TWO FORMS, ONE MECHANISM (UI-01C)
// ---------------------------------
// The acknowledgement vocabulary below — the mark, the live region, the
// `data-link-pending` hook every proof locates — is defined ONCE and shared.
// What differs between the two exports is only WHERE the acknowledgement can
// be painted, and that is decided by what the control's content is:
//
//   PendingLink           the content is a LABEL   -> fade it, mark in its place
//   PendingContainerLink  the content is a LAYOUT  -> leave it exactly alone
//
// `PendingLink` wraps `children` in ONE span so the label can fade without the
// anchor resizing. That span is a single in-flow box, which is correct for a
// label and WRONG for a link that is itself a flex/grid container: the
// dashboard appointment row body is `flex … gap-4` over a fixed time cell and
// a `min-w-0 flex-1` text column, and one wrapper would collapse both into a
// single flex track. That is the whole reason the row body was left out of
// UI-01A/B, and `PendingContainerLink` is what it was waiting for.
//
// WHY NOT `display: contents` ON THE WRAPPER
// ------------------------------------------
// It is the obvious fix and it was rejected. `display: contents` asks the
// browser to remove a box from the box tree, and whether the element also
// leaves the ACCESSIBILITY tree has been implementation-defined and has
// changed under us across releases in every engine Hone supports. Trading a
// layout bug for an accessibility bug that no local run can see is not a
// trade; and it is unnecessary, because nothing has to wrap the children at
// all.
//
// WHAT LAYOUT-TRANSPARENT ACTUALLY MEANS HERE
// -------------------------------------------
// `PendingContainerLink` renders `children` as the anchor's OWN children,
// untouched, and adds only OUT-OF-FLOW siblings:
//
//   * an absolutely positioned child of a flex container is not a flex item
//     and does not participate in flex layout (CSS Flexible Box Layout §4.1),
//     so the scrim adds no track to the row;
//   * Tailwind's `sr-only` is itself `position: absolute`, so the live region
//     is out of flow for the same reason — it is not a second exception, it is
//     the same one;
//   * `position: relative` with no offsets changes no geometry. It only
//     establishes the containing block the scrim needs, and the row body has
//     no positioned descendants for it to re-anchor.
//
// So the anchor keeps exactly the in-flow children it had, with the same box
// tree and the same computed geometry. The proof is a structural one — the
// bounding boxes of the anchor and BOTH flex children, at rest and mid-flight,
// at desktop and at 390px — in e2e/perceived-speed.spec.ts, not a screenshot.
//
// AND WHY THE CONTENT IS NOT FADED
// --------------------------------
// A label may fade to `opacity-0` because its accessible name survives and the
// control is two words wide. A treatment row is not a label: fading it would
// blank the client's name, the pills, the caution line and the plan note, and
// a row that goes blank on tap reads as a bug, not as an acknowledgement. The
// content stays lit and a scrim dims it instead — same instant, same mark,
// same sentence for a screen reader, nothing hidden.

type LinkProps = ComponentProps<typeof Link>;

export type PendingLinkProps = Omit<LinkProps, "className" | "children"> & {
  children: ReactNode;
  className?: string;
  /**
   * What a screen reader hears while the navigation is in flight. It must
   * describe the REQUEST, never the outcome: "Opening…", not "Opened".
   */
  pendingLabel?: string;
};

/**
 * The mark, spelled ONCE for both forms.
 *
 * A ring drawn in `border`, deliberately, and not a box-shadow: forced-colors
 * mode (Windows High Contrast) forces `box-shadow: none` and would erase a
 * shadow-drawn mark entirely, while a border is repainted in a system colour.
 * Reduced motion keeps the MARK and drops only the rotation; closing the ring
 * makes the still frame read as a deliberate glyph rather than a broken
 * circle. The state change survives without motion, and it is a shape change,
 * never colour alone.
 */
const MARK =
  "size-4 animate-spin rounded-full border-2 border-current border-t-transparent " +
  "motion-reduce:animate-none motion-reduce:border-t-current";

/**
 * The live region, spelled ONCE for both forms.
 *
 * MOUNTED AT ALL TIMES; only its TEXT changes.
 *
 * This element must NOT be rendered conditionally. A polite live region has to
 * exist before its content changes: a `role="status"` node that is inserted
 * already containing its message is not reliably announced (that is
 * `role="alert"` behaviour, not this one). Mounting it pre-populated left the
 * pending state silent for exactly the screen-reader users this label exists to
 * serve — the announcement is the ONLY signal they get, since the mark beside
 * it is aria-hidden and the label change is purely visual.
 *
 * Empty at rest, so it contributes nothing to the link's accessible name until
 * there is genuinely something to say. `sr-only` is `position: absolute`, which
 * is also what keeps it out of a container link's flex flow.
 */
function PendingStatus({
  pending,
  pendingLabel,
}: {
  pending: boolean;
  pendingLabel: string;
}) {
  return (
    <span role="status" className="sr-only">
      {pending ? pendingLabel : ""}
    </span>
  );
}

function PendingLabel({
  children,
  pendingLabel,
}: {
  children: ReactNode;
  pendingLabel: string;
}) {
  const { pending } = useLinkStatus();
  return (
    <>
      <span
        // `opacity-0`, NOT `invisible`/`hidden`: visibility:hidden would pull
        // the label out of the accessibility tree, and the link's accessible
        // name would momentarily collapse to "Opening…" — losing the only
        // words that say WHERE it goes. Opacity keeps both the box and the
        // name, so the control never resizes and never loses its meaning.
        //
        // PRESS_TRANSITION (120ms) is the token #609 defines as
        // "acknowledgement — must feel instant", and reduced motion collapses
        // it to 1ms in app/globals.css.
        className={cx(PRESS_TRANSITION, pending && "opacity-0")}
      >
        {children}
      </span>
      {/* The mark that replaces the label. Decorative — the sentence a screen
          reader gets is the live region below, not this. */}
      {pending && (
        <span
          data-link-pending="true"
          aria-hidden="true"
          className={cx("pointer-events-none absolute inset-0 m-auto", MARK)}
        />
      )}
      <PendingStatus pending={pending} pendingLabel={pendingLabel} />
    </>
  );
}

function PendingScrim({ pendingLabel }: { pendingLabel: string }) {
  const { pending } = useLinkStatus();
  return (
    <>
      {/* Out of flow, so the control it covers is laid out exactly as it was.
          `rounded-[inherit]` adopts whatever radius the anchor has, so the
          scrim cannot square off a rounded control. It carries the same
          `data-link-pending` hook as the label form's mark: one mechanism, one
          thing for a proof to look for. */}
      {pending && (
        <span
          data-link-pending="true"
          aria-hidden="true"
          className={cx(
            "pointer-events-none absolute inset-0 rounded-[inherit]",
            "flex items-center justify-center",
            // Dim, never blank. The row's own words stay legible underneath —
            // this says "opening", it does not take the row away.
            "bg-white/60 dark:bg-neutral-950/60",
          )}
        >
          <span className={MARK} />
        </span>
      )}
      <PendingStatus pending={pending} pendingLabel={pendingLabel} />
    </>
  );
}

export function PendingLink({
  children,
  className,
  pendingLabel = "Opening…",
  ...rest
}: PendingLinkProps) {
  return (
    <Link
      {...rest}
      // `relative` is owned here, not by the call site: the spinner is
      // absolutely positioned so the control cannot change width mid-tap, and
      // a caller that forgot this class would let the mark escape to the
      // nearest positioned ancestor.
      className={cx("relative", className)}
    >
      <PendingLabel pendingLabel={pendingLabel}>{children}</PendingLabel>
    </Link>
  );
}

/**
 * The same acknowledgement for a link that IS a layout.
 *
 * Use this when the anchor's content is its own flex/grid arrangement — the
 * dashboard appointment row body — and `PendingLink` when the content is a
 * label. The only structural difference is the one that matters: `children`
 * are rendered as the anchor's own children and nothing wraps them, so every
 * flex track, every basis and every `min-w-0` the call site established is the
 * same box it was before this component existed.
 */
export function PendingContainerLink({
  children,
  className,
  pendingLabel = "Opening…",
  ...rest
}: PendingLinkProps) {
  return (
    <Link
      {...rest}
      // Same reason as above, plus one specific to this form: the scrim is
      // sized `inset-0` against THIS anchor, and a call site that forgot
      // `relative` would stretch it across a distant ancestor instead.
      className={cx("relative", className)}
    >
      {children}
      <PendingScrim pendingLabel={pendingLabel} />
    </Link>
  );
}
