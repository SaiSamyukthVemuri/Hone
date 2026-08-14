import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #219. Docs drift cleanup pins. After the PR #196 ledger
// unification and the PR #217/#218 hardening, several docs and one
// runtime header comment still described the OLD world (no refunds,
// legacy fee executor as live runtime, OPS_ALERT_EMAILS unread,
// preview modal not using the HTML renderer). These tests pin the
// corrected claims so the docs cannot silently drift back, and pin
// that the cleanup did NOT overclaim live-payment readiness.

function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../..", rel), "utf8");
}

const OVERVIEW = read("docs/00_PRODUCT_OVERVIEW.md");
const AUDIT = read("docs/18_LIVE_PAYMENTS_AUDIT.md");
const SECURITY = read("docs/03_SECURITY_AND_PRIVACY.md");
const MARKDOWN_LITE = read("lib/email/markdown-lite.ts");

describe("docs/00: payment claims match the shipped state", () => {
  it("no longer claims that no code path issues a refund", () => {
    expect(OVERVIEW).not.toMatch(/No code path issues a refund/);
    expect(OVERVIEW).not.toMatch(/No receipt or charge notice email is sent/);
  });

  it("describes test-mode receipts and owner-only refunds as built on the unified ledger", () => {
    expect(OVERVIEW).toMatch(
      /Test-mode receipts and full-amount, owner-only refunds ARE built on the unified `payment_charge_attempts` ledger/,
    );
  });

  // SUPERSEDED PIN (2026-07-27). This test previously required docs/00 to state
  // that the canonical `payment_charge_attempts` ledger "has a DB CHECK" pinning
  // `stripe_livemode = false`. That constraint NO LONGER EXISTS: migration
  // 0101_live_payment_charge_attempts_db_readiness.sql drops
  // `payment_charge_attempts_livemode_false_check` and replaces it with
  // `payment_charge_attempts_live_requires_account_check`
  // (stripe_livemode = false OR stripe_account_id is not null), which does NOT
  // prevent live rows. Verified in production 2026-07-27 via pg_constraint: the
  // only remaining livemode CHECK is on the LEGACY `manual_fee_charge_attempts`
  // table, and the canonical ledger holds 8 rows with stripe_livemode = true.
  // The guard kept enforcing a falsehood, so it is replaced below with pins on
  // the verified present state.
  it("names 0101 as having dropped the canonical ledger's livemode-false CHECK", () => {
    expect(OVERVIEW).toMatch(
      /DB CHECK that pinned `stripe_livemode = false` on the canonical `payment_charge_attempts` ledger was \*\*dropped by migration 0101\*\*/,
    );
    // The stale affirmative claim must not come back.
    expect(OVERVIEW).not.toMatch(
      /canonical `payment_charge_attempts` ledger \(and the legacy, read-only `manual_fee_charge_attempts` table\) has a DB CHECK/,
    );
  });

  it("states live rows are supported for approved studios, with evidence", () => {
    expect(OVERVIEW).toMatch(/live payments ARE built and in use/i);
    expect(OVERVIEW).toMatch(/enabled for two approved studios/i);
    // Evidence, not just an assertion of enablement.
    expect(OVERVIEW).toMatch(/6 succeeded live-mode charges/i);
  });

  it("keeps the legacy manual_fee_charge_attempts table test-mode-only", () => {
    expect(OVERVIEW).toMatch(
      /only the legacy, read-only `manual_fee_charge_attempts` table still carries one/,
    );
  });

  it("keeps live manual no-show / late-cancel fees hard-held server-side", () => {
    expect(OVERVIEW).toMatch(
      /live manual no-show \/ late-cancel fees \(\*\*server-side hard hold\*\* — only `session_payment` charges live\)/,
    );
  });

  it("still refuses to claim broad self-serve live payments are ready", () => {
    expect(OVERVIEW).toMatch(/broad self-serve live payments \(a new studio starts in test mode\)/i);
    expect(OVERVIEW).toMatch(/broad self-serve live payments are not ready/i);
  });

  it("the Soon list no longer defers things that already shipped", () => {
    // The stale list deferred receipts/refunds, email claim discipline,
    // hashed feed tokens, and tests + CI to "soon"; all are live now.
    expect(OVERVIEW).not.toMatch(
      /Soon:[^\n]*(Receipts and refunds|outbox\/claim discipline|Hashed calendar feed tokens|Automated tests \+ CI)/,
    );
    expect(OVERVIEW).toMatch(/Email sends use atomic claim discipline/);
    expect(OVERVIEW).toMatch(/Calendar feed tokens are hashed at rest/);
  });

  it("broad SaaS launch no longer lists refund + receipt code as missing", () => {
    expect(OVERVIEW).not.toMatch(/refund \+ receipt code/);
  });

  it("states supervised live for approved studios without overclaiming broad readiness", () => {
    // Current posture: supervised live for approved studios...
    expect(OVERVIEW).toMatch(/\| Live payment \| \*\*Supervised live for approved studios/);
    // ...but explicitly NOT broad self-serve, and the still-off items are named (no overclaim).
    expect(OVERVIEW).toMatch(/broad self-serve live payments are not ready/i);
    expect(OVERVIEW).toMatch(/public booking card collection/i);
  });
});

