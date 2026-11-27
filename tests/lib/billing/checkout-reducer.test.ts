import { describe, expect, it } from "vitest";
import {
  answerSettles, awaitLedger, settleFromLedger, cardReduce, chargeFingerprint, reconcileRefundSelection, refundFingerprint, refundSendable, settleSubmission, submissionFor,
  type CardEvent, type CardPhase,
} from "@/lib/billing/visit-payments-core";

// The checkout state machine as a TRANSITION TABLE: every (phase, event) pair is stated, so a change that adds, drops or re-routes a transition fails here by name.
// Covers the three review findings: restore from the ledger, the refund selection, and one submission id per distinct intent.

const A = "attempt-a";
const B = "attempt-b";
const idle: CardPhase = { phase: "idle" };
const preparing: CardPhase = { phase: "preparing" };
const charging: CardPhase = { phase: "charging", attemptId: A };
const unknown: CardPhase = { phase: "unknown", attemptId: A };
const succeeded: CardPhase = { phase: "succeeded", attemptId: A };
const failed: CardPhase = { phase: "failed", attemptId: A, message: "m" };
const failedNoAttempt: CardPhase = { phase: "failed", attemptId: null, message: "m" };

const events: Record<string, CardEvent> = {
  submit: { type: "submit" },
  prepared: { type: "prepared", attemptId: A },
  prepare_refused: { type: "prepare_refused", text: "no" },
  result_ok: { type: "result", outcome: "succeeded" },
  result_failed: { type: "result", outcome: "failed", text: "declined" },
  result_unknown: { type: "result", outcome: "unknown" },
  lost: { type: "lost_response" },
  restore_same: { type: "restore", attemptId: A },
  restore_other: { type: "restore", attemptId: B },
  settled_ok_same: { type: "ledger_settled", attemptId: A, status: "succeeded" },
  settled_failed_same: { type: "ledger_settled", attemptId: A, status: "failed" },
  settled_other: { type: "ledger_settled", attemptId: B, status: "succeeded" },
};

const TABLE: Array<[string, CardPhase, string, CardPhase]> = [
  // submit: only from a resting phase; never while preparing, charging or checking
  ["idle", idle, "submit", preparing], ["failed", failed, "submit", preparing], ["succeeded", succeeded, "submit", preparing],
  ["preparing", preparing, "submit", preparing], ["charging", charging, "submit", charging], ["unknown", unknown, "submit", unknown],
  // prepared / refused only answer a preparing screen
  ["preparing", preparing, "prepared", charging], ["idle", idle, "prepared", idle], ["charging", charging, "prepared", charging], ["unknown", unknown, "prepared", unknown],
  ["preparing", preparing, "prepare_refused", { phase: "failed", attemptId: null, message: "no" }],
  ["idle", idle, "prepare_refused", idle], ["charging", charging, "prepare_refused", charging],
  // definite results settle a charging or checking screen only
  ["charging", charging, "result_ok", succeeded], ["unknown", unknown, "result_ok", succeeded],
  ["charging", charging, "result_failed", { phase: "failed", attemptId: A, message: "declined" }], ["unknown", unknown, "result_failed", { phase: "failed", attemptId: A, message: "declined" }],
  ["charging", charging, "result_unknown", unknown], ["unknown", unknown, "result_unknown", unknown],
  ["idle", idle, "result_ok", idle], ["succeeded", succeeded, "result_failed", succeeded], ["failed", failed, "result_ok", failed], ["preparing", preparing, "result_ok", preparing],
  // a lost response is only meaningful while charging
  ["charging", charging, "lost", unknown], ["idle", idle, "lost", idle], ["unknown", unknown, "lost", unknown], ["succeeded", succeeded, "lost", succeeded],
  // RESTORE: from idle, and from a finished phase when the pending attempt is a DIFFERENT one (another device); never over an in-flight screen
  ["idle", idle, "restore_same", unknown], ["idle", idle, "restore_other", { phase: "unknown", attemptId: B }],
  ["succeeded", succeeded, "restore_other", { phase: "unknown", attemptId: B }], ["failed", failed, "restore_other", { phase: "unknown", attemptId: B }],
  ["succeeded", succeeded, "restore_same", succeeded], ["failed", failed, "restore_same", failed],
  ["failed(no attempt)", failedNoAttempt, "restore_other", { phase: "unknown", attemptId: B }],
  ["preparing", preparing, "restore_other", preparing], ["charging", charging, "restore_other", charging], ["unknown", unknown, "restore_other", unknown],
  // LEDGER SETTLED: ends checking only for the attempt being checked
  ["unknown", unknown, "settled_ok_same", succeeded], ["unknown", unknown, "settled_failed_same", { phase: "failed", attemptId: A, message: "The card was not charged." }],
  ["unknown", unknown, "settled_other", unknown], ["charging", charging, "settled_ok_same", charging], ["idle", idle, "settled_ok_same", idle], ["succeeded", succeeded, "settled_failed_same", succeeded],
];

