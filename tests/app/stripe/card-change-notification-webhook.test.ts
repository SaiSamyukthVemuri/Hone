import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Structural proof that the card-change notification is wired into the
// setup_intent.succeeded arm ONLY on the paths where a card was actually
// persisted, and NEVER on the live-mode dormancy guard or any lineage
// rejection (so a cross-studio / forged / live-mode event produces no
// notification — Tests 6 & 7). Behavioral content + dedupe are proven by the
// content unit test + the .db.test.ts.

const ROUTE = readFileSync(
  join(process.cwd(), "app/api/stripe/webhook/route.ts"),
  "utf8",
);

// Isolate the setup_intent.succeeded handler body.
const HANDLER_START = ROUTE.indexOf("async function handleSetupIntentSucceeded");
const HANDLER = ROUTE.slice(HANDLER_START);
// The FIRST notify is the step-5 idempotency branch (card already persisted by
// a prior delivery of this event). The LAST notify is the fresh-insert path.
const FIRST_NOTIFY = HANDLER.indexOf("ensureCardChangeNotification(admin,");
const LAST_NOTIFY = HANDLER.lastIndexOf("ensureCardChangeNotification(admin,");
const BEFORE_FIRST_NOTIFY = HANDLER.slice(0, FIRST_NOTIFY);
const BEFORE_LAST_NOTIFY = HANDLER.slice(0, LAST_NOTIFY);
const AFTER_LAST_NOTIFY = HANDLER.slice(LAST_NOTIFY);

describe("card-change notification webhook wiring", () => {
  it("imports the durable orchestration (not the fire-and-forget recorder)", () => {
    expect(ROUTE).toMatch(
      /import \{ ensureCardChangeNotification \} from "@\/lib\/billing\/card-change-notification";/,
    );
    // The webhook must NOT use the fire-and-forget recorder for card events.
    expect(ROUTE).not.toMatch(/recordPractitionerNotification/);
  });

  it("is called (awaited) in exactly the three card-persisted branches", () => {
    const calls = HANDLER.match(/await ensureCardChangeNotification\(admin,/g) ?? [];
    expect(calls.length).toBe(3);
  });

  it("the live-mode dormancy guard + cross-studio/forged rejections return BEFORE ANY notification (Tests 6 & 7)", () => {
    // Every security-critical guard — the live-mode dormancy guard and the
    // studio/account/customer/signature lineage rejections — returns before the
    // FIRST notify. So an ignored live event or a forged/cross-studio event
    // never reaches any notification call.
    for (const guard of [
      "shouldIgnoreLiveModeEvent",
      "livemodeEventIgnored: true",
      'rejected: "missing_metadata"',
      'rejected: "missing_account_context"',
      'rejected: "studio_metadata_mismatch"',
      'rejected: "missing_customer"',
      'rejected: "customer_lineage_mismatch"',
      'rejected: "signature_lineage_mismatch"',
    ]) {
      expect(BEFORE_FIRST_NOTIFY).toContain(guard);
    }
  });

  it("the payment-method quality rejections return before the FRESH-insert notify", () => {
    // A missing / non-card PaymentMethod returns before the fresh insert +
    // notify (and it cannot have persisted a card, so the step-5 re-delivery
    // notify is unreachable for it). No card => no notification.
    for (const rejection of [
      'rejected: "missing_payment_method"',
      'rejected: "non_card_payment_method"',
    ]) {
      expect(BEFORE_LAST_NOTIFY).toContain(rejection);
    }
    // Nothing rejects AFTER the fresh-path notify — it is the last step before
    // the success return.
    expect(AFTER_LAST_NOTIFY).not.toContain('rejected: "');
  });

  it("preserves the existing card write + analytics (unchanged behavior)", () => {
    // Pre-flip retire (mode-scoped) + insert still present.
    expect(HANDLER).toMatch(/\.update\(\{ status: "removed", removed_at: nowIso \}\)/);
    expect(HANDLER).toMatch(/\.from\("client_payment_methods"\)\s*\n\s*\.insert\(\{/);
    // The card_on_file_saved analytics event still fires, and BEFORE the
    // fresh-path notification (so a notification failure cannot suppress it).
    const analyticsIdx = HANDLER.indexOf('event: "card_on_file_saved"');
    expect(analyticsIdx).toBeGreaterThan(-1);
    const freshNotifyIdx = HANDLER.lastIndexOf("await ensureCardChangeNotification(admin,");
    expect(analyticsIdx).toBeLessThan(freshNotifyIdx);
  });

  it("does not wire card notifications into the money / account handlers", () => {
    // account.updated / capability.updated / payment_intent / charge arms must
    // not emit a card-change notification.
    const moneyRegion = ROUTE.slice(
      ROUTE.indexOf('case "account.updated"'),
      ROUTE.indexOf('case "setup_intent.succeeded"'),
    );
    expect(moneyRegion).not.toContain("ensureCardChangeNotification");
  });
});
