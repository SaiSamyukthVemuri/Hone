import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resolveSessionPaymentDefault } from "@/lib/billing/session-payment-default-amount";

// PR #200: Last Treatment warning placement + service price default.
//
// 1. The "From last visit, for today" Watch/Plan box renders as a
//    flush footer band INSIDE the Last treatment card (attached
//    variant), omitted cleanly when empty, never duplicated on the
//    Sessions tab.
// 2. The Session payment prepare form defaults its amount from the
//    booked service (client custom pricing wins over the menu price),
//    with source copy and the field still editable. Display default
//    only: no executor, gate, or Stripe-call change.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const PAGE = read("app/(app)/clients/[id]/page.tsx");
const SESSION_PAGE = read(
  "app/(app)/clients/[id]/sessions/[sessionId]/page.tsx",
);
const SUMMARY = read("components/last-session-summary.tsx");
const CARD = read("components/session-payment-prepare-card.tsx");
const RESOLVER = read("lib/billing/session-payment-default-amount.ts");

// ---------------------------------------------------------------------------
// 1. Watch/Plan box attached to the Last treatment card
// ---------------------------------------------------------------------------

describe("From last visit box is attached to the Last treatment card", () => {
  // The Sessions-tab card region: from the Last treatment heading to
  // the appointment timeline that follows the card.
  const headingIdx = PAGE.indexOf(">Last treatment</h2>");
  const cardRegion = PAGE.slice(
    headingIdx,
    PAGE.indexOf("<ClientAppointmentTimeline", headingIdx),
  );

  it("renders inside the card as a flush footer band (attached variant)", () => {
    expect(cardRegion).toMatch(
      /<FromLastVisitForToday[\s\S]{0,120}attached/,
    );
    // Full-bleed wrapper so the band touches the card's border.
    expect(cardRegion).toMatch(/-mx-5 -mb-5 mt-4/);
    // The attached variant is a top-bordered footer, not a floating
    // island: square top, rounded bottom, border-t only.
    expect(SUMMARY).toMatch(
      /attached\s*\?\s*"rounded-b-lg border-t border-amber-200/,
    );
  });

  it("appears after the area summaries and before the card closes", () => {
    const areas = cardRegion.indexOf("<AreaSummaries");
    const box = cardRegion.indexOf("<FromLastVisitForToday");
    expect(areas).toBeGreaterThan(-1);
    expect(box).toBeGreaterThan(areas);
  });

  it("is omitted cleanly when there is no watch/plan content", () => {
    // Host gate (no empty footer margins)...
    expect(cardRegion).toMatch(/hasFromLastVisitContent\(lastTreatmentSummary\)/);
    // ...and the component itself still returns null when empty.
    expect(SUMMARY).toMatch(
      /if \(!hasFromLastVisitContent\(summary\)\) \{\s*\n\s*return null;/,
    );
  });

  it("renders exactly once on the Sessions tab (no duplicate warning/plan box)", () => {
    const sessionsTab = PAGE.slice(
      PAGE.indexOf('{activeTab === "sessions"'),
      PAGE.indexOf('{activeTab === "treatment"'),
    );
    expect(sessionsTab.match(/<FromLastVisitForToday/g)?.length).toBe(1);
  });

  it("also renders for the legacy entries fallback, so a plan note is not dropped", () => {
    // The footer band sits OUTSIDE the areas/entries ternary: the
    // entries branch closes before the band renders.
    const entries = cardRegion.indexOf("<LastSessionEntries");
    const box = cardRegion.indexOf("<FromLastVisitForToday");
    expect(entries).toBeGreaterThan(-1);
    expect(box).toBeGreaterThan(entries);
  });

  it("old area-level caution data still feeds the Watch lines", () => {
    const helper = read("lib/sessions/clinical-summary.ts");
    expect(helper).toMatch(/caution_for_next_session/);
    expect(helper).toMatch(/watchLines/);
    expect(SUMMARY).toMatch(/Watch:<\/span>/);
    expect(SUMMARY).toMatch(/Plan:<\/span>/);
  });

  it("the other surfaces keep the standalone box (default variant unchanged)", () => {
    const newSession = read("app/(app)/clients/[id]/sessions/new/page.tsx");
    const calendar = read("app/(app)/calendar/[id]/page.tsx");
    expect(newSession).not.toMatch(/<FromLastVisitForToday[\s\S]{0,120}attached/);
    expect(calendar).not.toMatch(/<FromLastVisitForToday[\s\S]{0,120}attached/);
  });
});

// ---------------------------------------------------------------------------
// 2. Session payment default amount (pure resolver, behavioral)
// ---------------------------------------------------------------------------

const TODAY = "2026-06-12";

describe("resolveSessionPaymentDefault", () => {
  it("linked appointment with a service price defaults from the service", () => {
    const r = resolveSessionPaymentDefault({
      service: { name: "Electrolysis 60 min", price_cents: 12000 },
      appointmentDurationMinutes: 60,
      customPricing: [],
      today: TODAY,
    });
    expect(r).toEqual({
      amountCents: 12000,
      source: "service_price",
      serviceName: "Electrolysis 60 min",
      durationMinutes: 60,
      customPricingNote: null,
    });
  });

  it("no service or no service price keeps manual behavior (null)", () => {
    expect(
      resolveSessionPaymentDefault({
        service: null,
        appointmentDurationMinutes: 60,
        customPricing: [],
        today: TODAY,
      }),
    ).toBeNull();
    expect(
      resolveSessionPaymentDefault({
        service: { name: "Consult", price_cents: null },
        appointmentDurationMinutes: 30,
        customPricing: [],
        today: TODAY,
      }),
    ).toBeNull();
    expect(
      resolveSessionPaymentDefault({
        service: { name: "Consult", price_cents: 0 },
        appointmentDurationMinutes: 30,
        customPricing: [],
        today: TODAY,
      }),
    ).toBeNull();
  });

  it("client custom pricing for the same service name overrides the menu price", () => {
    const r = resolveSessionPaymentDefault({
      service: { name: "Electrolysis 60 min", price_cents: 12000 },
      appointmentDurationMinutes: 60,
      customPricing: [
        {
          service_name: "  electrolysis 60 MIN ",
          price_cents: 9500,
          notes: "Loyalty rate",
          effective_from: "2026-01-01",
        },
      ],
      today: TODAY,
    });
    expect(r?.source).toBe("custom_pricing");
    expect(r?.amountCents).toBe(9500);
    expect(r?.customPricingNote).toBe("Loyalty rate");
  });

  it("future-dated custom pricing is ignored; newest effective row wins", () => {
    const r = resolveSessionPaymentDefault({
      service: { name: "Electrolysis 60 min", price_cents: 12000 },
      appointmentDurationMinutes: 60,
      customPricing: [
        {
          service_name: "Electrolysis 60 min",
          price_cents: 8000,
          notes: null,
          effective_from: "2025-01-01",
        },
        {
          service_name: "Electrolysis 60 min",
          price_cents: 9000,
          notes: null,
          effective_from: "2026-06-01",
        },
        {
          service_name: "Electrolysis 60 min",
          price_cents: 7000,
          notes: null,
          effective_from: "2027-01-01",
        },
      ],
      today: TODAY,
    });
    expect(r?.amountCents).toBe(9000);
  });

  it("custom pricing for a DIFFERENT service does not apply", () => {
    const r = resolveSessionPaymentDefault({
      service: { name: "Electrolysis 60 min", price_cents: 12000 },
      appointmentDurationMinutes: 60,
      customPricing: [
        {
          service_name: "Electrolysis 30 min",
          price_cents: 6000,
          notes: null,
          effective_from: "2026-01-01",
        },
      ],
      today: TODAY,
    });
    expect(r?.source).toBe("service_price");
    expect(r?.amountCents).toBe(12000);
  });
});

describe("Session payment prepare form wiring", () => {
  it("the session page resolves the default from appointment + custom pricing and passes it down", () => {
    expect(SESSION_PAGE).toMatch(/resolveSessionPaymentDefault\(\{/);
    expect(SESSION_PAGE).toMatch(
      /services:service_id\(name, price_cents\)/,
    );
    expect(SESSION_PAGE).toMatch(/from\("client_pricing"\)/);
    expect(SESSION_PAGE).toMatch(/defaultAmount=\{sessionPaymentDefault\}/);
  });

  it("the default fills the amount field but the field stays editable", () => {
    expect(CARD).toMatch(
      /defaultAmount != null\s*\n?\s*\? formatCadFromCents\(defaultAmount\.amountCents\)/,
    );
    // Same plain text input; no readOnly/disabled on the amount.
    const amountInput = CARD.slice(
      CARD.indexOf('name="amount_dollars"') - 400,
      CARD.indexOf('name="amount_dollars"') + 400,
    );
    expect(amountInput).toMatch(/defaultValue=\{suggestedAmount\}/);
    expect(amountInput).not.toMatch(/readOnly|disabled/);
  });

  it("source copy: booked service label / custom pricing reminder / adjustable (PR #202 shape)", () => {
    // PR #202: the booked service name is a visible line of its own
    // near the amount, for both default sources.
    expect(CARD).toMatch(/Booked service: \{defaultAmount\.serviceName\}/);
    expect(CARD).toMatch(/Defaulted from booked service\./);
    expect(CARD).toMatch(/custom pricing\./);
    expect(CARD).toMatch(/Custom pricing reminder:/);
    expect(CARD).toMatch(/You can adjust before preparing\./);
  });

  it("falls back to the historical session price suggestion when no default", () => {
    expect(CARD).toMatch(/Suggestion from session price/);
    expect(CARD).toMatch(
      /defaultAmount == null &&\s*\n?\s*eligibility\.session\?\.pricePaidCents != null/,
    );
  });

  it("test-mode copy is unchanged and nothing implies the client paid", () => {
    expect(CARD).toMatch(
      /This prepares a test-mode payment record\. It does not charge the\s*\n?\s*client\./,
    );
    expect(CARD).not.toMatch(/already paid|payment received/i);
  });
});

describe("safety: defaulting is display-only", () => {
  it("the resolver imports nothing (pure) and never calls Stripe", () => {
    expect(RESOLVER).not.toMatch(/^import /m);
    expect(RESOLVER).not.toMatch(/require\(/);
    expect(RESOLVER).not.toMatch(/paymentIntents|stripeClient|getStripe/);
  });

  it("prepare/execute actions and the executor are untouched surfaces", () => {
    const actions = read(
      "app/(app)/clients/[id]/sessions/[sessionId]/payment-actions.ts",
    );
    expect(actions).not.toMatch(/resolveSessionPaymentDefault/);
    expect(
      existsSync(join(process.cwd(), "lib/billing/session-payment-charge.ts")),
    ).toBe(true);
    const executor = read("lib/billing/session-payment-charge.ts");
    expect(executor).not.toMatch(/resolveSessionPaymentDefault/);
  });

  it("the eligibility helper is unchanged by the defaulting path", () => {
    const eligibility = read("lib/billing/session-payment-eligibility.ts");
    expect(eligibility).not.toMatch(/resolveSessionPaymentDefault/);
  });
});
