import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #178. Source-grep tests pin the refund sub-panel shape:
//   * lives ONLY inside SucceededPanel (not in any other panel)
//   * reads refund_status from the persisted summary so the
//     already-refunded / pending / failed states survive refresh
//   * shows Refund charge button only when refund_status is
//     null or 'failed'
//   * uses two-click confirm (Refund charge then
//     "Confirm: refund charge ($X.XX)")
//   * says test mode + no live money
//   * never says "Live refund", "Refund complete", "Money returned",
//     "Official refund receipt"

const CARD_PATH = path.resolve(
  __dirname,
  "../../../components/session-payment-prepare-card.tsx",
);
const CARD = readFileSync(CARD_PATH, "utf8");

const TYPES_PATH = path.resolve(
  __dirname,
  "../../../lib/billing/session-payment-types.ts",
);
const TYPES = readFileSync(TYPES_PATH, "utf8");

const ELIG_PATH = path.resolve(
  __dirname,
  "../../../lib/billing/session-payment-eligibility.ts",
);
const ELIG = readFileSync(ELIG_PATH, "utf8");

const PAGE_PATH = path.resolve(
  __dirname,
  "../../../app/(app)/clients/[id]/sessions/[sessionId]/page.tsx",
);
const PAGE = readFileSync(PAGE_PATH, "utf8");

function blockFor(name: string): string {
  const startIdx = CARD.indexOf(`function ${name}(`);
  if (startIdx === -1) return "";
  const after = startIdx + 1;
  const rel = CARD.slice(after).search(/^function \w+\(/m);
  return rel === -1 ? CARD.slice(startIdx) : CARD.slice(startIdx, after + rel);
}

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}
const CARD_CODE = codeOnly(CARD);

describe("PR #178: SessionPaymentExistingAttemptSummary carries refund fields", () => {
  it("type adds refundStatus / refundAmountCents / refundedAt", () => {
    expect(TYPES).toMatch(/refundStatus:\s*string \| null/);
    expect(TYPES).toMatch(/refundAmountCents:\s*number \| null/);
    expect(TYPES).toMatch(/refundedAt:\s*string \| null/);
  });

  it("type adds stripeRefundId / refundFailureCode / refundFailureMessageSafe", () => {
    expect(TYPES).toMatch(/stripeRefundId:\s*string \| null/);
    expect(TYPES).toMatch(/refundFailureCode:\s*string \| null/);
    expect(TYPES).toMatch(/refundFailureMessageSafe:\s*string \| null/);
  });

  it("eligibility helper SELECTs every new refund column", () => {
    for (const col of [
      "refund_status",
      "refund_amount_cents",
      "refunded_at",
      "stripe_refund_id",
      "refund_failure_code",
      "refund_failure_message_safe",
    ]) {
      expect(ELIG).toContain(col);
    }
  });

  it("eligibility helper maps each refund column into the summary", () => {
    expect(ELIG).toMatch(/refundStatus:[\s\S]{0,80}row\.refund_status/);
    expect(ELIG).toMatch(/refundAmountCents:[\s\S]{0,80}row\.refund_amount_cents/);
    expect(ELIG).toMatch(/refundedAt:[\s\S]{0,80}row\.refunded_at/);
    expect(ELIG).toMatch(/stripeRefundId:[\s\S]{0,80}row\.stripe_refund_id/);
    expect(ELIG).toMatch(/refundFailureCode:[\s\S]{0,80}row\.refund_failure_code/);
    expect(ELIG).toMatch(
      /refundFailureMessageSafe:[\s\S]{0,80}row\.refund_failure_message_safe/,
    );
  });
});

