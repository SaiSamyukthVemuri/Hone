import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PRICING_PLANS, CURRENCY } from "@/lib/marketing/content";

// Pricing page guards: CAD everywhere, three honest plans, no artificial
// feature restrictions / caps / quotas, no unsupported annual, no self-service
// checkout, no multi-location or Google Calendar claims, no stale $19 pilot.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

const RAW = read("app/pricing/page.tsx");
const PAGE = stripComments(RAW).replace(/\s+/g, " ");

describe("pricing: CAD + three plans", () => {
  it("declares CAD and the three plans in the shared source of truth", () => {
    expect(CURRENCY).toBe("CAD");
    const ids = PRICING_PLANS.map((p) => p.id);
    expect(ids).toEqual(["founding-solo", "solo", "studio"]);
  });

  it("renders the plans from the shared constants + metadata helper", () => {
    expect(PAGE).toMatch(/PRICING_PLANS/);
    expect(PAGE).toMatch(/marketingMetadata\("\/pricing"\)/);
  });

  it("shows the founding transition + Studio seats + guided onboarding", () => {
    expect(PAGE).toMatch(/CAD \$29/);
    expect(PAGE).toMatch(/CAD \$39/);
    expect(PAGE).toMatch(/CAD \$49/);
    expect(PAGE).toMatch(/CAD \$99/);
    expect(PAGE).toMatch(/first 12 months/);
    expect(PAGE).toMatch(/up to three practitioners/);
    expect(PAGE).toMatch(/Studio setup is completed through guided onboarding/);
  });

  it("has exactly one H1 (Display) and a visible FAQ", () => {
    expect((RAW.match(/<Display\b/g) ?? []).length).toBe(1);
    expect(PAGE).toMatch(/FAQ\.map/);
    expect(PAGE).toMatch(/Pricing questions, answered\./);
  });

  it("carries the payment qualifier and the conditional replaces statement", () => {
    expect(PAGE).toMatch(/PAYMENT_QUALIFIER/);
    expect(PAGE).toMatch(/REPLACES_STATEMENT/);
  });
});

describe("pricing: no forbidden pricing claims", () => {
  it("drops the $19 pilot / $149 annual / early-access framing", () => {
    expect(PAGE).not.toMatch(/\$19\b/);
    expect(PAGE).not.toMatch(/\$149/);
    expect(PAGE).not.toMatch(/founding pilot/i);
    expect(PAGE).not.toMatch(/early access/i);
    expect(PAGE).not.toMatch(/\bpilot\b/i);
    expect(PAGE).not.toMatch(/founding annual|\$\d+\s*(per|\/)\s*year/i);
  });

  it("makes no caps/quotas, multi-location, or named-competitor absolute claim", () => {
    expect(PAGE).not.toMatch(/appointment (cap|limit)|client (cap|limit)|SMS (quota|limit)/i);
    expect(PAGE).not.toMatch(/multi.?location/i);
    expect(PAGE).not.toMatch(/Calendly|Square Appointments/i);
    expect(PAGE).not.toMatch(/Jane/); // no absolute "replaces Jane"
  });

  it("never markets Google Calendar", () => {
    expect(PAGE).not.toMatch(/google calendar/i);
    expect(PAGE).not.toMatch(/calendar sync/i);
  });

  it("does not imply self-service live-payment activation", () => {
    // The page truthfully says setup is guided; it must not claim self-serve activation.
    expect(PAGE).not.toMatch(/turn on (live )?payments yourself|activate payments yourself/i);
  });
});
