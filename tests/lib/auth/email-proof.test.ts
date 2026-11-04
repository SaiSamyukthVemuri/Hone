import { describe, expect, it, vi } from "vitest";
import { claimsFromAccessToken, emailChangeState, mailboxProofMethod } from "@/lib/auth/email-proof";
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

describe("S-2b: link proof counts only on an account whose address NEVER changed; a changed account is the database's call", () => {
  const T = 1_793_674_853; // whole epoch seconds
  const created = "2026-11-04T00:27:44.65494Z"; // GoTrue trims trailing zeros of the microseconds
  const link = (ts: number | undefined, method = "magiclink") => ({ amr: [{ method, ...(ts === undefined ? {} : { timestamp: ts }) }] });
  const account = (extra: Record<string, unknown> = {}, identity: Record<string, unknown> = { created_at: created, updated_at: created }) => ({
    email: "victim@example.com",
    identities: [{ provider: "email", identity_data: { email: "victim@example.com" }, ...identity }],
    ...extra,
  });

  it.each(["otp", "magiclink", "recovery"])("POSITIVE: a never-changed account (identity updated_at == created_at, no email_change_sent_at) proves by %s, whatever the amr second", (m) => {
    // The first sign-in of a new account: the identity is written in the SAME second as the session (machines/1333-PROBE-RAW.json),
    // which is what made a strict `>` refuse every first sign-in. No time is compared, so it is proven.
    for (const ts of [undefined, 1, T]) expect(mailboxProofMethod(link(ts, m), account({ email_change_sent_at: null })), `${m} ts=${ts}`).toBe("email_link_or_otp");
    expect(emailChangeState(account())).toBe("never_changed");
  });

  it("the same instant in another spelling is equal (trimmed zeros, +00:00, a space separator); a 1 microsecond difference is not", () => {
    expect(emailChangeState(account({}, { created_at: "2026-11-04T00:27:44.65494Z", updated_at: "2026-11-04T00:27:44.654940+00:00" }))).toBe("never_changed");
    expect(emailChangeState(account({}, { created_at: "2026-11-04 00:27:44.65494+00", updated_at: "2026-11-04T00:27:44.65494Z" }))).toBe("never_changed");
    expect(emailChangeState(account({}, { created_at: "2026-11-04T00:27:44.654940Z", updated_at: "2026-11-04T00:27:44.654941Z" }))).toBe("changed");
  });

  it.each(["otp", "magiclink", "recovery"])("NEGATIVE: after an applied change (identity updated_at moved) a %s session is unproven here, before, AT or after the change second (Codex P1)", (m) => {
    const u = account({ email_change_sent_at: new Date(T * 1000).toISOString() }, { created_at: created, updated_at: new Date(T * 1000 + 400).toISOString() });
    for (const ts of [T - 3, T, T + 0.9, T + 1, T + 3600]) expect(mailboxProofMethod(link(ts, m), u), `${m} ts=${ts}`).toBeNull();
  });

  it("NEGATIVE: a PENDING change (email_change_sent_at set, identity untouched) already counts as change activity", () => {
    expect(mailboxProofMethod(link(T + 10), account({ email_change_sent_at: new Date(T * 1000).toISOString() }))).toBeNull();
    expect(mailboxProofMethod(link(T + 10), account({}, { created_at: created, updated_at: "2026-11-04T00:27:45Z" }))).toBeNull();
  });

  it("fails closed: an unreadable email_change_sent_at, or an email identity without readable created_at/updated_at, counts as changed", () => {
    for (const ecs of ["not a date", { x: 1 }, 0]) expect(mailboxProofMethod(link(T), account({ email_change_sent_at: ecs })), JSON.stringify(ecs)).toBeNull();
    for (const identity of [{}, { created_at: created }, { updated_at: created }, { created_at: "yesterday", updated_at: "yesterday" }, { created_at: 1, updated_at: 1 }]) {
      expect(mailboxProofMethod(link(T), account({}, identity)), JSON.stringify(identity)).toBeNull();
    }
  });

  it("only `email` identities count: a changed google identity does not make the account changed; no email identity at all is never-changed", () => {
    const u = {
      email: "victim@example.com",
      identities: [
        { provider: "email", identity_data: {}, created_at: created, updated_at: created },
        { provider: "google", identity_data: {}, created_at: created, updated_at: "2026-11-05T00:00:00Z" },
      ],
    };
    expect(mailboxProofMethod(link(T), u)).toBe("email_link_or_otp");
    expect(mailboxProofMethod(link(T), { email: "victim@example.com", identities: [] })).toBe("email_link_or_otp");
  });

  it("EA-1: an ABSENT, null or non-array identities list is unreadable, so the account counts as changed (fail closed)", () => {
    for (const identities of [undefined, null, "[]", {}, 0, { 0: { provider: "email" } }]) {
      expect(emailChangeState({ email: "victim@example.com", email_change_sent_at: null, identities } as never), JSON.stringify(identities)).toBe("changed");
    }
    // a non-object entry inside the list is unreadable too (and must not throw)
    expect(emailChangeState({ email: "victim@example.com", identities: [null] } as never)).toBe("changed");
    expect(emailChangeState({ email: "victim@example.com", identities: ["email"] } as never)).toBe("changed");
    // the EMPTY array stays never-changed (an account with no email identity row, e.g. Google-only)
    expect(emailChangeState({ email: "victim@example.com", email_change_sent_at: null, identities: [] })).toBe("never_changed");
  });

  it.each(["otp", "magiclink", "recovery"])("EA-1: a user WITHOUT the identities key is NOT proven by the pure rule for %s (the database decides)", (m) => {
    const noKey = { email: "victim@example.com", email_change_sent_at: null };
    expect("identities" in noKey).toBe(false);
    expect(mailboxProofMethod(link(T, m), noKey)).toBeNull();
    expect(mailboxProofMethod(link(T, m), { ...noKey, identities: null } as never)).toBeNull();
  });

  it("a password entry never proves, changed or not", () => {
    expect(mailboxProofMethod({ amr: [{ method: "password", timestamp: T + 50 }] }, account())).toBeNull();
    expect(mailboxProofMethod({ amr: [{ method: "password", timestamp: T + 50 }] }, account({ email_change_sent_at: new Date(T * 1000).toISOString() }))).toBeNull();
  });

  it("oauth is unaffected: it is bound to the address by the verified Google identity itself", () => {
    const u = {
      email: "victim@example.com",
      email_change_sent_at: new Date(T * 1000).toISOString(),
      identities: [{ provider: "google", identity_data: { email: "victim@example.com", email_verified: true } }],
    };
    expect(mailboxProofMethod({ amr: [{ method: "oauth", timestamp: T - 500 }] }, u)).toBe("oauth_verified");
  });
});
