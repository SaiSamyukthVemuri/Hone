"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type {
  SessionPaymentEligibility,
  SessionPaymentExistingAttemptSummary,
} from "@/lib/billing/session-payment-types";
import type {
  ResolvedSessionPaymentAmount,
  SessionPaymentAmountResult,
} from "@/lib/billing/session-payment-amount";
import { unresolvedAmountMessage } from "@/lib/billing/session-payment-amount";
import { SESSION_PAYMENT_INTERNAL_NOTE_MAX_LENGTH } from "@/lib/billing/session-payment-types";
import { FormattedDateTime } from "@/components/formatted-date-time";
import {
  derivePaymentSummary,
  humanChargeFailure,
  maskReceiptEmail,
  technicalRowsForAttempt,
} from "@/lib/payments/payment-summary-presenter";
import { PaymentSummaryCard } from "@/components/payment/payment-summary-card";
import { ReceiptStatus } from "@/components/payment/receipt-status";
import { TechnicalPaymentDetails } from "@/components/payment/technical-payment-details";

type PrepareResult =
  | { ok: true; attemptId: string }
  | { ok: false; error: string; blockingReasons?: string[] };

type ExecuteResult =
  | {
      ok: true;
      outcome: "succeeded";
      stripePaymentIntentId: string;
      stripeChargeId: string | null;
    }
  | {
      ok: false;
      outcome: string;
      error: string;
      blockingReasons?: string[];
      failureCode?: string | null;
    };

// PR #175. SendPaymentReceiptActionResult shape; the card consumes
// the discriminated union directly so the per-outcome copy on the
// succeeded panel can branch on the reason. The string union is
// loose on purpose: any future outcome added to the action layer
// renders as a generic failure message rather than crashing.
type SendReceiptResult =
  | { ok: true; outcome: "sent"; emailTo: string }
  | {
      ok: false;
      outcome: string;
      error: string;
      emailTo?: string;
      sentAt?: string | null;
    };

type PrepareAction = (formData: FormData) => Promise<PrepareResult>;
type ExecuteAction = (formData: FormData) => Promise<ExecuteResult>;
type SendReceiptAction = (formData: FormData) => Promise<SendReceiptResult>;

// PR #178. RefundPaymentActionResult shape; the card consumes the
// discriminated union directly so the per-outcome copy on the
// refund sub-panel can branch on the reason. Loose string union on
// the failure outcome lets a future action-level reason render as
// a generic failure message rather than crashing the UI.
type RefundResult =
  | {
      ok: true;
      outcome: "succeeded";
      stripeRefundId: string;
      refundedAt: string;
      refundAmountCents: number;
    }
  | {
      ok: false;
      outcome: string;
      error: string;
      failureCode?: string | null;
    };

type RefundAction = (formData: FormData) => Promise<RefundResult>;

// PR #172 + #173 + #174. Practitioner-only session payment surface.
// Renders one of three top-level branches resolved server-side by
// getSessionPaymentEligibility:
//
//   * No active attempt + eligible -> the prepare form (PR #172).
//   * No active attempt + blocked  -> a calm list of blocking
//                                     reasons (PR #172).
//   * Active attempt exists       -> a status-specific panel driven
//                                    by the persisted row, so the
//                                    full state survives a page
//                                    refresh (PR #174 hardening).
//
// PR #174 was the UX hardening pass after PR #173 shipped Stripe
// test-mode execution. Before #174 the card relied on React local
// state (executeSuccess / success) to show the PaymentIntent id
// immediately after Run charge; that state was lost on
// refresh, leaving the practitioner with a bare "Succeeded" label
// and no Stripe ids. The fix is two-part:
//   1. lib/billing/session-payment-eligibility.ts SELECT widened to
//      carry stripe_payment_intent_id, stripe_charge_id,
//      charged_at, failed_at, failure_code, failure_message_safe.
//   2. The card now dispatches on attempt.status with dedicated
//      ReadyPanel / PendingPanel / SucceededPanel / FailedPanel /
//      CancelledPanel / BlockedPanel components (mirrors the
//      ManualFeeChargeCard precedent from PR #146). The status
//      panel is the single source of truth for what the
//      practitioner sees about the persisted row; React local
//      state is used only for in-session feedback during the
//      prepare and execute submit/transition.
//
// What this card does NOT do:
//   * No Stripe charge create. The execute action talks to the
//     allowlisted Stripe SDK call site in
//     lib/billing/session-payment-charge.ts. The refund action
//     talks to the SEPARATE allowlisted Stripe refund call site
//     in lib/billing/payment-refund.ts (PR #178). The card
//     itself is a render surface; it only dispatches to the
//     actions it receives as props.
//   * No webhook handler logic.
//   * No "Pay now" affordance. No "Charge card" affordance. No
//     "Collect payment" label. The only money-moving button is
//     Run charge, which is framed per the deployment mode
//     mode.
//   * No client-facing surface. Sessions are practitioner-only.
//   * No receipt claim. The succeeded panel explicitly notes
//     "No receipt was sent in this PR."
//   * No live-payment claim. Every reference to a successful
//     charge uses "Charge succeeded," never "Payment
//     complete" or "Live payment."

const CENTS_PER_DOLLAR = 100;

function formatCadFromCents(cents: number | null): string {
  if (cents == null) return "";
  const dollars = cents / CENTS_PER_DOLLAR;
  return `$${dollars.toFixed(2)}`;
}

