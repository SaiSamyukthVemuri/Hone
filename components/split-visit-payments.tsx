"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { formatMoney } from "@/lib/billing/payment-jurisdiction";
import {
  canStartCharge, cardReduce, CHECKING_PAYMENT_STATUS, historyLines, methodLabel, parseDollarsToCents, showCheckingStatus,
  STATUS_LABEL, unresolvedCardAttempt, type CardPhase, type ExternalMethod, type VisitCurrency,
} from "@/lib/billing/visit-payments-core";
import {
  confirmTransferAction, sendSplitCardReceiptAction, prepareSplitCardPaymentAction, refundCardPaymentAction, recordExternalPaymentAction, refundExternalPaymentAction, runSplitCardPaymentAction,
  voidTransferAction, cancelSplitCardAttemptAction, recheckCardRefundAction, resolveRefundReviewAction, type SplitActionResult, type SplitState,
} from "@/app/(app)/visit-payment-actions";

/** Free-text fields on money records are never shown to the client and are kept out of logs and messages, but they are still stored: keep names and health details out of them. */
const REASON_HELP = "No client or personal details.";

// ===========================================================================
// Split payments on one visit (HON-123 / HON-122): the checkout panel.
// ===========================================================================
// Shown only for a studio with split_payments switched on (the server decides; this component never does). Every amount rule is the
// database's; this panel shows what the database answered, in plain words, and keeps what the person typed when something is refused.
//
// While a card payment's outcome is UNKNOWN (the response never arrived, or Stripe has not said yet) the panel shows exactly
// "Checking payment status" and offers NO charge control: a second click could make a second charge. Checking again is safe: the same
// attempt id is the Stripe idempotency key.

const btn = "inline-flex min-h-[44px] items-center justify-center rounded-md px-4 text-sm font-medium disabled:opacity-50";
const primary = `${btn} bg-neutral-900 text-white hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900`;
const secondary = `${btn} border border-neutral-300 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800`;
const input = "mt-1 block min-h-[44px] w-full rounded-md border border-neutral-300 bg-white px-3 text-base dark:border-neutral-700 dark:bg-neutral-900";
const POLL_MS = 3000;
const POLL_MAX = 40;

type Tender = "card" | ExternalMethod;

export type SplitVisitPaymentsProps = {
  appointmentId: string;
  currency: VisitCurrency;
  country?: "CA" | "US" | null;
  state: SplitState;
  onChanged: (next: SplitState | null) => void;
};

