import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #169. Pin the session-payment product model documented in
// docs/16 §12 + docs/02. Every assertion below is a load-
// bearing product decision; a future PR that contradicts one of
// them must either update the doc OR be the live-mode enablement
// PR that deliberately retires the constraint.
//
// These are docs-only tests. The runtime guards on the Stripe path
// live in tests/lib/billing/live-mode-blockers.test.ts (PR #168) and
// scripts/check-stripe-gates.mjs (tests/scripts/check-stripe-gates.test.ts).

function readDoc(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../..", rel), "utf8");
}

const READINESS = readDoc("docs/16_LIVE_PAYMENTS_READINESS.md");
const DOMAIN = readDoc("docs/02_DOMAIN_MODEL.md");

describe("docs/16 §12: session payment product model exists", () => {
  it("a §12 section was added for the session payment model (PR #169)", () => {
    expect(READINESS).toMatch(
      /## 12\.\s*Session payment product model \(PR #169\)/,
    );
  });

  it("§12 declares the charge-after-session decision explicitly", () => {
    // Section 12.1 is the load-bearing v1 product decision. The
    // phrasing must remain unambiguous: charge AFTER, not at
    // booking.
    expect(READINESS).toMatch(/12\.1[\s\S]{0,200}[Cc]harge after session/);
    expect(READINESS).toMatch(/charge AFTER the session, with a practitioner-confirmed amount/i);
  });

  it("§12 enumerates the three and only three canonical charge reasons", () => {
    // The product supports exactly three reasons. A future PR that
    // tries to silently add a fourth (deposit, package, gift card)
    // must update this enumeration and the doc.
    expect(READINESS).toMatch(/session_payment/);
    expect(READINESS).toMatch(/late_cancellation_fee/);
    expect(READINESS).toMatch(/no_show_fee/);
  });
});

describe("docs/16 §12.3: one charge primitive, not parallel implementations", () => {
  it("§12.3 names the architectural choice", () => {
    expect(READINESS).toMatch(
      /one charge-execution helper, parameterized by .{0,5}charge_reason/i,
    );
  });

  it("the doc explicitly forbids parallel charge-execution code paths", () => {
    expect(READINESS).toMatch(
      /must reuse it, not parallel it/,
    );
  });

  it("the runManualFeeCharge pattern is named as the proven contract", () => {
    expect(READINESS).toMatch(/runManualFeeCharge/);
    expect(READINESS).toMatch(/deterministic idempotency key/i);
    expect(READINESS).toMatch(/three independent dormancy guards/i);
  });
});

describe("docs/16 §12.4: v1 session payment flow forbids auto-charge", () => {
  it("the practitioner-enters-amount rule is explicit", () => {
    expect(READINESS).toMatch(
      /practitioner enters the final amount/i,
    );
  });

  it("auto-charge from service price / duration / area / hair count is forbidden", () => {
    // The negation list is pinned because each item has tempted a
    // past discussion ("we already know the duration, why not just
    // charge..."). The answer is no.
    const forbiddenList = [
      "services.price_cents",
      "appointment duration",
      "session duration",
      "treatment area",
      "hair count",
      "machine settings",
    ];
    for (const item of forbiddenList) {
      expect(READINESS).toContain(item);
    }
  });
});

describe("docs/16 §12.5: off-session SetupIntent already satisfied", () => {
  it("the positive finding cites the actual source line", () => {
    // The audit's positive finding: lib/stripe/setup-intent.ts:202
    // already uses usage: "off_session". A future SetupIntent
    // refactor that drops or weakens this property must update
    // both the code AND this doc.
    expect(READINESS).toMatch(/lib\/stripe\/setup-intent\.ts:202/);
    expect(READINESS).toMatch(/usage:\s*"off_session"/);
  });
});

