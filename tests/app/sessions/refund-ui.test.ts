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
//   * never says "Live refund" or "Official refund receipt"

const CARD_PATH = path.resolve(
  __dirname,
  "../../../components/session-payment-prepare-card.tsx",
);
const CARD = readFileSync(CARD_PATH, "utf8");

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

describe("PR #178: RefundSubPanel rendering shape", () => {
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

  it("setLocalRefunded only fires on r.ok === true", () => {
    const block = blockFor("RefundSubPanel");
    expect(block).toMatch(
      /if \(r\.ok\)\s*\{[\s\S]{0,400}setLocalRefunded\(/,
    );
  });
});

describe("PR #178: forbidden copy on the refund surface", () => {
  it("does NOT say 'Live refund'", () => {
    expect(CARD_CODE).not.toMatch(/Live refund/);
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
