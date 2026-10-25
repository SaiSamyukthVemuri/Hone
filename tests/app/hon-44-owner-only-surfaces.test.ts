import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// HON-44 / Sam decision 12. The server actions are the authority (see
// hon-44-owner-only-actions.test.ts); these pins hold the SURFACES: a non-owner
// is neither offered a control that would be refused nor made to run a financial
// read for a card that is not shown. Source contracts, like the repo's other
// page-level pins, because these pages are server components.

const read = (p: string) => readFileSync(path.resolve(__dirname, "../..", p), "utf8");

describe("dashboard roster", () => {
  const src = read("app/(app)/dashboard/page.tsx");
  it("never loads payment state for a non-owner", () => {
    expect(src).toMatch(
      /const paymentStatesPromise = settleLater\(\s*isOwner\s*\?\s*getAppointmentPaymentStates\([^)]*\)\s*:\s*Promise\.resolve\(new Map<string, AppointmentPaymentState>\(\)\)/,
    );
  });
  it("renders the checkout cell for the owner only, from a server-derived flag", () => {
    expect(src).toMatch(/const isOwner = practitioner\.role === "owner";/);
    expect(src).toMatch(/\{isOwner && \(\s*<AppointmentCheckoutCell/);
    expect(src).toMatch(/isOwner=\{isOwner\}/);
  });
});

describe("appointment detail page", () => {
  const src = read("app/(app)/calendar/[id]/page.tsx");
  it("loads the manual-fee eligibility only for the owner", () => {
    expect(src).toMatch(/const showManualFeeCard =\s*isOwner && \(data\.status === "cancelled" \|\| data\.status === "no_show"\);/);
  });
  it("loads checkout payment state and renders the Payment section only for the owner", () => {
    expect(src).toMatch(/const checkoutPaymentState =\s*isOwner && typedStatus === "completed"/);
    expect(src).toMatch(/\{isOwner && typedStatus === "completed" && \(/);
  });
});

describe("session page", () => {
  const src = read("app/(app)/clients/[id]/sessions/[sessionId]/page.tsx");
  it("withdraws the whole payment card from a non-owner", () => {
    expect(src).toMatch(/\{practitioner\.role === "owner" && \(\s*<div id="session-payment">/);
  });
});

describe("client page", () => {
  const src = read("app/(app)/clients/[id]/page.tsx");
  it("shows the add and delete price controls to the owner only", () => {
    expect(src).toMatch(/\{practitioner\.role === "owner" && \(\s*<form action=\{deleteClientPricingAction\}>/);
    expect(src).toMatch(/\{practitioner\.role === "owner" && \(\s*<div className="border-t[^"]*">\s*<AddPricingForm/);
  });
});

describe("every gated action derives the role from the authenticated practitioner, never the request", () => {
  const files = [
    "app/(app)/clients/[id]/sessions/[sessionId]/payment-actions.ts",
    "app/(app)/calendar/[id]/manual-fee-actions.ts",
    "app/(app)/appointment-settlement-actions.ts",
    "app/(app)/quick-checkout-actions.ts",
    "app/(app)/clients/[id]/sessions/[sessionId]/actions.ts",
    "app/(app)/clients/[id]/actions.ts",
    "app/(app)/clients/[id]/pinned-notes-actions.ts",
  ];
  it.each(files)("%s reads no owner or role field from FormData", (file) => {
    const src = read(file);
    expect(src).not.toMatch(/formData\.get\(["'](is_owner|isOwner|role|owner)["']\)/);
  });
});
