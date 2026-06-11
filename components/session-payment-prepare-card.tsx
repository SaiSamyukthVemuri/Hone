"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type {
  SessionPaymentEligibility,
  SessionPaymentExistingAttemptSummary,
} from "@/lib/billing/session-payment-types";
import type { SessionPaymentDefaultAmount } from "@/lib/billing/session-payment-default-amount";
import { SESSION_PAYMENT_INTERNAL_NOTE_MAX_LENGTH } from "@/lib/billing/session-payment-types";
import { FormattedDateTime } from "@/components/formatted-date-time";

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
// immediately after Run test charge; that state was lost on
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
//     Run test charge, which is explicitly framed as Stripe test
//     mode.
//   * No client-facing surface. Sessions are practitioner-only.
//   * No receipt claim. The succeeded panel explicitly notes
//     "No receipt was sent in this PR."
//   * No live-payment claim. Every reference to a successful
//     charge uses "Test charge succeeded," never "Payment
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
  ready: "Ready (test mode)",
  pending_stripe: "Pending Stripe (test mode)",
  succeeded: "Succeeded (test mode)",
  failed: "Failed (test mode)",
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
  defaultAmount = null,
  prepareAction,
  executeAction,
  sendReceiptAction,
  refundAction,
}: {
  sessionId: string;
  clientId: string;
  eligibility: SessionPaymentEligibility;
  // PR #200: resolved booked-service / custom-pricing default for the
  // prepare form's amount field. Display default only; the field
  // stays editable and the prepare action re-validates the submitted
  // amount. Null keeps the pre-#200 behavior.
  defaultAmount?: SessionPaymentDefaultAmount | null;
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
  // PR #200 defaulting order: client custom pricing / booked service
  // price (resolved server-side into defaultAmount), then the
  // historical session price, then blank manual entry.
  const suggestedAmount =
    defaultAmount != null
      ? formatCadFromCents(defaultAmount.amountCents).replace("$", "")
      : eligibility.session?.pricePaidCents != null
        ? formatCadFromCents(eligibility.session.pricePaidCents).replace(
            "$",
            "",
          )
        : "";

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
          This prepares a test-mode payment record. It does not charge the
          client.
        </p>
      </header>

      {/* PR #174. Active attempt status panel. Drives the full
          succeeded / pending / ready rendering from the persisted
          row so a refresh on the session detail page shows the
          same state the practitioner saw at submit. The patch on
          PR #174 narrowed this to activeAttempt (ACTIVE_STATUSES)
          so a failed / cancelled / blocked row does NOT take over
          the main slot; the callout below picks up that case. */}
      {activeAttempt && (
        <AttemptStatusPanel
          attempt={activeAttempt}
          sessionId={sessionId}
          clientId={clientId}
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
        <PreviousTerminalCallout attempt={previousTerminalAttempt} />
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
            You can now run the test charge.
          </p>
        </div>
      )}

      {!eligibility.eligible && !activeAttempt && !prepareJustSucceeded && (
        <BlockedPanel reasons={eligibility.blockingReasons} />
      )}

      {showPrepareForm && (
        <PrepareForm
          sessionId={sessionId}
          eligibility={eligibility}
          suggestedAmount={suggestedAmount}
          defaultAmount={defaultAmount}
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
}: {
  attempt: SessionPaymentExistingAttemptSummary;
}) {
  switch (attempt.status) {
    case "failed":
      return <FailedPanel attempt={attempt} />;
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
  executeAction,
  sendReceiptAction,
  refundAction,
}: {
  attempt: SessionPaymentExistingAttemptSummary;
  sessionId: string;
  clientId: string;
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
          executeAction={executeAction}
        />
      );
    case "pending_stripe":
      return <PendingPanel attempt={attempt} />;
    case "succeeded":
      return (
        <SucceededPanel
          attempt={attempt}
          sessionId={sessionId}
          clientId={clientId}
          sendReceiptAction={sendReceiptAction}
          refundAction={refundAction}
        />
      );
    case "failed":
      return <FailedPanel attempt={attempt} />;
    case "cancelled":
      return <CancelledPanel attempt={attempt} />;
    case "blocked":
      return <BlockedAttemptPanel attempt={attempt} />;
    default:
      return <UnknownStatusPanel attempt={attempt} />;
  }
}

