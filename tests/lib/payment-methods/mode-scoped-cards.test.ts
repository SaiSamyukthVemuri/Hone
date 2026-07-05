import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Post-live-billing cosmetic/mode-drift cleanup. Pins:
//   1. the consent-template label rename (no more "(deferred)")
//   2. the Settings → Payments readiness copy separating booking-time card
//      collection (off) from portal card-on-file (available)
//   3. the mode line never renders as an incomplete/grey task in live mode
//   4. getActiveCardForStudioClient is mode-scoped (a test card is never
//      displayed as active while the runtime is live)
//   5. the webhook card pre-flip is mode-scoped (saving a live card does not
//      retire the test card row, and vice versa)

function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}

describe("1) consent template label", () => {
  it('card_authorization label is "Card-on-file authorization" (no "(deferred)")', () => {
    const src = read("app/(app)/settings/consent/ConsentTemplatesEditor.tsx");
    expect(src).toMatch(/card_authorization: "Card-on-file authorization"/);
    expect(src).not.toMatch(/Card on file \(deferred\)/);
  });
});

describe("2+3) Settings → Payments readiness copy", () => {
  const src = read("app/(app)/settings/payments/PaymentsSettings.tsx");

  it("separates booking-time collection (off) from portal card-on-file (available)", () => {
    expect(src).toMatch(/Public booking does not collect cards from clients/);
    expect(src).toMatch(/Card-on-file is\s*\n?\s*available through the client portal/);
    expect(src).toMatch(/Booking collection off/);
    expect(src).toMatch(/Booking-time card collection not enabled \(portal card-on-file is separate and available\)/);
    // The old conflated line is gone.
    expect(src).not.toMatch(/Card collection is not enabled yet\. No cards are being collected\./);
  });

  it("the mode line is informational — never a grey unfinished task in live mode", () => {
    // ok is unconditional; the label flips by mode.
    expect(src).toMatch(/<ReadinessItem\s+ok\s+okLabel=\{/);
    expect(src).toMatch(
      /isTestMode \? "Test mode — no live charges" : "Live mode enabled"/,
    );
    // The old shape (check-state tied to isTestMode) rendered "Live mode
    // enabled" as grey once the runtime went live.
    expect(src).not.toMatch(/ok=\{isTestMode\}/);
  });
});

describe("4) getActiveCardForStudioClient is mode-scoped", () => {
  it('filters by .eq("stripe_livemode", inferStripeLivemode())', () => {
    const src = read("lib/payment-methods/queries.ts");
    const block = src.slice(src.indexOf('.from("client_payment_methods")'));
    expect(block).toMatch(/\.eq\("stripe_livemode", inferStripeLivemode\(\)\)/);
    expect(src).toMatch(/import \{ inferStripeLivemode \} from "@\/lib\/stripe\/server"/);
  });
});

describe("5) webhook card pre-flip is mode-scoped", () => {
  it("the removed-status pre-flip filters by the event's mode (ctx.livemode)", () => {
    const src = read("app/api/stripe/webhook/route.ts");
    const flip = src.slice(
      src.indexOf('.update({ status: "removed", removed_at: nowIso })'),
    );
    const chain = flip.slice(0, flip.indexOf(";"));
    expect(chain).toMatch(/\.eq\("stripe_livemode", ctx\.livemode\)/);
    expect(chain).toMatch(/\.eq\("status", "active"\)/);
  });

  it("the pre-flip never uses a hardcoded mode literal", () => {
    const src = read("app/api/stripe/webhook/route.ts");
    expect(src).not.toMatch(/\.eq\("stripe_livemode", (true|false)\)/);
  });
});
