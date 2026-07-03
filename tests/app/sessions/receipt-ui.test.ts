import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #175. Receipt UI hardening tests. The succeeded panel's
// receipt sub-section must:
//   * render only inside SucceededPanel (never on ready /
//     pending / failed rows)
//   * read receipt_status from the persisted summary so the
//     already-sent state survives refresh
//   * show the Send receipt button only when receipt_status
//     is null / failed (the latter for retry after fix)
//   * never say "Pay now" / "Send invoice" / "Tax receipt" /
//     "Official invoice" / "Payment complete" / "Live payment"

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

describe("PR #175: SessionPaymentExistingAttemptSummary carries receipt fields", () => {
  it("type adds receiptStatus / receiptSentAt / receiptEmailTo", () => {
    expect(TYPES).toMatch(/receiptStatus:\s*string \| null/);
    expect(TYPES).toMatch(/receiptSentAt:\s*string \| null/);
    expect(TYPES).toMatch(/receiptEmailTo:\s*string \| null/);
  });

  it("type adds receiptFailureCode / receiptFailureMessageSafe", () => {
    expect(TYPES).toMatch(/receiptFailureCode:\s*string \| null/);
    expect(TYPES).toMatch(/receiptFailureMessageSafe:\s*string \| null/);
  });

  it("eligibility helper SELECTs every new receipt column", () => {
    expect(ELIG).toMatch(/receipt_status/);
    expect(ELIG).toMatch(/receipt_sent_at/);
    expect(ELIG).toMatch(/receipt_email_to/);
    expect(ELIG).toMatch(/receipt_failure_code/);
    expect(ELIG).toMatch(/receipt_failure_message_safe/);
  });

  it("eligibility helper maps each receipt column into the summary", () => {
    expect(ELIG).toMatch(/receiptStatus:[\s\S]{0,80}row\.receipt_status/);
    expect(ELIG).toMatch(/receiptSentAt:[\s\S]{0,80}row\.receipt_sent_at/);
    expect(ELIG).toMatch(/receiptEmailTo:[\s\S]{0,80}row\.receipt_email_to/);
    expect(ELIG).toMatch(
      /receiptFailureCode:[\s\S]{0,80}row\.receipt_failure_code/,
    );
    expect(ELIG).toMatch(
      /receiptFailureMessageSafe:[\s\S]{0,80}row\.receipt_failure_message_safe/,
    );
  });
});

describe("PR #175: SessionPaymentPrepareCard wires sendReceiptAction", () => {
  it("the card accepts a sendReceiptAction prop", () => {
    expect(CARD).toMatch(/sendReceiptAction:\s*SendReceiptAction/);
  });

  it("the page passes sendPaymentChargeReceiptAction into the card", () => {
    expect(PAGE).toMatch(/sendReceiptAction=\{sendPaymentChargeReceiptAction\}/);
  });

  it("AttemptStatusPanel forwards sendReceiptAction to SucceededPanel only", () => {
    const dispatch = blockFor("AttemptStatusPanel");
    expect(dispatch).toMatch(
      /case "succeeded":[\s\S]{0,400}sendReceiptAction=\{sendReceiptAction\}/,
    );
    // Other branches must NOT receive the prop. Slice each case
    // block from "case <name>:" to "case " (or "default:") so the
    // negative does not over-match into the succeeded branch.
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
      expect(block).not.toMatch(/sendReceiptAction=/);
    }
  });
});

