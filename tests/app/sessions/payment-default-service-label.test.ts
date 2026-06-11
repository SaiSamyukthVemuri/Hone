import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR #202: the booked service name renders clearly near the Amount
// field whenever the payment default resolved (service price OR
// client custom pricing), so the practitioner sees why that amount
// loaded. UI/copy only: no defaulting-logic, action, executor, or
// gate change.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const CARD = read("components/session-payment-prepare-card.tsx");

describe("booked service label near the amount (PR #202)", () => {
  // The block between the amount input and the internal-note field.
  const region = CARD.slice(
    CARD.indexOf('name="amount_dollars"'),
    CARD.indexOf('name="internal_note"'),
  );

  it("service-price default shows the booked service name near the amount", () => {
    expect(region).toMatch(/Booked service: \{defaultAmount\.serviceName\}/);
    // It renders ABOVE the source copy, inside the same label block.
    expect(region.indexOf("Booked service:")).toBeLessThan(
      region.indexOf("Defaulted from booked service."),
    );
  });

  it("custom-pricing default shows the service name AND the custom pricing reminder", () => {
    // The service label line sits outside the source ternary, so it
    // renders for BOTH sources; the reminder stays custom-only.
    const labelIdx = region.indexOf("Booked service:");
    const ternaryIdx = region.indexOf('defaultAmount.source === "custom_pricing"');
    expect(labelIdx).toBeGreaterThan(-1);
    expect(labelIdx).toBeLessThan(ternaryIdx);
    expect(region).toMatch(/Custom pricing reminder: \{defaultAmount\.customPricingNote\}/);
  });

  it("no service label renders when no default resolved (no fake label)", () => {
    // The entire block is gated on a resolved default; an unlinked
    // or unpriced session has defaultAmount === null.
    expect(region).toMatch(/\{defaultAmount != null && \(/);
    const before = region.slice(0, region.indexOf("{defaultAmount != null && ("));
    expect(before).not.toMatch(/Booked service:/);
  });

  it("the amount stays editable and the adjust copy remains", () => {
    expect(region).toMatch(/defaultValue=\{suggestedAmount\}/);
    expect(region).not.toMatch(/readOnly|disabled/);
    expect(region).toMatch(/You can adjust before preparing\./);
  });
});

describe("safety: display-only change", () => {
  it("prepare/refund actions and the executor are untouched by the label", () => {
    const actions = read(
      "app/(app)/clients/[id]/sessions/[sessionId]/payment-actions.ts",
    );
    const executor = read("lib/billing/session-payment-charge.ts");
    const resolver = read("lib/billing/session-payment-default-amount.ts");
    expect(actions).not.toMatch(/Booked service:/);
    expect(executor).not.toMatch(/Booked service:/);
    // The defaulting logic itself is unchanged: still a pure module
    // with no imports.
    expect(resolver).not.toMatch(/^import /m);
  });
});
