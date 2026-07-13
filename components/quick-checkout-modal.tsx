"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { FormattedDateTime } from "@/components/formatted-date-time";
import { SessionPaymentPrepareCard } from "@/components/session-payment-prepare-card";
import {
  prepareSessionPaymentChargeAction,
  executeSessionPaymentChargeAction,
  sendPaymentChargeReceiptAction,
  refundPaymentChargeAttemptAction,
} from "@/app/(app)/clients/[id]/sessions/[sessionId]/payment-actions";
import {
  getQuickCheckoutContextAction,
  type QuickCheckoutContextResult,
} from "@/app/(app)/quick-checkout-actions";

// Quick checkout modal (Chloe: complete payment while the client is standing
// there, without navigating client → sessions → charting → payment). It is a
// thin shell: it resolves context via getQuickCheckoutContextAction and renders
// the EXISTING SessionPaymentPrepareCard, so every payment rule, state, duplicate
// protection, and the compact display are reused unchanged. It never marks
// charting complete or touches clinical state — the practitioner closes it and
// finishes charting later.

export function QuickCheckoutModal({
  appointmentId,
  open,
  onClose,
}: {
  appointmentId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [ctx, setCtx] = useState<QuickCheckoutContextResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const titleId = useId();
  const descId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Re-read trusted server context every time the modal opens, so a stale local
  // view (e.g. a charge that succeeded in another tab) is never authoritative.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setCtx(null);
    getQuickCheckoutContextAction(appointmentId)
      .then((result) => {
        if (!cancelled) setCtx(result);
      })
      .catch(() => {
        if (!cancelled)
          setLoadError(
            "Could not load checkout. Reload the page and try again.",
          );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, appointmentId]);

  // Escape to close + move focus into the dialog on open.
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
      onMouseDown={(e) => {
        // Backdrop click closes; clicks inside the panel do not.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        data-testid="quick-checkout-modal"
        className="flex max-h-[92vh] w-full max-w-md flex-col overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl dark:bg-neutral-950 sm:rounded-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-lg font-semibold">
            Checkout
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            data-testid="quick-checkout-close"
            aria-label="Close checkout"
            className="-m-2 flex h-11 w-11 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            ✕
          </button>
        </div>

        <p id={descId} className="sr-only">
          Take payment for this appointment. Charting is not affected; you can
          close this and finish charting later.
        </p>

        {loading && (
          <p
            className="mt-4 text-sm text-neutral-500"
            role="status"
            aria-live="polite"
          >
            Loading checkout…
          </p>
        )}

        {loadError && (
          <p className="mt-4 text-sm text-red-700 dark:text-red-400" role="alert">
            {loadError}
          </p>
        )}

        {!loading && ctx && ctx.ok === false && (
          <div className="mt-4 flex flex-col gap-3" data-testid="quick-checkout-ineligible">
            <p className="text-sm text-neutral-700 dark:text-neutral-300">
              {ctx.reason}
            </p>
            {ctx.clientId && (
              <Link
                href={`/clients/${ctx.clientId}?tab=sessions`}
                className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-neutral-300 px-4 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
              >
                Open the client&apos;s sessions
              </Link>
            )}
          </div>
        )}

        {!loading && ctx && ctx.ok === true && (
          <div className="mt-3 flex flex-col gap-3">
            <div className="text-xs text-neutral-500 dark:text-neutral-400">
              <span className="font-medium text-neutral-700 dark:text-neutral-200">
                {ctx.clientName}
              </span>
              {ctx.appointment.startsAt && (
                <>
                  {" · "}
                  <FormattedDateTime iso={ctx.appointment.startsAt} />
                </>
              )}
              {ctx.appointment.serviceName && <> · {ctx.appointment.serviceName}</>}
            </div>

            {/* The EXISTING payment card — prepare / confirm / charge / receipt /
                refund all run through the same hardened server actions, with the
                compact (owner-gated) display from PR #418. */}
            <SessionPaymentPrepareCard
              sessionId={ctx.sessionId}
              clientId={ctx.clientId}
              eligibility={ctx.eligibility}
              defaultAmount={ctx.defaultAmount}
              isOwner={ctx.isOwner}
              prepareAction={prepareSessionPaymentChargeAction}
              executeAction={executeSessionPaymentChargeAction}
              sendReceiptAction={sendPaymentChargeReceiptAction}
              refundAction={refundPaymentChargeAttemptAction}
            />

            <p className="border-t border-neutral-200 pt-3 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
              Taking payment here does not finish charting. You can close this and
              finish charting later.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
