import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  sanitizeAdminAuditMetadata,
  logAdminAction,
} from "@/lib/audit/admin-actions";

function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}

describe("sanitizeAdminAuditMetadata: allowlist + redaction", () => {
  it("keeps safe primitive keys/values", () => {
    const out = sanitizeAdminAuditMetadata({
      slug: "willow",
      reason: "studio_insert_failed",
      has_resolution_note: true,
      count: 3,
    });
    expect(out).toEqual({
      slug: "willow",
      reason: "studio_insert_failed",
      has_resolution_note: true,
      count: 3,
    });
  });

  it("drops sensitive-looking KEYS entirely (token/secret/url/card/email/phone/etc.)", () => {
    const out = sanitizeAdminAuditMetadata({
      token: "RAWSECRET",
      raw_token: "x",
      api_key: "k",
      stripe_secret: "sk_live_x",
      password: "p",
      authorization: "Bearer x",
      cookie: "c",
      url: "https://hone.care/portal/verify/TOK",
      magic_link: "https://hone.care/portal/verify/TOK",
      card: "4242424242424242",
      cvc: "123",
      email: "client@example.com",
      phone: "555-1212",
      ssn: "000",
    });
    expect(out).toEqual({});
  });

  it("drops non-primitive values + truncates long strings", () => {
    const out = sanitizeAdminAuditMetadata({
      nested: { a: 1 },
      arr: [1, 2, 3],
      big: "x".repeat(1000),
    });
    expect(out.nested).toBeUndefined();
    expect(out.arr).toBeUndefined();
    // truncated to <= 200 (the value-level redactor may shorten further)
    expect(typeof out.big).toBe("string");
    expect((out.big as string).length).toBeLessThanOrEqual(200);
  });

  it("never lets a token/url/card/email survive into the JSON", () => {
    const out = sanitizeAdminAuditMetadata({
      token: "sk_live_DEADBEEF",
      url: "https://x/verify/TOK",
      card: "4242424242424242",
      email: "a@b.com",
    });
    const blob = JSON.stringify(out).toLowerCase();
    expect(blob).not.toContain("sk_live");
    expect(blob).not.toContain("verify/tok");
    expect(blob).not.toContain("4242");
    expect(blob).not.toContain("a@b.com");
  });
});

describe("logAdminAction: fail-soft (never throws)", () => {
  it("resolves without throwing even when the admin client / insert is unavailable", async () => {
    // vitest loads no env, so createAdminClient (or its insert) fails; the helper
    // must swallow it and never throw (an audit-log outage must not break the
    // admin action it records).
    await expect(
      logAdminAction({
        actorUserId: "u1",
        actorEmail: "op@example.com",
        action: "studio_created",
        targetType: "studio",
        outcome: "succeeded",
        metadata: { slug: "willow" },
      }),
    ).resolves.toBeUndefined();
  });
});

describe("admin actions are wired to the audit log (source pins)", () => {
  const STUDIO = read("app/admin/studios/new/actions.ts");
  const OPS = read("app/admin/ops-alerts/actions.ts");
  const DEMO = read("app/admin/actions.ts");
  const HELPER = read("lib/audit/admin-actions.ts");
  const PAGE = read("app/admin/audit/page.tsx");

  it("studio creation logs started + succeeded + failed + blocked", () => {
    expect(STUDIO).toMatch(/action: "studio_created"[\s\S]{0,120}outcome: "started"/);
    expect(STUDIO).toMatch(/outcome: "succeeded"/);
    expect(STUDIO).toMatch(/outcome: "failed"/);
    expect(STUDIO).toMatch(/outcome: "blocked"/);
    // logged metadata is only the (public) slug + safe reason codes, never the
    // owner email or name.
    expect(STUDIO).toMatch(/metadata: \{ slug: input\.slug \}/);
    expect(STUDIO).not.toMatch(/metadata:[^}]*owner_?email/i);
    expect(STUDIO).not.toMatch(/metadata:[^}]*ownerDisplayName/i);
  });

  it("ops-alert resolve logs succeeded/failed/blocked but only a note BOOLEAN, not the text", () => {
    expect(OPS).toMatch(/action: "ops_alert_resolved"/);
    expect(OPS).toMatch(/outcome: "blocked"/);
    // logs whether a note exists (boolean), never the free-text note itself.
    expect(OPS).toMatch(/has_resolution_note: note != null/);
    // a BARE resolution_note key would be the raw text; has_resolution_note is fine.
    expect(OPS).not.toMatch(/metadata:[^}]*\bresolution_note:/);
  });

  it("demo-contacted logs the outcome", () => {
    expect(DEMO).toMatch(/action: "demo_request_contacted"/);
    expect(DEMO).toMatch(/outcome: "succeeded"/);
  });

  it("the helper insert stores no secret columns (only ids/action/outcome/metadata)", () => {
    const start = HELPER.indexOf(".insert({");
    const payload = HELPER.slice(start, HELPER.indexOf("});", start));
    expect(payload).toMatch(/actor_user_id/);
    expect(payload).toMatch(/metadata: sanitizeAdminAuditMetadata/);
    expect(payload).not.toMatch(/token|secret|card|url|password|cookie|authorization/i);
  });

  it("the /admin audit page is isAdmin-gated + reads via the helper + no raw JSON dump", () => {
    expect(PAGE).toMatch(/isAdmin\(user\.email\)/);
    expect(PAGE).toMatch(/getRecentAdminActionEvents\(/);
    expect(PAGE).not.toMatch(/JSON\.stringify\(.*metadata/);
    // no Stripe/payment/email/SMS surface introduced
    expect(PAGE).not.toMatch(/stripe|sendEmail|twilio|sendSms/i);
  });
});