describe("PR #178: SessionPaymentPrepareCard wires refundAction", () => {
  it("the card accepts a refundAction prop", () => {
    expect(CARD).toMatch(/refundAction:\s*RefundAction/);
  });

  it("the page passes refundPaymentChargeAttemptAction into the card", () => {
    expect(PAGE).toMatch(/refundAction=\{refundPaymentChargeAttemptAction\}/);
  });

  it("AttemptStatusPanel forwards refundAction to SucceededPanel only", () => {
    const dispatch = blockFor("AttemptStatusPanel");
    expect(dispatch).toMatch(
      /case "succeeded":[\s\S]{0,500}refundAction=\{refundAction\}/,
    );
    // Other branches must NOT receive the prop.
    const sliceCase = (name: string): string => {
      const start = dispatch.indexOf(`case "${name}":`);
      if (start === -1) return "";
      const after = start + 1;
      const next = dispatch.slice(after).search(/case "|default:/);
      return next === -1
        ? dispatch.slice(start)
        : dispatch.slice(start, after + next);
    };
    for (const name of ["ready", "pending_stripe", "failed", "cancelled", "blocked"]) {
      const block = sliceCase(name);
      expect(block).not.toMatch(/refundAction=/);
    }
  });
});

describe("PR #178: RefundSubPanel rendering shape", () => {
  it("the SucceededPanel renders <RefundSubPanel ...>", () => {
    const block = blockFor("SucceededPanel");
    expect(block).toMatch(/<RefundSubPanel/);
  });

  it("RefundSubPanel exists as a dedicated function", () => {
    expect(CARD).toMatch(/function RefundSubPanel/);
  });

  it("RefundSubPanel reads BOTH refund columns through refundDisplayState (R1) and branches on its kinds", () => {
    const block = blockFor("RefundSubPanel");
    expect(block).toMatch(/refundDisplayState\(\{/);
    expect(block).toMatch(/refundStatus:\s*attempt\.refundStatus/);
    expect(block).toMatch(/providerRefundStatus:\s*attempt\.stripeRefundStatus/);
    for (const kind of ["refunded", "pending", "needs_action", "unclear", "failed"]) {
      expect(block, kind).toMatch(new RegExp(`display\\.kind === "${kind}"`));
    }
    // The old single-column reads must be gone: they are what let "succeeded" hide a provider failure.
    expect(block).not.toMatch(/attempt\.refundStatus === "/);
  });

  it("the Refund charge button renders ONLY when refundDisplayState allows a new refund", () => {
    const block = blockFor("RefundSubPanel");
    const gateIdx = block.indexOf("display.mayStartRefund");
    const buttonIdx = block.indexOf("Refund charge");
    expect(gateIdx, "mayStartRefund guard present").toBeGreaterThan(-1);
    expect(buttonIdx, "Refund charge button present").toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(buttonIdx);
    expect(block).toMatch(/isOwner\s*&&\s*\n?\s*display\.mayStartRefund\s*&&\s*\n?\s*!localRefunded/);
  });

  it("the refund copy is neutral (no test-mode / no-live-money claim)", () => {
    const block = blockFor("RefundSubPanel");
    expect(block).toMatch(
      /This creates a Stripe refund for this charge on the studio(&apos;|')s\s+connected account\./,
    );
    expect(block).not.toMatch(/Stripe test-mode refund/);
    expect(block).not.toMatch(/No live\s+money is moved/);
  });

  it("uses a two-click confirm with the amount in the confirm button", () => {
    const block = blockFor("RefundSubPanel");
    expect(block).toMatch(/setConfirming\(true\)/);
    expect(block).toMatch(
      /Confirm: refund charge \(\$\{refundAmountFormatted\}\)/,
    );
  });

  it("the succeeded state surfaces amount + refunded timestamp (raw refund id is owner-only)", () => {
    const block = blockFor("RefundSubPanel");
    expect(block).toMatch(/Refund succeeded\./);
    expect(block).toMatch(/Amount refunded/);
    expect(block).toMatch(/Refunded:/);
    expect(block).toMatch(/attempt\.refundedAt/);
    // The raw Stripe refund id is no longer inline — it lives in the owner-only
    // Technical payment details disclosure on SucceededPanel.
    expect(block).not.toMatch(/Stripe refund:/);
    // R1: the refund id is an INPUT to refundDisplayState (a provider trace blocks a new attempt) and is never rendered.
    expect([...block.matchAll(/attempt\.stripeRefundId/g)]).toHaveLength(1);
    expect(block).toMatch(/stripeRefundId:\s*attempt\.stripeRefundId,/);
  });

  it("the failed state stays calm — no raw code/message inline (they are owner-only)", () => {
    const block = blockFor("RefundSubPanel");
    expect(block).toMatch(/Refund failed\./);
    expect(block).toMatch(/You can try again below\./);
    expect(block).not.toMatch(/attempt\.refundFailureMessageSafe/);
    expect(block).not.toMatch(/attempt\.refundFailureCode/);
  });

  it("the pending state surfaces a calm 'Refund pending' message", () => {
    const block = blockFor("RefundSubPanel");
    expect(block).toMatch(/Refund pending\./);
  });

  it("setLocalRefunded only fires on r.ok === true", () => {
    const block = blockFor("RefundSubPanel");
    expect(block).toMatch(
      /if \(r\.ok\)\s*\{[\s\S]{0,400}setLocalRefunded\(/,
    );
  });

  it("non-ok results call setError(r.error) instead of setLocalRefunded", () => {
    const block = blockFor("RefundSubPanel");
    expect(block).toMatch(/setError\(r\.error\);/);
  });
});

describe("PR #178: forbidden copy on the refund surface", () => {
  it("does NOT say 'Live refund'", () => {
    expect(CARD_CODE).not.toMatch(/Live refund/);
  });

  it("does NOT say 'Refund complete'", () => {
    expect(CARD_CODE).not.toMatch(/Refund complete/);
  });

  it("does NOT say 'Money returned'", () => {
    expect(CARD_CODE).not.toMatch(/Money returned/);
  });

  it("does NOT say 'Official refund receipt'", () => {
    expect(CARD_CODE).not.toMatch(/Official refund receipt/);
  });
});

describe("PR #178: refund surface is succeeded-only (negative checks)", () => {
  it("ReadyPanel does NOT render <RefundSubPanel", () => {
    const block = blockFor("ReadyPanel");
    expect(block).not.toMatch(/<RefundSubPanel/);
  });

  it("PendingPanel does NOT render <RefundSubPanel", () => {
    const block = blockFor("PendingPanel");
    expect(block).not.toMatch(/<RefundSubPanel/);
  });

  it("FailedPanel does NOT render <RefundSubPanel", () => {
    const block = blockFor("FailedPanel");
    expect(block).not.toMatch(/<RefundSubPanel/);
  });

  it("CancelledPanel does NOT render <RefundSubPanel", () => {
    const block = blockFor("CancelledPanel");
    expect(block).not.toMatch(/<RefundSubPanel/);
  });
});