describe("cardReduce transition table", () => {
  it.each(TABLE)("%s + %s", (_n, from, ev, to) => {
    expect(cardReduce(from, events[ev])).toEqual(to);
  });
  it("a screen that is checking offers no charge: no event but a definite result or the ledger leaves unknown", () => {
    for (const [name, e] of Object.entries(events)) {
      const next = cardReduce(unknown, e);
      const leaves = next.phase !== "unknown" || (next.phase === "unknown" && next.attemptId !== A);
      const allowed = ["result_ok", "result_failed", "settled_ok_same", "settled_failed_same"].includes(name);
      expect(leaves, name).toBe(allowed);
    }
  });
});

describe("one submission id per intent", () => {
  const mint = (() => { let n = 0; return () => `id-${++n}`; })();
  it("the same intent reuses its id across a lost answer; a different intent gets its own", () => {
    const fpA = refundFingerprint({ paymentId: "p1", cents: 4000, kind: "payment_reversal", reason: "late" });
    const fpB = refundFingerprint({ paymentId: "p1", cents: 3000, kind: "payment_reversal", reason: "late" });
    const a1 = submissionFor({}, fpA, mint);
    const a2 = submissionFor(a1.next, fpA, mint);
    expect(a2.id).toBe(a1.id);
    const b = submissionFor(a2.next, fpB, mint);
    expect(b.id).not.toBe(a1.id);
    // and the first is still held while the second is asked
    expect(submissionFor(b.next, fpA, mint).id).toBe(a1.id);
  });
  it("every field of the fingerprint matters (payment, amount, kind, reason), reason is trimmed", () => {
    const base = { paymentId: "p1", cents: 4000, kind: "payment_reversal", reason: "late" };
    const fps = new Set([base, { ...base, paymentId: "p2" }, { ...base, cents: 4001 }, { ...base, kind: "price_reduction" }, { ...base, reason: "other" }].map(refundFingerprint));
    expect(fps.size).toBe(5);
    expect(refundFingerprint({ ...base, reason: "  late " })).toBe(refundFingerprint(base));
    expect(chargeFingerprint({ tender: "card", cents: 100, currency: "cad" })).not.toBe(chargeFingerprint({ tender: "paid_cash", cents: 100, currency: "cad" }));
  });
  it("a definite answer settles the intent: the next ask mints a new id; settling leaves the others", () => {
    const x = submissionFor({}, "x", mint), y = submissionFor(x.next, "y", mint);
    const after = settleSubmission(y.next, "x");
    expect(after).toEqual({ y: y.id });
    expect(submissionFor(after, "x", mint).id).not.toBe(x.id);
    expect(settleSubmission(after, "never")).toBe(after);
  });
});