// ---------------------------------------------------------------------------
// PR #173 + #174. Ready panel. The Run test charge button lives
// here and survives refresh. Two-click confirm prevents accidental
// double-tap charges.
// ---------------------------------------------------------------------------
function ReadyPanel({
  attempt,
  sessionId,
  clientId,
  executeAction,
}: {
  attempt: SessionPaymentExistingAttemptSummary;
  sessionId: string;
  clientId: string;
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
      <div className="rounded-md border border-green-300 bg-green-50 p-3 text-xs text-green-900 dark:border-green-800 dark:bg-green-950/30 dark:text-green-200">
        <p className="font-medium">Test charge succeeded.</p>
        <p className="mt-1">
          PaymentIntent: <code>{executeSuccess.paymentIntentId}</code>
          {executeSuccess.chargeId && (
            <>
              {" "}
              Charge: <code>{executeSuccess.chargeId}</code>
            </>
          )}
        </p>
        <p className="mt-1">
          This was a Stripe test-mode charge. No live card was charged. No
          receipt was sent in this PR. Refresh to see the persisted succeeded
          state.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-neutral-300 bg-neutral-50 p-3 text-xs text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
      <p className="font-medium text-neutral-900 dark:text-neutral-100">
        Session payment prepared
      </p>
      <p className="mt-1">
        Amount: {formatCadFromCents(attempt.amountCents)}
        {" · "}
        Status: {STATUS_LABEL[attempt.status]}
      </p>
      <p className="mt-1">
        Prepared: <FormattedDateTime iso={attempt.createdAt} />
      </p>

      <div className="mt-3 flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/30">
        <p className="text-[11px] font-medium uppercase tracking-wider text-amber-900 dark:text-amber-200">
          Stripe test mode
        </p>
        <p className="text-xs text-amber-900 dark:text-amber-200">
          Run test charge will create a Stripe PaymentIntent on the connected
          account in test mode against the saved test card. No live card is
          charged. No receipt is sent.
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
              ? "Running test charge..."
              : confirmExecute
                ? `Confirm: run test charge (${formatCadFromCents(attempt.amountCents)})`
                : "Run test charge"}
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
// the test charge may need manual review, surfaces the PI id if
// the row has one, and explicitly avoids any Run-style button.
// ---------------------------------------------------------------------------
function PendingPanel({
  attempt,
}: {
  attempt: SessionPaymentExistingAttemptSummary;
}) {
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
      <p className="font-medium">Test charge pending.</p>
      <p className="mt-1">
        Amount: {formatCadFromCents(attempt.amountCents)}
        {" · "}
        Status: {STATUS_LABEL[attempt.status]}
      </p>
      <p className="mt-1">
        This may need manual review if it stays pending. Reload the page in a
        minute to recheck status.
      </p>
      {attempt.stripePaymentIntentId && (
        <p className="mt-1 font-mono">
          PaymentIntent: {attempt.stripePaymentIntentId}
        </p>
      )}
      <p className="mt-1">
        This was a Stripe test-mode attempt. No live card is charged.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PR #174. Succeeded panel. Survives page refresh because every
// rendered field comes from the persisted row. Explicitly says
// "Test charge succeeded" rather than "Payment complete" to keep
// the test-mode posture unambiguous.
// ---------------------------------------------------------------------------
function SucceededPanel({
  attempt,
  sessionId,
  clientId,
  sendReceiptAction,
  refundAction,
}: {
  attempt: SessionPaymentExistingAttemptSummary;
  sessionId: string;
  clientId: string;
  sendReceiptAction: SendReceiptAction;
  refundAction: RefundAction;
}) {
  // PR #181. Top-of-card state model. When the persisted row carries
  // refund_status='succeeded' the practitioner-facing top status MUST
  // read "Test payment refunded", not "Test charge succeeded". Without
  // this promotion Chloe sees a green succeeded heading + the refund
  // sub-panel saying refunded simultaneously, which reads as
  // "succeeded but also refunded" -- confusing. The new top heading
  // is the SINGLE current state; sub-panels handle the rest.
  const refunded = attempt.refundStatus === "succeeded";
  return (
    <div
      className={
        refunded
          ? "rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
          : "rounded-md border border-green-300 bg-green-50 p-3 text-xs text-green-900 dark:border-green-800 dark:bg-green-950/30 dark:text-green-200"
      }
    >
      <p className="font-medium">
        {refunded ? "Test payment refunded." : "Test charge succeeded."}
      </p>
      <p className="mt-1">
        Amount charged: {formatCadFromCents(attempt.amountCents)}
        {attempt.chargedAt && (
          <>
            {" · "}
            Charged: <FormattedDateTime iso={attempt.chargedAt} />
          </>
        )}
      </p>
      {attempt.stripePaymentIntentId && (
        <p className="mt-1 font-mono">
          PaymentIntent: {attempt.stripePaymentIntentId}
        </p>
      )}
      {attempt.stripeChargeId && (
        <p className="mt-1 font-mono">Charge: {attempt.stripeChargeId}</p>
      )}

      {/* PR #181. When the row is refunded, surface the refund
          identifiers + amount + timestamp as a peer detail block
          right under the charge details. The RefundSubPanel below
          still renders the same data with its own heading; this
          block makes the refund a first-class top-card concern
          rather than something hidden inside a sub-panel. */}
      {refunded && (
        <>
          <p className="mt-2 font-medium">Refund details</p>
          {attempt.refundAmountCents != null && (
            <p className="mt-1">
              Amount refunded:{" "}
              {formatCadFromCents(attempt.refundAmountCents)}
              {attempt.refundedAt && (
                <>
                  {" · "}
                  Refunded: <FormattedDateTime iso={attempt.refundedAt} />
                </>
              )}
            </p>
          )}
          {attempt.stripeRefundId && (
            <p className="mt-1 font-mono">
              Refund: {attempt.stripeRefundId}
            </p>
          )}
        </>
      )}

      <p className="mt-2">
        This was a Stripe test-mode charge. No live card was charged.
      </p>

      {/* PR #175. Receipt sub-panel. Visible only when the
          charge is succeeded; reads receipt_status from the
          persisted row so the already-sent / failed states
          survive page refresh. */}
      <ReceiptSubPanel
        attempt={attempt}
        sessionId={sessionId}
        clientId={clientId}
        sendReceiptAction={sendReceiptAction}
      />

      {/* PR #178. Refund sub-panel. Also succeeded-only. Reads
          refund_status from the persisted row so the
          already-refunded / pending / failed states survive a
          page refresh. The Refund test charge button only
          renders when refund_status is null or 'failed'. */}
      <RefundSubPanel
        attempt={attempt}
        sessionId={sessionId}
        clientId={clientId}
        refundAction={refundAction}
      />
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

      {(persistedSent || localSent) && (
        <p className="text-xs text-neutral-700 dark:text-neutral-300">
          Receipt already sent to{" "}
          <code>{localSent?.emailTo ?? attempt.receiptEmailTo ?? "(unknown)"}</code>
          {attempt.receiptSentAt && !localSent && (
            <>
              {" "}
              on <FormattedDateTime iso={attempt.receiptSentAt} />
            </>
          )}
          .
        </p>
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
              Sends a Stripe test-mode receipt to the client. No live card was
              charged.
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
              className="self-start rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900"
            >
              {pending ? "Sending test receipt..." : "Send test receipt"}
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
// page refresh. The Refund test charge button only renders when
// refund_status is null or 'failed' (the latter so a terminal
// failure can be retried after the operator investigates).
//
// Copy contract (pinned by source-grep tests):
//   * Header: "Refund"
//   * Idle state: "This creates a Stripe test-mode refund for
//     this charge. No live money is moved."
//   * Action button: "Refund test charge"
//   * Confirm button: "Confirm: refund test charge ($X.XX)"
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
  refundAction,
}: {
  attempt: SessionPaymentExistingAttemptSummary;
  sessionId: string;
  clientId: string;
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
          <p className="font-medium">Test refund succeeded.</p>
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
          {(localRefunded?.stripeRefundId ?? attempt.stripeRefundId) && (
            <p className="mt-1 font-mono">
              Stripe refund:{" "}
              {localRefunded?.stripeRefundId ?? attempt.stripeRefundId}
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
          <p className="font-medium">Test refund failed.</p>
          {attempt.refundFailureMessageSafe && (
            <p className="mt-1">Failure: {attempt.refundFailureMessageSafe}</p>
          )}
          {attempt.refundFailureCode && (
            <p className="mt-1 font-mono">Code: {attempt.refundFailureCode}</p>
          )}
          <p className="mt-1">You can try again below.</p>
        </div>
      )}

      {error && (
        <p className="text-xs text-red-700 dark:text-red-400" role="alert">
          {error}
        </p>
      )}

      {!persistedSucceeded &&
        !persistedPending &&
        !localRefunded && (
          <>
            <p className="text-xs text-neutral-600 dark:text-neutral-400">
              This creates a Stripe test-mode refund for this charge. No live
              money is moved.
            </p>
            {!confirming ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => setConfirming(true)}
                className="self-start rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900"
              >
                Refund test charge
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
                    ? "Refunding test charge..."
                    : `Confirm: refund test charge (${refundAmountFormatted})`}
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
}: {
  attempt: SessionPaymentExistingAttemptSummary;
}) {
  return (
    <div className="rounded-md border border-red-300 bg-red-50 p-3 text-xs text-red-800 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200">
      <p className="font-medium">Test charge failed.</p>
      <p className="mt-1">
        Amount: {formatCadFromCents(attempt.amountCents)}
        {attempt.failedAt && (
          <>
            {" · "}
            Failed: <FormattedDateTime iso={attempt.failedAt} />
          </>
        )}
      </p>
      {attempt.failureMessageSafe && (
        <p className="mt-1">Failure: {attempt.failureMessageSafe}</p>
      )}
      {attempt.failureCode && (
        <p className="mt-1 font-mono">Code: {attempt.failureCode}</p>
      )}
      {attempt.stripePaymentIntentId && (
        <p className="mt-1 font-mono">
          PaymentIntent: {attempt.stripePaymentIntentId}
        </p>
      )}
      <p className="mt-1">
        Prepare a new session payment attempt if you need to try again.
      </p>
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
  suggestedAmount,
  defaultAmount,
  pending,
  error,
  blockingReasons,
  onSubmit,
}: {
  sessionId: string;
  eligibility: Extract<SessionPaymentEligibility, { eligible: true }>;
  suggestedAmount: string;
  defaultAmount: SessionPaymentDefaultAmount | null;
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

      <label className="flex flex-col gap-1">
        <span className="text-[11px] uppercase tracking-wider text-neutral-500">
          Amount (CAD)
        </span>
        <div className="flex items-center gap-2">
          <span className="text-sm text-neutral-500">$</span>
          <input
            type="text"
            name="amount_dollars"
            defaultValue={suggestedAmount}
            placeholder="0.00"
            inputMode="decimal"
            className="w-32 rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
            aria-label="Amount in Canadian dollars"
          />
          {defaultAmount == null &&
            eligibility.session?.pricePaidCents != null && (
              <span className="text-[11px] text-neutral-500">
                Suggestion from session price
              </span>
            )}
        </div>
        {/* PR #200: say where the default came from, and that it is
            editable. Never implies the client has paid or that live
            payments are on; the test-mode header copy above is
            unchanged. PR #202 (Chloe retest): the booked service
            name is now a visible line of its own right under the
            amount, so the practitioner sees WHY that amount loaded;
            the source copy below it stays small. Rendered only when
            a default actually resolved, so no fake service label
            appears for unlinked or unpriced sessions. */}
        {defaultAmount != null && (
          <div className="flex flex-col gap-0.5 text-[11px] text-neutral-500">
            <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
              Booked service: {defaultAmount.serviceName}
              {defaultAmount.durationMinutes != null &&
                ` (${defaultAmount.durationMinutes} min)`}
            </span>
            {defaultAmount.source === "custom_pricing" ? (
              <>
                <span>
                  Defaulted from this client&apos;s custom pricing.
                </span>
                {defaultAmount.customPricingNote && (
                  <span>
                    Custom pricing reminder: {defaultAmount.customPricingNote}
                  </span>
                )}
              </>
            ) : (
              <span>Defaulted from booked service.</span>
            )}
            <span>You can adjust before preparing.</span>
          </div>
        )}
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[11px] uppercase tracking-wider text-neutral-500">
          Internal note
        </span>
        <textarea
          name="internal_note"
          required
          rows={3}
          maxLength={SESSION_PAYMENT_INTERNAL_NOTE_MAX_LENGTH}
          placeholder="Short note explaining the session payment (visible only to studio members)."
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
        className="self-start rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900"
      >
        {pending ? "Preparing..." : "Prepare session payment (test mode)"}
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
