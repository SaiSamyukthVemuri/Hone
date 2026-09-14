import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  autoSendReceiptAfterCharge,
  describeAutoReceipt,
  AUTO_RECEIPT_BUDGET_MS,
  type ReceiptSender,
} from "@/lib/billing/auto-payment-receipt";
import type { SessionPaymentChargeResult } from "@/lib/billing/session-payment-charge";
import type { SendPaymentChargeReceiptResult } from "@/lib/billing/payment-receipt";
import type { OpsAlertInput } from "@/lib/ops/alerts";

// NO REAL ALERT PROVIDER. recordOpsAlert writes an ops_alerts row and, at
// critical severity, dispatches a bare Resend email. lib/ops/alert-email.ts
// happens to return early without credentials, but "the env was not set" is
// not a guarantee -- this mock is. It also lets the alert's CONTENT be
// asserted instead of merely observed on stderr.
const alertSpy = vi.hoisted(() => ({
  calls: [] as OpsAlertInput[],
  behaviour: { mode: "resolve" as "resolve" | "hang" | "reject" },
  release: null as null | (() => void),
}));

vi.mock("@/lib/ops/alerts", () => ({
  recordOpsAlert: vi.fn(async (input: OpsAlertInput) => {
    alertSpy.calls.push(input);
    if (alertSpy.behaviour.mode === "reject") {
      throw new Error("ops alerting is down");
    }
    if (alertSpy.behaviour.mode === "hang") {
      await new Promise<void>((resolve) => {
        alertSpy.release = resolve;
      });
    }
  }),
}));

beforeEach(() => {
  alertSpy.calls.length = 0;
  alertSpy.behaviour.mode = "resolve";
  alertSpy.release = null;
});

// ===========================================================================
// PAY-RECEIPT-AUTO-01 — the receipt sends itself, and the card never re-runs
// ===========================================================================
//
// NO REAL PROVIDER IS REACHED. Every send below is an injected fake; the
// module's `send` seam exists for exactly this. The last describe proves by
// source inspection that no Stripe receipt_email was introduced.
// ===========================================================================

const ARGS = { attemptId: "att-1", studioId: "st-1", practitionerId: "pr-1" };

/** THIS invocation committed the charge: a receipt is owed. */
const SUCCEEDED: SessionPaymentChargeResult = {
  ok: true,
  outcome: "succeeded",
  stripePaymentIntentId: "pi_1",
  stripeChargeId: "ch_1",
  committedNow: true,
};

/**
 * The money is settled, but an EARLIER invocation committed it. Identical in
 * every other respect to SUCCEEDED — which is the whole point: the only thing
 * that distinguishes a replay is the runner's own claim result.
 */
const REPLAY: SessionPaymentChargeResult = {
  ok: true,
  outcome: "succeeded",
  stripePaymentIntentId: "pi_1",
  stripeChargeId: null,
  committedNow: false,
};

/** Every non-definitive outcome the runner can return. */
const NOT_DEFINITIVE: SessionPaymentChargeResult[] = [
  "failed",
  "needs_manual_review",
  "blocked",
  "live_mode_blocked",
  "lineage_mismatch",
  "authorization_not_current",
  "not_found",
  "not_authorized",
].map((outcome) => ({
  ok: false,
  outcome: outcome as "failed",
  message: `charge ${outcome}`,
}));

const sent: SendPaymentChargeReceiptResult = {
  ok: true,
  status: "sent",
  emailTo: "client@example.com",
};

function spySender(result: SendPaymentChargeReceiptResult): ReceiptSender {
  return vi.fn(async () => result) as unknown as ReceiptSender;
}

/**
 * A stand-in for the framework's `after()`. Records what was registered so the
 * continuation's existence, its timing, and its content are all provable
 * without a live request scope.
 */
function regSpy() {
  const registered: Promise<unknown>[] = [];
  const register = vi.fn((work: Promise<unknown>) => {
    registered.push(work);
  });
  return { register, registered };
}

/** An `after()` that is unavailable, exactly as it is outside a request scope. */
function regUnavailable() {
  return vi.fn(() => {
    throw new Error("`after` was called from outside a request scope");
  });
}

/** Let every already-resolvable microtask drain. */
async function drain(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

describe("A — a definitive successful charge sends exactly one receipt", () => {
  it("calls the receipt helper exactly once, with the charge's own identifiers", async () => {
    const send = spySender(sent);
    const outcome = await autoSendReceiptAfterCharge({ charge: SUCCEEDED, ...ARGS, send });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      attemptId: "att-1",
      studioId: "st-1",
      practitionerId: "pr-1",
    });
    expect(outcome).toEqual({ attempted: true, result: sent });
    expect(describeAutoReceipt(outcome)).toBe("sent");
  });
});

