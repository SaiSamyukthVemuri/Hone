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

describe("5) card retire-on-replace is mode-scoped", () => {
  // OWNERSHIP MOVED IN 0180. The retire used to be a PostgREST .update() in the
  // webhook, paired with a separate .insert() — two transactions, so a failed
  // insert left the client with zero active cards. Both writes now live inside
  // save_client_card_on_file. The PROPERTY is unchanged and still load-bearing:
  // saving a LIVE card must never retire the client's TEST card, or vice versa.
  // Only the file that owns it changed.
  it("the command retires only the SAME-mode active card", () => {
    const sql = read("supabase/migrations/0180_card_payment_method_replacement_integrity.sql");
    const body = sql.slice(sql.indexOf("update public.client_payment_methods"));
    const stmt = body.slice(0, body.indexOf("returning"));
    expect(stmt).toMatch(/cpm\.stripe_livemode = p_stripe_livemode/);
    expect(stmt).toMatch(/cpm\.status = 'active'/);
  });

  it("the webhook passes the EVENT's mode into the command, never a literal", () => {
    const src = read("app/api/stripe/webhook/route.ts");
    const call = src.slice(src.indexOf('"save_client_card_on_file"'));
    const args = call.slice(0, call.indexOf("},"));
    expect(args).toMatch(/p_stripe_livemode: ctx\.livemode/);
    expect(src).not.toMatch(/\.eq\("stripe_livemode", (true|false)\)/);
    expect(args).not.toMatch(/p_stripe_livemode: (true|false)/);
  });
});
