import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #181. Source-grep tests pin the cleaner payment-card state
// model. The card now:
//   * Gates the local prepareJustSucceeded banner on !activeAttempt
//     so it cannot conflict with the persisted SucceededPanel /
//     refunded state.
//   * Calls router.refresh() after a successful Prepare so the
//   persisted ready row replaces the local banner immediately.
//   * Promotes refund_status='succeeded' to the top heading
//     ("Payment refunded") with a refund details block below
//     the charge details. Receipt + Refund sub-panels still
//   render below as the per-section detail.
//   * Wraps the SessionPaymentPrepareCard in <div id="session-
//   payment"> so the calendar NextStepCard's "Go to billing"
//   deep link lands here.

const CARD_PATH = path.resolve(
  __dirname,
  "../../../components/session-payment-prepare-card.tsx",
);
const CARD = readFileSync(CARD_PATH, "utf8");

const SESSION_PAGE_PATH = path.resolve(
  __dirname,
  "../../../app/(app)/clients/[id]/sessions/[sessionId]/page.tsx",
);
const SESSION_PAGE = readFileSync(SESSION_PAGE_PATH, "utf8");

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

describe("PR #181: prepareJustSucceeded banner is single-render", () => {
  it("the local banner is gated on !activeAttempt so it cannot conflict with the persisted SucceededPanel", () => {
    expect(CARD).toMatch(
      /\{prepareJustSucceeded && !activeAttempt && \(/,
    );
  });

  it("the new banner copy is 'You can now run the charge.' (replaces the stale 'No charge has been run' wording)", () => {
    expect(CARD).toMatch(/You can now run the charge\./);
  });

  it("the stale 'Attempt id: ... No charge has been run' banner is gone", () => {
    // The previous copy said:
    //   Attempt id: <code>{prepareJustSucceeded.attemptId}</code>. No charge
    //   has been run. Refresh to see the persisted state...
    // PR #181 removed both the attempt-id render and the
    // "No charge has been run" line.
    expect(CARD).not.toMatch(/No charge has been run/);
    expect(CARD).not.toMatch(
      /Refresh to see the persisted state and the Run charge affordance/,
    );
  });

  it("the action's success branch calls router.refresh() so persisted state catches up immediately", () => {
    expect(CARD).toMatch(
      /setPrepareJustSucceeded\(\{ attemptId: r\.attemptId \}\);[\s\S]{0,800}router\.refresh\(\);/,
    );
  });

  it("the parent component imports useRouter from next/navigation", () => {
    expect(CARD).toMatch(
      /import \{ useRouter \} from "next\/navigation";/,
    );
  });
});

describe("PR #181: SucceededPanel promotes refund_status='succeeded' to the top heading", () => {
  it("the panel declares a refunded discriminator off attempt.refundStatus", () => {
    const block = blockFor("SucceededPanel");
    expect(block).toMatch(
      /const refunded = attempt\.refundStatus === "succeeded";/,
    );
  });

  it("the top heading reads 'Payment refunded.' when refunded", () => {
    const block = blockFor("SucceededPanel");
    expect(block).toMatch(/refunded \? "Payment refunded\." :/);
  });

  it("the top heading reads 'Charge succeeded.' when not refunded", () => {
    const block = blockFor("SucceededPanel");
    expect(block).toMatch(
      /refunded \? "Payment refunded\." : "Charge succeeded\."/,
    );
  });

  it("the refunded variant switches the border + background palette (amber, not green)", () => {
    const block = blockFor("SucceededPanel");
    expect(block).toMatch(
      /refunded\s*\?[\s\S]{0,300}border-amber-300 bg-amber-50/,
    );
  });

  it("a refund details block (Amount refunded / Refunded / Refund id) renders when refunded", () => {
    const block = blockFor("SucceededPanel");
    expect(block).toMatch(/Refund details/);
    expect(block).toMatch(/Amount refunded:/);
    expect(block).toMatch(/Refunded:/);
    expect(block).toMatch(/attempt\.refundedAt/);
    expect(block).toMatch(/attempt\.stripeRefundId/);
  });

  it("the panel uses neutral charge copy below the details (no false 'no live card' claim)", () => {
    const block = blockFor("SucceededPanel");
    expect(block).toMatch(
      /This charge ran on the studio(&apos;|')s Stripe connected account\./,
    );
    expect(block).not.toMatch(/No live card was charged/);
  });

  it("the Amount line is renamed to 'Amount charged:' so it reads as a charge total", () => {
    const block = blockFor("SucceededPanel");
    expect(block).toMatch(/Amount charged:/);
  });
});

describe("PR #181: ReceiptSubPanel + RefundSubPanel still mount inside SucceededPanel", () => {
  it("ReceiptSubPanel is still rendered inside SucceededPanel", () => {
    const block = blockFor("SucceededPanel");
    expect(block).toMatch(/<ReceiptSubPanel/);
  });

  it("RefundSubPanel is still rendered inside SucceededPanel (idle and post-refund render is handled there)", () => {
    const block = blockFor("SucceededPanel");
    expect(block).toMatch(/<RefundSubPanel/);
  });
});

describe("PR #181: session detail page has the deep-link anchor", () => {
  it("SessionPaymentPrepareCard is wrapped in <div id=\"session-payment\">", () => {
    expect(SESSION_PAGE).toMatch(
      /<div id="session-payment">[\s\S]{0,2000}<SessionPaymentPrepareCard/,
    );
  });
});

describe("PR #181: forbidden copy on the payment surface", () => {
  it("never says 'Payment complete'", () => {
    const code = codeOnly(CARD);
    expect(code).not.toMatch(/Payment complete/);
  });

  it("never says 'Live payment'", () => {
    const code = codeOnly(CARD);
    expect(code).not.toMatch(/Live payment/);
  });

  it("never says 'Money returned'", () => {
    const code = codeOnly(CARD);
    expect(code).not.toMatch(/Money returned/);
  });

  it("never says 'Refund complete' (test-mode wording is 'Payment refunded')", () => {
    const code = codeOnly(CARD);
    expect(code).not.toMatch(/Refund complete/);
  });
});