export function SplitVisitPayments({ appointmentId, currency, country, state, onChanged }: SplitVisitPaymentsProps) {
  const { ledger, balance } = state;
  const [tender, setTender] = useState<Tender>("card");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState<{ tone: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [submission, setSubmission] = useState(() => crypto.randomUUID());
  const [phase, dispatch] = useReducer(cardReduce, { phase: "idle" } as CardPhase);
  const pollRef = useRef(0);
  const fmt = (c: number) => formatMoney(c, currency);
  const collectable = balance?.collectableCents ?? 0;

  useEffect(() => { setAmount((a) => (a === "" && collectable > 0 ? (collectable / 100).toFixed(2) : a)); }, [collectable]);

  const apply = useCallback((r: SplitActionResult) => {
    setNote(r.note);
    if (r.state) onChanged(r.state);
    // A definite answer ends this submission; the next one gets a fresh id. A refusal keeps what was typed.
    if (r.ok) { setSubmission(crypto.randomUUID()); setAmount(""); }
  }, [onChanged]);

  const form = (extra: Record<string, string>) => {
    const f = new FormData();
    f.set("appointment_id", appointmentId);
    for (const [k, v] of Object.entries(extra)) f.set(k, v);
    return f;
  };

  // --- card -------------------------------------------------------------
  const runCard = useCallback(async (attemptId: string) => {
    let tries = 0;
    const attempt = async (): Promise<void> => {
      const mine = ++pollRef.current;
      try {
        const out = await runSplitCardPaymentAction(form({ attempt_id: attemptId }));
        if (mine !== pollRef.current) return;
        if (out.state) onChanged(out.state);
        if (out.outcome === "succeeded") { dispatch({ type: "result", outcome: "succeeded" }); setNote({ tone: "ok", message: "Card payment received." }); setSubmission(crypto.randomUUID()); setAmount(""); return; }
        if (out.outcome === "failed") { dispatch({ type: "result", outcome: "failed", text: out.message }); setNote({ tone: "blocked", message: out.message }); setSubmission(crypto.randomUUID()); return; }
        dispatch({ type: "result", outcome: "unknown" });
      } catch {
        // The connection dropped: we do NOT know whether Stripe took the charge. Never offer a second charge; ask again.
        dispatch({ type: "lost_response" });
      }
      tries += 1;
      if (tries < POLL_MAX) await new Promise<void>((res) => setTimeout(res, POLL_MS)).then(attempt);
    };
    await attempt();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appointmentId, onChanged]);

  // A reload (or a second device) while a card payment is unresolved: show "Checking payment status" and check it, offering NO charge control.
  // Runs once per mount; the attempt id is the idempotency key, so checking is safe.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    const id = unresolvedCardAttempt(ledger);
    if (!id) return;
    restoredRef.current = true;
    dispatch({ type: "restore", attemptId: id });
    void runCard(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function chargeCard() {
    if (!canStartCharge(phase)) return;
    dispatch({ type: "submit" });
    setBusy(true);
    try {
      const prep = await prepareSplitCardPaymentAction(form({ amount_dollars: amount, submission_id: submission, expected_currency: currency }));
      if (!prep.ok) {
        dispatch({ type: "prepare_refused", text: prep.note.message });
        setNote(prep.note);
        if (prep.state) onChanged(prep.state);
        return;
      }
      dispatch({ type: "prepared", attemptId: prep.attemptId });
      await runCard(prep.attemptId);
    } catch {
      dispatch({ type: "prepare_refused", text: "That did not go through and nothing was charged. Check your connection and try again." });
      setNote({ tone: "blocked", message: "That did not go through and nothing was charged. Check your connection and try again." });
    } finally {
      setBusy(false);
    }
  }

  // --- cash / transfer ----------------------------------------------------
  async function recordExternal() {
    setBusy(true);
    try {
      apply(await recordExternalPaymentAction(form({ method: tender, amount_dollars: amount, submission_id: submission })));
    } catch {
      setNote({ tone: "blocked", message: "That did not go through. Reload the page and check before trying again." });
    } finally {
      setBusy(false);
    }
  }

  const cents = parseDollarsToCents(amount);
  const unknown = showCheckingStatus(phase);
  const transfers = ledger.externals.filter((e) => e.state === "pending_confirmation");
  // Choose ONE payment to refund against. Cash and transfers are recorded at once; a card refund asks Stripe (and may say "Checking refund status").
  const stillRefundable = (match: (r: (typeof ledger.refunds)[number]) => boolean, total: number) =>
    total - ledger.refunds.filter((r) => r.status !== "failed" && match(r)).reduce((n, r) => n + r.amountCents, 0);
  const refundable = [
    ...ledger.cards.filter((c) => c.status === "succeeded").map((c) => ({ key: `card:${c.id}`, label: "Card", cents: stillRefundable((r) => r.attemptId === c.id, c.amountCents), id: c.id, card: true })),
    ...ledger.externals.filter((e) => e.state === "confirmed").map((e) => ({ key: `ext:${e.id}`, label: methodLabel(e.method), cents: stillRefundable((r) => r.externalPaymentId === e.id, e.amountCents), id: e.id, card: false })),
  ].filter((r) => r.cents > 0 && !ledger.reviewOpen);
  const tenderLabel = tender === "card" ? "Charge card" : tender === "paid_cash" ? "Record cash received" : "Record transfer";
  const submitLabel = cents ? `${tenderLabel} ${fmt(cents)}` : tenderLabel;

  return (
    <section aria-labelledby="split-title" data-testid="split-visit-payments" className="flex flex-col gap-4">
      <h3 id="split-title" className="text-base font-semibold">Payments for this visit</h3>

      {balance && (
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-base" data-testid="split-balance">
          <dt>Bill total</dt><dd className="text-right font-medium">{fmt(balance.totalCents)}</dd>
          <dt>Received</dt><dd className="text-right font-medium">{fmt(balance.confirmedCents + balance.cardCents - balance.refundedCents)}</dd>
          {balance.pendingCents > 0 && (<><dt>Waiting for confirmation</dt><dd className="text-right font-medium">{fmt(balance.pendingCents)}</dd></>)}
          <dt className="font-semibold">Still to collect</dt>
          <dd className="text-right text-lg font-semibold" data-testid="split-collectable">{fmt(balance.collectableCents)}</dd>
        </dl>
      )}
      {balance && balance.pendingCents > 0 && (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {fmt(balance.pendingCents)} is reserved for a pending transfer. It stays owed until you confirm it.
        </p>
      )}

      {note && (
        <p role={note.tone === "blocked" ? "alert" : "status"} data-testid="split-note"
           className={note.tone === "blocked" ? "text-sm text-red-700 dark:text-red-400" : "text-sm text-neutral-800 dark:text-neutral-200"}>
          {note.message}
        </p>
      )}

      {unknown && (
        <div role="status" aria-live="polite" data-testid="split-checking" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950">
          <p className="font-semibold">{CHECKING_PAYMENT_STATUS}</p>
          <p className="mt-1">We have not heard back about this card payment yet. Please wait: nothing will be charged twice.</p>
          {phase.phase === "unknown" && (
            <button type="button" className={`${secondary} mt-2`} onClick={() => void runCard(phase.attemptId)}>Check payment status again</button>
          )}
        </div>
      )}

      {(ledger.reviews ?? []).map((rv) => (
        <div key={rv.id} role="status" data-testid="split-review" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950">
          <p className="font-semibold">A refund of {fmt(rv.amountCents)} was made in your Stripe dashboard</p>
          <p className="mt-1">
            {rv.settled
              ? "Confirm it to count it on this visit. Until then this visit is not marked as settled and refunds for that payment are paused."
              : "Stripe has not finished this refund yet. Until it does, this visit is not marked as settled and refunds for that payment are paused."}
          </p>
          {rv.settled && (
            <button type="button" className={`${secondary} mt-2`} disabled={busy} data-testid="split-review-confirm"
              onClick={async () => { setBusy(true); try { apply(await resolveRefundReviewAction(form({ review_id: rv.id }))); } finally { setBusy(false); } }}>
              Confirm this refund
            </button>
          )}
        </div>
      ))}

      {transfers.map((t) => (
        <PendingTransfer key={t.id} id={t.id} label={methodLabel(t.method)} amount={fmt(t.amountCents)} busy={busy}
          onConfirm={async () => { setBusy(true); try { apply(await confirmTransferAction(form({ payment_id: t.id }))); } finally { setBusy(false); } }}
          onVoid={async (reason) => { setBusy(true); try { apply(await voidTransferAction(form({ payment_id: t.id, reason }))); } finally { setBusy(false); } }} />
      ))}

      {ledger.cards.filter((c) => c.status === "succeeded" && !c.receiptSent).map((c) => (
        <button key={c.id} type="button" className={secondary} disabled={busy}
          onClick={async () => { setBusy(true); try { apply(await sendSplitCardReceiptAction(form({ attempt_id: c.id }))); } finally { setBusy(false); } }}>
          Send receipt for {fmt(c.amountCents)} card payment
        </button>
      ))}

      <ul className="flex flex-col divide-y divide-neutral-200 dark:divide-neutral-800" aria-label="Payment history" data-testid="split-history">
        {historyLines(ledger).map((l) => (
          <li key={l.key} className="flex items-baseline justify-between gap-3 py-2 text-sm">
            <span>{l.label}<span className="ml-2 text-neutral-500">{STATUS_LABEL[l.status]}</span></span>
            <span className="flex items-baseline gap-3">
              {l.status === "not_sent" && !unknown && (
                <button type="button" className="text-sm underline" disabled={busy} data-testid="split-cancel-attempt"
                  onClick={async () => { setBusy(true); try { apply(await cancelSplitCardAttemptAction(form({ attempt_id: l.key.slice(5) }))); } finally { setBusy(false); } }}>
                  Cancel this card payment
                </button>
              )}
              {l.status === "refund_in_progress" && (
                <button type="button" className="text-sm underline" disabled={busy} data-testid="split-recheck-refund"
                  onClick={async () => { setBusy(true); try { apply(await recheckCardRefundAction(form({ refund_id: l.key.slice(7) }))); } finally { setBusy(false); } }}>
                  Check refund status
                </button>
              )}
              <span className="font-medium">{l.direction === "out" ? "−" : ""}{fmt(l.amountCents)}</span>
            </span>
          </li>
        ))}
        {historyLines(ledger).length === 0 && (
          <li className="py-2 text-sm text-neutral-500">No payments yet.</li>
        )}
      </ul>

      {!unknown && collectable > 0 && (
        <fieldset className="flex flex-col gap-3" disabled={busy}>
          <legend className="text-sm font-semibold">Add a payment</legend>
          <div role="radiogroup" aria-label="How was it paid?" className="flex flex-wrap gap-2">
            {([["card", "Card"], ["paid_cash", "Cash"], [country === "US" ? "paid_other_external" : "paid_e_transfer", country === "US" ? "Transfer or other" : "E-transfer"]] as [Tender, string][]).map(([v, label]) => (
              <label key={v} className={`${secondary} cursor-pointer ${tender === v ? "ring-2 ring-neutral-900 dark:ring-neutral-100" : ""}`}>
                <input type="radio" name="tender" className="sr-only" checked={tender === v} onChange={() => setTender(v)} />{label}
              </label>
            ))}
          </div>
          <label className="text-sm font-medium">
            Amount ({currency.toUpperCase()})
            <input inputMode="decimal" autoComplete="off" className={input} value={amount} onChange={(e) => setAmount(e.target.value)} aria-describedby="split-amount-help" />
          </label>
          <p id="split-amount-help" className="text-sm text-neutral-600 dark:text-neutral-400">Up to {fmt(collectable)} can be collected now.</p>
          <button type="button" className={primary} disabled={cents === null || cents > collectable || busy}
            onClick={() => (tender === "card" ? void chargeCard() : void recordExternal())}>
            {submitLabel}
          </button>
          {tender !== "card" && tender !== "paid_cash" && (
            <p className="text-sm text-neutral-600 dark:text-neutral-400">A transfer is not counted as received until you confirm it. Its amount is reserved meanwhile.</p>
          )}
        </fieldset>
      )}

      {refundable.length > 0 && !unknown && (
        <RefundForm received={refundable} fmt={fmt} busy={busy}
          onSubmit={async (v) => {
            setBusy(true);
            try {
              if (v.card) {
                const r = await refundCardPaymentAction(form({ attempt_id: v.paymentId, amount_dollars: v.amount, kind: v.kind, reason: v.reason, submission_id: submission }));
                apply(r);
                // Lost answer: keep the SAME submission so checking again re-reads the one refund, never makes another.
                if (r.checking) { setSubmission(submission); setNote({ tone: "info", message: "Checking refund status" }); }
              } else {
                apply(await refundExternalPaymentAction(form({ payment_id: v.paymentId, amount_dollars: v.amount, kind: v.kind, reason: v.reason, submission_id: submission })));
              }
            } catch {
              setNote({ tone: "blocked", message: "Checking refund status. Do not refund again yet; reload and check this payment's history." });
            } finally { setBusy(false); }
          }} />
      )}
    </section>
  );
}

function PendingTransfer(props: { id: string; label: string; amount: string; busy: boolean; onConfirm: () => Promise<void>; onVoid: (reason: string) => Promise<void> }) {
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <div className="rounded-md border border-neutral-300 p-3 dark:border-neutral-700" data-testid="split-pending-transfer">
      <p className="text-sm font-medium">{props.label} of {props.amount} is waiting for confirmation</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className={primary} disabled={props.busy} onClick={() => void props.onConfirm()}>Confirm {props.amount} transfer received</button>
        <button type="button" className={secondary} disabled={props.busy} onClick={() => setVoiding((v) => !v)}>Cancel this transfer</button>
      </div>
      {voiding && (
        <div className="mt-3 flex flex-col gap-2">
          <label className="text-sm font-medium">Reason for cancelling the transfer
            <input className={input} value={reason} maxLength={500} aria-describedby="split-void-reason-help" onChange={(e) => setReason(e.target.value)} />
            <span id="split-void-reason-help" className="mt-1 block text-xs font-normal text-neutral-600 dark:text-neutral-400">{REASON_HELP}</span>
          </label>
          <button type="button" className={secondary} disabled={props.busy || reason.trim() === ""} onClick={() => void props.onVoid(reason.trim())}>
            Cancel {props.amount} transfer and release the amount
          </button>
        </div>
      )}
    </div>
  );
}

function RefundForm(props: {
  received: { key: string; label: string; cents: number; id: string; card: boolean }[]; fmt: (c: number) => string; busy: boolean;
  onSubmit: (v: { paymentId: string; amount: string; kind: "price_reduction" | "payment_reversal"; reason: string; card: boolean }) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [paymentId, setPaymentId] = useState(props.received[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [kind, setKind] = useState<"price_reduction" | "payment_reversal">("payment_reversal");
  const [reason, setReason] = useState("");
  if (props.received.length === 0) return null;
  const cents = parseDollarsToCents(amount);
  return (
    <div>
      <button type="button" className={secondary} aria-expanded={open} onClick={() => setOpen((o) => !o)}>Refund or reduce a payment</button>
      {open && (
        <div className="mt-3 flex flex-col gap-3" data-testid="split-refund-form">
          <label className="text-sm font-medium">Payment to refund
            <select className={input} value={paymentId} onChange={(e) => setPaymentId(e.target.value)}>
              {props.received.map((r) => <option key={r.key} value={r.id}>{r.label}, up to {props.fmt(r.cents)} refundable</option>)}
            </select>
          </label>
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">What is this refund?</legend>
            <label className="flex items-start gap-2 text-sm"><input type="radio" name="refund-kind" checked={kind === "payment_reversal"} onChange={() => setKind("payment_reversal")} />
              <span><b>Return the payment.</b> The bill stays the same, so this amount becomes due again.</span></label>
            <label className="flex items-start gap-2 text-sm"><input type="radio" name="refund-kind" checked={kind === "price_reduction"} onChange={() => setKind("price_reduction")} />
              <span><b>Reduce the price.</b> The bill goes down by this amount and the balance is unchanged.</span></label>
          </fieldset>
          <label className="text-sm font-medium">Refund amount
            <input inputMode="decimal" autoComplete="off" className={input} value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <label className="text-sm font-medium">Reason
            <input className={input} value={reason} maxLength={500} aria-describedby="split-refund-reason-help" onChange={(e) => setReason(e.target.value)} />
            <span id="split-refund-reason-help" className="mt-1 block text-xs font-normal text-neutral-600 dark:text-neutral-400">{REASON_HELP}</span>
          </label>
          <button type="button" className={primary} disabled={props.busy || cents === null || reason.trim() === ""}
            onClick={() => void props.onSubmit({ paymentId, amount, kind, reason: reason.trim(), card: props.received.find((r) => r.id === paymentId)?.card ?? false }).then(() => { setAmount(""); setReason(""); })}>
            {cents ? `Record ${props.fmt(cents)} ${kind === "price_reduction" ? "price reduction" : "refund"}` : "Record refund"}
          </button>
        </div>
      )}
    </div>
  );
}
