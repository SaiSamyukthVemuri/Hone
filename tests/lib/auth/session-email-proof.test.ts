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

describe("S-2b: a changed account's link session is decided by the database (0291 session_link_proof_is_current)", () => {
  const created = "2026-11-04T00:27:44.65494Z";
  const changed = { id: "u", email: "ops@harness.local", email_change_sent_at: "2026-11-04T00:28:00Z", identities: [{ provider: "email", identity_data: {}, created_at: created, updated_at: "2026-11-04T00:28:01Z" }] };
  const never = { id: "u", email: "ops@harness.local", identities: [{ provider: "email", identity_data: {}, created_at: created, updated_at: created }] };
  const withRpc = (user: unknown, claims: unknown, rpc: unknown) => ({ ...(client(user, claims) as object), rpc }) as never;

  it("asks the database only for a link-type entry on a changed account, and takes a true answer as proof", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
    expect((await sessionMailboxProof(withRpc(changed, { amr: [{ method: "magiclink" }] }, rpc))).method).toBe("email_link_or_otp");
    expect(rpc).toHaveBeenCalledWith("session_link_proof_is_current");
    expect(await isProvenPlatformAdmin(withRpc(changed, { amr: [{ method: "otp" }] }, rpc))).toBe(true);
  });
  it("fails closed: false, an error, a throw, or no rpc at all", async () => {
    for (const rpc of [vi.fn().mockResolvedValue({ data: false, error: null }), vi.fn().mockResolvedValue({ data: null, error: { code: "PGRST202" } }), vi.fn().mockResolvedValue({ data: "true", error: null }), vi.fn().mockRejectedValue(new Error("x")), undefined]) {
      expect((await sessionMailboxProof(withRpc(changed, { amr: [{ method: "otp" }] }, rpc))).method).toBeNull();
    }
  });
  it("never calls the database for a never-changed account or a non-link session", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
    expect((await sessionMailboxProof(withRpc(never, { amr: [{ method: "otp" }] }, rpc))).method).toBe("email_link_or_otp");
    expect((await sessionMailboxProof(withRpc(changed, { amr: [{ method: "password" }] }, rpc))).method).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });
});
