"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useDialogKeyboard } from "@/components/use-dialog-keyboard";
import Link from "next/link";
import { FormattedDateTime } from "@/components/formatted-date-time";
import { splitBillFeeFields, type CheckoutFeeDraft } from "@/components/checkout-fee-fields";
import type { CheckoutMethod } from "@/components/checkout-method-picker";
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
import { SplitVisitPayments } from "@/components/split-visit-payments";
import {
  getSplitStateAction, startSplitBillAction, type SplitState,
} from "@/app/(app)/visit-payment-actions";

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
  initialMethod,
  initialFeeDraft,
}: {
  appointmentId: string;
  open: boolean;
  onClose: () => void;
  initialMethod?: CheckoutMethod;
  initialFeeDraft?: CheckoutFeeDraft;
}) {
  const [ctx, setCtx] = useState<QuickCheckoutContextResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // HON-123. Only a studio with split_payments switched on (the server decides) ever sees the split panel; everyone else is unchanged.
  const [split, setSplit] = useState<{ enabled: boolean; state: SplitState | null } | null>(null);
  const [splitNote, setSplitNote] = useState<string | null>(null);
  const titleId = useId();
  const descId = useId();
  const { panelRef, initialFocusRef: closeRef } = useDialogKeyboard<HTMLDivElement, HTMLButtonElement>({
    open,
    busy: false, // Preserve existing Escape/Close behavior; payment gates are unchanged.
    onClose,
  });

  // Track open state + the latest request so a response that lands after the
  // modal closed (or after a newer request started) is ignored.
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);
  const requestSeq = useRef(0);
  // The fee draft as the two checkout children hold it right now (they report it; this never re-renders).
  const feeDraftRef = useRef<CheckoutFeeDraft | undefined>(undefined);

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
      return Promise.all([
        getQuickCheckoutContextAction(appointmentId),
        getSplitStateAction(appointmentId).catch(() => ({ enabled: false, state: null as SplitState | null })),
      ])
        .then(([result, splitResult]) => {
          // Drop stale / post-close responses.
          if (seq !== requestSeq.current || !openRef.current) return;
          setCtx(result);
          setSplit(splitResult);
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

  const splitBill = split?.enabled ? split.state?.ledger.bill ?? null : null;
  const splitActive = !loading && !!splitBill && !!split?.state;
  // Offered only where splitting is possible: switched on, a finished visit, and nothing recorded or charged yet.
  const canOfferSplit =
    !loading && !!ctx && !!split?.enabled && !splitBill && !!ctx.settlement?.canRecord && !ctx.settlement.settledMethod &&
    (ctx.settlement.quotedAmountCents ?? 0) > 0 &&
    !("eligibility" in ctx && ctx.eligibility.existingAttempts.some((a) => ["ready", "pending_stripe", "succeeded"].includes(a.status)));

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
        tabIndex={-1}
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

        {!loading && !splitActive && ctx && ctx.ok === false && (
          <div className="mt-4 flex flex-col gap-3" data-testid="quick-checkout-ineligible">
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
            {ctx.settlement?.canRecord && (ctx.settlement.quotedAmountCents !== 0 || ctx.settlement.settledMethod) && (
              <AppointmentSettlementControls
                initialFeeDraft={initialFeeDraft}
                onDraftObserved={(d) => { feeDraftRef.current = d; }}
                initialMethod={initialMethod ?? (ctx.isOwner ? "paid_e_transfer" : undefined)}
                currency={ctx.settlement.currency ?? null}
                stripeUnavailable={ctx.settlement.quotedAmountCents === 0 ? undefined : "A linked treatment session is needed to charge with Stripe."}
                appointmentId={ctx.settlement.appointmentId}
                isOwner={ctx.isOwner}
                settledMethod={ctx.settlement.settledMethod}
                settledId={ctx.settlement.settledId}
                settledAmountCents={ctx.settlement.settledAmountCents}
                settledQuotedCents={ctx.settlement.settledQuotedCents}
                defaultAmountCents={ctx.settlement.quotedAmountCents}
                onRecorded={refetchAfterSettlement}
              />
            )}
            <p className="text-sm text-neutral-700 dark:text-neutral-300">
              {ctx.settlement?.canRecord && ctx.settlement.quotedAmountCents === 0 && !ctx.settlement.settledMethod ? "No payment due for this visit." : ctx.reason}
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

        {!loading && ctx?.settlement && initialFeeDraft && ctx.settlement.quotedAmountCents !== initialFeeDraft.referenceCents && (
          <p role="status" className="mt-3 text-sm">The booked fee changed. Review the current fee before confirming.</p>
        )}
        {!loading && !splitActive && ctx && ctx.ok === true && (
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
              initialFeeDraft={initialFeeDraft}
              onDraftObserved={(d) => { feeDraftRef.current = d; }}
              initialMethod={initialMethod}
              sessionId={ctx.sessionId}
              clientId={ctx.clientId}
              appointmentId={ctx.appointment.id}
              settledMethod={ctx.settlement.settledMethod}
              settledId={ctx.settlement.settledId}
              settledAmountCents={ctx.settlement.settledAmountCents}
                settledQuotedCents={ctx.settlement.settledQuotedCents}
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

        {canOfferSplit && (
          <div className="mt-3 border-t border-neutral-200 pt-3 dark:border-neutral-800" data-testid="split-offer">
            <p className="text-sm text-neutral-700 dark:text-neutral-300">Taking part of the payment now and the rest later?</p>
            <button
              type="button"
              className="mt-2 inline-flex min-h-[44px] items-center justify-center rounded-md border border-neutral-300 px-4 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
              onClick={() => {
                // The fee the owner reviewed (the dashboard draft, or what they edited since) travels with the bill: never the booked price by default.
                const fee = splitBillFeeFields(feeDraftRef.current ?? initialFeeDraft, ctx?.settlement?.quotedAmountCents ?? 0);
                if (!fee.ok) { setSplitNote(fee.message); return; }
                const f = new FormData();
                f.set("appointment_id", appointmentId);
                for (const [k, v] of Object.entries(fee.fields)) f.set(k, v);
                void startSplitBillAction(f).then((r) => {
                  setSplitNote(r.ok ? null : r.note.message);
                  if (r.state) setSplit({ enabled: true, state: r.state });
                }).catch(() => setSplitNote("That did not go through. Reload the page and try again."));
              }}
            >
              Split this payment
            </button>
            {splitNote && <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-400">{splitNote}</p>}
          </div>
        )}

        {splitActive && split?.state && splitBill && (
          <div className="mt-3">
            <SplitVisitPayments
              appointmentId={appointmentId}
              currency={splitBill.currency}
              country={splitBill.currency === "usd" ? "US" : "CA"}
              state={split.state}
              onChanged={(next) => setSplit((prev) => ({ enabled: prev?.enabled ?? true, state: next ?? prev?.state ?? null }))}
            />
          </div>
        )}
      </div>
    </div>
  );
}
