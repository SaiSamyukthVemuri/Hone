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
    expect(src).toMatch(/\{isOwner && sessionPaymentEligibility && \(\s*<div id="session-payment">/);
  });
});

describe("session page loaders (Privacy PEER-1140 L3): the payment reads run for the owner alone", () => {
  const src = read("app/(app)/clients/[id]/sessions/[sessionId]/page.tsx");
  it("eligibility, amount and settlement are each behind the owner check, resolving to null otherwise", () => {
    expect(src).toMatch(/const isOwner = practitioner\.role === "owner";/);
    expect(src).toMatch(/isOwner\s*\?\s*timed\("session-chart\.payment-eligibility"[\s\S]*?:\s*Promise\.resolve\(null\)/);
    expect(src).toMatch(/isOwner\s*\?\s*timed\("session-chart\.payment-amount"[\s\S]*?:\s*Promise\.resolve\(null\)/);
    expect(src).toMatch(/isOwner && linkedAppointmentId\s*\?\s*timed\("session-chart\.settlements"/);
  });
  it("the card renders only with the owner flag AND the loaded eligibility", () => {
    expect(src).toMatch(/\{isOwner && sessionPaymentEligibility && \(\s*<div id="session-payment">/);
  });
});

describe("appointment next step (Privacy PEER-1140 L2): a non-owner is not sent to billing", () => {
  const src = read("app/(app)/calendar/[id]/page.tsx");
  it("the billing deep link needs the owner; otherwise the CTA opens the session", () => {
    expect(src).toMatch(/\} else if \(!sessionStarted \|\| !isOwner\) \{\s*ctaHref = `\/clients\/\$\{clientId\}\/sessions\/\$\{sessionId\}`;\s*ctaLabel = "Open session";/);
    expect(src).toMatch(/<NextStepCard[^>]*isOwner=\{isOwner\}/s);
    expect(src).toContain("The studio owner takes payment.");
  });
});

describe("pinned cautions (Privacy PEER-1140 L1): the card gets the viewer and withdraws controls that would be refused", () => {
  it("the client page passes the server-derived viewer", () => {
    expect(read("app/(app)/clients/[id]/page.tsx")).toMatch(
      /viewer=\{\{ isOwner: practitioner\.role === "owner", practitionerId: practitioner\.id \}\}/,
    );
  });
  it("Edit and Remove are each behind pinnedNotePermissions", () => {
    const card = read("components/client-pinned-notes-card.tsx");
    expect(card).toMatch(/pinnedNotePermissions\(n, viewer\)\.canEdit && \(/);
    expect(card).toMatch(/pinnedNotePermissions\(n, viewer\)\.canRemove && \(/);
  });
});

describe("the unreachable non-owner branches inside the payment card are KEPT as a second render gate", () => {
  it("the owner-only amount hint is the non-owner branch of the final-charge field", () => {
    const card = read("components/session-payment-prepare-card.tsx");
    expect(card).toContain('data-testid="owner-only-amount-hint"');
    expect(card).toMatch(/isOwner = false,/); // the prop defaults CLOSED
  });
  it("TechnicalPaymentDetails renders nothing for a non-owner, whatever it is given", () => {
    expect(read("components/payment/technical-payment-details.tsx")).toMatch(/if \(!isOwner\) return null;/);
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
