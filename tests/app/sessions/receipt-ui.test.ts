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
//   * never say "Send invoice" / "Tax receipt" / "Official invoice"

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

describe("PR #175: ReceiptSubPanel rendering shape", () => {
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

  it("the already-sent state surfaces a MASKED recipient + sent timestamp (never the full email)", () => {
    const block = blockFor("ReceiptSubPanel");
    // The "Receipt sent [to …]" line is rendered by <ReceiptStatus>, fed a
    // masked address; the raw email is never rendered inline.
    expect(block).toMatch(/<ReceiptStatus/);
    expect(block).toMatch(/maskReceiptEmail\(/);
    expect(block).toMatch(/attempt\.receiptSentAt/);
    expect(block).not.toMatch(/<code>\{[^}]*receiptEmailTo[^}]*\}<\/code>/);
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
