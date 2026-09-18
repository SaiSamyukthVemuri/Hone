"use client";

// The canonical async-form submit control (UI-R01).
//
// WHY THIS LIVES IN components/ AND NOT components/ui/
// ----------------------------------------------------
// The first draft of UI-R01 put this in components/ui/ and the #609 guard in
// tests/components/ui-foundations.test.ts caught it immediately: that directory
// is the SERVER-COMPATIBLE primitive layer, and the guard asserts no file in it
// declares "use client" or touches a stateful React hook. This file does both.
//
// components/pending-link.tsx hit the identical wall and its test records the
// ruling verbatim: "Carving an exception into that guard would have weakened a
// rule with a real stated purpose; the component moved instead." So this moved
// too. The guard was not touched.
//
// `useFormStatus` is a client hook AND it only reports anything when it runs
// inside the <form> it is reading. Both facts point the same way: this has to
// be a LEAF island, and it must not be folded into Button.
//
// Button is deliberately server-compatible — no "use client", no state, no
// hook — so that a settings page, a records page or a clinical page can render
// its controls on the server. Putting `useFormStatus` inside Button would make
// every one of those pages hydrate for nothing. #609 guards components/ui/
// against exactly that, so `pending` stays a PROP on Button and the hook lives
// out here, in the smallest possible wrapper that owns it.
//
// This file imports Button and one hook. Nothing else. It is the leaf.
//
// THE STATE MACHINE THIS IMPLEMENTS
//
//   REST ──press──> PRESSED ──submit──> PENDING ──> SETTLED | ERROR
//
//   REST     Button's resting variant.
//   PRESSED  CONTROL_PRESS — CSS only, no JS, paints in the first frame.
//            This is what makes the control feel alive before the network
//            has been touched at all.
//   PENDING  useFormStatus().pending -> Button `pending` -> disabled +
//            aria-busy + geometry-stable spinner. The disable IS the
//            duplicate-submit guard; it is not advisory.
//   SETTLED  The form action returned and React cleared `pending`. The
//            surrounding page re-renders with the new state; this control
//            simply stops being busy. It does NOT invent a success toast —
//            success feedback belongs to the surface that knows whether the
//            result is self-evident.
//   ERROR    Identical to SETTLED from this control's point of view: pending
//            clears and the control becomes pressable again. The error text
//            belongs to the form, not to the button. What this guarantees is
//            the part that was actually broken — the control never stays stuck
//            in a busy state after a failed action.

import { useFormStatus } from "react-dom";

import { Button, type ButtonProps } from "@/components/ui/button";

export type PendingButtonProps = Omit<ButtonProps, "pending" | "type"> & {
  /**
   * Announced while the action is in flight.
   *
   * Passed straight through to Button's existing `busyLabel`, so a caller that
   * wants the historical visible label swap keeps it. Omit it — the
   * recommended default — and the control shows the geometry-stable spinner
   * instead, which cannot resize the button.
   */
  busyLabel?: string;
};

export function PendingButton({ busyLabel, disabled, ...rest }: PendingButtonProps) {
  const { pending } = useFormStatus();
  return (
    <Button
      {...rest}
      // A submit control, by definition. Button defaults to type="button" so a
      // bare button cannot submit a form by accident; here the whole point is
      // that it submits one.
      type="submit"
      pending={pending}
      busyLabel={busyLabel}
      // Button already computes `disabled || pending`; this keeps a caller's
      // own disabled reason (invalid form, missing permission) working too.
      disabled={disabled}
    />
  );
}
