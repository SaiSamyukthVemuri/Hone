import { describe, expect, it, vi } from "vitest";
import { claimsFromAccessToken, mailboxProofMethod } from "@/lib/auth/email-proof";
import { hardenAccountAfterMailboxProof, HARDENED_MARKER, reissueProvenSession, applyProofHardening, accountHasPassword, hardeningMode } from "@/lib/auth/proof-hardening";

const U = { email: "Member@Harness.local", identities: [] as never[] };
const google = (email: string, verified: unknown) => ({ ...U, identities: [{ provider: "google", identity_data: { email, email_verified: verified } }] });

describe("mailboxProofMethod (email-trust)", () => {
  it.each(["otp", "magiclink", "recovery"])("%s proves the mailbox (measured: implicit links are otp; PKCE magic link is magiclink; PKCE recovery is recovery)", (method) => {
    expect(mailboxProofMethod({ amr: [{ method }] }, U)).toBe("email_link_or_otp");
  });
  it.each(["email/signup", "invite", "sso/saml", "anonymous", "password", "mfa/totp"])("NEGATIVE: %s is not a measured mailbox method and proves nothing", (method) => {
    expect(mailboxProofMethod({ amr: [{ method }] }, U)).toBeNull();
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
  it("POSITIVE: GoTrue's REAL oauth amr entry carries no provider ({method, timestamp}); Google is read from the identity (Codex P1)", () => {
    expect(mailboxProofMethod({ amr: [{ method: "oauth", timestamp: 1 }] }, google("member@harness.local", true))).toBe("oauth_verified");
  });
  it("NEGATIVE: a provider-less oauth amr with a google identity for ANOTHER address, or unverified, is not proof", () => {
    expect(mailboxProofMethod({ amr: [{ method: "oauth", timestamp: 1 }] }, google("x@harness.local", true))).toBeNull();
    expect(mailboxProofMethod({ amr: [{ method: "oauth", timestamp: 1 }] }, google("member@harness.local", false))).toBeNull();
  });
  it("NEGATIVE: an oauth amr naming an untrusted provider, or with only a non-google identity, is not proof", () => {
    const gh = { ...U, identities: [{ provider: "github", identity_data: { email: "member@harness.local", email_verified: true } }] };
    expect(mailboxProofMethod({ amr: [{ method: "oauth", timestamp: 1 }] }, gh as never)).toBeNull();
    expect(mailboxProofMethod({ amr: [{ method: "oauth", provider: "github" }] }, google("member@harness.local", true))).toBeNull();
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
  const mk = (over: { update?: unknown; link?: unknown } = {}) => ({
    auth: { admin: {
      updateUserById: vi.fn().mockResolvedValue(over.update ?? { error: null }),
      generateLink: vi.fn().mockResolvedValue(over.link ?? { data: { properties: { hashed_token: "th" } }, error: null }),
    } },
  });
  it("rotates the password and stamps the marker", async () => {
    const a = mk();
    const r = await hardenAccountAfterMailboxProof(a, { id: "u1", app_metadata: { provider: "email" } }, () => new Date("2026-11-02T00:00:00Z"));
    expect(r).toBe("hardened");
    const attrs = a.auth.admin.updateUserById.mock.calls[0][1];
    expect(typeof attrs.password).toBe("string");
    expect(attrs.password.length).toBeGreaterThanOrEqual(48);
    expect(attrs.app_metadata).toEqual({ provider: "email", [HARDENED_MARKER]: "2026-11-02T00:00:00.000Z" });
  });
  it("is one-time: an already-hardened account is untouched", async () => {
    const a = mk();
    expect(await hardenAccountAfterMailboxProof(a, { id: "u1", app_metadata: { [HARDENED_MARKER]: "x" } })).toBe("already_hardened");
    expect(a.auth.admin.updateUserById).not.toHaveBeenCalled();
  });
  it("a different random password each time", async () => {
    const a = mk(); const b = mk();
    await hardenAccountAfterMailboxProof(a, { id: "u1" }); await hardenAccountAfterMailboxProof(b, { id: "u1" });
    expect(a.auth.admin.updateUserById.mock.calls[0][1].password).not.toBe(b.auth.admin.updateUserById.mock.calls[0][1].password);
  });
  it("failures are reported, never thrown", async () => {
    expect(await hardenAccountAfterMailboxProof(mk({ update: { error: new Error("x") } }), { id: "u" })).toBe("failed");
    const boom = { auth: { admin: { updateUserById: vi.fn().mockRejectedValue(new Error("x")), generateLink: vi.fn() } } };
    expect(await hardenAccountAfterMailboxProof(boom, { id: "u" })).toBe("failed");
  });
});

describe("reissueProvenSession", () => {
  const admin = (link: unknown) => ({ auth: { admin: { updateUserById: vi.fn(), generateLink: vi.fn().mockResolvedValue(link) } } });
  it("redeems a server-generated magiclink token on the request client", async () => {
    const verifyOtp = vi.fn().mockResolvedValue({ error: null });
    expect(await reissueProvenSession(admin({ data: { properties: { hashed_token: "th" } }, error: null }), { auth: { verifyOtp } }, "a@harness.local")).toBe(true);
    expect(verifyOtp).toHaveBeenCalledExactlyOnceWith({ token_hash: "th", type: "magiclink" });
  });
  it("false (never throws) when no token, a link error, a verify error or an exception", async () => {
    const ok = vi.fn().mockResolvedValue({ error: null });
    expect(await reissueProvenSession(admin({ data: { properties: null }, error: null }), { auth: { verifyOtp: ok } }, "a@h")).toBe(false);
    expect(await reissueProvenSession(admin({ data: null, error: new Error("x") }), { auth: { verifyOtp: ok } }, "a@h")).toBe(false);
    expect(await reissueProvenSession(admin({ data: { properties: { hashed_token: "t" } }, error: null }), { auth: { verifyOtp: vi.fn().mockResolvedValue({ error: new Error("x") }) } }, "a@h")).toBe(false);
    expect(await reissueProvenSession(admin({ data: { properties: { hashed_token: "t" } }, error: null }), { auth: { verifyOtp: vi.fn().mockRejectedValue(new Error("x")) } }, "a@h")).toBe(false);
  });
});

describe("hardeningMode: the rollout flag defaults OFF", () => {
  it.each([[undefined, "off"], [null, "off"], ["", "off"], ["off", "off"], ["OFF", "off"], ["true", "off"], ["1", "off"], ["on", "off"], ["password_only", "password_only"], [" Password_Only ", "password_only"], ["all", "all"], ["ALL", "all"]])("%j -> %s", (raw, mode) => {
    expect(hardeningMode(raw as never)).toBe(mode);
  });
});

describe("accountHasPassword (boolean from a service-role function; the hash is never read)", () => {
  const probe = (r: unknown) => ({ rpc: vi.fn().mockResolvedValue(r) });
  it("true / false pass through", async () => {
    expect(await accountHasPassword(probe({ data: true, error: null }), "u")).toBe(true);
    expect(await accountHasPassword(probe({ data: false, error: null }), "u")).toBe(false);
  });
  it.each([{ data: null, error: { code: "42883" } }, { data: "yes", error: null }, { data: null, error: null }])("unknown (%j) is null, never a guess", async (r) => {
    expect(await accountHasPassword(probe(r), "u")).toBeNull();
  });
  it("a thrown call is null", async () => {
    expect(await accountHasPassword({ rpc: vi.fn().mockRejectedValue(new Error("x")) }, "u")).toBeNull();
  });
});

describe("applyProofHardening: what each flag value does", () => {
  const mk = (has: unknown = { data: true, error: null }) => ({
    auth: { admin: {
      updateUserById: vi.fn().mockResolvedValue({ error: null }),
      generateLink: vi.fn().mockResolvedValue({ data: { properties: { hashed_token: "th" } }, error: null }),
    } },
    rpc: vi.fn().mockResolvedValue(has),
  });
  const run = async (mode: "off" | "password_only" | "all", admin = mk(), user: { id: string; email: string; app_metadata?: Record<string, unknown> } = { id: "u", email: "a@harness.local" }, verify = vi.fn().mockResolvedValue({ error: null })) => {
    const makeAdmin = vi.fn(() => admin as never);
    const outcome = await applyProofHardening({ mode, user, makeAdmin, supabase: { auth: { verifyOtp: verify } } });
    return { outcome, admin, makeAdmin, verify };
  };
  const untouched = (r: Awaited<ReturnType<typeof run>>) => {
    expect(r.admin.auth.admin.updateUserById).not.toHaveBeenCalled();
    expect(r.admin.auth.admin.generateLink).not.toHaveBeenCalled();
    expect(r.verify).not.toHaveBeenCalled();
  };
  it("off: NO SIDE EFFECT of any kind (no admin client, no read, no marker, no session)", async () => {
    const r = await run("off");
    expect(r.outcome).toBe("skipped_off");
    expect(r.makeAdmin).not.toHaveBeenCalled();
    expect(r.admin.rpc).not.toHaveBeenCalled();
    untouched(r);
  });
  it("password_only: an account WITH a password is rotated, marked and re-issued a session", async () => {
    const r = await run("password_only");
    expect(r.outcome).toBe("hardened_session_reissued");
    expect(r.admin.rpc).toHaveBeenCalledExactlyOnceWith("auth_account_has_password", { p_user_id: "u" });
    expect(r.admin.auth.admin.updateUserById).toHaveBeenCalledOnce();
    expect(r.verify).toHaveBeenCalledOnce();
  });
  it("password_only: an account WITHOUT a password is not touched (no marker either)", async () => {
    const r = await run("password_only", mk({ data: false, error: null }));
    expect(r.outcome).toBe("skipped_no_password");
    untouched(r);
  });
  it("password_only: an UNKNOWN password state (function missing / call failed) is not touched", async () => {
    const r = await run("password_only", mk({ data: null, error: { code: "42883" } }));
    expect(r.outcome).toBe("skipped_password_unknown");
    untouched(r);
  });
  it("all: an account without a password is hardened too, and no password probe is made", async () => {
    const r = await run("all", mk({ data: false, error: null }));
    expect(r.outcome).toBe("hardened_session_reissued");
    expect(r.admin.rpc).not.toHaveBeenCalled();
  });
  it.each(["password_only", "all"] as const)("%s: an already-hardened account is left alone", async (mode) => {
    const r = await run(mode, mk(), { id: "u", email: "a@h", app_metadata: { email_proof_hardened_at: "x" } });
    expect(r.outcome).toBe("already_hardened");
    untouched(r);
  });
  it("a failed re-issue is reported so the caller can ask for a fresh sign-in", async () => {
    const r = await run("all", mk(), undefined, vi.fn().mockResolvedValue({ error: new Error("x") }));
    expect(r.outcome).toBe("hardened_reissue_failed");
  });
  it("any throw is 'failed', never an exception", async () => {
    const outcome = await applyProofHardening({ mode: "all", user: { id: "u" }, makeAdmin: () => { throw new Error("x"); }, supabase: { auth: { verifyOtp: vi.fn() } } });
    expect(outcome).toBe("failed");
  });
  it("touches the auth account only: no studio-membership table is ever addressed", async () => {
    const r = await run("all");
    expect(Object.keys(r.admin)).toEqual(["auth", "rpc"]);
    expect(r.admin.rpc.mock.calls.every((c) => c[0] === "auth_account_has_password")).toBe(true);
  });
  // Insurance G-1: the provider set is closed. A provider enabled later proves nothing until it is added to the proof set on purpose.
  it.each(["github", "apple", "azure", "facebook", "twitter", "discord", "keycloak", "workos", "phone"])(
    "NEGATIVE (closed provider set): a verified %s identity for the account's own address is not mailbox proof",
    (provider) => {
      const user = { email: U.email, identities: [{ provider, identity_data: { email: U.email, email_verified: true } }] };
      // Positive control: the SAME shape with google IS proof, so the refusal below is about the provider and nothing else.
      const google = { email: U.email, identities: [{ provider: "google", identity_data: { email: U.email, email_verified: true } }] };
      expect(mailboxProofMethod({ amr: [{ method: "oauth", timestamp: 1 }] }, google)).toBe("oauth_verified");
      expect(mailboxProofMethod({ amr: [{ method: "oauth", timestamp: 1 }] }, user)).toBeNull();
      expect(mailboxProofMethod({ amr: [{ method: "oauth", provider, timestamp: 1 }] }, user)).toBeNull();
    },
  );

});