describe("the refund selection follows the ledger", () => {
  const opts = [{ id: "c1", cents: 4000 }, { id: "c2", cents: 2500 }];
  it("keeps a still-refundable choice", () => expect(reconcileRefundSelection("c2", opts)).toBe("c2"));
  it("a choice that is no longer refundable (0 left, gone) falls to the first refundable one, never a stale id", () => {
    expect(reconcileRefundSelection("c2", [{ id: "c1", cents: 4000 }, { id: "c2", cents: 0 }])).toBe("c1");
    expect(reconcileRefundSelection("gone", opts)).toBe("c1");
  });
  it("nothing refundable selects nothing", () => {
    expect(reconcileRefundSelection("c1", [])).toBe("");
    expect(reconcileRefundSelection("c1", [{ id: "c1", cents: 0 }])).toBe("");
  });
  it("a refund is sendable only within the selected payment's own remainder, with a reason", () => {
    const sel = { cents: 4000 };
    expect(refundSendable(sel, 4000, "r")).toBe(true);
    expect(refundSendable(sel, 4001, "r")).toBe(false);
    expect(refundSendable(sel, 0, "r")).toBe(false);
    expect(refundSendable(sel, null, "r")).toBe(false);
    expect(refundSendable(sel, 100, "  ")).toBe(false);
    expect(refundSendable(undefined, 100, "r")).toBe(false);
  });
});

describe("a lost answer does not settle its submission id (Insurance F2)", () => {
  it("only a definite answer settles: ok and not checking", () => {
    expect(answerSettles({ ok: true })).toBe(true);
    expect(answerSettles({ ok: true, checking: false })).toBe(true);
    expect(answerSettles({ ok: true, checking: true })).toBe(false);
    expect(answerSettles({ ok: false })).toBe(false);
    expect(answerSettles({ ok: false, checking: true })).toBe(false);
  });
  it("lost answer, retry of the SAME refund: the same id; the id is released only when the ledger shows nothing pending", () => {
    const fp = refundFingerprint({ paymentId: "p1", cents: 4000, kind: "payment_reversal", reason: "late" });
    let n = 0; const mint = () => `id-${++n}`;
    const first = submissionFor({}, fp, mint);
    let awaiting = awaitLedger([], fp);
    expect(awaitLedger(awaiting, fp)).toEqual([fp]); // remembered once
    // the answer was lost (checking): nothing settles, a retry reuses the id
    expect(submissionFor(first.next, fp, mint).id).toBe(first.id);
    // the ledger still shows a refund pending at Stripe: still held
    const still = settleFromLedger(first.next, awaiting, 1);
    expect(still.subs).toEqual(first.next); expect(still.awaiting).toEqual([fp]);
    // a refund pending at Stripe no longer (settled or failed on the ledger): released, the next ask is a new command
    const done = settleFromLedger(still.subs, still.awaiting, 0);
    expect(done.subs).toEqual({}); expect(done.awaiting).toEqual([]);
    expect(submissionFor(done.subs, fp, mint).id).not.toBe(first.id);
  });
  it("settling from the ledger releases only the remembered intents, never another one that is in flight", () => {
    const a = "refund|p1|4000|payment_reversal|late", b = "refund|p2|1000|payment_reversal|other";
    let n = 0; const mint = () => `id-${++n}`;
    const s1 = submissionFor({}, a, mint), s2 = submissionFor(s1.next, b, mint);
    const r = settleFromLedger(s2.next, [a], 0);
    expect(r.subs).toEqual({ [b]: s2.id });
    expect(settleFromLedger(s2.next, [], 0).subs).toEqual(s2.next);
  });
});

describe("the charge intent is fixed at the start (Insurance P3a)", () => {
  it("an amount edited mid-check does not change which id the answer settles", () => {
    let n = 0; const mint = () => `id-${++n}`;
    const atStart = chargeFingerprint({ tender: "card", cents: 7500, currency: "cad" });
    const first = submissionFor({}, atStart, mint);
    // while checking, the owner types a different amount and starts forming a NEW intent
    const edited = chargeFingerprint({ tender: "card", cents: 5000, currency: "cad" });
    const both = submissionFor(first.next, edited, mint);
    expect(edited).not.toBe(atStart);
    // the answer for the first charge settles ITS fingerprint (captured at the start), leaving the edited intent's id alone
    const after = settleSubmission(both.next, atStart);
    expect(after).toEqual({ [edited]: both.id });
  });
});
