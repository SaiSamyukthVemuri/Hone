"use client";

import { useState, useTransition } from "react";
import type { SessionPaymentEligibility } from "@/lib/billing/session-payment-types";
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

type PrepareAction = (formData: FormData) => Promise<PrepareResult>;
type ExecuteAction = (formData: FormData) => Promise<ExecuteResult>;

// PR #172. Session payment PREPARE card. Practitioner-only.
// Renders one of three states resolved server-side by
// getSessionPaymentEligibility:
//
//   * Blocked: lists the blocking reasons returned by the
//     helper. Mirrors the manual fee BlockedPanel pattern from
//     PR #145; the operator-facing copy is the practitioner's
//     "what should I tell the client" hint.
//   * Existing prepared attempt: shows the active row's status,
//     amount, and a short note. No new form. A future PR will
//     add a "Charge card" affordance here when the runtime
//     execution helper ships; for now the row is a prepared
//     audit record only.
//   * Form: amount + internal note + Prepare button.
//
// What this card does NOT do:
//   * No Stripe call. No PaymentIntent. No charge. No refund.
//   * No "Pay now" affordance. The card explicitly tells the
//     practitioner this is a test-mode audit record only.
//   * No client-facing surface. Sessions are practitioner-only.

const CENTS_PER_DOLLAR = 100;

function formatCadFromCents(cents: number | null): string {
  if (cents == null) return "";
  const dollars = cents / CENTS_PER_DOLLAR;
  return `$${dollars.toFixed(2)}`;
}

const STATUS_LABEL: Record<string, string> = {
  ready: "Prepared (ready to charge in a future PR)",
  pending_stripe: "Pending Stripe (test-mode reservation)",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
  blocked: "Blocked",
};

