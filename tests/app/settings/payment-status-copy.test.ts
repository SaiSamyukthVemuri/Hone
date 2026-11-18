import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR A of the app-wide smart-payment-status plan: practitioner surfaces
// derive payment copy from the shared presenter instead of making static
// claims. The presenter's own copy and derivation are proved in
// tests/lib/payments/payment-status-presenter.test.ts. This suite pins:
//   * the banned stale strings are GONE from the PR-A surfaces
//   * the mode row keys off the RUNTIME, never the nullable row
//   * a failed read degrades to unknown; manual fees are never automatic
//   * public booking stays card-free; getting-started counts are mode-scoped

function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}

const PRA_SURFACES = [
  "app/(app)/settings/payments/PaymentsSettings.tsx",
  "app/(app)/settings/payments/PaymentsView.tsx",
  "app/(app)/settings/launch/page.tsx",
  "app/(app)/settings/studio/PolicySettingsForm.tsx",
  "lib/onboarding/getting-started.ts",
  "app/(app)/getting-started/page.tsx",
];

describe("banned stale claims are gone from PR-A surfaces", () => {
  const BANNED: Array<[string, RegExp]> = [
    ["client payments are not enabled", /Client payments are not enabled/i],
    ["future update", /future update/i],
    ["when card-on-file becomes available", /[Ww]hen card-on-file becomes available/],
    ["live payments remain off/disabled", /Live payments (remain|are) (off|disabled)\.(?!.*environment)/],
    ["card-on-file is not enabled", /Card-on-file is not enabled/],
    ["no cards are collected yet", /No cards are collected yet/],
  ];
  for (const file of PRA_SURFACES) {
    it(`${file} makes no banned static claim`, () => {
      const src = read(file);
      for (const [name, re] of BANNED) {
        expect(src, `${file} still contains banned claim: ${name}`).not.toMatch(re);
      }
    });
  }
});

describe("Settings → Payments stays truthful", () => {
  const page = read("app/(app)/settings/payments/PaymentsView.tsx");
  const component = read("app/(app)/settings/payments/PaymentsSettings.tsx");

  it("the read-error path degrades to 'unknown', never an all-clear", () => {
    expect(page).toMatch(/error\s*\n?\s*\? undefined/);
  });

  it("the mode readiness row keys off the RUNTIME (row-null bug fixed)", () => {
    expect(component).toMatch(/const isTestMode = runtimeMode !== "live"/);
    expect(component).not.toMatch(/const isTestMode = livemode !== true/);
    // Test-branch copy stays available for test runtime.
    expect(component).toMatch(/Test mode: no live charges/);
  });

  it("manual-fee posture: configuration only, never automatic; fee card keeps 'Money is not charged here'", () => {
    expect(component).toMatch(/money\s*\n?\s*is never charged automatically/);
    expect(component).toMatch(/run manual fees only if explicitly approved/i);
    expect(read("app/(app)/settings/payments/FeeAmountsCard.tsx")).toMatch(
      /Money is not charged here\./,
    );
  });
});

describe("public booking stays card-free", () => {
  it("public booking still confirms no payment was collected and adds no card step", () => {
    const src = read("app/book/[slug]/PublicBookForm.tsx");
    expect(src).toMatch(/No payment was collected for this booking\./);
    expect(src).not.toMatch(/loadStripe|Elements|card number/i);
  });
});

describe("getting-started payments copy is mode-aware", () => {
  it("lib builder: mode-scoped count + runtime-derived items (no unscoped count)", () => {
    const src = read("lib/onboarding/getting-started.ts");
    const block = src.slice(src.indexOf('.from("payment_charge_attempts")'));
    expect(block.slice(0, 300)).toMatch(/\.eq\("stripe_livemode", inferStripeLivemode\(\)\)/);
    expect(src).toMatch(/runtimeLivemode/);
    expect(src).not.toMatch(/Willow Stripe live checklist pending/);
    expect(src).not.toMatch(/Legal\/accounting review pending/);
  });
});
