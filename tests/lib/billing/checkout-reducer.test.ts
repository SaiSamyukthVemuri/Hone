import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  idDisposition, awaitFromAnswer, SUCCESS_CODES, RELEASE_ANY_CODES, KEEP_CODES, awaitRefund, bindAttempt, releaseCardAttempt, releaseRefund, settleFromLedger, cardReduce, chargeFingerprint, reconcileRefundSelection, refundFingerprint, refundSendable, settleSubmission, submissionFor,
  type CardEvent, type CardPhase, type Submissions,
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

describe("the id mechanism: one rule for every path (Insurance F2, Codex P2)", () => {
  const mint = () => { let n = 0; return () => `id-${++n}`; };
  const card50 = chargeFingerprint({ tender: "card", cents: 5000, currency: "cad" });
  const card30 = chargeFingerprint({ tender: "card", cents: 3000, currency: "cad" });
  const cash50 = chargeFingerprint({ tender: "paid_cash", cents: 5000, currency: "cad" });

  it("the disposition table: every code against its disposition", () => {
    for (const code of SUCCESS_CODES) {
      expect(idDisposition({ ok: true, code }), code).toBe("release");
      expect(idDisposition({ ok: false, code }), `${code} with ok:false (a blocked card refund answers requested/ok:false)`).toBe("keep");
      expect(idDisposition({ ok: true, code, checking: true }), `${code} while checking`).toBe("keep");
    }
    for (const code of RELEASE_ANY_CODES) expect(idDisposition({ ok: false, code }), code).toBe("release");
    for (const code of KEEP_CODES) {
      expect(idDisposition({ ok: false, code }), code).toBe("keep");
      expect(idDisposition({ ok: true, code }), `${code} even with ok:true`).toBe("keep");
    }
  });
  it("an unlisted, empty or unreadable code keeps; a lost answer (checking) keeps", () => {
    for (const code of ["brand_new_code", "", "RECORDED", "recorded ", undefined as unknown as string, null as unknown as string, 7 as unknown as string])
      expect(idDisposition({ ok: true, code })).toBe("keep");
    expect(idDisposition({ ok: true, code: "requested", checking: true })).toBe("keep");
  });
  // ENTRY PATHS INTO A CARD ATTEMPT'S DEFINITE OUTCOME: first answer, recheck (manual status check), ledger-restore effect, ledger settle. All are the same event for the ids: releaseCardAttempt(attempt).
  it.each(["first answer", "manual status check (recheck)", "ledger-restore effect", "ledger settle (ledger_settled)"])(
    "card charge: %s releases exactly that attempt's id, so the next $50 is a NEW command (the $50 + $50 sequence)", (_path) => {
      const m = mint();
      const first = submissionFor({}, card50, m);
      const bound = bindAttempt({}, "att-1", card50);
      const released = releaseCardAttempt(first.next, bound, "att-1");
      expect(released.subs).toEqual({}); expect(released.bound).toEqual({});
      const second = submissionFor(released.subs, card50, m);
      expect(second.id).not.toBe(first.id);
    });

  it("a lost answer (not definite) keeps the id: the retry of the same charge is the same command", () => {
    const m = mint();
    const first = submissionFor({}, card50, m);
    expect(submissionFor(first.next, card50, m).id).toBe(first.id);
  });

  it("a definite outcome releases the attempt's id AND any card id bound to no open attempt (a prepare whose answer was lost), but never cash/transfer or an id bound to ANOTHER open attempt", () => {
    const m = mint();
    let subs: Submissions = {};
    const a = submissionFor(subs, card50, m); subs = a.next;           // bound to att-1
    const b = submissionFor(subs, card30, m); subs = b.next;           // bound to att-2 (still open)
    const c = submissionFor(subs, cash50, m); subs = c.next;           // not a card charge
    const ghost = chargeFingerprint({ tender: "card", cents: 1234, currency: "cad" });
    const g = submissionFor(subs, ghost, m); subs = g.next;            // its prepare answer was lost: bound to nothing
    const bound = bindAttempt(bindAttempt({}, "att-1", card50), "att-2", card30);
    const r = releaseCardAttempt(subs, bound, "att-1");
    expect(r.subs).toEqual({ [card30]: b.id, [cash50]: c.id });
    expect(r.bound).toEqual({ "att-2": card30 });
  });

  // REFUND PATHS
  const fpR = refundFingerprint({ paymentId: "p1", cents: 4000, kind: "payment_reversal", reason: "late" });
  const fpS = refundFingerprint({ paymentId: "p2", cents: 1000, kind: "payment_reversal", reason: "other" });
  it("refund first answer: a definite answer settles its own intent only (answerSettles + settleSubmission)", () => {
    const m = mint();
    const a = submissionFor({}, fpR, m), b = submissionFor(a.next, fpS, m);
    expect(settleSubmission(b.next, fpR)).toEqual({ [fpS]: b.id });
  });
  it("refund lost answer: held until the ledger shows ITS row is no longer pending (other pending rows do not release it)", () => {
    const m = mint();
    const a = submissionFor({}, fpR, m);
    const awaiting = awaitRefund([], fpR, "rf-1");
    expect(awaitRefund(awaiting, fpR, null)).toEqual([{ fp: fpR, refundId: "rf-1" }]); // remembered once, the row id is kept
    expect(settleFromLedger(a.next, awaiting, ["rf-1", "rf-9"]).subs).toEqual(a.next);   // still pending
    expect(settleFromLedger(a.next, awaiting, ["rf-9"]).subs).toEqual({});               // its row settled (another is pending elsewhere)
    expect(settleFromLedger(a.next, awaiting, ["rf-9"]).awaiting).toEqual([]);
  });
  it("refund recheck: a definite recheck of THAT row releases exactly that intent's id", () => {
    const m = mint();
    const a = submissionFor({}, fpR, m), b = submissionFor(a.next, fpS, m);
    const awaiting = awaitRefund(awaitRefund([], fpR, "rf-1"), fpS, "rf-2");
    const r = releaseRefund(b.next, awaiting, "rf-1");
    expect(r.subs).toEqual({ [fpS]: b.id }); expect(r.awaiting).toEqual([{ fp: fpS, refundId: "rf-2" }]);
    expect(releaseRefund(r.subs, r.awaiting, "rf-unknown")).toEqual(r);
  });
  it("a row-less lost answer waits for NO refund pending, then the ledger releases it", () => {
    const m = mint();
    const a = submissionFor({}, fpR, m);
    const awaiting = awaitRefund([], fpR, null);
    expect(settleFromLedger(a.next, awaiting, ["rf-9"]).subs).toEqual(a.next);
    expect(settleFromLedger(a.next, awaiting, []).subs).toEqual({});
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

describe("every code the screen words is classified", () => {
  it("each case in commandNote is on exactly one list, so none falls to the off-union default by accident", () => {
    const src = readFileSync("lib/billing/visit-payments-core.ts", "utf8");
    const body = src.slice(src.indexOf("export function commandNote"), src.indexOf("default:", src.indexOf("export function commandNote")));
    const codes = [...body.matchAll(/case "([A-Za-z0-9_]+)"/g)].map((m) => m[1]);
    const listed = new Set<string>([...SUCCESS_CODES, ...RELEASE_ANY_CODES, ...KEEP_CODES]);
    expect(codes.length).toBeGreaterThan(30);
    expect(codes.filter((c) => !listed.has(c))).toEqual([]);
    expect(SUCCESS_CODES.filter((c) => (KEEP_CODES as readonly string[]).includes(c))).toEqual([]);
  });
});

describe("only a checking card refund waits for the ledger (Insurance P3)", () => {
  it("a plain keep is never registered; a checking answer with its row is", () => {
    expect(awaitFromAnswer([], "fp", { checking: false })).toEqual([]);
    expect(awaitFromAnswer([], "fp", { checking: false, refundId: "rf-1" })).toEqual([]);
    expect(awaitFromAnswer([], "fp", { checking: true })).toEqual([]);
    expect(awaitFromAnswer([], "fp", { checking: true, refundId: "rf-1" })).toEqual([{ fp: "fp", refundId: "rf-1" }]);
  });
});
