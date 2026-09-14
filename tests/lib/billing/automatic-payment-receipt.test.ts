import { describe, expect, it, vi } from "vitest";
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

// ===========================================================================
// PAY-RECEIPT-AUTO-01 — the receipt sends itself, and the card never re-runs
// ===========================================================================
//
// NO REAL PROVIDER IS REACHED. Every send below is an injected fake; the
// module's `send` seam exists for exactly this. The last describe proves by
// source inspection that no Stripe receipt_email was introduced.
// ===========================================================================

const ARGS = { attemptId: "att-1", studioId: "st-1", practitionerId: "pr-1" };

const SUCCEEDED: SessionPaymentChargeResult = {
  ok: true,
  outcome: "succeeded",
  stripePaymentIntentId: "pi_1",
  stripeChargeId: "ch_1",
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
    });

    expect(outcome).toEqual({ attempted: true, timedOut: true, waitedMs: 10 });
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
