import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  redactOpsAlertMessage,
  redactOpsAlertValue,
  redactOpsAlertDetails,
  REDACTED,
} from "@/lib/ops/redact";

// PR #285. Central ops-alert message redaction. recordOpsAlert previously
// stored/logged/emailed the RAW message; now it runs redactOpsAlertMessage
// first, so a leaked provider error.message (PII / signed URLs / tokens /
// Stripe secrets) is scrubbed before ANY sink. These tests pin the pure
// redactor patterns + that the wiring is central (one call protects every
// caller).

const has = (s: string, sub: string) => s.includes(sub);
const redacted = (s: string) => s.includes(REDACTED);

// ---------------------------------------------------------------------------
// Pure message redaction, each sensitive pattern is removed.
// ---------------------------------------------------------------------------
describe("redactOpsAlertMessage scrubs sensitive patterns", () => {
  it("email address", () => {
    const out = redactOpsAlertMessage("send failed to jane.doe+x@example.com today");
    expect(redacted(out)).toBe(true);
    expect(has(out, "jane.doe+x@example.com")).toBe(false);
  });

  it("phone number", () => {
    const out = redactOpsAlertMessage("SMS to +1 (555) 123-4567 failed");
    expect(redacted(out)).toBe(true);
    expect(has(out, "555")).toBe(false);
  });

  it("bearer token / authorization header", () => {
    const a = redactOpsAlertMessage("got 401 with Authorization: Bearer abcDEF123ghiJKL456mnoPQR789stu");
    expect(has(a, "abcDEF123ghiJKL456mnoPQR789stu")).toBe(false);
    expect(redacted(a)).toBe(true);
    const b = redactOpsAlertMessage('header authorization="Bearer zzzz1111yyyy2222xxxx3333wwww4444"');
    expect(redacted(b)).toBe(true);
  });

  it("CRON_SECRET-shaped value (named field + high-entropy)", () => {
    const out = redactOpsAlertMessage("cron_secret=2b7e151628aed2a6abf7158809cf4f3c2b7e1516");
    expect(has(out, "2b7e151628aed2a6abf7158809cf4f3c2b7e1516")).toBe(false);
    expect(redacted(out)).toBe(true);
  });

  it("JWT-like string", () => {
    const out = redactOpsAlertMessage(
      "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3In0.dBjftJeZ4CVPmB92K27uhbUJU1p1r",
    );
    expect(redacted(out)).toBe(true);
    expect(has(out, "eyJhbGci")).toBe(false);
  });

  it("Supabase signed URL", () => {
    const out = redactOpsAlertMessage(
      "sign failed for https://abc.supabase.co/storage/v1/object/sign/treatment-images/aaa/bbb/c.jpg?token=eyJh.eyJ.sig",
    );
    expect(redacted(out)).toBe(true);
    expect(has(out, "object/sign")).toBe(false);
  });

  it("generic URL with token / signature / X-Amz-Signature query params", () => {
    const out = redactOpsAlertMessage(
      "fetch https://x.test/p?foo=1&token=SEKRET123&X-Amz-Signature=DEADBEEFsig&expires=99 failed",
    );
    expect(has(out, "SEKRET123")).toBe(false);
    expect(has(out, "DEADBEEFsig")).toBe(false);
    expect(redacted(out)).toBe(true);
  });

  it("appointment/cancel/manage token in a URL", () => {
    const out = redactOpsAlertMessage(
      "bad link https://hone.care/cancel/appt?token=cancel-token-abc123def456ghi789 here",
    );
    expect(has(out, "cancel-token-abc123def456ghi789")).toBe(false);
  });

  it("treatment-images storage path", () => {
    const out = redactOpsAlertMessage(
      "object missing at treatment-images/550e8400-e29b-41d4-a716-446655440000/9f8b/c.jpg",
    );
    expect(has(out, "treatment-images/")).toBe(false);
    expect(redacted(out)).toBe(true);
  });

  it("raw <uuid>/<uuid>/file storage path", () => {
    const out = redactOpsAlertMessage(
      "path 550e8400-e29b-41d4-a716-446655440000/660e8400-e29b-41d4-a716-446655440111/x.png not found",
    );
    expect(redacted(out)).toBe(true);
  });

  it("Stripe secret + restricted keys", () => {
    expect(redacted(redactOpsAlertMessage("key sk_live_51HxYabcdEFGHijklMNOP rejected"))).toBe(true);
    expect(redacted(redactOpsAlertMessage("key sk_test_51HxYabcdEFGHijklMNOP rejected"))).toBe(true);
    expect(redacted(redactOpsAlertMessage("key rk_live_51HxYabcdEFGHijklMNOP rejected"))).toBe(true);
    expect(has(redactOpsAlertMessage("sk_live_51HxYabcdEFGHijklMNOP"), "sk_live_")).toBe(false);
  });

  it("Stripe webhook secret (whsec_)", () => {
    const out = redactOpsAlertMessage("verify failed for whsec_abcdEFGH1234ijklMNOP5678");
    expect(has(out, "whsec_")).toBe(false);
    expect(redacted(out)).toBe(true);
  });

  it("Stripe client secrets (pi_/seti_ ..._secret_...)", () => {
    const a = redactOpsAlertMessage("pi_3Nabc123XYZ_secret_4Kdef456UVW could not confirm");
    expect(has(a, "_secret_")).toBe(false);
    expect(redacted(a)).toBe(true);
    const b = redactOpsAlertMessage("seti_1Mabc_secret_2Ndef leaked");
    expect(redacted(b)).toBe(true);
  });

  it("generic high-entropy token", () => {
    const out = redactOpsAlertMessage("opaque token AKIA1234567890ABCDEFGHIJKLMNOPQRSTUVWX seen");
    expect(has(out, "AKIA1234567890ABCDEFGHIJKLMNOPQRSTUVWX")).toBe(false);
    expect(redacted(out)).toBe(true);
  });

  it("named JSON-ish fields token/secret/password/client_secret", () => {
    const out = redactOpsAlertMessage(
      '{"token":"abc123","secret":"shh","password":"hunter2","client_secret":"cs_live_zzz"}',
    );
    for (const leak of ["abc123", "shh", "hunter2", "cs_live_zzz"]) {
      expect(has(out, leak)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Preservation, operator context survives.
// ---------------------------------------------------------------------------
describe("redactOpsAlertMessage preserves safe operator context", () => {
  it("preserves a non-secret Stripe PaymentIntent id (for reconciliation)", () => {
    const out = redactOpsAlertMessage("PaymentIntent pi_3NabcDEF123ghiJKL succeeded but write failed");
    expect(has(out, "pi_3NabcDEF123ghiJKL")).toBe(true);
    expect(redacted(out)).toBe(false);
  });

  it("preserves charge / refund / customer ids", () => {
    const out = redactOpsAlertMessage("refund re_1NabcDEF for ch_1NxyzGHI on cus_OabcDEF");
    expect(has(out, "re_1NabcDEF")).toBe(true);
    expect(has(out, "ch_1NxyzGHI")).toBe(true);
    expect(has(out, "cus_OabcDEF")).toBe(true);
  });

  it("preserves a standalone UUID resource id verbatim", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    const out = redactOpsAlertMessage(`attempt ${id} could not be stamped`);
    expect(out).toBe(`attempt ${id} could not be stamped`);
  });

  it("preserves short status / code words", () => {
    const out = redactOpsAlertMessage("stripe_status: requires_action, code: card_declined");
    expect(out).toBe("stripe_status: requires_action, code: card_declined");
  });

  it("is deterministic + idempotent", () => {
    const msg = "email a@b.com and token Bearer abc123ABC456def789DEF000ghi111JKL";
    const once = redactOpsAlertMessage(msg);
    expect(redactOpsAlertMessage(msg)).toBe(once);
    expect(redactOpsAlertMessage(once)).toBe(once);
  });

  it("returns empty/unchanged for empty input", () => {
    expect(redactOpsAlertMessage("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// safeDetails value redaction (redactOpsAlertValue / redactOpsAlertDetails).
// ---------------------------------------------------------------------------
describe("safeDetails value redaction", () => {
  it("redacts a signed-URL / whsec_ / client-secret VALUE", () => {
    const out = redactOpsAlertDetails({
      url: "https://x.supabase.co/storage/v1/object/sign/treatment-images/a/b/c.jpg?token=eyJ.eyJ.s",
      hook: "whsec_abcdEFGH1234ijklMNOP5678",
      cs: "pi_3Nabc_secret_4Kdef",
    });
    expect(out.url).toBe(REDACTED);
    expect(out.hook).toBe(REDACTED);
    expect(out.cs).toBe(REDACTED);
  });

  it("scrubs embedded email/token inside a longer detail VALUE", () => {
    const out = redactOpsAlertValue("contact jane@example.com or use Bearer abc123ABC456def789DEF000ghi");
    expect(String(out).includes("jane@example.com")).toBe(false);
    expect(String(out).includes(REDACTED)).toBe(true);
  });

  it("still redacts credential-named KEYS + preserves UUIDs (regression)", () => {
    const out = redactOpsAlertDetails({
      token: "anything",
      appointment_id: "550e8400-e29b-41d4-a716-446655440000",
      stripe_payment_intent_id: "pi_3NabcDEF123ghiJKL",
    });
    expect(out.token).toBe(REDACTED);
    expect(out.appointment_id).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(out.stripe_payment_intent_id).toBe("pi_3NabcDEF123ghiJKL");
  });
});

// ---------------------------------------------------------------------------
// Central wiring, recordOpsAlert redacts the message before every sink.
// ---------------------------------------------------------------------------
describe("recordOpsAlert wires central message redaction (PR #285)", () => {
  const ALERTS = readFileSync(
    path.resolve(__dirname, "../../../lib/ops/alerts.ts"),
    "utf8",
  );

  it("imports + applies redactOpsAlertMessage to the message", () => {
    expect(ALERTS).toMatch(/import \{[\s\S]*redactOpsAlertMessage[\s\S]*\} from "@\/lib\/ops\/redact"/);
    expect(ALERTS).toMatch(/redactOpsAlertMessage\(input\.message\)/);
  });

  it("the redaction wraps the message BEFORE it reaches the log / DB / email", () => {
    // The single `message` local feeds the structured log, the ops_alerts
    // insert, and the critical email, so redacting it once covers all sinks.
    const redactIdx = ALERTS.indexOf("redactOpsAlertMessage(input.message)");
    const logIdx = ALERTS.indexOf("structuredConsoleLog({");
    const insertIdx = ALERTS.indexOf('from("ops_alerts").insert(');
    const emailIdx = ALERTS.indexOf("notifyCriticalOpsAlert(");
    expect(redactIdx).toBeGreaterThan(-1);
    expect(logIdx).toBeGreaterThan(redactIdx);
    expect(insertIdx).toBeGreaterThan(redactIdx);
    expect(emailIdx).toBeGreaterThan(redactIdx);
    // The DB insert + log + email use the `message` local, not input.message.
    expect(ALERTS).not.toMatch(/message:\s*input\.message/);
  });

  it("safeDetails redaction (redactSafeDetails) is preserved", () => {
    expect(ALERTS).toMatch(/redactSafeDetails/);
    expect(ALERTS).toMatch(/redactOpsAlertDetails/);
  });
});

// ---------------------------------------------------------------------------
// Targeted call-site cleanup, the riskiest storage-error alerts no longer
// pass a raw provider error.message (the central redactor covers the rest).
// ---------------------------------------------------------------------------
describe("treatment-images alert call sites use generic messages (PR #285)", () => {
  const IMG_ACTIONS = readFileSync(
    path.resolve(__dirname, "../../../app/(app)/clients/[id]/images/actions.ts"),
    "utf8",
  );

  it("upload / metadata-insert / sign alerts no longer pass raw error.message", () => {
    expect(IMG_ACTIONS).not.toMatch(/message:\s*upErr\.message/);
    expect(IMG_ACTIONS).not.toMatch(/message:\s*rmErr \? rmErr\.message : insErr\.message/);
    expect(IMG_ACTIONS).not.toMatch(/message:\s*signErr\?\.message/);
  });

  it("they use generic, event-descriptive messages instead", () => {
    expect(IMG_ACTIONS).toMatch(/message:\s*"Treatment image upload to storage failed\."/);
    expect(IMG_ACTIONS).toMatch(/Treatment image metadata insert failed\./);
    expect(IMG_ACTIONS).toMatch(/Treatment image signed-URL creation failed\./);
  });
});