// PR #174. Status labels reflect the persisted row's actual state
// after PR #173 shipped execution. Before PR #174 the 'ready' label
// said "Prepared (ready to charge in a future PR)" which was already
// stale once PR #173 added the charge action; the label is now
// honest about what 'ready' means in the post-execute world.
const STATUS_LABEL: Record<string, string> = {
  ready: "Ready",
  pending_stripe: "Pending Stripe",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
  blocked: "Blocked",
};

// Active statuses match the PR #172 duplicate-protection set
// (payment_charge_attempts_active_session_payment_uniq partial
// unique). A row in one of these statuses takes the active-attempt
// slot, blocks a new prepare, and drives the main status panel.
// failed / cancelled / blocked rows are TERMINAL but DO NOT block a
// new prepare; the PR #174 patch separates "active attempt drives
// the main panel" from "latest historical attempt for context" so a
// failed row no longer leaves the practitioner in a dead end (no
// Run button + no Prepare form).
const ACTIVE_STATUSES = new Set([
  "ready",
  "pending_stripe",
  "succeeded",
]);
// Terminal-non-success statuses that should NOT take over the
// main slot but DO surface a small callout above the Prepare
// form so the practitioner sees why they are preparing a new
// attempt.
const TERMINAL_RETRY_STATUSES = new Set([
  "failed",
  "cancelled",
  "blocked",
]);

