import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { redactAccountId } from "@/lib/payments/admin-payment-status";

// PR B: admin smart payment status. Pins the redaction-first design, the
// mode-separated reads, the shared row-mode badge (Unknown for null), and
// the absence of the three stale hardcoded admin claims.

function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}

const HELPER = read("lib/payments/admin-payment-status.ts");
// Comment-stripped view for identifier bans (the header comments NAME the
// banned identifiers to document the redaction posture).
const HELPER_CODE = HELPER.replace(/^\s*\/\/.*$/gm, "");
const BADGE = read("app/admin/mode-badge.tsx");

describe("stale hardcoded admin claims are gone", () => {
  it("no admin surface hardcodes payments-off claims", () => {
    expect(read("app/admin/page.tsx")).not.toMatch(/Live payments are disabled/);
    expect(read("app/admin/studios/[id]/page.tsx")).not.toMatch(/Live payments disabled/);
    expect(read("app/admin/studios/new/page.tsx")).not.toMatch(/Live payments remain disabled/);
  });
});

describe("redaction-first helper", () => {
  it("redactAccountId never returns a full id", () => {
    expect(redactAccountId("acct_1Tp4X9AbCdEf5678")).toBe("acct_…5678");
    expect(redactAccountId(null)).toBeNull();
  });

  it("selects capability/status/count columns only — no sensitive identifiers", () => {
    // The ONLY columns the helper ever selects:
    expect(HELPER).toMatch(/stripe_livemode, stripe_account_id, stripe_account_status, stripe_charges_enabled, stripe_payouts_enabled/);
    expect(HELPER).toMatch(/select\("stripe_livemode"\)/); // cards: mode only
    expect(HELPER).toMatch(/select\("stripe_livemode, status"\)/); // attempts: mode+status only
    // Never PI/customer/card identifiers, fingerprints, tokens, emails,
    // client columns, or intake/health content.
    expect(HELPER_CODE).not.toMatch(/payment_intent|stripe_customer|stripe_payment_method|fingerprint|last4|brand|email|client_id|intake|token/i);
    // The raw account id never leaves: only the redacted suffix is exposed.
    expect(HELPER).toMatch(/accountIdRedacted: redactAccountId\(/);
    expect(HELPER).not.toMatch(/accountId: row/);
  });

  it("creates NO client of its own and performs NO writes", () => {
    expect(HELPER).not.toMatch(/createAdminClient|createClient\(/);
    expect(HELPER).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.rpc\(/);
    expect(HELPER).toMatch(/import "server-only"/);
  });

  it("counts are mode-separated (per-row stripe_livemode), capability via the shared presenter", () => {
    expect(HELPER).toMatch(/\.eq\("stripe_livemode", livemode\)/); // platform summary scope
    expect(HELPER).toMatch(/r\.stripe_livemode === livemode/); // per-mode row pick
    expect(HELPER).toMatch(/c\.stripe_livemode === livemode/); // cards split
    expect(HELPER).toMatch(/a\.stripe_livemode === livemode/); // attempts split
    expect(HELPER).toMatch(/deriveConnectCapability\(/);
    // Load errors are said out loud (loadError flag), never an all-clear.
    expect(HELPER).toMatch(/loadError: true/);
  });
});

describe("shared admin mode badge", () => {
  it("badges from the ROW's stripe_livemode via the presenter; null renders unknown, never test", () => {
    expect(BADGE).toMatch(/modeBadgeForRow/);
    expect(BADGE).toMatch(/"unknown mode"/);
    expect(BADGE).toMatch(/livemode: boolean \| null \| undefined/);
  });

  it("manual-review queue uses the shared badge (local duplicate removed)", () => {
    const mr = read("app/admin/payments/manual-review/page.tsx");
    expect(mr).toMatch(/AdminModeBadge/);
    expect(mr).not.toMatch(/function ModeBadge\(/);
  });
});

describe("admin pages render status, not a Stripe data dump", () => {
  it("studio detail shows both mode rows + redacted account + mode-separated counts", () => {
    const page = read("app/admin/studios/[id]/page.tsx");
    expect(page).toMatch(/PaymentModeCard label="Live"/);
    expect(page).toMatch(/PaymentModeCard label="Test"/);
    expect(page).toMatch(/row\.accountIdRedacted/);
    expect(page).toMatch(/row\.attempts\.succeeded/);
    expect(page).toMatch(/No \{label\.toLowerCase\(\)\}-mode row/);
  });

  it("homepage banner is counts-only (no per-studio identifiers)", () => {
    const page = read("app/admin/page.tsx");
    expect(page).toMatch(/summary\.ready/);
    expect(page).toMatch(/summary\.payoutsPending/);
    expect(page).not.toMatch(/acct_|stripe_account_id/);
  });
});