describe("PR #175: ReceiptSubPanel rendering shape", () => {
  it("the SucceededPanel renders <ReceiptSubPanel ...>", () => {
    const block = blockFor("SucceededPanel");
    expect(block).toMatch(/<ReceiptSubPanel/);
  });

  it("ReceiptSubPanel exists as a dedicated function", () => {
    expect(CARD).toMatch(/function ReceiptSubPanel/);
  });

  it("ReceiptSubPanel branches on persisted receipt_status (sent / failed / sending)", () => {
    const block = blockFor("ReceiptSubPanel");
    expect(block).toMatch(/attempt\.receiptStatus === "sent"/);
    expect(block).toMatch(/attempt\.receiptStatus === "failed"/);
    expect(block).toMatch(/attempt\.receiptStatus === "sending"/);
  });

  it("the Send receipt button only appears when status is null or failed (persisted)", () => {
    const block = blockFor("ReceiptSubPanel");
    // The button-render gate excludes persistedSent + persistedSending.
    // We pin both negations + the button appearing inside the
    // same gated JSX; whitespace + && separators may consume
    // several hundred chars, so use a generous window.
    expect(block).toMatch(
      /!persistedSent[\s\S]{0,800}!persistedSending[\s\S]{0,800}<button/,
    );
    expect(block).toMatch(/Send receipt/);
  });

  it("the receipt copy is neutral (no test-mode / no-live-card claim)", () => {
    const block = blockFor("ReceiptSubPanel");
    expect(block).toMatch(/Sends a Stripe receipt to the client for this charge\./);
    expect(block).not.toMatch(/Stripe test-mode receipt/);
    expect(block).not.toMatch(/No live card was\s+charged/);
  });

  it("the already-sent state surfaces the recipient + sent timestamp", () => {
    const block = blockFor("ReceiptSubPanel");
    expect(block).toMatch(/Receipt already sent to/);
    expect(block).toMatch(/attempt\.receiptEmailTo/);
    expect(block).toMatch(/attempt\.receiptSentAt/);
  });

  it("the failed state surfaces the sanitised failure message + code", () => {
    const block = blockFor("ReceiptSubPanel");
    expect(block).toMatch(/Receipt send failed/);
    expect(block).toMatch(/attempt\.receiptFailureMessageSafe/);
    expect(block).toMatch(/attempt\.receiptFailureCode/);
  });

  it("the in-flight state surfaces a calm 'in flight' message", () => {
    const block = blockFor("ReceiptSubPanel");
    expect(block).toMatch(/A receipt send is in flight/);
  });
});

describe("PR #175: forbidden copy on the receipt surface", () => {
  it("does NOT say 'Send invoice'", () => {
    expect(CARD_CODE).not.toMatch(/Send invoice/);
  });

  it("does NOT say 'Tax receipt'", () => {
    expect(CARD_CODE).not.toMatch(/Tax receipt/);
  });

  it("does NOT say 'Official invoice'", () => {
    expect(CARD_CODE).not.toMatch(/Official invoice/);
  });

  it("does NOT say 'Payment complete'", () => {
    expect(CARD_CODE).not.toMatch(/Payment complete/);
  });

  it("does NOT say 'Live payment'", () => {
    expect(CARD_CODE).not.toMatch(/Live payment/);
  });
});

describe("PR #175 patch: localSent is set ONLY when r.ok === true", () => {
  // The pre-patch UI flipped localSent on every send result and
  // showed "Receipt already sent to <email>" as soon as the
  // action returned, regardless of whether the row was actually
  // persisted. The patched flow only sets localSent when r.ok
  // is true. The sent_but_record_update_failed branch returns
  // ok:false with a warning message; that message must surface
  // in the error slot, not in the success panel.

  it("setLocalSent only fires on r.ok === true", () => {
    const block = blockFor("ReceiptSubPanel");
    // Pin the if(r.ok) guard around setLocalSent.
    expect(block).toMatch(
      /if \(r\.ok\)\s*\{\s*\n?\s*setLocalSent\(\{ emailTo: r\.emailTo \}\)/,
    );
  });

  it("non-ok results call setError(r.error) instead of setLocalSent", () => {
    const block = blockFor("ReceiptSubPanel");
    // The else branch surfaces the warning via setError. The
    // sent_but_record_update_failed warning message is built
    // by the action layer; the UI just renders it as-is in the
    // error slot.
    expect(block).toMatch(/setError\(r\.error\)/);
  });

  it("the patch comment explains the load-bearing invariant", () => {
    // A future refactor that loses the if(r.ok) gate must be a
    // deliberate decision; the comment block is the search
    // anchor for the next operator audit.
    const block = blockFor("ReceiptSubPanel");
    expect(block).toMatch(/setLocalSent fires ONLY when[\s\S]{0,100}r\.ok === true/);
  });
});

describe("PR #175: receipt surface is succeeded-only (negative checks)", () => {
  it("ReadyPanel does NOT render <ReceiptSubPanel", () => {
    const block = blockFor("ReadyPanel");
    expect(block).not.toMatch(/<ReceiptSubPanel/);
  });

  it("PendingPanel does NOT render <ReceiptSubPanel", () => {
    const block = blockFor("PendingPanel");
    expect(block).not.toMatch(/<ReceiptSubPanel/);
  });

  it("FailedPanel does NOT render <ReceiptSubPanel", () => {
    const block = blockFor("FailedPanel");
    expect(block).not.toMatch(/<ReceiptSubPanel/);
  });

  it("CancelledPanel does NOT render <ReceiptSubPanel", () => {
    const block = blockFor("CancelledPanel");
    expect(block).not.toMatch(/<ReceiptSubPanel/);
  });
});