export function SessionPaymentPrepareCard({
  sessionId,
  clientId,
  eligibility,
  amountResult = null,
  isOwner = false,
  prepareAction,
  executeAction,
  sendReceiptAction,
  refundAction,
}: {
  sessionId: string;
  clientId: string;
  eligibility: SessionPaymentEligibility;
  // Server-derived studio-owner flag (trusted; from practitioner.role on the
  // session page). Gates the owner-only Technical payment details disclosure +
  // the Refund button (refunds are ALSO server-side owner-only — unchanged).
  isOwner?: boolean;
  // PR #200: resolved booked-service / custom-pricing default for the
  // prepare form's amount field. Display default only; the field
  // stays editable and the prepare action re-validates the submitted
  // amount. Null keeps the pre-#200 behavior.
  // The server's pricing decision for this session (resolved or blocked).
  amountResult?: SessionPaymentAmountResult | null;
  prepareAction: PrepareAction;
  executeAction: ExecuteAction;
  sendReceiptAction: SendReceiptAction;
  refundAction: RefundAction;
}) {
  // PR #181. router.refresh() is called after a successful prepare
  // so the persisted row catches up immediately. Without it the
  // local prepareJustSucceeded banner is the only feedback the
  // practitioner has until they reload the page; the banner is
  // truthful at that moment but stays stale once the persisted
  // row advances past 'ready'.
  const router = useRouter();
  // In-session feedback only. After refresh the persisted row drives
  // the rendering; these are confined to the same page-load.
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const [prepareBlockingReasons, setPrepareBlockingReasons] = useState<string[]>(
    [],
  );
  const [preparePending, startPrepareTransition] = useTransition();
  const [prepareJustSucceeded, setPrepareJustSucceeded] = useState<
    { attemptId: string } | null
  >(null);

  // PR #174 patch. activeAttempt is the row in ready /
  // pending_stripe / succeeded that BLOCKS a new prepare and drives
  // the main status panel. A failed / cancelled / blocked row is
  // NOT an active attempt; the practitioner must be free to prepare
  // a new one. latestHistoricalAttempt is purely for the
  // "previous attempt failed/cancelled" callout that sits above
  // the Prepare form when there is no active attempt but at least
  // one prior row exists.
  const activeAttempt =
    eligibility.existingAttempts.find((a) =>
      ACTIVE_STATUSES.has(a.status),
    ) ?? null;
  const latestHistoricalAttempt =
    eligibility.existingAttempts[0] ?? null;
  const previousTerminalAttempt =
    !activeAttempt &&
    latestHistoricalAttempt &&
    TERMINAL_RETRY_STATUSES.has(latestHistoricalAttempt.status)
      ? latestHistoricalAttempt
      : null;

  const showPrepareForm =
    eligibility.eligible && !activeAttempt && !prepareJustSucceeded;
  // FREE-01 / review 3777045531. Freeness is a property of the CURRENT price,
  // not of whether a prepare form happens to be showing. A positive-price
  // attempt already in `ready` sets showPrepareForm false, so gating the free
  // notice on it left the AttemptStatusPanel still offering Run charge for a
  // visit every other surface now calls "No payment required".
  const isFreeNow = amountResult?.kind === "free";
  // Review 3777045537. ACTIVE_STATUSES is {ready, pending_stripe, succeeded},
  // so suppressing the whole panel whenever the price is now free hid an
  // IN-FLIGHT charge behind "No payment required" and stripped the receipt and
  // refund controls off a SUCCEEDED one. Only `ready` carries a money-moving
  // control, so only `ready` may be suppressed. pending_stripe and succeeded
  // are transaction state — money that has actually moved — and the
  // appointment-state reducer deliberately ranks processing/paid/refunded
  // ABOVE free for exactly this reason. Mirror that ranking here: what the
  // price says today never overrides what has already happened.
  const readyAttemptIsNowFree =
    isFreeNow && activeAttempt !== null && activeAttempt.status === "ready";
  const settledOrInFlightAttempt =
    activeAttempt !== null && activeAttempt.status !== "ready";
  // F-PAY-001: there is no "suggested" amount any more. Either the server
  // resolved ONE authoritative amount, or preparation is blocked with a reason.
  // The historical session price is NOT a pricing authority and is no longer
  // consulted here.
  const resolvedAmount =
    amountResult && amountResult.kind === "resolved" ? amountResult : null;

  return (
    <section
      className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800"
      aria-label="Session payment"
    >
      <header>
        <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
          Session payment
        </h2>
        <p className="mt-1 text-xs text-neutral-500">
          This prepares a payment record. The client is not charged until you
          run the charge.
        </p>
      </header>

      {/* PR #174. Active attempt status panel. Drives the full
          succeeded / pending / ready rendering from the persisted
          row so a refresh on the session detail page shows the
          same state the practitioner saw at submit. The patch on
          PR #174 narrowed this to activeAttempt (ACTIVE_STATUSES)
          so a failed / cancelled / blocked row does NOT take over
          the main slot; the callout below picks up that case. */}
      {activeAttempt && !readyAttemptIsNowFree && (
        <AttemptStatusPanel
          attempt={activeAttempt}
          sessionId={sessionId}
          clientId={clientId}
          isOwner={isOwner}
          executeAction={executeAction}
          sendReceiptAction={sendReceiptAction}
          refundAction={refundAction}
        />
      )}

      {/* PR #174 patch. Previous-terminal callout. When the latest
          historical attempt is failed / cancelled / blocked AND
          there is no active attempt, surface a compact panel above
          the Prepare form so the practitioner sees why they are
          being asked to prepare again. The full failure detail is
          rendered through the same per-status subcomponent the
          main slot would use; it is just demoted to a context
          panel here. */}
      {previousTerminalAttempt && (
        <PreviousTerminalCallout
          attempt={previousTerminalAttempt}
          isOwner={isOwner}
        />
      )}

      {/* PR #172 + PR #181 patch. Just-prepared in-session
          confirmation, scoped tightly to the brief render window
          between the action succeeding and router.refresh()
          re-fetching the persisted ready row. The banner is gated
          on !activeAttempt so it disappears the moment the
          persisted row catches up. Without the gate the banner
          stays visible through later succeeded / refunded states
          and conflicts with the per-status panels. */}
      {prepareJustSucceeded && !activeAttempt && (
        <div className="rounded-md border border-green-300 bg-green-50 p-3 text-xs text-green-900 dark:border-green-800 dark:bg-green-950/30 dark:text-green-200">
          <p className="font-medium">Session payment prepared.</p>
          <p className="mt-1">
            You can now run the charge.
          </p>
        </div>
      )}

      {!eligibility.eligible && !activeAttempt && !prepareJustSucceeded && (
        <BlockedPanel reasons={eligibility.blockingReasons} />
      )}

      {/* Blocked pricing: a calm explanation instead of a blank editable box.
          Preparation is withdrawn entirely — there is no amount to confirm. */}
      {/* A null result means the pricing context itself could not be loaded.
          Never render nothing: say so, and offer no prepare action. */}
      {showPrepareForm && !amountResult && (
        <p
          data-testid="pricing-blocked"
          className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
        >
          The payment amount could not be confirmed. Refresh and try again.
        </p>
      )}

      {/* FREE-01: an explicit $0 service renders a calm, factual state — never
          Prepare, never Run charge, and never the amber "pricing blocked"
          warning, because nothing is wrong. Defense in depth: even if a route
          reaches this card directly, there is no money-moving control here. */}
      {isFreeNow && !settledOrInFlightAttempt && (
        <p
          data-testid="payment-not-required"
          className="rounded-md border border-neutral-300 bg-neutral-50 p-3 text-xs text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
        >
          {amountResult.serviceName} is free · No payment required.
        </p>
      )}

      {showPrepareForm &&
        amountResult &&
        amountResult.kind !== "resolved" &&
        amountResult.kind !== "free" && (
        <p
          data-testid="pricing-blocked"
          className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
        >
          {unresolvedAmountMessage(amountResult)}
        </p>
      )}

      {showPrepareForm && resolvedAmount && (
        <PrepareForm
          sessionId={sessionId}
          eligibility={eligibility}
          amount={resolvedAmount}
          pending={preparePending}
          error={prepareError}
          blockingReasons={prepareBlockingReasons}
          onSubmit={(fd) => {
            setPrepareError(null);
            setPrepareBlockingReasons([]);
            startPrepareTransition(async () => {
              const r = await prepareAction(fd);
              if (r.ok) {
                setPrepareJustSucceeded({ attemptId: r.attemptId });
                // PR #181. Force the persisted ready row to flow
                // into the page so the AttemptStatusPanel takes
                // over as the single source of truth. The local
                // banner is gated on !activeAttempt above so it
                // disappears as soon as the refresh completes.
                router.refresh();
                return;
              }
              setPrepareError(r.error);
              setPrepareBlockingReasons(r.blockingReasons ?? []);
            });
          }}
        />
      )}

      {eligibility.existingAttempts.length > 1 && (
        <AttemptHistory attempts={eligibility.existingAttempts} />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// PR #174 patch. Compact "previous attempt failed / cancelled /
// blocked" callout. Sits above the Prepare form when there is no
// active attempt but the most recent historical row is terminal-
// non-success. Renders the same FailedPanel / CancelledPanel /
// BlockedAttemptPanel detail so the practitioner sees the failure
// message, code, and timestamp; the difference vs the main-slot
// rendering is that the Prepare form continues to appear below
// (the panel here is context, not a duplicate-protection block).
// ---------------------------------------------------------------------------
function PreviousTerminalCallout({
  attempt,
  isOwner,
}: {
  attempt: SessionPaymentExistingAttemptSummary;
  isOwner: boolean;
}) {
  switch (attempt.status) {
    case "failed":
      return <FailedPanel attempt={attempt} isOwner={isOwner} />;
    case "cancelled":
      return <CancelledPanel attempt={attempt} />;
    case "blocked":
      return <BlockedAttemptPanel attempt={attempt} />;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// PR #172. Blocking panel for the "not eligible + no active attempt"
// state. The eligibility helper already filtered the reasons; we
// render them as-is so the practitioner sees the same wording as the
// server-side blocking message.
// ---------------------------------------------------------------------------
function BlockedPanel({ reasons }: { reasons: string[] }) {
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
      <p className="font-medium">
        Session payment cannot be prepared right now.
      </p>
      <ul className="mt-2 flex flex-col gap-1">
        {reasons.map((r, idx) => (
          <li key={idx}>{r}</li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PR #174. Status dispatcher. The persisted row drives the
// rendering; React local state is no longer the source of truth
// for the post-submit / post-execute UI.
// ---------------------------------------------------------------------------
function AttemptStatusPanel({
  attempt,
  sessionId,
  clientId,
  isOwner,
  executeAction,
  sendReceiptAction,
  refundAction,
}: {
  attempt: SessionPaymentExistingAttemptSummary;
  sessionId: string;
  clientId: string;
  isOwner: boolean;
  executeAction: ExecuteAction;
  sendReceiptAction: SendReceiptAction;
  refundAction: RefundAction;
}) {
  switch (attempt.status) {
    case "ready":
      return (
        <ReadyPanel
          attempt={attempt}
          sessionId={sessionId}
          clientId={clientId}
          isOwner={isOwner}
          executeAction={executeAction}
        />
      );
    case "pending_stripe":
      return <PendingPanel attempt={attempt} isOwner={isOwner} />;
    case "succeeded":
      return (
        <SucceededPanel
          attempt={attempt}
          sessionId={sessionId}
          clientId={clientId}
          isOwner={isOwner}
          sendReceiptAction={sendReceiptAction}
          refundAction={refundAction}
        />
      );
    case "failed":
      return <FailedPanel attempt={attempt} isOwner={isOwner} />;
    case "cancelled":
      return <CancelledPanel attempt={attempt} />;
    case "blocked":
      return <BlockedAttemptPanel attempt={attempt} />;
    default:
      return <UnknownStatusPanel attempt={attempt} />;
  }
}

// ---------------------------------------------------------------------------
// PR #173 + #174. Ready panel. The Run charge button lives
// here and survives refresh. Two-click confirm prevents accidental
// double-tap charges.
// ---------------------------------------------------------------------------
function ReadyPanel({
  attempt,
  sessionId,
  clientId,
  isOwner,
  executeAction,
}: {
  attempt: SessionPaymentExistingAttemptSummary;
  sessionId: string;
  clientId: string;
  isOwner: boolean;
  executeAction: ExecuteAction;
}) {
  const [confirmExecute, setConfirmExecute] = useState(false);
  const [executePending, startExecuteTransition] = useTransition();
  const [executeError, setExecuteError] = useState<string | null>(null);
  const [executeBlockingReasons, setExecuteBlockingReasons] = useState<string[]>(
    [],
  );
  const [executeSuccess, setExecuteSuccess] = useState<{
    paymentIntentId: string;
    chargeId: string | null;
  } | null>(null);

  // After a successful execute the persisted row will be 'succeeded'
  // on next refresh. Until then we show an in-session success block
  // so the practitioner sees the PaymentIntent id immediately.
  if (executeSuccess) {
    return (
      <PaymentSummaryCard
        summary={{
          kind: "paid",
          headline: "Paid",
          tone: "paid",
          amountCents: attempt.amountCents,
        }}
        subLine="Refresh to see the full receipt options."
      >
        <TechnicalPaymentDetails
          isOwner={isOwner}
          rows={[
            { label: "PaymentIntent", value: executeSuccess.paymentIntentId },
            { label: "Charge", value: executeSuccess.chargeId },
          ]}
        />
      </PaymentSummaryCard>
    );
  }

  return (
    <div className="rounded-md border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-950">
      <PaymentSummaryCard
        summary={derivePaymentSummary(attempt)}
        subLine={
          <>
            Prepared <FormattedDateTime iso={attempt.createdAt} /> · not yet
            charged
          </>
        }
      />

      <div className="mt-3 flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/30">
        <p className="text-[11px] font-medium uppercase tracking-wider text-amber-900 dark:text-amber-200">
          Charge client
        </p>
        <p className="text-xs text-amber-900 dark:text-amber-200">
          The client&apos;s saved card will be charged{" "}
          {formatCadFromCents(attempt.amountCents)}.
        </p>
        {executeError && (
          <p className="text-xs text-red-700 dark:text-red-400" role="alert">
            {executeError}
          </p>
        )}
        {executeBlockingReasons.length > 0 && (
          <ul className="flex flex-col gap-1 text-xs text-amber-900 dark:text-amber-200">
            {executeBlockingReasons.map((r, idx) => (
              <li key={idx}>{r}</li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={executePending}
            onClick={() => {
              setExecuteError(null);
              setExecuteBlockingReasons([]);
              if (!confirmExecute) {
                setConfirmExecute(true);
                return;
              }
              const fd = new FormData();
              fd.set("attempt_id", attempt.id);
              fd.set("session_id", sessionId);
              fd.set("client_id", clientId);
              fd.set("confirm_charge", "true");
              startExecuteTransition(async () => {
                const r = await executeAction(fd);
                if (r.ok) {
                  setExecuteSuccess({
                    paymentIntentId: r.stripePaymentIntentId,
                    chargeId: r.stripeChargeId,
                  });
                  setConfirmExecute(false);
                  return;
                }
                setExecuteError(r.error);
                setExecuteBlockingReasons(r.blockingReasons ?? []);
                setConfirmExecute(false);
              });
            }}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            {executePending
              ? "Running charge..."
              : confirmExecute
                ? `Confirm: run charge (${formatCadFromCents(attempt.amountCents)})`
                : "Run charge"}
          </button>
          {confirmExecute && !executePending && (
            <button
              type="button"
              onClick={() => setConfirmExecute(false)}
              className="text-xs underline text-neutral-600 dark:text-neutral-400"
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PR #174. Pending panel. Reached when the claim RPC transitioned
// the row to pending_stripe but the create call did not return a
// terminal status (network blip, unknown error after claim, etc.).
// Mirrors ManualFeeChargeCard's PendingPanel: tells the operator
// the charge may need manual review, surfaces the PI id if
// the row has one, and explicitly avoids any Run-style button.
// ---------------------------------------------------------------------------
function PendingPanel({
  attempt,
  isOwner,
}: {
  attempt: SessionPaymentExistingAttemptSummary;
  isOwner: boolean;
}) {
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/30">
      <PaymentSummaryCard
        summary={derivePaymentSummary(attempt)}
        subLine="Reload in a minute to recheck. It may need manual review if it stays pending."
      >
        <TechnicalPaymentDetails
          isOwner={isOwner}
          rows={[
            { label: "PaymentIntent", value: attempt.stripePaymentIntentId },
          ]}
        />
      </PaymentSummaryCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PR #174. Succeeded panel. Survives page refresh because every
// rendered field comes from the persisted row. Explicitly says
// "Charge succeeded" rather than "Payment complete" to keep
// the test-mode posture unambiguous.
// ---------------------------------------------------------------------------
function SucceededPanel({
  attempt,
  sessionId,
  clientId,
  isOwner,
  sendReceiptAction,
  refundAction,
}: {
  attempt: SessionPaymentExistingAttemptSummary;
  sessionId: string;
  clientId: string;
  isOwner: boolean;
  sendReceiptAction: SendReceiptAction;
  refundAction: RefundAction;
}) {
  // Compact card: derivePaymentSummary picks the SINGLE current headline —
  // "Paid" for a live charge, "Refunded" once the row carries
  // refund_status='succeeded' — so the practitioner never sees a paid heading
  // and a refunded sub-panel fighting each other. Sub-panels handle the rest.
  const refunded = attempt.refundStatus === "succeeded";
  return (
    <div
      className={
        refunded
          ? "rounded-md border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-950"
          : "rounded-md border border-emerald-200 bg-emerald-50/60 p-3 dark:border-emerald-900/50 dark:bg-emerald-950/20"
      }
    >
      {/* Compact practitioner face: "Paid · $X" (or "Refunded · $X"), with the
          charge date. Processor identifiers move into the owner-only disclosure
          below — never shown in the default charting view. */}
      <PaymentSummaryCard
        summary={derivePaymentSummary(attempt)}
        subLine={
          refunded ? (
            attempt.refundedAt ? (
              <>
                Refunded <FormattedDateTime iso={attempt.refundedAt} />
                {attempt.refundAmountCents != null
                  ? ` · ${formatCadFromCents(attempt.refundAmountCents)}`
                  : ""}
              </>
            ) : (
              "Refunded"
            )
          ) : attempt.chargedAt ? (
            <FormattedDateTime iso={attempt.chargedAt} />
          ) : undefined
        }
      >
        {/* PR #175 receipt sub-panel: receipt status + retry, email masked. */}
        <ReceiptSubPanel
          attempt={attempt}
          sessionId={sessionId}
          clientId={clientId}
          sendReceiptAction={sendReceiptAction}
        />

        {/* PR #178 refund sub-panel: owner-only Refund button; server refund
            authorization is unchanged (owner-only there too). */}
        <RefundSubPanel
          attempt={attempt}
          sessionId={sessionId}
          clientId={clientId}
          isOwner={isOwner}
          refundAction={refundAction}
        />

        <TechnicalPaymentDetails
          isOwner={isOwner}
          rows={technicalRowsForAttempt(attempt)}
        />
      </PaymentSummaryCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PR #175. Receipt sub-panel for the succeeded state. Drives off
// the persisted receipt_status column (migration 0076) so the
// "already sent" + "failed" states survive page refresh. The
// "Send test receipt" button only renders when receipt_status is
// null or 'failed' (the latter so a terminal failure can still be
// retried after the operator investigates).
// ---------------------------------------------------------------------------
function ReceiptSubPanel({
  attempt,
  sessionId,
  clientId,
  sendReceiptAction,
}: {
  attempt: SessionPaymentExistingAttemptSummary;
  sessionId: string;
  clientId: string;
  sendReceiptAction: SendReceiptAction;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [localSent, setLocalSent] = useState<{ emailTo: string } | null>(null);

  // Persisted-state takes precedence; local in-session state is
  // for immediate feedback before the next render cycle catches
  // up via the page revalidatePath.
  const persistedSent = attempt.receiptStatus === "sent";
  const persistedFailed = attempt.receiptStatus === "failed";
  const persistedSending = attempt.receiptStatus === "sending";

  return (
    <div className="mt-3 flex flex-col gap-2 rounded-md border border-neutral-200 bg-white p-3 dark:border-neutral-700 dark:bg-neutral-950">
      <p className="text-[11px] font-medium uppercase tracking-wider text-neutral-600 dark:text-neutral-400">
        Receipt
      </p>

      {/* Masked destination only — the full email never appears in the
          practitioner card (it stays in the owner-only technical details). */}
      {(persistedSent || localSent) && (
        <ReceiptStatus
          line={{
            kind: "sent",
            masked:
              maskReceiptEmail(localSent?.emailTo ?? attempt.receiptEmailTo) ||
              null,
          }}
        >
          {attempt.receiptSentAt && !localSent && (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Sent <FormattedDateTime iso={attempt.receiptSentAt} />
            </p>
          )}
        </ReceiptStatus>
      )}

      {persistedFailed && !localSent && (
        <div className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-800 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200">
          <p className="font-medium">Receipt send failed.</p>
          {attempt.receiptFailureMessageSafe && (
            <p className="mt-1">Reason: {attempt.receiptFailureMessageSafe}</p>
          )}
          {attempt.receiptFailureCode && (
            <p className="mt-1 font-mono">Code: {attempt.receiptFailureCode}</p>
          )}
          <p className="mt-1">You can try again below.</p>
        </div>
      )}

      {persistedSending && !localSent && (
        <p className="text-xs text-neutral-600 dark:text-neutral-400">
          A receipt send is in flight. Refresh to see the latest state.
        </p>
      )}

      {error && (
        <p className="text-xs text-red-700 dark:text-red-400" role="alert">
          {error}
        </p>
      )}

      {!persistedSent &&
        !persistedSending &&
        !localSent && (
          <>
            <p className="text-xs text-neutral-600 dark:text-neutral-400">
              Sends a Stripe receipt to the client for this charge.
            </p>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setError(null);
                const fd = new FormData();
                fd.set("attempt_id", attempt.id);
                fd.set("session_id", sessionId);
                fd.set("client_id", clientId);
                startTransition(async () => {
                  const r = await sendReceiptAction(fd);
                  // PR #175 patch. setLocalSent fires ONLY when
                  // r.ok === true. The sent_but_record_update
                  // _failed branch returns ok:false and a
                  // warning message; surfacing it as "already
                  // sent" via local state would let the
                  // practitioner walk away thinking the row is
                  // persisted when it is not.
                  if (r.ok) {
                    setLocalSent({ emailTo: r.emailTo });
                    return;
                  }
                  setError(r.error);
                });
              }}
              // min-h-[44px]: this is the control Chloe presses on a phone with a
        // client in the chair, so it meets the touch-target floor the rest of
        // the charting surfaces already use.
        className="inline-flex min-h-[44px] items-center justify-center self-start rounded-md bg-neutral-900 px-4 py-2 text-xs font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900"
            >
              {pending ? "Sending receipt..." : "Send receipt"}
            </button>
          </>
        )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PR #178. Refund sub-panel for the succeeded state. Drives off
// the persisted refund_status column (migration 0078) so the
// already-refunded + pending + failed-refund states survive a
// page refresh. The Refund charge button only renders when
// refund_status is null or 'failed' (the latter so a terminal
// failure can be retried after the operator investigates).
//
// Copy contract (pinned by source-grep tests):
//   * Header: "Refund"
//   * Idle state: "This creates a Stripe test-mode refund for
//     this charge. No live money is moved."
//   * Action button: "Refund charge"
//   * Confirm button: "Confirm: refund charge ($X.XX)"
//   * Succeeded state: "Test refund succeeded."
//   * Failed state: "Test refund failed."
//   * Pending state: "Refund pending."
// Forbidden copy:
//   "Live refund" / "Refund complete" / "Money returned" /
//   "Official refund receipt"
// ---------------------------------------------------------------------------
function RefundSubPanel({
  attempt,
  sessionId,
  clientId,
  isOwner,
  refundAction,
}: {
  attempt: SessionPaymentExistingAttemptSummary;
  sessionId: string;
  clientId: string;
  isOwner: boolean;
  refundAction: RefundAction;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [localRefunded, setLocalRefunded] = useState<{
    stripeRefundId: string;
    refundedAt: string;
    refundAmountCents: number;
  } | null>(null);

  // Persisted state takes precedence; local in-session state is
  // for the same-render-cycle flip before the page revalidatePath
  // catches up.
  const persistedSucceeded = attempt.refundStatus === "succeeded";
  const persistedPending = attempt.refundStatus === "pending_stripe";
  const persistedFailed = attempt.refundStatus === "failed";

  // v1 refunds are full-only. The amount the practitioner is
  // confirming equals the charge amount; partial refunds may
  // land in a future PR without changing the schema (the CHECK
  // refund_amount_cents <= amount_cents already allows it).
  const refundAmountFormatted = formatCadFromCents(attempt.amountCents);

  return (
    <div className="mt-3 flex flex-col gap-2 rounded-md border border-neutral-200 bg-white p-3 dark:border-neutral-700 dark:bg-neutral-950">
      <p className="text-[11px] font-medium uppercase tracking-wider text-neutral-600 dark:text-neutral-400">
        Refund
      </p>

      {(persistedSucceeded || localRefunded) && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
          <p className="font-medium">Refund succeeded.</p>
          <p className="mt-1">
            Amount refunded:{" "}
            {formatCadFromCents(
              localRefunded?.refundAmountCents ??
                attempt.refundAmountCents ??
                attempt.amountCents,
            )}
          </p>
          {(localRefunded?.refundedAt ?? attempt.refundedAt) && (
            <p className="mt-1">
              Refunded:{" "}
              <FormattedDateTime
                iso={
                  (localRefunded?.refundedAt ??
                    attempt.refundedAt ??
                    "") as string
                }
              />
            </p>
          )}
        </div>
      )}

      {persistedPending && !localRefunded && (
        <div className="rounded-md border border-neutral-300 bg-neutral-50 p-2 text-xs text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
          <p className="font-medium">Refund pending.</p>
          <p className="mt-1">
            This may need manual review if it stays pending. Refresh to see
            the latest state.
          </p>
        </div>
      )}

      {persistedFailed && !localRefunded && (
        <div className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-800 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200">
          <p className="font-medium">Refund failed.</p>
          <p className="mt-1">You can try again below.</p>
        </div>
      )}

      {error && (
        <p className="text-xs text-red-700 dark:text-red-400" role="alert">
          {error}
        </p>
      )}

      {isOwner &&
        !persistedSucceeded &&
        !persistedPending &&
        !localRefunded && (
          <>
            <p className="text-xs text-neutral-600 dark:text-neutral-400">
              This creates a Stripe refund for this charge on the studio&apos;s
              connected account.
            </p>
            {!confirming ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => setConfirming(true)}
                // min-h-[44px]: this is the control Chloe presses on a phone with a
        // client in the chair, so it meets the touch-target floor the rest of
        // the charting surfaces already use.
        className="inline-flex min-h-[44px] items-center justify-center self-start rounded-md bg-neutral-900 px-4 py-2 text-xs font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900"
              >
                Refund charge
              </button>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    setError(null);
                    const fd = new FormData();
                    fd.set("attempt_id", attempt.id);
                    fd.set("session_id", sessionId);
                    fd.set("client_id", clientId);
                    startTransition(async () => {
                      const r = await refundAction(fd);
                      // setLocalRefunded fires ONLY when r.ok ===
                      // true. The needs_manual_review branch
                      // returns ok:false so the practitioner sees
                      // the warning and does not assume the
                      // refund is complete.
                      if (r.ok) {
                        setLocalRefunded({
                          stripeRefundId: r.stripeRefundId,
                          refundedAt: r.refundedAt,
                          refundAmountCents: r.refundAmountCents,
                        });
                        setConfirming(false);
                        return;
                      }
                      setError(r.error);
                      setConfirming(false);
                    });
                  }}
                  className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                >
                  {pending
                    ? "Refunding charge..."
                    : `Confirm: refund charge (${refundAmountFormatted})`}
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    setConfirming(false);
                    setError(null);
                  }}
                  className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
                >
                  Cancel
                </button>
              </div>
            )}
          </>
        )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PR #174. Failed panel. Terminal in this PR (no retry affordance).
// The practitioner is told to prepare a new attempt instead of
// re-running the failed one, which mirrors the PR #173 helper's
// status-machine guarantee that 'failed' rows refuse retry.
// ---------------------------------------------------------------------------
function FailedPanel({
  attempt,
  isOwner,
}: {
  attempt: SessionPaymentExistingAttemptSummary;
  isOwner: boolean;
}) {
  return (
    <div className="rounded-md border border-red-200 bg-red-50/70 p-3 dark:border-red-900/50 dark:bg-red-950/20">
      <PaymentSummaryCard
        summary={derivePaymentSummary(attempt)}
        subLine={
          <>
            {/* practitioner-friendly reason; raw code/message stay owner-only */}
            {humanChargeFailure(attempt.failureCode)}
            {attempt.failedAt && (
              <>
                {" "}
                (<FormattedDateTime iso={attempt.failedAt} />)
              </>
            )}
          </>
        }
      >
        <p className="text-xs text-neutral-600 dark:text-neutral-400">
          Prepare a new session payment attempt to try again.
        </p>
        <TechnicalPaymentDetails
          isOwner={isOwner}
          rows={technicalRowsForAttempt(attempt)}
        />
      </PaymentSummaryCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PR #174. Cancelled panel. The session payment path does not yet
// surface a cancel affordance in this PR (the existing-attempt
// branch's two-click confirm is for execute only). A cancelled row
// arrives only via a future PR's cancel action; for now the panel
// is render-only.
// ---------------------------------------------------------------------------
function CancelledPanel({
  attempt,
}: {
  attempt: SessionPaymentExistingAttemptSummary;
}) {
  return (
    <div className="rounded-md border border-neutral-300 bg-neutral-50 p-3 text-xs text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
      <p className="font-medium">Session payment cancelled.</p>
      <p className="mt-1">
        Amount: {formatCadFromCents(attempt.amountCents)}
        {" · "}
        Prepared: <FormattedDateTime iso={attempt.createdAt} />
      </p>
      <p className="mt-1">
        Prepare a new session payment attempt if you need to charge this
        session.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PR #174. Blocked panel. The 'blocked' status enum value is
// reserved by the payment_charge_attempts CHECK constraint and is
// not written by any current code path. The panel exists so a row
// that arrives via a future flow renders cleanly.
// ---------------------------------------------------------------------------
function BlockedAttemptPanel({
  attempt,
}: {
  attempt: SessionPaymentExistingAttemptSummary;
}) {
  return (
    <div className="rounded-md border border-neutral-300 bg-neutral-50 p-3 text-xs text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
      <p className="font-medium">Session payment blocked.</p>
      <p className="mt-1">
        Amount: {formatCadFromCents(attempt.amountCents)}
        {" · "}
        Prepared: <FormattedDateTime iso={attempt.createdAt} />
      </p>
      <p className="mt-1">
        Prepare a new session payment attempt to try again.
      </p>
    </div>
  );
}

// Safety net for any status value the schema later adds but this
// component does not know about yet. Renders the bare metadata so
// the page does not silently drop the row.
function UnknownStatusPanel({
  attempt,
}: {
  attempt: SessionPaymentExistingAttemptSummary;
}) {
  return (
    <div className="rounded-md border border-neutral-300 bg-neutral-50 p-3 text-xs text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
      <p className="font-medium">Session payment status: {attempt.status}</p>
      <p className="mt-1">
        Amount: {formatCadFromCents(attempt.amountCents)}
        {" · "}
        Created: <FormattedDateTime iso={attempt.createdAt} />
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PR #172. Prepare form. Extracted to its own component to keep the
// status-dispatch logic readable. The form posts to
// prepareSessionPaymentChargeAction which writes one row to
// payment_charge_attempts and returns the new attempt id.
// ---------------------------------------------------------------------------
function PrepareForm({
  sessionId,
  eligibility,
  amount,
  pending,
  error,
  blockingReasons,
  onSubmit,
}: {
  sessionId: string;
  eligibility: Extract<SessionPaymentEligibility, { eligible: true }>;
  // The SERVER's resolved amount. The form renders it and never edits it.
  amount: ResolvedSessionPaymentAmount;
  pending: boolean;
  error: string | null;
  blockingReasons: string[];
  onSubmit: (formData: FormData) => void;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        fd.set("session_id", sessionId);
        onSubmit(fd);
      }}
      className="flex flex-col gap-3"
    >
      {error && (
        <p className="text-xs text-red-700 dark:text-red-400" role="alert">
          {error}
        </p>
      )}
      {blockingReasons.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
          {blockingReasons.map((r, idx) => (
            <li key={idx}>{r}</li>
          ))}
        </ul>
      )}

      {/* F-PAY-001. The amount is NO LONGER an input. It used to be an
          editable field whose value the prepare action inserted verbatim, so
          the browser decided what the client was charged. The server now
          resolves the amount from current records; this renders that decision
          and submits it back ONLY as expected_amount_cents, which can cause a
          rejection if the price moved but can never choose a value. */}
      <div className="flex flex-col gap-1">
        <span className="text-[11px] uppercase tracking-wider text-neutral-500">
          Amount (CAD)
        </span>
        <div className="flex items-baseline gap-2">
          <span
            data-testid="authoritative-amount"
            className="text-lg font-medium tabular-nums"
          >
            {formatCadFromCents(amount.amountCents)}
          </span>
        </div>
        <input
          type="hidden"
          name="expected_amount_cents"
          value={String(amount.amountCents)}
        />
        <div className="flex flex-col gap-0.5 text-[11px] text-neutral-500">
          <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
            Booked service: {amount.serviceName}
            {amount.durationMinutes != null && ` (${amount.durationMinutes} min)`}
          </span>
          {amount.source === "custom_pricing" ? (
            <>
              <span data-testid="amount-source">
                Client-specific price for this service.
              </span>
              {amount.customPricingNote && (
                <span>Custom pricing reminder: {amount.customPricingNote}</span>
              )}
            </>
          ) : (
            <span data-testid="amount-source">Booked service price.</span>
          )}
        </div>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-[11px] uppercase tracking-wider text-neutral-500">
          Internal note (optional)
        </span>
        {/* Optional (Chloe workflow fix): the note is no longer `required`, so a
            client-present quick checkout is few-tap. Blank input is stored as
            NULL server-side; a real note is preserved and still length-capped. */}
        <textarea
          name="internal_note"
          rows={3}
          maxLength={SESSION_PAYMENT_INTERNAL_NOTE_MAX_LENGTH}
          placeholder="Optional note explaining the session payment (visible only to studio members)."
          className="rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
        />
      </label>

      <div className="flex flex-col gap-1 rounded-md border border-neutral-200 bg-neutral-50 p-2 text-[11px] text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400">
        <p>
          Card on file: {eligibility.card.brand} ending in {eligibility.card.last4}.
        </p>
        <p>
          Card authorization v{eligibility.cardAuthorization.templateVersion}{" "}
          signed{" "}
          <FormattedDateTime iso={eligibility.cardAuthorization.signedAt} />.
        </p>
        <p>
          This prepares a row only. No PaymentIntent. No charge. No receipt.
        </p>
      </div>

      <button
        type="submit"
        disabled={pending}
        // min-h-[44px]: this is the control Chloe presses on a phone with a
        // client in the chair, so it meets the touch-target floor the rest of
        // the charting surfaces already use.
        className="inline-flex min-h-[44px] items-center justify-center self-start rounded-md bg-neutral-900 px-4 py-2 text-xs font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900"
      >
        {pending ? "Preparing..." : "Prepare session payment"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// PR #174. Compact history panel for prior attempts on the same
// session. Only visible when there are 2+ attempts; the active
// attempt is already rendered in AttemptStatusPanel above. The
// older rows are read-only and rendered as quiet record rows.
// ---------------------------------------------------------------------------
function AttemptHistory({
  attempts,
}: {
  attempts: readonly SessionPaymentExistingAttemptSummary[];
}) {
  return (
    <details className="text-[11px] text-neutral-500">
      <summary className="cursor-pointer">
        Earlier attempts ({attempts.length})
      </summary>
      <ul className="mt-2 flex flex-col gap-1">
        {attempts.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center gap-2">
            <code className="text-[10px]">{a.id.slice(0, 8)}</code>
            <span>{STATUS_LABEL[a.status] ?? a.status}</span>
            <span>{formatCadFromCents(a.amountCents)}</span>
            <FormattedDateTime iso={a.createdAt} />
            {a.failureCode && (
              <span className="font-mono">code: {a.failureCode}</span>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