describe("docs/18: legacy fee executor is no longer presented as runtime", () => {
  it("never cites manual-fee-charge.ts as a runtime writer path", () => {
    // The stale inventory row read "`lib/billing/manual-fee-charge.ts`
    // via `app/...`"; the file was deleted in PR #218 and may only be
    // mentioned as removed/dead history.
    expect(AUDIT).not.toMatch(/`lib\/billing\/manual-fee-charge\.ts` via/);
    // Present-tense form only; the §3 resolution note legitimately says
    // the table "was still the live runtime" at audit time.
    expect(AUDIT).not.toMatch(/is still the live runtime/);
    expect(AUDIT).not.toMatch(/\): still the live runtime/);
    expect(AUDIT).not.toMatch(/The ledger is \*\*still split\*\*/);
  });

  it("inventory row marks the legacy table as read-only history with no runtime writers", () => {
    expect(AUDIT).toMatch(/\*\*none since PR #196\*\*/);
    expect(AUDIT).toMatch(/LEGACY, read-only history/);
  });

  it("fee flow row points at the unified executor and canonical ledger", () => {
    expect(AUDIT).toMatch(
      /No-show \/ late-cancel fee[^\n]*session-payment-charge\.ts[^\n]*unified executor since PR #196/,
    );
  });

  it("gate counts state exactly ONE paymentIntents.create call site", () => {
    expect(AUDIT).toMatch(/`paymentIntents\.create` exactly 1 allowlisted/);
    expect(AUDIT).not.toMatch(/`paymentIntents\.create` exactly 2 allowlisted/);
  });

  it("dual-ledger section is marked resolved without dropping the 0032 cleanup follow-up", () => {
    expect(AUDIT).toMatch(/RESOLVED \(PR #196 unification \+ PR #218 cleanup/);
    expect(AUDIT).toMatch(/still exist in prod with zero runtime references/);
  });

  // SUPERSEDED PIN (2026-07-27). This test previously read
  //   expect(AUDIT).toMatch(/NOT READY FOR LIVE PAYMENTS/);
  //   expect(AUDIT).toMatch(/Live payments remain disabled/);
  // Both strings are still present in docs/18, but they are the DATED
  // 2026-06-10 audit verdict, not current state. As written, the guard let a
  // historical verdict silently satisfy a test whose name asserted it was the
  // present posture. Live owner-run session payments are now enabled for
  // approved studios and production-exercised (Willow Electrolysis: 6 succeeded
  // live-mode charges, most recent 2026-07-26). The guard is therefore rewritten
  // to require the document to DISTINGUISH the two, rather than to require the
  // stale claim to exist unqualified.
  it("distinguishes its dated historical verdict from today's supervised-live posture", () => {
    // The historical verdict may remain, but only explicitly marked as historical.
    expect(AUDIT).toMatch(
      /\*\*Verdict \(2026-06-10 — HISTORICAL; superseded[^)]*\): NOT READY FOR LIVE PAYMENTS\.\*\*/,
    );
    // A bare, unqualified present-tense verdict line must not exist.
    expect(AUDIT).not.toMatch(/^\*\*Verdict: NOT READY FOR LIVE PAYMENTS\.\*\*/m);
    // The document must state the superseding current posture somewhere.
    expect(AUDIT).toMatch(/supervised live session payments are live for approved studios/i);
  });

  it("marks its live-mode gate section as superseded rather than current", () => {
    // §2 documented the pre-live three-guard stack, including the CHECK 0101 dropped.
    expect(AUDIT).toMatch(/## 2\. Live-mode gates .*NOW SUPERSEDED/);
    // The correction wraps across blockquote lines, so match tolerantly.
    expect(AUDIT).toMatch(
      /migration \*\*0101\*\* dropped[\s>]*`payment_charge_attempts_livemode_false_check`/,
    );
    // …and it must say the canonical ledger now holds live rows.
    expect(AUDIT).toMatch(/8 rows with `stripe_livemode=true`/);
  });
});

describe("docs/03: OPS_ALERT_EMAILS language matches lib/ops/alert-email.ts", () => {
  it("no longer claims the env var is unread or that email dispatch is deferred", () => {
    expect(SECURITY).not.toMatch(/not read today/);
    expect(SECURITY).not.toMatch(
      /Operator email dispatch is deferred to a future PR/,
    );
  });

  it("states the variable IS read, by which helper, and its production-required status", () => {
    expect(SECURITY).toMatch(
      /`OPS_ALERT_EMAILS` \(comma-separated recipient list\) IS read by that helper/,
    );
    expect(SECURITY).toMatch(/`lib\/ops\/alert-email\.ts`/);
    // PR #291: optional outside production, REQUIRED in production (env gate).
    expect(SECURITY).toMatch(/optional outside production/);
    expect(SECURITY).toMatch(/REQUIRED in production/);
    expect(SECURITY).toMatch(/once-per-instance warning is logged and the email is skipped/);
    expect(SECURITY).toMatch(/durable row and the dashboard are unaffected/);
  });

  it("matches the runtime helper: alert-email.ts really reads OPS_ALERT_EMAILS", () => {
    const helper = read("lib/ops/alert-email.ts");
    expect(helper).toMatch(/process\.env\.OPS_ALERT_EMAILS/);
    // The helper's comments mention send-appointment.ts only to say it
    // is never imported; pin the absence of an actual import.
    expect(helper).not.toMatch(/from "@\/lib\/email\/send-appointment"/);
  });
});

describe("lib/email/markdown-lite.ts: header comment matches actual usage", () => {
  it("no longer claims the preview renders plain text instead of the HTML", () => {
    expect(MARKDOWN_LITE).not.toMatch(/the plain-text version, not the HTML/);
    expect(MARKDOWN_LITE).not.toMatch(
      /not exposed through dangerouslySetInnerHTML/,
    );
  });

  it("names the preview modal surface and the dangerouslySetInnerHTML exposure", () => {
    expect(MARKDOWN_LITE).toMatch(/PostcareEditingHelpers\.tsx/);
    expect(MARKDOWN_LITE).toMatch(
      /DOES render\s*(\/\/\s*)?this helper's HTML output via dangerouslySetInnerHTML/,
    );
    expect(MARKDOWN_LITE).toMatch(
      /ONLY\s*(\/\/\s*)?approved browser surface/,
    );
  });

  it("the claimed usage is real: the preview modal consumes markdownLiteToHtml via dangerouslySetInnerHTML", () => {
    const preview = read("app/(app)/settings/studio/PostcareEditingHelpers.tsx");
    expect(preview).toMatch(/markdownLiteToHtml\(/);
    expect(preview).toMatch(/dangerouslySetInnerHTML/);
  });

  it("renderer behavior is unchanged: escape-first order and scheme allowlist intact", () => {
    // Comment-only PR: the escape happens before any transform and the
    // scheme allowlist still rejects javascript:/data: URLs.
    expect(MARKDOWN_LITE).toMatch(
      /const escaped = escapeHtml\(text\);/,
    );
    expect(MARKDOWN_LITE).toMatch(/lower\.startsWith\("https:\/\/"\)/);
    expect(MARKDOWN_LITE).toMatch(/lower\.startsWith\("mailto:"\)/);
  });
});
