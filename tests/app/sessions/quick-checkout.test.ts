import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Quick checkout — contract + security + reuse guards. The behaviour of the
// underlying payment path is already covered by the session-payment action/UI
// tests; these lock that quick checkout is a THIN caller that (a) reuses the
// existing eligibility + actions unchanged, (b) trusts no client-supplied
// payment state, and (c) never touches clinical/charting state. The full
// eligibility-seed browser E2E is deferred (see PR notes) pending the shared
// payment seed harness.

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const RESOLVER = read("lib/billing/quick-checkout.ts");
const ACTION = read("app/(app)/quick-checkout-actions.ts");
const MODAL = read("components/quick-checkout-modal.tsx");
const BUTTON = read("components/checkout-button.tsx");
const CAL = read("app/(app)/calendar/[id]/page.tsx");

describe("resolver reuses the existing eligibility + amount path (no duplicated payment logic)", () => {
  it("delegates to getSessionPaymentEligibility + resolveSessionPaymentDefault", () => {
    expect(RESOLVER).toMatch(/getSessionPaymentEligibility\(\{/);
    expect(RESOLVER).toMatch(/resolveSessionPaymentDefault\(/);
  });
  it("is session-scoped: requires a session for the appointment, else returns an ineligible reason", () => {
    expect(RESOLVER).toMatch(/from\("sessions"\)/);
    expect(RESOLVER).toMatch(/No treatment session for this appointment yet/);
  });
  it("reads the appointment studio-scoped (no client-supplied studio/amount/status trusted)", () => {
    expect(RESOLVER).toMatch(/\.eq\("studio_id", args\.studioId\)/);
    expect(RESOLVER).toMatch(/\.eq\("id", args\.appointmentId\)/);
    expect(RESOLVER).toMatch(/Appointment not found in this studio/);
  });
  it("never charges, writes, or mutates — read-only resolution", () => {
    expect(RESOLVER).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
    expect(RESOLVER).not.toMatch(/@stripe\/|paymentIntents\.|charges\.|refunds\./);
  });
});

describe("action derives auth server-side (no client trust)", () => {
  it("resolves practitioner + studio from getCurrentPractitionerWithStudio", () => {
    expect(ACTION).toMatch(/getCurrentPractitionerWithStudio\(\)/);
    expect(ACTION).toMatch(/studioId: studio\.id/);
    expect(ACTION).toMatch(/isOwner: practitioner\.role === "owner"/);
  });
  it("passes only the appointment id from the client; studio is server-derived", () => {
    expect(ACTION).toMatch(/appointmentId: typeof appointmentId === "string"/);
    // studioId comes from the resolved studio, never from the client argument.
    expect(ACTION).not.toMatch(/studioId:\s*appointmentId/);
    expect(ACTION).toMatch(/studioId: studio\.id/);
  });
});

describe("modal reuses the existing card + actions (single hardened payment path)", () => {
  it("renders the existing SessionPaymentPrepareCard, not a new charge flow", () => {
    expect(MODAL).toMatch(/<SessionPaymentPrepareCard/);
    // The same four hardened server actions are passed through unchanged.
    for (const a of [
      "prepareSessionPaymentChargeAction",
      "executeSessionPaymentChargeAction",
      "sendPaymentChargeReceiptAction",
      "refundPaymentChargeAttemptAction",
    ]) {
      expect(MODAL).toMatch(new RegExp(a));
    }
  });
  it("does NOT reimplement any Stripe / charge / refund logic", () => {
    expect(MODAL).not.toMatch(/@stripe\/|paymentIntents\.|charges\.|refunds\.|amount_cents/);
  });
  it("re-reads trusted server state on open (local state is never authoritative)", () => {
    expect(MODAL).toMatch(/getQuickCheckoutContextAction\(appointmentId\)/);
    expect(MODAL).toMatch(/if \(!open\) return/);
  });
  it("is charting-independent: closes to finish charting later, never finalizes", () => {
    expect(MODAL).toMatch(/finish charting later/);
    expect(MODAL).not.toMatch(/finaliz|record_status|markAppointmentComplete|session_block/i);
  });
  it("is an accessible dialog (role, aria-modal, labelled, esc, 44px close)", () => {
    expect(MODAL).toMatch(/role="dialog"/);
    expect(MODAL).toMatch(/aria-modal="true"/);
    expect(MODAL).toMatch(/aria-labelledby=/);
    expect(MODAL).toMatch(/e\.key === "Escape"/);
    expect(MODAL).toMatch(/h-11 w-11/);
  });
  it("shows the ineligible reason + a link into the existing charting workflow", () => {
    expect(MODAL).toMatch(/quick-checkout-ineligible/);
    expect(MODAL).toMatch(/\/clients\/\$\{ctx\.clientId\}/);
  });
});

describe("entry point is completed-appointment only", () => {
  it("the button renders only for completed appointments", () => {
    expect(BUTTON).toMatch(/if \(status !== "completed"\) return null/);
    expect(BUTTON).toMatch(/data-testid="checkout-button"/);
    expect(BUTTON).toMatch(/min-h-\[44px\]/);
  });
  it("the calendar appointment detail wires Checkout for completed appointments", () => {
    expect(CAL).toMatch(/<CheckoutButton/);
    expect(CAL).toMatch(/typedStatus === "completed"/);
  });
  it("there is a single checkout flow (calendar reuses the shared component)", () => {
    // No second bespoke checkout modal/flow in calendar code.
    expect(CAL).not.toMatch(/prepareSessionPaymentChargeAction|executeSessionPaymentChargeAction/);
  });
});
