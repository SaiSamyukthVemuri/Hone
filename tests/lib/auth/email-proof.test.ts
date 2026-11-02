import { describe, expect, it, vi } from "vitest";
import { claimsFromAccessToken, mailboxProofMethod } from "@/lib/auth/email-proof";
import { hardenAccountAfterMailboxProof, HARDENED_MARKER } from "@/lib/auth/proof-hardening";

const U = { email: "Member@Harness.local", identities: [] as never[] };
const google = (email: string, verified: unknown) => ({ ...U, identities: [{ provider: "google", identity_data: { email, email_verified: verified } }] });

describe("mailboxProofMethod (email-trust)", () => {
  it.each(["otp", "magiclink", "email/signup", "invite", "recovery"])("%s proves the mailbox", (method) => {
    expect(mailboxProofMethod({ amr: [{ method }] }, U)).toBe("email_link_or_otp");
  });
  it("NEGATIVE: a password session proves nothing, even next to nothing else", () => {
    expect(mailboxProofMethod({ amr: [{ method: "password" }] }, U)).toBeNull();
  });
  it.each([null, undefined, {}, { amr: "otp" }, { amr: [null, 3] }])("NEGATIVE: malformed claims %j prove nothing", (c) => {
    expect(mailboxProofMethod(c as never, U)).toBeNull();
  });
  it("NEGATIVE: no email on the account proves nothing", () => {
    expect(mailboxProofMethod({ amr: [{ method: "otp" }] }, { email: null })).toBeNull();
  });
  it("POSITIVE: google with email_verified === true for the same address (case-insensitive)", () => {
    expect(mailboxProofMethod({ amr: [{ method: "oauth", provider: "google" }] }, google("member@harness.local", true))).toBe("oauth_verified");
  });
  it.each([false, "true", undefined, 1])("NEGATIVE: google email_verified=%j is not proof", (v) => {
    expect(mailboxProofMethod({ amr: [{ method: "oauth", provider: "google" }] }, google("member@harness.local", v))).toBeNull();
  });
  it("NEGATIVE: google for a different address, or another provider, is not proof", () => {
    expect(mailboxProofMethod({ amr: [{ method: "oauth", provider: "google" }] }, google("x@harness.local", true))).toBeNull();
    expect(mailboxProofMethod({ amr: [{ method: "oauth", provider: "github" }] }, { ...U, identities: [{ provider: "github", identity_data: { email: "member@harness.local", email_verified: true } }] })).toBeNull();
  });
  it("NEGATIVE: an oauth amr without a matching google identity is not proof", () => {
    expect(mailboxProofMethod({ amr: [{ method: "oauth", provider: "google" }] }, U)).toBeNull();
  });
});

describe("claimsFromAccessToken", () => {
  it("decodes the payload and fails closed on garbage", () => {
    const t = `h.${Buffer.from(JSON.stringify({ amr: [{ method: "otp" }] })).toString("base64url")}.s`;
    expect(claimsFromAccessToken(t)).toEqual({ amr: [{ method: "otp" }] });
    expect(claimsFromAccessToken("nope")).toBeNull();
    expect(claimsFromAccessToken("a.!!!.c")).toBeNull();
    expect(claimsFromAccessToken(null)).toBeNull();
  });
});

describe("hardenAccountAfterMailboxProof", () => {
  const mk = (over: { update?: unknown; signOut?: unknown } = {}) => ({
    auth: { admin: {
      updateUserById: vi.fn().mockResolvedValue(over.update ?? { error: null }),
      signOut: vi.fn().mockResolvedValue(over.signOut ?? { error: null }),
    } },
  });
  it("rotates the password, stamps the marker and revokes OTHER sessions", async () => {
    const a = mk();
    const r = await hardenAccountAfterMailboxProof(a, { id: "u1", app_metadata: { provider: "email" } }, "jwt", () => new Date("2026-11-02T00:00:00Z"));
    expect(r).toBe("hardened");
    const attrs = a.auth.admin.updateUserById.mock.calls[0][1];
    expect(typeof attrs.password).toBe("string");
    expect(attrs.password.length).toBeGreaterThanOrEqual(48);
    expect(attrs.app_metadata).toEqual({ provider: "email", [HARDENED_MARKER]: "2026-11-02T00:00:00.000Z" });
    expect(a.auth.admin.signOut).toHaveBeenCalledExactlyOnceWith("jwt", "others");
  });
  it("is one-time: an already-hardened account is untouched (a second device is not signed out)", async () => {
    const a = mk();
    expect(await hardenAccountAfterMailboxProof(a, { id: "u1", app_metadata: { [HARDENED_MARKER]: "x" } }, "jwt")).toBe("already_hardened");
    expect(a.auth.admin.updateUserById).not.toHaveBeenCalled();
    expect(a.auth.admin.signOut).not.toHaveBeenCalled();
  });
  it("a different random password each time", async () => {
    const a = mk(); const b = mk();
    await hardenAccountAfterMailboxProof(a, { id: "u1" }, "j"); await hardenAccountAfterMailboxProof(b, { id: "u1" }, "j");
    expect(a.auth.admin.updateUserById.mock.calls[0][1].password).not.toBe(b.auth.admin.updateUserById.mock.calls[0][1].password);
  });
  it("failures are reported, never thrown", async () => {
    expect(await hardenAccountAfterMailboxProof(mk({ update: { error: new Error("x") } }), { id: "u" }, "j")).toBe("failed");
    expect(await hardenAccountAfterMailboxProof(mk({ signOut: { error: new Error("x") } }), { id: "u" }, "j")).toBe("failed");
    const boom = { auth: { admin: { updateUserById: vi.fn().mockRejectedValue(new Error("x")), signOut: vi.fn() } } };
    expect(await hardenAccountAfterMailboxProof(boom, { id: "u" }, "j")).toBe("failed");
  });
});