export function SessionPaymentPrepareCard({
  sessionId,
  clientId,
  eligibility,
  prepareAction,
  executeAction,
}: {
  sessionId: string;
  clientId: string;
  eligibility: SessionPaymentEligibility;
  prepareAction: PrepareAction;
  executeAction: ExecuteAction;
}) {
  const [error, setError] = useState<string | null>(null);
  const [blockingReasons, setBlockingReasons] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();
  const [success, setSuccess] = useState<{ attemptId: string } | null>(null);
  // PR #173. Execute-flow state. The execute action runs against an
  // existing 'ready' active attempt (the one already in the
  // existing-attempt branch). The two flows never overlap visually:
  // showForm is true only when there is no active attempt, and
  // executeReady is true only when there IS an active 'ready'
  // attempt. The confirm step is a two-click pattern: the first
  // click flips confirmExecute=true and changes the button label;
  // the second click (within the same render) submits with
  // confirm_charge='true' so a stray double-click on the original
  // Run button cannot accidentally charge.
  const [confirmExecute, setConfirmExecute] = useState(false);
  const [executePending, startExecuteTransition] = useTransition();
  const [executeError, setExecuteError] = useState<string | null>(null);
  const [executeBlockingReasons, setExecuteBlockingReasons] = useState<string[]>([]);
  const [executeSuccess, setExecuteSuccess] = useState<{
    paymentIntentId: string;
    chargeId: string | null;
  } | null>(null);

  // Three rendering branches per the spec:
  //   1. Existing active attempt -> show the row; no form.
  //   2. Blocked (not eligible) -> show blocking reasons; no form.
  //   3. Eligible -> show the prepare form.
  const activeAttempt = eligibility.existingAttempts.find((a) =>
    new Set(["ready", "pending_stripe", "succeeded"]).has(a.status),
  );
  const showForm = eligibility.eligible && !activeAttempt && !success;
  const suggestedAmount =
    eligibility.session?.pricePaidCents != null
      ? formatCadFromCents(eligibility.session.pricePaidCents).replace("$", "")
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
          This prepares a test-mode payment record. It does not charge the client.
        </p>
      </header>

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

      {success && (
        <div className="rounded-md border border-green-300 bg-green-50 p-3 text-xs text-green-900 dark:border-green-800 dark:bg-green-950/30 dark:text-green-200">
          <p className="font-medium">Session payment prepared.</p>
          <p className="mt-1">
            Attempt id: <code>{success.attemptId}</code>. No charge has been
            run. A future release will add the Charge button here.
          </p>
        </div>
      )}

      {activeAttempt && !success && (
        <div className="rounded-md border border-neutral-300 bg-neutral-50 p-3 text-xs text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
          <p className="font-medium">
            A session payment attempt is already prepared.
          </p>
          <p className="mt-1">
            Amount {formatCadFromCents(activeAttempt.amountCents)}. Status:{" "}
            {STATUS_LABEL[activeAttempt.status] ?? activeAttempt.status}.
            Created <FormattedDateTime iso={activeAttempt.createdAt} />.
          </p>

          {/* PR #173. Test-mode execute affordance. Visible only when
              the active attempt is in 'ready' status; a 'pending_stripe'
              or 'succeeded' row does NOT surface another Run button
              because the execute action would short-circuit anyway.
              Two-click confirm guards against accidental double-tap. */}
          {activeAttempt.status === "ready" && !executeSuccess && (
            <div className="mt-3 flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/30">
              <p className="text-[11px] font-medium uppercase tracking-wider text-amber-900 dark:text-amber-200">
                Stripe test mode
              </p>
              <p className="text-xs text-amber-900 dark:text-amber-200">
                Run test charge will create a Stripe PaymentIntent on the
                connected account in test mode against the saved test card.
                No live card is charged.
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
                    fd.set("attempt_id", activeAttempt.id);
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
                      ? `Confirm: run test charge (${formatCadFromCents(activeAttempt.amountCents)})`
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
          )}

          {executeSuccess && (
            <div className="mt-3 rounded-md border border-green-300 bg-green-50 p-3 text-xs text-green-900 dark:border-green-800 dark:bg-green-950/30 dark:text-green-200">
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
                Refresh to see the updated attempt status. No receipt was
                sent in this PR.
              </p>
            </div>
          )}
        </div>
      )}

      {!eligibility.eligible && !activeAttempt && !success && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
          <p className="font-medium">
            Session payment cannot be prepared right now.
          </p>
          <ul className="mt-2 flex flex-col gap-1">
            {eligibility.blockingReasons.map((r, idx) => (
              <li key={idx}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      {showForm && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            setBlockingReasons([]);
            const fd = new FormData(e.currentTarget);
            fd.set("session_id", sessionId);
            startTransition(async () => {
              const r = await prepareAction(fd);
              if (r.ok) {
                setSuccess({ attemptId: r.attemptId });
                return;
              }
              setError(r.error);
              setBlockingReasons(r.blockingReasons ?? []);
            });
          }}
          className="flex flex-col gap-3"
        >
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
              {eligibility.session?.pricePaidCents != null && (
                <span className="text-[11px] text-neutral-500">
                  Suggestion from session price
                </span>
              )}
            </div>
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
              Card on file: {eligibility.card.brand} ending in{" "}
              {eligibility.card.last4}.
            </p>
            <p>
              Card authorization v{eligibility.cardAuthorization.templateVersion}{" "}
              signed{" "}
              <FormattedDateTime
                iso={eligibility.cardAuthorization.signedAt}
              />
              .
            </p>
            <p>
              This prepares a row only. No PaymentIntent. No charge. No
              receipt.
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
      )}

      {eligibility.existingAttempts.length > 0 && !success && (
        <details className="text-[11px] text-neutral-500">
          <summary className="cursor-pointer">
            Attempt history ({eligibility.existingAttempts.length})
          </summary>
          <ul className="mt-2 flex flex-col gap-1">
            {eligibility.existingAttempts.map((a) => (
              <li key={a.id} className="flex items-center gap-2">
                <code className="text-[10px]">{a.id.slice(0, 8)}</code>
                <span>{STATUS_LABEL[a.status] ?? a.status}</span>
                <span>{formatCadFromCents(a.amountCents)}</span>
                <FormattedDateTime iso={a.createdAt} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
