import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/admin", () => ({ isAdmin: (e: string | null) => e === "ops@harness.local" }));
import { isProvenPlatformAdmin, sessionMailboxProof } from "@/lib/auth/session-email-proof";

const client = (user: unknown, claims: unknown, claimsError: unknown = null) => ({
  auth: {
    getUser: vi.fn().mockResolvedValue({ data: { user }, error: null }),
    getClaims: vi.fn().mockResolvedValue({ data: claims ? { claims } : null, error: claimsError }),
  },
}) as never;
const ops = { id: "u", email: "ops@harness.local", identities: [] };

describe("isProvenPlatformAdmin", () => {
  beforeEach(() => vi.clearAllMocks());
  it("NEGATIVE: allowlisted address on a PASSWORD (auto-confirmed) session is not an admin", async () => {
    expect(await isProvenPlatformAdmin(client(ops, { amr: [{ method: "password" }] }))).toBe(false);
  });
  it("POSITIVE: allowlisted address with an OTP/magic-link session is an admin", async () => {
    expect(await isProvenPlatformAdmin(client(ops, { amr: [{ method: "otp" }] }))).toBe(true);
  });
  it("POSITIVE: allowlisted address via verified Google is an admin", async () => {
    const u = { ...ops, identities: [{ provider: "google", identity_data: { email: ops.email, email_verified: true } }] };
    expect(await isProvenPlatformAdmin(client(u, { amr: [{ method: "oauth", timestamp: 1 }] }))).toBe(true);
  });
  it("NEGATIVE: a non-allowlisted address is refused WITHOUT an auth-server claims round trip", async () => {
    const c = client({ id: "x", email: "someone@harness.local" }, { amr: [{ method: "otp" }] });
    expect(await isProvenPlatformAdmin(c)).toBe(false);
    expect((c as { auth: { getClaims: ReturnType<typeof vi.fn> } }).auth.getClaims).not.toHaveBeenCalled();
  });
  it("NEGATIVE: claims unavailable, no user, or a thrown error all fail closed", async () => {
    expect(await isProvenPlatformAdmin(client(ops, null, { message: "x" }))).toBe(false);
    expect(await isProvenPlatformAdmin(client(null, null))).toBe(false);
    const boom = { auth: { getUser: vi.fn().mockRejectedValue(new Error("x")), getClaims: vi.fn() } } as never;
    expect(await isProvenPlatformAdmin(boom)).toBe(false);
  });
  it("uses a user the caller already resolved (no second getUser)", async () => {
    const c = client(ops, { amr: [{ method: "otp" }] });
    expect(await isProvenPlatformAdmin(c, ops)).toBe(true);
    expect((c as { auth: { getUser: ReturnType<typeof vi.fn> } }).auth.getUser).not.toHaveBeenCalled();
  });
});

describe("sessionMailboxProof", () => {
  it("returns the method and the user", async () => {
    const r = await sessionMailboxProof(client(ops, { amr: [{ method: "otp" }] }));
    expect(r.method).toBe("email_link_or_otp");
    expect(r.user?.email).toBe(ops.email);
  });
});
