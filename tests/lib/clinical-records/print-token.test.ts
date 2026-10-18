import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mintPrintToken, PRINT_TOKEN_TTL_MS, verifyPrintToken } from "@/lib/clinical-records/print-token";

// HON-46 (Codex P1 4303617257): the print audit is bound to the rendered
// preview by a server-minted token. Nothing the browser sends can change the
// client or the scope that gets audited.

const STUDIO = "11111111-1111-4111-8111-111111111111";
const OTHER_STUDIO = "22222222-2222-4222-8222-222222222222";
const ACTOR = "33333333-3333-4333-8333-333333333333";
const CLIENT = "44444444-4444-4444-8444-444444444444";
const OTHER_CLIENT = "55555555-5555-4555-8555-555555555555";
const PREVIEW = "66666666-6666-4666-8666-666666666666";
const NOW = Date.parse("2026-10-17T17:00:00Z");

const claims = {
  studioId: STUDIO,
  clientId: CLIENT,
  actorId: ACTOR,
  previewAuditId: PREVIEW,
  scope: { kind: "day" as const, day: "2026-09-24" },
};
const expected = { studioId: STUDIO, actorId: ACTOR };

/** Re-encode a token's payload with changes, keeping the ORIGINAL signature. */
function tamper(token: string, change: (p: Record<string, unknown>) => void): string {
  const [payload, sig] = token.split(".");
  const obj = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  change(obj);
  const forged = Buffer.from(JSON.stringify(obj)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `${forged}.${sig}`;
}

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.APPOINTMENT_SIGNING_SECRET;
  process.env.APPOINTMENT_SIGNING_SECRET = "unit-test-signing-secret";
});
afterEach(() => {
  if (saved === undefined) delete process.env.APPOINTMENT_SIGNING_SECRET;
  else process.env.APPOINTMENT_SIGNING_SECRET = saved;
});

describe("print token: the honest path", () => {
  it("verifies for the same studio and actor, and yields exactly the minted client and scope", () => {
    const token = mintPrintToken(claims, NOW)!;
    const r = verifyPrintToken(token, expected, NOW + 1000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.claims).toMatchObject({ clientId: CLIENT, previewAuditId: PREVIEW, scope: { kind: "day", day: "2026-09-24" } });
  });
});

describe("print token: tampering and replay are refused", () => {
  it("a tampered client id is refused", () => {
    const token = tamper(mintPrintToken(claims, NOW)!, (p) => {
      p.clientId = OTHER_CLIENT;
    });
    expect(verifyPrintToken(token, expected, NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });
  it("a tampered scope is refused", () => {
    const token = tamper(mintPrintToken(claims, NOW)!, (p) => {
      p.scope = { kind: "range", from: "2026-01-01", to: "2026-12-31" };
    });
    expect(verifyPrintToken(token, expected, NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });
  it("a token minted for another studio is refused", () => {
    const token = mintPrintToken({ ...claims, studioId: OTHER_STUDIO }, NOW)!;
    expect(verifyPrintToken(token, expected, NOW)).toEqual({ ok: false, reason: "wrong_studio" });
  });
  it("a token minted for another owner is refused", () => {
    const token = mintPrintToken(claims, NOW)!;
    expect(verifyPrintToken(token, { studioId: STUDIO, actorId: OTHER_CLIENT }, NOW)).toEqual({
      ok: false,
      reason: "wrong_actor",
    });
  });
  it("an expired token is refused, and one issued in the future is too", () => {
    const token = mintPrintToken(claims, NOW)!;
    expect(verifyPrintToken(token, expected, NOW + PRINT_TOKEN_TTL_MS + 1)).toEqual({ ok: false, reason: "expired" });
    expect(verifyPrintToken(token, expected, NOW - 5 * 60 * 1000)).toEqual({ ok: false, reason: "expired" });
  });
  it("a token signed with a different key is refused", () => {
    const token = mintPrintToken(claims, NOW)!;
    process.env.APPOINTMENT_SIGNING_SECRET = "a-different-key";
    expect(verifyPrintToken(token, expected, NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });
  it("garbage is refused without throwing", () => {
    for (const bad of [undefined, null, 42, "", "x", "a.b.c", "a.", ".b", "x".repeat(5000)]) {
      expect(verifyPrintToken(bad, expected, NOW).ok).toBe(false);
    }
  });
  it("an invalid scope inside a validly signed token is refused (scope is re-parsed, never trusted)", () => {
    const token = mintPrintToken({ ...claims, scope: { kind: "day", day: "not-a-day" } as never }, NOW)!;
    expect(verifyPrintToken(token, expected, NOW)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("print token: fails closed without a key", () => {
  it("mints nothing and verifies nothing", () => {
    const token = mintPrintToken(claims, NOW)!;
    delete process.env.APPOINTMENT_SIGNING_SECRET;
    expect(mintPrintToken(claims, NOW)).toBeNull();
    expect(verifyPrintToken(token, expected, NOW)).toEqual({ ok: false, reason: "unavailable" });
  });
});
