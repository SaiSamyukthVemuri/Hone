"use client";

import { useState } from "react";
import { QuickCheckoutModal } from "@/components/quick-checkout-modal";

// Entry point for quick checkout. Rendered on practitioner surfaces (appointment
// detail, today's roster). Payment is session-scoped and requires a COMPLETED
// appointment, so the button only shows for completed appointments: cancelled /
// no-show / confirmed appointments never see it. The modal itself resolves the
// accurate state (already-paid, no card, no session, refunded) server-side.
export function CheckoutButton({
  appointmentId,
  status,
  variant = "primary",
  // PAY-SETTLE / 0187. The same entry point, honestly labelled for the one
  // case where "Checkout" would be a lie: a fully refunded visit is not
  // awaiting checkout, but it DOES need a route to record how it was settled
  // instead. Defaults to the historical label so every existing call site is
  // unchanged.
  label = "Checkout",
}: {
  appointmentId: string;
  status: string | null;
  variant?: "primary" | "compact";
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  if (status !== "completed") return null;

  const cls =
    variant === "compact"
      ? "inline-flex min-h-[44px] items-center justify-center rounded-md border border-neutral-300 px-3 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
      : "inline-flex min-h-[44px] items-center justify-center rounded-md bg-neutral-900 px-4 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900";

  return (
    <>
      <button
        type="button"
        data-testid="checkout-button"
        onClick={() => setOpen(true)}
        className={cls}
      >
        {label}
      </button>
      <QuickCheckoutModal
        appointmentId={appointmentId}
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
