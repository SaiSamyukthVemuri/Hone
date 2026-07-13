import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Compact payment card — component-level security/privacy + wiring guards for the
// three presentational pieces. Behaviour of the pure derivation is covered by
// tests/lib/payments/payment-summary-presenter.test.ts; here we lock that the
// owner-only disclosure is a real render gate (not CSS) and the practitioner
// card never leaks processor internals or the full email.

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const TECH = read("components/payment/technical-payment-details.tsx");
const RECEIPT = read("components/payment/receipt-status.tsx");
const SUMMARY = read("components/payment/payment-summary-card.tsx");
const CARD = read("components/session-payment-prepare-card.tsx");

describe("TechnicalPaymentDetails — owner-only, collapsed, real render gate", () => {
  it("returns null for a non-owner (not CSS-hidden)", () => {
    expect(TECH).toMatch(/if\s*\(!isOwner\)\s*return null;/);
  });
  it("is a <details> collapsed by default (no `open` attribute)", () => {
    expect(TECH).toMatch(/<details/);
    expect(TECH).not.toMatch(/<details[^>]*\bopen\b/);
  });
  it("drops null/blank rows and renders nothing when empty", () => {
    expect(TECH).toMatch(/r\.value != null/);
    expect(TECH).toMatch(/if\s*\(shown\.length === 0\)\s*return null;/);
  });
  it("labels the disclosure 'Technical payment details' with a 44px+ target", () => {
    expect(TECH).toMatch(/Technical payment details/);
    expect(TECH).toMatch(/min-h-\[44px\]/);
  });
  it("carries no secret / card / publishable-key material (executable code)", () => {
    const code = TECH.split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/sk_live|sk_test|last4|cvc|publishable/i);
  });
});

describe("ReceiptStatus — success separate from delivery; never the full email", () => {
  it("renders 'Receipt not sent' for a failed delivery (charge stays paid elsewhere)", () => {
    expect(RECEIPT).toMatch(/Receipt not sent/);
    expect(RECEIPT).toMatch(/Receipt sent/);
  });
  it("conveys failure with text, not colour alone", () => {
    expect(RECEIPT).toMatch(/⚠/);
  });
  it("takes an already-masked line — no email formatting here", () => {
    // It renders line.masked verbatim; it never touches the raw email field.
    expect(RECEIPT).not.toMatch(/receiptEmailTo/);
  });
});

describe("PaymentSummaryCard — compact, status not by colour alone", () => {
  it("shows the headline text + amount (not just a colour dot)", () => {
    expect(SUMMARY).toMatch(/summary\.headline/);
    expect(SUMMARY).toMatch(/formatCadFromCents\(summary\.amountCents\)/);
    expect(SUMMARY).toMatch(/aria-hidden/); // the dot is decorative
  });
});

describe("session card integration — owner threading + no default leak", () => {
  it("threads a server-derived isOwner into the panels", () => {
    expect(CARD).toMatch(/isOwner/);
    // Every attempt panel receives it.
    expect(CARD).toMatch(/<TechnicalPaymentDetails\s+isOwner=\{isOwner\}/);
  });
  it("the page passes practitioner.role-derived isOwner", () => {
    const PAGE = read(
      "app/(app)/clients/[id]/sessions/[sessionId]/page.tsx",
    );
    expect(PAGE).toMatch(/isOwner=\{practitioner\.role === "owner"\}/);
  });
  it("the Refund button is owner-gated in the UI (server auth unchanged)", () => {
    // The refund action block is gated on isOwner; server-side owner-only
    // authorization in payment-actions is not touched by this PR.
    expect(CARD).toMatch(/isOwner &&[\s\S]{0,80}!persistedSucceeded/);
  });
  it("no inline processor id / full-email rows survive in the default face", () => {
    const codeOnly = CARD.split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("{/*"))
      .join("\n");
    expect(codeOnly).not.toMatch(/PaymentIntent:\s*\{?\s*attempt\.stripePaymentIntentId/);
    expect(codeOnly).not.toMatch(/Charge:\s*\{?\s*attempt\.stripeChargeId/);
    expect(codeOnly).not.toMatch(/<code>\{[^}]*receiptEmailTo[^}]*\}<\/code>/);
  });
  it("does not introduce any Stripe SDK / email / SMS call (presentation only)", () => {
    expect(CARD).not.toMatch(/@stripe\/|paymentIntents\.|refunds\.|lib\/email\/|lib\/sms\/|twilio/i);
  });
});
