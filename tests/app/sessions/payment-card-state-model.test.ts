import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #181. Source-grep tests for the payment card: processor identifiers are
// owner-only, and forbidden copy never appears on the payment surface.

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

describe("PR #181: SucceededPanel technical details", () => {
  it("processor identifiers are owner-only via technicalRowsForAttempt", () => {
    const block = blockFor("SucceededPanel");
    expect(block).toMatch(/<TechnicalPaymentDetails/);
    expect(block).toMatch(/technicalRowsForAttempt\(attempt\)/);
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
