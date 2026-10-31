import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// HON-11 (FLOW-03), step inventory. A SOURCE CONTRACT, not a behaviour test: it
// pins what today's checkout asks of the practitioner, so the Chloe measurement
// is taken against a known baseline and a later repair can be shown to have
// removed steps and nothing else. It changes no behaviour.
//
// Counting rule: a STEP is one tap or one value the practitioner must supply
// on the shortest successful path, for an owner with the appointment already
// completed. Reading a screen is not a step. Optional fields are listed but not
// counted. Settlement here is owner-only (HON-44).

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

const ENTRY = "components/checkout-button.tsx";
const MODAL = "components/quick-checkout-modal.tsx";
const CARD = "components/session-payment-prepare-card.tsx";
const SETTLE = "components/appointment-settlement-controls.tsx";
const COMPLETE = "components/appointment/mark-complete-control.tsx";
const CTX = "app/(app)/quick-checkout-actions.ts";
const DRAWER = "app/(app)/calendar/QuickBookDrawer.tsx";

type Step = { path: "card" | "external"; kind: "tap" | "value"; mandatory: boolean; what: string; file: string; marker: string };

// The shortest successful paths, in order.
const STEPS: Step[] = [
  { path: "card", kind: "tap", mandatory: true, what: "Checkout (opens the modal)", file: ENTRY, marker: 'data-testid="checkout-button"' },
  { path: "card", kind: "tap", mandatory: true, what: "Prepare session payment (creates the attempt; no charge)", file: CARD, marker: "Prepare session payment" },
  { path: "card", kind: "value", mandatory: false, what: "Final charge (prefilled with the booked price)", file: CARD, marker: 'data-testid="final-charge-input"' },
  { path: "card", kind: "value", mandatory: false, what: "Internal note", file: CARD, marker: 'name="internal_note"' },
  { path: "card", kind: "tap", mandatory: true, what: "Run charge (arms the confirmation)", file: CARD, marker: '"Run charge"' },
  { path: "card", kind: "tap", mandatory: true, what: "Confirm: run charge", file: CARD, marker: "Confirm: run charge" },
  { path: "card", kind: "tap", mandatory: false, what: "Send receipt", file: CARD, marker: '"Send receipt"' },
  { path: "card", kind: "tap", mandatory: true, what: "Close the modal", file: MODAL, marker: 'data-testid="quick-checkout-close"' },
  { path: "external", kind: "tap", mandatory: true, what: "Checkout (opens the modal)", file: ENTRY, marker: 'data-testid="checkout-button"' },
  { path: "external", kind: "tap", mandatory: true, what: "Choose the method (cash, e-transfer, another way, still owes; owner also waive)", file: SETTLE, marker: "data-testid={`settlement-open-${m}`}" },
  { path: "external", kind: "value", mandatory: false, what: "Amount (prefilled with the booked price)", file: SETTLE, marker: 'data-testid="settlement-amount"' },
  { path: "external", kind: "value", mandatory: false, what: "Note", file: SETTLE, marker: 'data-testid="settlement-note"' },
  { path: "external", kind: "tap", mandatory: true, what: "Record (confirms the attestation)", file: SETTLE, marker: "data-testid={`settlement-confirm-${open}`}" },
  { path: "external", kind: "tap", mandatory: true, what: "Close the modal", file: MODAL, marker: 'data-testid="quick-checkout-close"' },
];

const count = (p: Step["path"], kind: Step["kind"], mandatory: boolean) =>
  STEPS.filter((s) => s.path === p && s.kind === kind && s.mandatory === mandatory).length;

describe("HON-11 checkout step inventory", () => {
  it("every inventoried step still exists in the source it names", () => {
    for (const s of STEPS) {
      expect(read(s.file), `${s.path}: ${s.what}`).toContain(s.marker);
    }
  });

  it("the shortest card path is 5 taps and no required value; external is 4 taps and no required value", () => {
    expect(count("card", "tap", true)).toBe(5);
    expect(count("card", "value", true)).toBe(0);
    expect(count("external", "tap", true)).toBe(4);
    expect(count("external", "value", true)).toBe(0);
  });

  it("completing the visit first costs 2 taps (button, then the confirmation dialog)", () => {
    const src = read(COMPLETE);
    expect(src).toContain('data-testid="mark-appointment-complete"');
    expect(src).toContain("<ConfirmDialog");
    expect(src).toContain("No payment is taken.");
  });

  it("the card path is two phases by design: prepare writes an attempt, the charge needs an armed second tap", () => {
    const src = read(CARD);
    expect(src).toContain("This prepares a row only. No PaymentIntent. No charge. No receipt.");
    expect(src).toMatch(/if \(!confirmExecute\) \{\s*setConfirmExecute\(true\);\s*return;\s*\}/);
    expect(src).toContain('fd.set("confirm_charge", "true")');
  });

  it("an unchanged price needs no reason; a changed price needs one (owner)", () => {
    const src = read(CARD);
    expect(src).toMatch(/differsFromReference &&\s*\(isOwner/);
    expect(src).toContain('name="adjustment_reason"');
    expect(src).toMatch(/name="adjustment_reason"[\s\S]{0,200}required/);
    // the note is optional
    expect(src).not.toMatch(/name="internal_note"[^>]*required/);
  });

  it("settlement offers four practitioner methods plus owner-only waive, and the amount is prefilled", () => {
    const src = read(SETTLE);
    expect(src).toContain("...PRACTITIONER_METHODS");
    expect(src).toContain('[...PRACTITIONER_METHODS, "waived"]');
    expect(src).toContain("(defaultAmountCents / 100).toFixed(2)");
    expect(read("lib/billing/settlement-types.ts")).toMatch(/PRACTITIONER_METHODS = \[\s*"paid_cash",\s*"paid_e_transfer",\s*"paid_other_external",\s*"still_owes",\s*\] as const/);
  });

  it("settlement controls are withheld once Hone holds card money, and checkout is owner-only", () => {
    expect(read(CARD)).toMatch(/appointmentId && canRecordSettlement && !cardMoneyHeld/);
    expect(read(CTX)).toContain('practitioner.role !== "owner"');
  });

  it("the modal stays open after a recorded outcome or a charge: closing is its own tap", () => {
    const src = read(MODAL);
    expect(src).not.toMatch(/onRecorded=\{[^}]*onClose/);
    expect(src).not.toMatch(/withRefresh[\s\S]{0,300}onClose\(\)/);
  });

  it("rebooking is NOT part of the checkout flow today: no rebook link in the modal, card or settlement controls", () => {
    for (const f of [MODAL, CARD, SETTLE, ENTRY]) {
      expect(read(f).toLowerCase(), f).not.toMatch(/rebook|quickbook|book again/);
    }
    // it lives in the calendar drawer, behind a client search and a service choice
    expect(read(DRAWER)).toContain("Rebook last service?");
    expect(read(DRAWER)).toContain("Book appointment");
  });
});
