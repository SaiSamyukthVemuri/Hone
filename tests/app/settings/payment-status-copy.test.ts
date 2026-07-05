import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR A of the app-wide smart-payment-status plan: practitioner surfaces
// derive payment copy from the shared presenter instead of making static
// claims. This suite pins:
//   * the banned stale strings are GONE from the PR-A surfaces
//   * Settings → Payments renders the presenter banner (live-ready /
//     test-ready / payouts-warning all reachable via connectBannerCopy)
//   * the mode row + banner key off the RUNTIME, never the nullable row
//   * portal card-on-file + booking-collection copy come from the presenter
//   * getting-started + launch + policy surfaces no longer claim payments
//     are off / future

function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}

const PRA_SURFACES = [
  "app/(app)/settings/payments/PaymentsSettings.tsx",
  "app/(app)/settings/payments/page.tsx",
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

  it("live-ready presenter copy itself never contains banned strings (belt)", () => {
    const presenter = read("lib/payments/payment-status-presenter.ts");
    expect(presenter).not.toMatch(/future update/i);
    expect(presenter).not.toMatch(/becomes available/i);
    expect(presenter).not.toMatch(/Client payments are not enabled/i);
  });
});

describe("Settings → Payments is presenter-driven", () => {
  const page = read("app/(app)/settings/payments/page.tsx");
  const component = read("app/(app)/settings/payments/PaymentsSettings.tsx");

  it("page derives banner + portal + booking copy from the presenter", () => {
    expect(page).toMatch(/from "@\/lib\/payments\/payment-status-presenter"/);
    expect(page).toMatch(/connectBannerCopy\(runtimeMode, connect\)/);
    expect(page).toMatch(/derivePortalCardCapability\(/);
    expect(page).toMatch(/bookingCardCopy\(bookingCardCollection\(\)\)/);
    // Runtime mode from the deployment, not the row.
    expect(page).toMatch(/const runtimeMode = currentRuntimeMode\(\)/);
  });

  it("the read-error path degrades to 'unknown', never an all-clear", () => {
    expect(page).toMatch(/error\s*\n?\s*\? undefined/);
  });

  it("component renders the banner + messages as data (no static claims)", () => {
    expect(component).toMatch(/\{banner\.headline\}/);
    expect(component).toMatch(/\{banner\.detail\}/);
    expect(component).toMatch(/\{portalCardMessage\}/);
    expect(component).toMatch(/\{bookingCardMessage\}/);
    // The old row-derived test banner is gone.
    expect(component).not.toMatch(/showTestBanner/);
    expect(component).not.toMatch(/Test mode: not collecting payments/);
  });

  it("the mode readiness row keys off the RUNTIME (row-null bug fixed)", () => {
    expect(component).toMatch(/const isTestMode = runtimeMode !== "live"/);
    expect(component).not.toMatch(/const isTestMode = livemode !== true/);
    // Test-branch copy stays available for test runtime.
    expect(component).toMatch(/Test mode — no live charges/);
  });

  it("live-ready / test-ready / payouts-warning copy is exactly the approved wording (presenter source)", () => {
    const presenter = read("lib/payments/payment-status-presenter.ts");
    expect(presenter).toMatch(/Live payments are ready\./);
    expect(presenter).toMatch(
      /accept live payments through Hone after a client saves an authorized card on file/,
    );
    expect(presenter).toMatch(/Test payment setup is ready\./);
    expect(presenter).toMatch(/without moving real money/);
    expect(presenter).toMatch(
      /Charges may be enabled, but payouts are not ready\. Finish payout setup before charging clients\./,
    );
    expect(presenter).toMatch(
      /Portal card-on-file is available\. Clients can sign the card authorization and save a card in the client portal\./,
    );
    expect(presenter).toMatch(
      /Booking-time card collection is off\. Clients can still book without entering a card\./,
    );
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