describe("docs/16 §12.6: card authorization wording requirement", () => {
  it("the production gap (body=\"test\") is documented explicitly", () => {
    // Production query confirmed both Willow studios have body
    // length = 4, body = "test". This is the legal blocker.
    expect(READINESS).toMatch(
      /body = "test".*4 characters|body length = 4|body_chars[\s\S]{0,20}4/i,
    );
  });

  it("the four authorization elements are enumerated", () => {
    const required = [
      /[Oo]ff-session charging for completed sessions/,
      /[Ll]ate cancellation fees/,
      /[Nn]o-show fees/,
      /[Cc]hargeback.{0,30}dispute/i,
    ];
    for (const pattern of required) {
      expect(READINESS).toMatch(pattern);
    }
  });

  it("CASL and PIPEDA are named as the legal frame", () => {
    expect(READINESS).toMatch(/CASL/);
    expect(READINESS).toMatch(/PIPEDA/);
  });
});

describe("docs/16 §12.7: 0% Hone platform fee in v1", () => {
  it("the 0% Hone fee decision is explicit", () => {
    expect(READINESS).toMatch(/0%[\s\S]{0,80}platform fee/i);
  });

  it("the doc forbids silently setting application_fee_bps", () => {
    expect(READINESS).toMatch(/Do not silently set/i);
  });

  it("studio is the merchant of record (§12.10)", () => {
    expect(READINESS).toMatch(
      /Studio is the merchant of record|studio.s connected account is the merchant of record/i,
    );
  });
});

describe("docs/16 §12.8: no tax calculation in v1", () => {
  it("practitioner enters the all-in / gross amount", () => {
    expect(READINESS).toMatch(/all-in[\s\S]{0,40}gross amount/i);
  });

  it("Hone does NOT compute or render tax in v1", () => {
    expect(READINESS).toMatch(/Hone does not calculate tax in v1|Hone does NOT in v1/i);
  });
});

describe("docs/16 §12.9: paid status derived from charge rows", () => {
  it("no appointments.paid or sessions.paid boolean in v1", () => {
    // The doc renders "No separate `appointments.paid` or
    // `sessions.paid` boolean." -- the backticks between the
    // identifier and "boolean" mean the regex must allow
    // arbitrary punctuation between them.
    expect(READINESS).toMatch(/No separate.{0,10}appointments\.paid/i);
    expect(READINESS).toMatch(/sessions\.paid[^\w]{0,5}boolean/i);
  });

  it("paid badge reads the existence of a status='succeeded' charge attempt row", () => {
    expect(READINESS).toMatch(
      /status='succeeded'[\s\S]{0,80}charge attempt/i,
    );
  });
});

describe("docs/16 §12.11: risk-ordered enablement", () => {
  it("session_payment ships live FIRST, then cancellation, then no-show", () => {
    // Pin the order: lower dispute risk first.
    const m = READINESS.match(/12\.11[\s\S]*?12\.12/);
    expect(m).not.toBeNull();
    const block = m?.[0] ?? "";
    const sIdx = block.indexOf("session_payment");
    const cIdx = block.indexOf("late_cancellation_fee");
    const nIdx = block.indexOf("no_show_fee");
    expect(sIdx).toBeGreaterThan(-1);
    expect(cIdx).toBeGreaterThan(sIdx);
    expect(nIdx).toBeGreaterThan(cIdx);
  });

  it("the DB CHECK relax is per-reason, not all-or-nothing", () => {
    expect(READINESS).toMatch(/per-reason, not all-or-nothing/);
  });
});

describe("docs/02 domain model carries the session payment section", () => {
  it("§Session payment model (PR #169) exists in docs/02", () => {
    expect(DOMAIN).toMatch(/Session payment model.{0,40}PR #169/);
  });

  it("docs/02 enumerates the three canonical charge reasons", () => {
    expect(DOMAIN).toMatch(/session_payment/);
    expect(DOMAIN).toMatch(/late_cancellation_fee/);
    expect(DOMAIN).toMatch(/no_show_fee/);
  });

  it("docs/02 cross-links to docs/16 §12", () => {
    expect(DOMAIN).toMatch(
      /16_LIVE_PAYMENTS_READINESS\.md#12-session-payment-product-model/,
    );
  });
});
