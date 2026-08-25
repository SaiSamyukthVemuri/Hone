"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { FormattedDateTime } from "@/components/formatted-date-time";
import { SessionPaymentPrepareCard } from "@/components/session-payment-prepare-card";
import { AppointmentSettlementControls } from "@/components/appointment-settlement-controls";
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
// charting complete or touches clinical state: the practitioner closes it and
// finishes charting later.
//
// CTA discoverability (Chloe workflow fix). The card advances through persisted
// states (ready → succeeded → receipt) that the session detail PAGE picks up
// automatically because the card's router.refresh() / the actions' revalidatePath
// re-render that route's server components. This MODAL, however, holds the
// eligibility in client state fetched once per open, which router.refresh() does
// NOT re-run, so after "Prepare" the persisted "ready" attempt never surfaced,
// the "Run charge" button never mounted, and the practitioner had to close and
// reopen to find it. The fix: wrap the four payment actions so a SUCCESSFUL
// result silently re-resolves the trusted server context here, advancing the
// card to the correct next state in place. No change to the shared card or the
// session detail page; the server actions and their gates are untouched.

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

  // Track open state + the latest request so a response that lands after the
  // modal closed (or after a newer request started) is ignored.
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);
  const requestSeq = useRef(0);

  // Resolve trusted server context. `silent` re-resolves WITHOUT tearing down
  // the visible card (no spinner, no ctx reset) so an in-place state advance
  // after a mutation does not flash "Loading checkout…". The initial open uses
  // the loud path so the first render shows a spinner.
  const fetchContext = useCallback(
    (opts?: { silent?: boolean }) => {
      const silent = opts?.silent ?? false;
      const seq = ++requestSeq.current;
      if (!silent) {
        setLoading(true);
        setLoadError(null);
        setCtx(null);
      }
      return getQuickCheckoutContextAction(appointmentId)
        .then((result) => {
          // Drop stale / post-close responses.
          if (seq !== requestSeq.current || !openRef.current) return;
          setCtx(result);
          if (!silent) setLoadError(null);
        })
        .catch(() => {
          if (seq !== requestSeq.current || !openRef.current) return;
          // A silent refetch failure keeps the last good context (the card's
          // own in-session success state still shows); only the loud initial
          // load surfaces an error.
          if (!silent) {
            setLoadError(
              "Could not load checkout. Reload the page and try again.",
            );
          }
        })
        .finally(() => {
          if (!silent && seq === requestSeq.current) setLoading(false);
        });
    },
    [appointmentId],
  );

  // Re-read trusted server context every time the modal opens, so a stale local
  // view (e.g. a charge that succeeded in another tab) is never authoritative.
  useEffect(() => {
    if (!open) return;
    void fetchContext();
  }, [open, fetchContext]);

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

  // Wrap a payment action so a successful result advances the card in place by
  // silently re-resolving server context. Failures return unchanged so the
  // card renders its own error state. The action itself is called exactly once
  // (the wrapper never retries); this only refreshes THIS modal's view.
  const withRefresh = useCallback(
    <T extends { ok: boolean }>(
        action: (fd: FormData) => Promise<T>,
      ): ((fd: FormData) => Promise<T>) =>
      async (fd: FormData) => {
        const result = await action(fd);
        if (result.ok) void fetchContext({ silent: true });
        return result;
      },
    [fetchContext],
  );

  // PAY-SETTLE / 0187. THE SAME MECHANISM the four payment actions already use,
  // extended to settlement. `router.refresh()` inside the controls re-renders
  // the server tree behind the modal; it does not replace `ctx`, which is the
  // client-held value this modal actually renders from. So a recorded outcome
  // left the buttons on screen, and the only thing preventing a second record
  // was the command answering `already_settled` — a database refusal covering
  // for a stale view.
  //
  // Silent, so the modal advances in place instead of flashing "Loading
  // checkout…" over a completed action.
  const refetchAfterSettlement = useCallback(
    () => fetchContext({ silent: true }),
    [fetchContext],
  );

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

            {/* PAY-SETTLE / 0187 — THE CARD PATH BEING UNAVAILABLE IS THE MAIN
                REASON TO OFFER THIS, NOT A REASON TO WITHHOLD IT.

                A completed appointment that was never charted cannot be
                charged: the amount comes off the treatment record. It CAN be
                paid in cash, and until now the only way to stop it asking for
                payment forever was to chart it and run a card charge that never
                happened.

                The SAME component the payment card renders, so there is one
                settlement implementation reachable from Dashboard, Calendar and
                the session page rather than three. The charting requirement for
                CARD charging is untouched, and the reason above still names it
                truthfully. */}
            {ctx.settlement?.canRecord && (
              <AppointmentSettlementControls
                appointmentId={ctx.settlement.appointmentId}
                isOwner={ctx.isOwner}
                settledMethod={ctx.settlement.settledMethod}
                settledAmountCents={ctx.settlement.settledAmountCents}
                defaultAmountCents={ctx.settlement.quotedAmountCents}
                onRecorded={refetchAfterSettlement}
              />
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

            {/* The EXISTING payment card: prepare / confirm / charge / receipt /
                refund all run through the same hardened server actions, with the
                compact (owner-gated) display from PR #418. The actions are wrapped
                with withRefresh so a successful step advances this modal's view to
                the persisted next state without a close/reopen. */}
            <SessionPaymentPrepareCard
              sessionId={ctx.sessionId}
              clientId={ctx.clientId}
              appointmentId={ctx.appointment.id}
              settledMethod={ctx.settlement.settledMethod}
              settledAmountCents={ctx.settlement.settledAmountCents}
              settlementQuotedAmountCents={ctx.settlement.quotedAmountCents}
              canRecordSettlement={ctx.settlement.canRecord}
              onSettlementRecorded={refetchAfterSettlement}
              eligibility={ctx.eligibility}
              amountResult={ctx.amountResult}
              isOwner={ctx.isOwner}
              prepareAction={withRefresh(prepareSessionPaymentChargeAction)}
              executeAction={withRefresh(executeSessionPaymentChargeAction)}
              sendReceiptAction={withRefresh(sendPaymentChargeReceiptAction)}
              refundAction={withRefresh(refundPaymentChargeAttemptAction)}
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