describe("B & C — nothing definitive, nothing sent", () => {
  it.each(NOT_DEFINITIVE.map((c) => [c.ok ? "succeeded" : c.outcome, c] as const))(
    "%s sends ZERO receipts",
    async (_label, charge) => {
      const send = spySender(sent);
      const outcome = await autoSendReceiptAfterCharge({ charge, ...ARGS, send });
      expect(send).not.toHaveBeenCalled();
      expect(outcome).toEqual({ attempted: false, reason: "charge_not_definitive" });
      expect(describeAutoReceipt(outcome)).toBe("not_attempted");
    },
  );

  it("C — needs_manual_review specifically: Stripe may have charged, Hone cannot prove the ledger", async () => {
    // The one case worth naming on its own. Sending "here is your receipt"
    // when we cannot prove what we recorded is worse than sending nothing.
    const send = spySender(sent);
    const charge: SessionPaymentChargeResult = {
      ok: false,
      outcome: "needs_manual_review",
      message: "stripe succeeded; local persistence unknown",
      stripePaymentIntentId: "pi_unknown",
      attemptId: "att-1",
    };
    await autoSendReceiptAfterCharge({ charge, ...ARGS, send });
    expect(send).toHaveBeenCalledTimes(0);
  });

  it("ANTI-VACUITY: the same sender DOES fire on the definitive case", () => {
    // Without this, a sender that never fires would pass every test above.
    const send = spySender(sent);
    return autoSendReceiptAfterCharge({ charge: SUCCEEDED, ...ARGS, send }).then(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
  });
});

describe("E & F — a receipt problem never touches payment truth, and never retries", () => {
  const failures: Array<[SendPaymentChargeReceiptResult["ok"] extends true ? never : string, SendPaymentChargeReceiptResult, string]> = [
    ["send_failed_retryable", { ok: false, reason: "send_failed_retryable", message: "smtp timeout" }, "needs_attention"],
    ["send_failed_terminal", { ok: false, reason: "send_failed_terminal", message: "rejected" }, "needs_attention"],
    ["client_email_missing", { ok: false, reason: "client_email_missing", message: "no email" }, "needs_attention"],
    ["send_failed_state_not_recorded", { ok: false, reason: "send_failed_state_not_recorded", message: "stranded" }, "needs_attention"],
    // AMBIGUOUS: delivery UNKNOWN. Pending, never "failed", never retried.
    ["send_ambiguous_state_not_recorded", { ok: false, reason: "send_ambiguous_state_not_recorded", message: "unknown" }, "pending"],
    ["sent_but_record_update_failed", { ok: false, reason: "sent_but_record_update_failed", message: "in the wild" }, "pending"],
    ["in_flight", { ok: false, reason: "in_flight", message: "already sending" }, "pending"],
    // The manual click won the race. Calm, not an error.
    ["already_sent", { ok: false, reason: "already_sent", message: "already sent" }, "sent"],
  ] as never;

  it.each(failures)("%s is reported, sent ONCE, and never retried", async (_l, result, expected) => {
    const send = spySender(result);
    const outcome = await autoSendReceiptAfterCharge({ charge: SUCCEEDED, ...ARGS, send });

    // F — exactly one attempt. No automatic resend on any outcome, ambiguous
    // included: a duplicate receipt is the risk, not a missing one.
    expect(send).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ attempted: true, result });
    expect(describeAutoReceipt(outcome)).toBe(expected);
  });

  it("E — a thrown sender is swallowed into a reported outcome, not propagated", async () => {
    // The charge is already committed. If this threw, the action would have to
    // decide what a successful charge with an exception means — and the honest
    // answer is that it means nothing about the money.
    const send = vi.fn(async () => {
      throw new Error("provider exploded");
    }) as unknown as ReceiptSender;

    const outcome = await autoSendReceiptAfterCharge({ charge: SUCCEEDED, ...ARGS, send });
    expect(outcome).toMatchObject({ attempted: true, threw: true });
    // Unknown delivery, so pending — NOT needs_attention, and NOT a resend.
    expect(describeAutoReceipt(outcome)).toBe("pending");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("never claims 'sent' unless the helper actually recorded sent", () => {
    // The UI reads this. "Receipt sent" is a claim to a client, so only two
    // results may produce it: a fresh send, and a send the other path already
    // completed.
    const claims = (r: SendPaymentChargeReceiptResult) =>
      describeAutoReceipt({ attempted: true, result: r });
    expect(claims(sent)).toBe("sent");
    expect(claims({ ok: false, reason: "already_sent", message: "" })).toBe("sent");
    expect(claims({ ok: false, reason: "in_flight", message: "" })).not.toBe("sent");
    expect(claims({ ok: false, reason: "send_failed_retryable", message: "" })).not.toBe("sent");
    expect(claims({ ok: false, reason: "sent_but_record_update_failed", message: "" })).not.toBe("sent");
  });
});

describe("the committed-charge response is never held hostage to an email", () => {
  // THE RULE THIS OBEYS, stated ten lines above the call site in
  // payment-actions.ts: "a PostHog outage must never delay or fail a COMMITTED
  // charge response". An email provider is the slower dependency, not the
  // faster one — sendEmailSafely allows 15s — and the practitioner is holding
  // this response with a client in front of them.

  it("releases the response when the send outruns its budget", async () => {
    let settle: (r: SendPaymentChargeReceiptResult) => void = () => {};
    const hang = vi.fn(
      () => new Promise<SendPaymentChargeReceiptResult>((r) => (settle = r)),
    ) as unknown as ReceiptSender;

    const outcome = await autoSendReceiptAfterCharge({
      charge: SUCCEEDED,
      ...ARGS,
      send: hang,
      timeoutMs: 10,
      register: regSpy().register,
    });

    expect(outcome).toEqual({
      attempted: true,
      timedOut: true,
      waitedMs: 10,
      continuationManaged: true,
    });
    // UNKNOWN delivery, exactly like an ambiguous provider result: pending,
    // never "sent", never "needs_attention", and never a resend.
    expect(describeAutoReceipt(outcome)).toBe("pending");
    expect(hang).toHaveBeenCalledTimes(1);

    // THE SEND WAS NOT CANCELLED. It still owns the atomic receipt_status
    // claim, so nothing can duplicate it, and the row it writes is what the
    // next render reads. Cancelling mid-send is what strands a row.
    settle(sent);
    await Promise.resolve();
    expect(hang).toHaveBeenCalledTimes(1);
  });

  it("an ordinary fast send still reports its real outcome inline", async () => {
    // The control. A bound that swallowed every result would make the inline
    // `receipt` field worthless and this whole change invisible to the UI.
    const send = spySender(sent);
    const outcome = await autoSendReceiptAfterCharge({
      charge: SUCCEEDED,
      ...ARGS,
      send,
      timeoutMs: 5_000,
    });
    expect(outcome).toEqual({ attempted: true, result: sent });
    expect(describeAutoReceipt(outcome)).toBe("sent");
  });

  it("the production budget is well under the provider's own timeout", () => {
    // sendEmailSafely allows 15s. If these ever crossed, the bound would stop
    // bounding anything.
    expect(AUTO_RECEIPT_BUDGET_MS).toBeLessThan(15_000);
    expect(AUTO_RECEIPT_BUDGET_MS).toBeGreaterThan(0);
  });

  it("neither action awaits the send after returning, nor revalidates twice", () => {
    // A second revalidatePath after the send would be a no-op dressed as a
    // guarantee: in the App Router the revalidate MARKS the path stale and the
    // re-render happens after the handler returns.
    const session = readFileSync(
      join(process.cwd(), "app/(app)/clients/[id]/sessions/[sessionId]/payment-actions.ts"),
      "utf8",
    );
    const at = session.indexOf("autoSendReceiptAfterCharge(");
    const tail = session.slice(at, session.indexOf("};", at));
    expect(tail).not.toContain("revalidatePath(");
  });
});

describe("D, G & H — the action layer keeps money and receipt separate", () => {
  const SESSION = join(process.cwd(), "app/(app)/clients/[id]/sessions/[sessionId]/payment-actions.ts");
  const FEE = join(process.cwd(), "app/(app)/calendar/[id]/manual-fee-actions.ts");
  const sessionSrc = readFileSync(SESSION, "utf8");
  const feeSrc = readFileSync(FEE, "utf8");

  it("D — both charge actions auto-send, and both still report payment success", () => {
    for (const [name, src] of [["session", sessionSrc], ["manual fee", feeSrc]] as const) {
      expect(src, `${name} must auto-send`).toContain("autoSendReceiptAfterCharge(");
      // The receipt rides ALONGSIDE the success; it never replaces it.
      expect(src).toMatch(/ok: true,\s*\n\s*outcome: "succeeded",/);
      expect(src).toContain("receipt,");
    }
  });

  it("the auto-send happens ONLY inside the success branch", () => {
    for (const src of [sessionSrc, feeSrc]) {
      const at = src.indexOf("autoSendReceiptAfterCharge(");
      const branch = src.lastIndexOf("if (result.ok) {", at);
      expect(branch, "auto-send must sit inside if (result.ok)").toBeGreaterThan(-1);
      // and before that branch closes into the failure return
      expect(src.indexOf('ok: false', branch)).toBeGreaterThan(at);
    }
  });

  it("G — the manual receipt action still exists and still routes through the one helper", () => {
    // Automatic sending does not remove the manual fallback. The helper's
    // atomic receipt_status claim is what makes both safe together, so the
    // manual path must keep going through it rather than around it.
    expect(sessionSrc).toContain("export async function sendPaymentChargeReceiptAction(");
    expect(sessionSrc).toContain("await sendPaymentChargeReceipt({");
    expect(feeSrc).toContain("await sendPaymentChargeReceipt({");
  });

  it("H — neither action lets the caller supply studio or practitioner identity", () => {
    // Authority is re-derived server-side; the receipt inherits exactly the
    // identifiers the charge was authorised with, so a forged attempt/studio/
    // practitioner is no more possible than it was before.
    for (const src of [sessionSrc, feeSrc]) {
      expect(src).toContain("getCurrentPractitionerWithStudio()");
      const at = src.indexOf("autoSendReceiptAfterCharge(");
      const call = src.slice(at, src.indexOf("});", at));
      expect(call).toContain("studioId,");
      expect(call).toContain("practitionerId,");
      expect(call).not.toMatch(/formData\.get/);
    }
  });

  it("neither action re-runs the card when the receipt misbehaves", () => {
    for (const src of [sessionSrc, feeSrc]) {
      const at = src.indexOf("autoSendReceiptAfterCharge(");
      const after = src.slice(at);
      // No second charge call downstream of the receipt attempt.
      expect(after).not.toContain("runSessionPaymentCharge(");
    }
  });
});

describe("I — no Stripe receipt_email is introduced anywhere", () => {
  it("the helper and both actions never set receipt_email", () => {
    const files = [
      "lib/billing/auto-payment-receipt.ts",
      "app/(app)/clients/[id]/sessions/[sessionId]/payment-actions.ts",
      "app/(app)/calendar/[id]/manual-fee-actions.ts",
    ];
    for (const rel of files) {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      expect(src, `${rel} must not set a Stripe receipt_email`).not.toMatch(/receipt_email/);
    }
  });

  it("the helper reaches no provider directly — only the one receipt authority", () => {
    const src = readFileSync(join(process.cwd(), "lib/billing/auto-payment-receipt.ts"), "utf8");
    expect(src).toContain('from "@/lib/billing/payment-receipt"');

    // COMMENTS STRIPPED FIRST. The header discusses Stripe at length — that is
    // documentation, not a provider call, and matching it would make this
    // assertion about prose instead of code. (Caught by its own first run.)
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/resend|nodemailer/i);
    // No provider SDK import of any kind.
    expect(code).not.toMatch(/^import[^\n]*(stripe|resend|nodemailer)/im);
  });
});

