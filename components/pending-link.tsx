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
// CONSTRAINT — COMPACT LABEL LINKS ONLY
// -------------------------------------
// `children` are wrapped in ONE span so the label can fade without the anchor
// resizing. Do not use this for a link that is itself a flex/grid container
// with positioned children (the dashboard appointment row body is one) — the
// wrapper would collapse those children into a single track. Use it for links
// whose content is a label.

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
          className={cx(
            "pointer-events-none absolute inset-0 m-auto size-4",
            "animate-spin rounded-full border-2 border-current border-t-transparent",
            // Reduced motion keeps the MARK and drops only the rotation;
            // closing the ring makes the still frame read as a deliberate
            // glyph rather than a broken circle. The state change survives
            // without motion, and it is a shape change, never colour alone.
            "motion-reduce:animate-none motion-reduce:border-t-current",
          )}
        />
      )}
      {/* MOUNTED AT ALL TIMES; only its TEXT changes.
       *
       * This element must NOT be rendered conditionally. A polite live region
       * has to exist before its content changes: a `role="status"` node that is
       * inserted already containing its message is not reliably announced (that
       * is `role="alert"` behaviour, not this one). Mounting it pre-populated
       * left the pending state silent for exactly the screen-reader users this
       * label exists to serve — the announcement is the ONLY signal they get,
       * since the mark beside it is aria-hidden and the label change is purely
       * visual.
       *
       * Empty at rest, so it contributes nothing to the link's accessible name
       * until there is genuinely something to say.
       */}
      <span role="status" className="sr-only">
        {pending ? pendingLabel : ""}
      </span>
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