// ===========================================================================
// J — REPLAY SUPPRESSION  (Codex P1 4008091139)
// ===========================================================================
//
// `ok: true` answers "is the money settled?". It does NOT answer "did THIS
// invocation settle it?". A double-submit, a retry after a retryable error,
// and a second tab all produce a perfectly legitimate `ok: true` for a charge
// that committed earlier. Sending on the state rather than the transition
// makes every one of them a fresh send attempt against a client's inbox.
// ===========================================================================

describe("J — a replay is a real success that owes no receipt", () => {
  it("an already-succeeded replay sends ZERO receipts", async () => {
    const send = spySender(sent);
    const outcome = await autoSendReceiptAfterCharge({
      charge: REPLAY,
      ...ARGS,
      send,
      register: regSpy().register,
    });

    expect(send).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      attempted: false,
      reason: "replay_not_a_new_charge",
    });
    expect(describeAutoReceipt(outcome)).toBe("not_attempted");
  });

  it("SEQUENTIAL REPLAY AFTER A RETRYABLE ERROR — the second submit is silent", async () => {
    // The exact sequence that motivated the finding. A retryable receipt
    // failure RESETS receipt_status back to null (payment-receipt.ts), so the
    // atomic claim would happily hand out a second send. The gate that stops
    // it is the charge runner's own claim result, not the receipt row.
    const send = vi.fn(async () => ({
      ok: false as const,
      reason: "send_failed_retryable" as const,
      message: "smtp timeout",
    })) as unknown as ReceiptSender;

    // Submit 1 — this invocation commits the charge. It sends, and the send
    // fails retryably, leaving receipt_status null.
    const first = await autoSendReceiptAfterCharge({
      charge: SUCCEEDED,
      ...ARGS,
      send,
      register: regSpy().register,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(first).toEqual({
      attempted: true,
      result: { ok: false, reason: "send_failed_retryable", message: "smtp timeout" },
    });

    // Submit 2 — the practitioner clicks again. The charge runner finds the
    // attempt already succeeded and returns ok:true / committedNow:false.
    const second = await autoSendReceiptAfterCharge({
      charge: REPLAY,
      ...ARGS,
      send,
      register: regSpy().register,
    });

    // STILL ONE. A null receipt_status is not permission to send again.
    expect(send).toHaveBeenCalledTimes(1);
    expect(second).toEqual({
      attempted: false,
      reason: "replay_not_a_new_charge",
    });
  });

  it("CONCURRENT SUBMISSIONS — at most one invocation may be the committer", async () => {
    // Two requests race. The succeeded write is a conditional UPDATE scoped to
    // .eq("status","pending_stripe"), so the loser cannot also come back with
    // committedNow — it comes back needs_manual_review and is refused by gate
    // 1 before gate 2 is ever consulted. Both shapes are exercised here.
    const send = spySender(sent);
    const loser: SessionPaymentChargeResult = {
      ok: false,
      outcome: "needs_manual_review",
      message: "succeeded but not persisted by this invocation",
    };

    const [winner, lost] = await Promise.all([
      autoSendReceiptAfterCharge({
        charge: SUCCEEDED,
        ...ARGS,
        send,
        register: regSpy().register,
      }),
      autoSendReceiptAfterCharge({
        charge: loser,
        ...ARGS,
        send,
        register: regSpy().register,
      }),
    ]);

    expect(send).toHaveBeenCalledTimes(1);
    expect(winner).toEqual({ attempted: true, result: sent });
    expect(lost).toEqual({ attempted: false, reason: "charge_not_definitive" });
  });

  it("MANUAL / AUTOMATIC COLLISION — the atomic claim is still the last defence", async () => {
    // The gate above suppresses REPLAYS. It cannot suppress a manual Send
    // clicked at the same moment as a genuinely fresh automatic one, because
    // that is one committer and one human, not two committers. The claim
    // inside sendPaymentChargeReceipt is what resolves it, and it is NOT
    // removed by this change: the automatic path sees already_sent and reports
    // "sent" calmly rather than sending a second copy.
    const send = spySender({
      ok: false,
      reason: "already_sent",
      message: "Receipt has already been sent.",
    });
    const outcome = await autoSendReceiptAfterCharge({
      charge: SUCCEEDED,
      ...ARGS,
      send,
      register: regSpy().register,
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(describeAutoReceipt(outcome)).toBe("sent");
  });

  it("ANTI-VACUITY: the ONLY difference between the two fixtures is committedNow", () => {
    // Without this, a gate keyed on stripeChargeId (or on anything else that
    // happens to differ) would pass every test above while suppressing the
    // wrong invocations in production.
    const probe: SessionPaymentChargeResult = { ...SUCCEEDED, committedNow: false };
    const send = spySender(sent);
    return autoSendReceiptAfterCharge({
      charge: probe,
      ...ARGS,
      send,
      register: regSpy().register,
    }).then((outcome) => {
      expect(send).not.toHaveBeenCalled();
      expect(outcome).toEqual({
        attempted: false,
        reason: "replay_not_a_new_charge",
      });
    });
  });

  it("the charge runner marks exactly the two persisted transitions", () => {
    // The gate is only as good as what feeds it. Every `outcome: "succeeded"`
    // return site must declare which it is, and the two that declare TRUE must
    // be the two that sit behind the persistence check.
    const runner = readFileSync(
      join(process.cwd(), "lib/billing/session-payment-charge.ts"),
      "utf8",
    );
    const code = runner.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    const succeededReturns = code.match(/outcome: "succeeded",/g) ?? [];
    const declarations = code.match(/committedNow: (true|false),/g) ?? [];
    // Every succeeded return declares, and none is missing.
    expect(declarations).toHaveLength(succeededReturns.length);
    expect(declarations.filter((d) => d.includes("true"))).toHaveLength(2);
    expect(declarations.filter((d) => d.includes("false"))).toHaveLength(2);

    // Each `committedNow: true` is preceded by the persistence gate that makes
    // it exclusive — not merely by a Stripe success.
    for (const idx of [...code.matchAll(/committedNow: true,/g)].map((m) => m.index ?? 0)) {
      const before = code.slice(Math.max(0, idx - 1200), idx);
      expect(before).toContain("persistence.persisted");
    }
  });

  it("the gate reads the runner's result and nothing else", () => {
    // Explicitly forbidden alternatives: a separate pre-read of the receipt
    // row, a browser-supplied flag, or a process-local Set.
    const helper = readFileSync(
      join(process.cwd(), "lib/billing/auto-payment-receipt.ts"),
      "utf8",
    );
    const code = helper.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    expect(code).toContain("charge.committedNow !== true");
    // No process-local memo: it does not survive two serverless instances.
    expect(code).not.toMatch(/\bnew Set\b/);
    expect(code).not.toMatch(/\bnew Map\b/);
    // No second read of the receipt row as a freshness source. The word
    // receipt_status DOES appear -- in operator-facing alert copy -- so the
    // assertion targets a QUERY of it, which is the thing forbidden.
    expect(code).not.toMatch(/\.eq\(\s*["']receipt_status["']/);
    expect(code).not.toMatch(/\.from\(\s*["']/);
    expect(code).not.toMatch(/\.select\(/);
    // Nothing browser-supplied reaches the gate: the arg list is fixed.
    expect(code).not.toMatch(/isFresh|wasFresh|forceSend|skipReceipt/);
  });
});

// ===========================================================================
// K — CONTINUATION LIFETIME  (Codex P1 4008091145)
// ===========================================================================
//
// The bounded wait released the response with the send still running and
// nothing holding the runtime open for it. `after()` is the framework's
// supported mechanism; the rules are that it must be registered BEFORE the
// response is released, must continue the SAME operation, and must never
// start a second send.
// ===========================================================================

describe("K — the abandoned send is continued, not orphaned and not restarted", () => {
  it("registers the continuation BEFORE the response is released", async () => {
    let settle: (r: SendPaymentChargeReceiptResult) => void = () => {};
    const hang = vi.fn(
      () => new Promise<SendPaymentChargeReceiptResult>((r) => (settle = r)),
    ) as unknown as ReceiptSender;
    const { register } = regSpy();

    const pending = autoSendReceiptAfterCharge({
      charge: SUCCEEDED,
      ...ARGS,
      send: hang,
      timeoutMs: 10_000,
      register,
    });

    // The response has NOT been released — the send is still hanging — and
    // registration has already happened. Registering after the await would be
    // a race the framework loses on a fast send.
    await drain();
    expect(register).toHaveBeenCalledTimes(1);

    settle(sent);
    await expect(pending).resolves.toEqual({ attempted: true, result: sent });
  });

  it("SLOW SEND — the continuation observes the SAME operation, and sends nothing new", async () => {
    let settle: (r: SendPaymentChargeReceiptResult) => void = () => {};
    const hang = vi.fn(
      () => new Promise<SendPaymentChargeReceiptResult>((r) => (settle = r)),
    ) as unknown as ReceiptSender;
    const { register, registered } = regSpy();

    const outcome = await autoSendReceiptAfterCharge({
      charge: SUCCEEDED,
      ...ARGS,
      send: hang,
      timeoutMs: 10,
      register,
    });

    expect(outcome).toEqual({
      attempted: true,
      timedOut: true,
      waitedMs: 10,
      continuationManaged: true,
    });
    expect(describeAutoReceipt(outcome)).toBe("pending");

    // The registered work is still pending: it is waiting on the SAME send,
    // which has not settled. A continuation that had already resolved would be
    // proof it was not actually observing anything.
    let settled = false;
    void registered[0]?.then(() => {
      settled = true;
    });
    await drain();
    expect(settled).toBe(false);

    // The one send finishes late. Still ONE call — the continuation did not
    // start a second one.
    settle(sent);
    await registered[0];
    expect(hang).toHaveBeenCalledTimes(1);
    expect(settled).toBe(true);
  });

  it("LATE REJECTION — a throw after the response is caught, not left unhandled", async () => {
    let boom: (e: unknown) => void = () => {};
    const rejectLate = vi.fn(
      () => new Promise<SendPaymentChargeReceiptResult>((_r, rej) => (boom = rej)),
    ) as unknown as ReceiptSender;
    const { register, registered } = regSpy();

    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const outcome = await autoSendReceiptAfterCharge({
        charge: SUCCEEDED,
        ...ARGS,
        send: rejectLate,
        timeoutMs: 10,
        register,
      });
      expect(outcome).toMatchObject({ timedOut: true });

      boom(new Error("provider exploded after we stopped waiting"));
      // The continuation resolves rather than rejecting: it is the last
      // observer, and an unhandled rejection here would surface as a crash in
      // a serverless runtime long after the charge response went out.
      await expect(registered[0]).resolves.toBeUndefined();
      await drain();
      expect(unhandled).not.toHaveBeenCalled();
      expect(rejectLate).toHaveBeenCalledTimes(1);
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("LATE SETTLEMENT that is benign does not alert", async () => {
    let settle: (r: SendPaymentChargeReceiptResult) => void = () => {};
    const hang = vi.fn(
      () => new Promise<SendPaymentChargeReceiptResult>((r) => (settle = r)),
    ) as unknown as ReceiptSender;
    const { register, registered } = regSpy();

    await autoSendReceiptAfterCharge({
      charge: SUCCEEDED,
      ...ARGS,
      send: hang,
      timeoutMs: 10,
      register,
    });
    // It landed, just slowly. Nothing is wrong and nothing is owed.
    settle(sent);
    await expect(registered[0]).resolves.toBeUndefined();
  });

  it("a FAST send registers a continuation that resolves without doing anything", async () => {
    // The control for the two above. The continuation must not report a late
    // settlement for an outcome the response already carried, or every
    // ordinary charge would emit a duplicate log line.
    const send = spySender(sent);
    const { register, registered } = regSpy();

    const outcome = await autoSendReceiptAfterCharge({
      charge: SUCCEEDED,
      ...ARGS,
      send,
      timeoutMs: 10_000,
      register,
    });

    expect(outcome).toEqual({ attempted: true, result: sent });
    expect(register).toHaveBeenCalledTimes(1);
    await expect(registered[0]).resolves.toBeUndefined();
  });

  it("when after() is unavailable it says so instead of claiming management", async () => {
    // Outside a request scope there is nothing to keep alive. The send still
    // runs; what changes is that the report is HONEST about it rather than
    // implying a guarantee the runtime is not making.
    const hang = vi.fn(
      () => new Promise<SendPaymentChargeReceiptResult>(() => {}),
    ) as unknown as ReceiptSender;

    const outcome = await autoSendReceiptAfterCharge({
      charge: SUCCEEDED,
      ...ARGS,
      send: hang,
      timeoutMs: 10,
      register: regUnavailable(),
    });

    expect(outcome).toEqual({
      attempted: true,
      timedOut: true,
      waitedMs: 10,
      continuationManaged: false,
    });
    // Still pending, never "sent": an unmanaged continuation is LESS certain,
    // not more.
    expect(describeAutoReceipt(outcome)).toBe("pending");
  });

  it("uses the framework mechanism, not a bare timer or a detached promise", () => {
    const helper = readFileSync(
      join(process.cwd(), "lib/billing/auto-payment-receipt.ts"),
      "utf8",
    );
    const code = helper.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    expect(code).toContain('import { after } from "next/server"');
    expect(code).toContain("args.register ?? after");
    // Exactly one send call site in the whole module. A second would be a
    // second send, which is the thing the finding forbids.
    expect(code.match(/\bsend\(/g) ?? []).toHaveLength(1);
    // No detached escape hatches.
    expect(code).not.toMatch(/setInterval\(/);
    expect(code).not.toMatch(/\.unref\(/);
  });

  it("the installed framework actually exports the mechanism", async () => {
    // The finding asked for the installed version to be VERIFIED, not assumed.
    const next = await import("next/server");
    expect(typeof (next as { after?: unknown }).after).toBe("function");
    const version = (
      JSON.parse(
        readFileSync(join(process.cwd(), "node_modules/next/package.json"), "utf8"),
      ) as { version: string }
    ).version;
    // after() is stable from 15.1; this pin is well past it.
    const [major, minor] = version.split(".").map(Number);
    expect(major > 15 || (major === 15 && minor >= 1)).toBe(true);
  });

  it("documents what after() does NOT guarantee", () => {
    // The honesty requirement, kept in the file rather than only in a PR
    // comment: no exactly-once, no durable recovery, dies with the instance.
    const helper = readFileSync(
      join(process.cwd(), "lib/billing/auto-payment-receipt.ts"),
      "utf8",
    );
    // The header is prose-wrapped, so compare on normalised text rather than
    // on accidental line breaks.
    const prose = helper.replace(/^\s*\/\/ ?/gm, "").replace(/\s+/g, " ");
    expect(prose).toContain("NOT a durable queue and NOT exactly-once delivery");
    expect(prose).toContain("max duration elapsing");
    expect(prose).toContain("AT MOST ONE automatic send per committed charge");
    expect(prose).toContain("Not at-least-once, and not exactly-once");
    // The recovery path that DOES survive a dead instance is named.
    expect(prose).toContain("manual Send button remains the operator");
  });
});

// ===========================================================================
// L — ALERTING OUTSIDE THE COMMITTED-PAYMENT BUDGET  (Codex P2 4008091156)
// ===========================================================================
//
// recordOpsAlert does a Supabase insert and then, for critical severity, a
// Resend call. Awaiting that on a committed-charge response reintroduces the
// delay the budget exists to prevent, on the worst path.
// ===========================================================================

describe("L — a slow alert cannot hold a committed charge", () => {
  it("SLOW ALERTING — the response returns without waiting for the alert", async () => {
    const boom = vi.fn(async () => {
      throw new Error("provider exploded");
    }) as unknown as ReceiptSender;
    const { register, registered } = regSpy();

    const outcome = await autoSendReceiptAfterCharge({
      charge: SUCCEEDED,
      ...ARGS,
      send: boom,
      timeoutMs: 10_000,
      register,
    });

    // The throw is reported inline — visibility is preserved — but the alert
    // it triggers was handed to the continuation, not awaited.
    expect(outcome).toMatchObject({ attempted: true, threw: true });
    expect(describeAutoReceipt(outcome)).toBe("pending");
    // Two registrations: the settlement continuation, and the alert.
    expect(register).toHaveBeenCalledTimes(2);
    expect(registered).toHaveLength(2);

    // VISIBILITY IS PRESERVED, not traded away. The alert really was raised,
    // at critical severity, naming the stranded-row condition an operator has
    // to act on.
    expect(alertSpy.calls).toHaveLength(1);
    expect(alertSpy.calls[0]).toMatchObject({
      severity: "critical",
      event: "auto_payment_receipt_threw",
      studioId: "st-1",
    });
    expect(alertSpy.calls[0]?.message).toContain("receipt_status='sending'");
    expect(alertSpy.calls[0]?.safeDetails).toMatchObject({ attempt_id: "att-1" });
  });

  it("A GENUINELY HANGING ALERT does not delay the response by one tick", async () => {
    // The strongest form of the finding: the alert provider is wedged. If the
    // response awaited it, this test would never resolve.
    alertSpy.behaviour.mode = "hang";
    const boom = vi.fn(async () => {
      throw new Error("provider exploded");
    }) as unknown as ReceiptSender;
    const { register } = regSpy();

    const outcome = await autoSendReceiptAfterCharge({
      charge: SUCCEEDED,
      ...ARGS,
      send: boom,
      timeoutMs: 10_000,
      register,
    });

    // Returned while the alert is still wedged.
    expect(outcome).toMatchObject({ threw: true });
    expect(alertSpy.calls).toHaveLength(1);
    expect(alertSpy.release).not.toBeNull();
    alertSpy.release?.();
  });

  it("a LATE failure alerts from the continuation, at the right severity", async () => {
    // The response has long gone. The slow send finally lands in an unrecorded
    // state, which is the operator-action case, so it is critical — while an
    // ordinary late failure is only a warning.
    const cases: Array<[SendPaymentChargeReceiptResult, string]> = [
      [
        { ok: false, reason: "send_ambiguous_state_not_recorded", message: "unknown" },
        "critical",
      ],
      [{ ok: false, reason: "send_failed_terminal", message: "rejected" }, "warning"],
    ];

    for (const [result, severity] of cases) {
      alertSpy.calls.length = 0;
      let settle: (r: SendPaymentChargeReceiptResult) => void = () => {};
      const hang = vi.fn(
        () => new Promise<SendPaymentChargeReceiptResult>((r) => (settle = r)),
      ) as unknown as ReceiptSender;
      const { register, registered } = regSpy();

      await autoSendReceiptAfterCharge({
        charge: SUCCEEDED,
        ...ARGS,
        send: hang,
        timeoutMs: 10,
        register,
      });
      // Nothing yet: the send has not settled.
      expect(alertSpy.calls).toHaveLength(0);

      settle(result);
      await registered[0];

      expect(alertSpy.calls).toHaveLength(1);
      expect(alertSpy.calls[0]).toMatchObject({
        severity,
        event: "auto_payment_receipt_late_failed",
        route: "lib/billing/auto-payment-receipt:reportLateSettlement",
      });
    }
  });

  it("FAILED ALERTING — an alert that rejects never becomes a payment failure", async () => {
    alertSpy.behaviour.mode = "reject";
    const boom = vi.fn(async () => {
      throw new Error("provider exploded");
    }) as unknown as ReceiptSender;
    const { register, registered } = regSpy();

    const outcome = await autoSendReceiptAfterCharge({
      charge: SUCCEEDED,
      ...ARGS,
      send: boom,
      timeoutMs: 10_000,
      register,
    });

    expect(outcome).toMatchObject({ threw: true });
    // Every registered promise resolves. recordOpsAlert is wrapped so an
    // alerting outage cannot reject into the runtime after the response.
    for (const work of registered) {
      await expect(work).resolves.toBeUndefined();
    }
    // It was attempted — the failure is the provider's, not a silent skip.
    expect(alertSpy.calls).toHaveLength(1);
  });

  it("with after() unavailable the alert is AWAITED, not fire-and-forget", async () => {
    // The fallback has to preserve visibility. Outside a request scope there
    // is no response being held, so awaiting costs nothing — and a bare
    // detached promise would be exactly what the finding forbids.
    const boom = vi.fn(async () => {
      throw new Error("provider exploded");
    }) as unknown as ReceiptSender;

    const outcome = await autoSendReceiptAfterCharge({
      charge: SUCCEEDED,
      ...ARGS,
      send: boom,
      timeoutMs: 10_000,
      register: regUnavailable(),
    });

    expect(outcome).toMatchObject({ threw: true });
    // Awaited, so by the time the response is in hand the alert has run.
    expect(alertSpy.calls).toHaveLength(1);
    expect(alertSpy.calls[0]).toMatchObject({ severity: "critical" });
  });

  it("no alert is raised on the ordinary successful path", () => {
    // Anti-vacuity for the two above: an implementation that alerted on every
    // charge would satisfy "the alert was registered" while being useless.
    const send = spySender(sent);
    const { register } = regSpy();
    return autoSendReceiptAfterCharge({
      charge: SUCCEEDED,
      ...ARGS,
      send,
      register,
    }).then(() => {
      // Only the settlement continuation. No alert.
      expect(register).toHaveBeenCalledTimes(1);
      expect(alertSpy.calls).toHaveLength(0);
    });
  });

  it("recordOpsAlert is never awaited on the response path", () => {
    const helper = readFileSync(
      join(process.cwd(), "lib/billing/auto-payment-receipt.ts"),
      "utf8",
    );
    const code = helper.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    // The only `await recordOpsAlert` is inside safeAlert, whose promise is
    // handed to the continuation rather than awaited by the caller.
    expect(code.match(/await recordOpsAlert\(/g) ?? []).toHaveLength(1);
    // Alerts reach the scheduler; the awaited fallback is the registration
    // failure only.
    expect(code).toContain("if (!tryRegister(register, alert)) await alert;");
    // No detached promise.
    expect(code).not.toMatch(/void safeAlert\(/);
  });
});
