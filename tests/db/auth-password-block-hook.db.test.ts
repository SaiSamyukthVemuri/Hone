import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { adminQuery, closePool } from "./helpers/harness";
import { E2E_SERVICE_ROLE_KEY, E2E_SUPABASE_URL, E2E_WEB_SERVER_ENV } from "../../e2e/helpers/local-env";

// 0292 (HELD): the Custom Access Token hook that refuses tokens issued through a PASSWORD. Hone is passwordless (Google + magic
// link), but GoTrue's email provider keeps /signup-with-password and /token?grant_type=password open.
//
// Two layers:
//  1. FUNCTION level (always): the hook called directly with synthetic events for every authentication method, plus its grants.
//  2. LIVE level (AUTH_HOOK_PHASE=post, on a stack whose TEST-ONLY workdir config enables the hook, confirmations ON): real GoTrue.
//     AUTH_HOOK_PHASE=pre runs FIRST on the same stack with the hook NOT yet configured and records password-origin sessions, so
//     the post phase can prove that an EXISTING password session dies at its next refresh.
// Synthetic addresses on a reserved test domain; tokens are held in a state file, never printed.

const ANON = E2E_WEB_SERVER_ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const PHASE = process.env.AUTH_HOOK_PHASE ?? "";
const STATE = process.env.AUTH_HOOK_STATE ?? "";
const evidence: Record<string, unknown> = {};
afterAll(async () => {
  if (process.env.AUTH_HOOK_EVIDENCE) writeFileSync(process.env.AUTH_HOOK_EVIDENCE, JSON.stringify({ phase: PHASE || "function-only", ...evidence }, null, 2));
  await closePool();
});

type Json = Record<string, unknown>;
async function gotrue(path: string, body: Json, key = E2E_SERVICE_ROLE_KEY) {
  const r = await fetch(`${E2E_SUPABASE_URL}/auth/v1/${path}`, { method: "POST", headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Json };
}
const addr = (t: string) => `ph-${t}-${randomUUID().slice(0, 8)}@harness.local`;
const PW = `Pw-${randomUUID()}`;
const createUser = (email: string, extra: Json = {}) => gotrue("admin/users", { email, password: PW, email_confirm: true, ...extra });
const passwordLogin = (email: string) => gotrue("token?grant_type=password", { email, password: PW }, ANON);
const refresh = (rt: string) => gotrue("token?grant_type=refresh_token", { refresh_token: rt }, ANON);
const hasToken = (r: { body: Json }) => typeof r.body.access_token === "string";
async function link(type: string, email: string, extra: Json = {}) {
  const l = await gotrue("admin/generate_link", { type, email, ...extra });
  expect(l.status, `setup: generate_link ${type}`).toBe(200);
  return gotrue("verify", { type, token_hash: l.body.hashed_token as string }, ANON);
}

async function hook(event: Json): Promise<Json> {
  const r = await adminQuery(`select public.custom_access_token_hook($1::jsonb) as r`, [JSON.stringify(event)]);
  return r.rows[0].r as Json;
}
const ev = (authentication_method: string | null, amr: unknown = [{ method: "otp", timestamp: 1 }]) => ({
  user_id: randomUUID(), authentication_method, claims: { aud: "authenticated", role: "authenticated", amr },
});
const denied = (r: Json) => (r.error as { http_code?: number } | undefined)?.http_code === 403 && r.claims === undefined;
const allowed = (r: Json, e: Json) => r.error === undefined && isDeepStrictEqual(r.claims, e.claims);

describe("0292 hook function (direct calls)", () => {
  it.each(["otp", "magiclink", "email/signup", "invite", "recovery", "oauth"])("POSITIVE: %s is allowed and the claims pass through unchanged", async (m) => {
    const e = ev(m);
    expect(allowed(await hook(e), e)).toBe(true);
  });
  it("NEGATIVE: password is denied (403), with no claims", async () => {
    expect(denied(await hook(ev("password", [{ method: "password" }])))).toBe(true);
  });
  it.each([["token_refresh", [{ method: "password", timestamp: 1 }]], ["token_refresh", [{ method: "otp" }, { method: "password" }]]])("NEGATIVE: a refresh of a password-origin session is denied (%j)", async (m, amr) => {
    expect(denied(await hook(ev(m as string, amr)))).toBe(true);
  });
  it.each([[[{ method: "otp" }]], [[{ method: "oauth", provider: "google" }]], [[{ method: "email/signup" }]]])("POSITIVE: a refresh of a non-password session is allowed (%j)", async (amr) => {
    const e = ev("token_refresh", amr);
    expect(allowed(await hook(e), e)).toBe(true);
  });
  it.each([[null], [""], ["anonymous"], ["web3"], ["totally_new_method"], ["mfa_code_login"]])("NEGATIVE: an unknown or missing method (%j) fails closed", async (m) => {
    expect(denied(await hook(ev(m as string | null)))).toBe(true);
  });
  it("a malformed claims/amr never errors out: refresh without amr is allowed (no password origin), password still denied", async () => {
    expect(denied(await hook({ authentication_method: "password", claims: {} }))).toBe(true);
    expect((await hook({ authentication_method: "token_refresh", claims: { amr: "x" } })).error).toBeUndefined();
    expect((await hook({ authentication_method: "otp" })).error).toBeUndefined();
  });
  it("GRANTS: only supabase_auth_admin may execute it", async () => {
    const r = await adminQuery(`select r, has_function_privilege(r, 'public.custom_access_token_hook(jsonb)', 'execute') as x
      from unnest(array['supabase_auth_admin','anon','authenticated','service_role']) r`);
    const by = Object.fromEntries(r.rows.map((x: { r: string; x: boolean }) => [x.r, x.x]));
    evidence.grants = by;
    expect(by).toEqual({ supabase_auth_admin: true, anon: false, authenticated: false, service_role: false });
    const pub = await adminQuery(`select has_function_privilege('public', 'public.custom_access_token_hook(jsonb)', 'execute') as x`);
    expect(pub.rows[0].x).toBe(false);
  });
  it("it reads and writes no table (no relation referenced in its source)", async () => {
    const r = await adminQuery(`select prosrc, prosecdef, provolatile from pg_proc where proname='custom_access_token_hook' and pronamespace='public'::regnamespace`);
    expect(r.rows[0].prosecdef).toBe(false);
    expect(r.rows[0].provolatile).toBe("s");
    expect(r.rows[0].prosrc).not.toMatch(/\b(insert|update|delete)\b|\bfrom\s+(auth|public)\./i);
  });
});

describe.runIf(PHASE === "pre")("PRE phase (hook NOT yet enabled): record password-origin sessions", () => {
  it("creates a password session for an existing account and stores its refresh token for the post phase", async () => {
    const email = addr("old");
    expect((await createUser(email)).status).toBe(200);
    const s = await passwordLogin(email);
    expect(s.status, "the stack must have the hook DISABLED in this phase").toBe(200);
    writeFileSync(STATE, JSON.stringify({ email, refresh_token: s.body.refresh_token, access_token: s.body.access_token }), { mode: 0o600 });
    evidence.preSessionRecorded = true;
  });
});

describe.runIf(PHASE === "post")("POST phase (real GoTrue, hook ENABLED, confirmations ON)", () => {
  it("NEGATIVE: a password sign-in on an auto-confirmed account yields NO token", async () => {
    const email = addr("pw");
    expect((await createUser(email)).status).toBe(200);
    const r = await passwordLogin(email);
    evidence.passwordSignIn = { status: r.status, hasToken: hasToken(r), error: r.body.error_code ?? r.body.msg ?? r.body.message };
    expect(hasToken(r)).toBe(false);
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
  it("NEGATIVE: password SIGN-UP may create an UNCONFIRMED user, but no session and no later password token ever results", async () => {
    const email = addr("signup");
    const s = await gotrue("signup", { email, password: PW }, ANON);
    expect([200, 201], JSON.stringify(s.body).slice(0, 200)).toContain(s.status);
    expect(hasToken(s)).toBe(false);
    const rows = await adminQuery(`select email_confirmed_at is null as unconfirmed from auth.users where lower(email)=lower($1)`, [email]);
    evidence.passwordSignUp = { created: rows.rows.length === 1, unconfirmed: rows.rows[0]?.unconfirmed, sessionIssued: hasToken(s) };
    expect(rows.rows[0].unconfirmed).toBe(true);
    const login = await passwordLogin(email);
    expect(hasToken(login)).toBe(false);
  });
  it("NEGATIVE: an EXISTING password-origin session (recorded before the hook) is refused at its next refresh", async () => {
    expect(existsSync(STATE), "PRE phase must have run on this stack").toBe(true);
    const st = JSON.parse(readFileSync(STATE, "utf8")) as { refresh_token: string };
    const r = await refresh(st.refresh_token);
    const again = await refresh(st.refresh_token);
    evidence.existingPasswordSessionRefresh = { first: { status: r.status, hasToken: hasToken(r), code: r.body.error_code ?? r.body.msg }, second: { status: again.status, hasToken: hasToken(again), code: again.body.error_code ?? again.body.msg } };
    expect(hasToken(again)).toBe(false);
    expect(hasToken(r)).toBe(false);
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
  it("POSITIVE: a magic-link session works, and refreshes", async () => {
    const email = addr("ml");
    await createUser(email);
    const s = await link("magiclink", email);
    expect(hasToken(s)).toBe(true);
    evidence.magicLink = { amr: ((s.body.access_token as string).split(".")[1] && JSON.parse(Buffer.from((s.body.access_token as string).split(".")[1], "base64url").toString()).amr) };
    const r = await refresh(s.body.refresh_token as string);
    expect(hasToken(r)).toBe(true);
  });
  it("POSITIVE: an email OTP code (the link sent by the accept page) works", async () => {
    const email = addr("otp");
    await createUser(email);
    const l = await gotrue("admin/generate_link", { type: "magiclink", email });
    const s = await gotrue("verify", { type: "email", email, token: l.body.email_otp as string }, ANON);
    expect(hasToken(s)).toBe(true);
  });
  it("POSITIVE: an INVITATION (new user) works", async () => {
    const s = await link("invite", addr("inv"));
    expect(hasToken(s)).toBe(true);
    evidence.invite = true;
  });
  it("POSITIVE: RECOVERY works", async () => {
    const email = addr("rec");
    await createUser(email);
    expect(hasToken(await link("recovery", email))).toBe(true);
    evidence.recovery = true;
  });
  it("POSITIVE: signup CONFIRMATION by link works (the account is confirmed; its password stays unusable)", async () => {
    const email = addr("conf");
    const s = await link("signup", email, { password: PW });
    expect(hasToken(s), JSON.stringify(Object.keys(s.body))).toBe(true);
    expect(hasToken(await passwordLogin(email))).toBe(false);
    evidence.signupConfirmation = true;
  });
  it("POSITIVE: Google/OAuth is covered at function level (no Google on a local stack); a refresh of an oauth session passes", async () => {
    const e = ev("token_refresh", [{ method: "oauth", provider: "google", timestamp: 1 }]);
    expect(allowed(await hook(e), e)).toBe(true);
  });
  it("a password session whose password was set by an admin cannot be revived through refresh either", async () => {
    const email = addr("rv");
    await createUser(email);
    const proven = await link("magiclink", email); // legitimate OTP session
    expect(hasToken(await refresh(proven.body.refresh_token as string))).toBe(true);
    expect(hasToken(await passwordLogin(email))).toBe(false);
  });
});

const claimsOf = (t: string) => JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString("utf8")) as { amr?: unknown; exp: number; iat: number };

describe("mixed-method sessions and repeated refreshes (function level, every amr shape)", () => {
  it.each([
    [[{ method: "password", timestamp: 1 }, { method: "otp", timestamp: 2 }]],
    [[{ method: "otp", timestamp: 1 }, { method: "password", timestamp: 2 }]],
    [[{ method: "oauth", provider: "google", timestamp: 1 }, { method: "password", timestamp: 2 }]],
    [[{ method: "password" }, { method: "password" }, { method: "otp" }]],
  ])("NEGATIVE: ANY password entry in a refreshed session's amr is refused, in either order (%j), on refresh 1..4", async (amr) => {
    for (let i = 1; i <= 4; i++) expect(denied(await hook(ev("token_refresh", amr))), `refresh ${i}`).toBe(true);
  });
  it("a session never BECOMES allowed by refreshing: the same event denied now is denied again, and a clean session stays allowed, over 5 refreshes", async () => {
    const bad = ev("token_refresh", [{ method: "password" }]);
    const good = ev("token_refresh", [{ method: "otp" }]);
    for (let i = 0; i < 5; i++) {
      expect(denied(await hook(bad))).toBe(true);
      expect(allowed(await hook(good), good)).toBe(true);
    }
  });
});

describe.runIf(PHASE === "post")("POST phase: mixed sessions and repeated refreshes on real GoTrue", () => {
  it("the SAME user holds a password-origin session (refused every time) and a magic-link session (works for 4 refreshes), interleaved", async () => {
    const st = JSON.parse(readFileSync(STATE, "utf8")) as { email: string; refresh_token: string };
    let ml = await link("magiclink", st.email);
    expect(hasToken(ml)).toBe(true);
    const log: Array<{ n: number; passwordRefreshToken: boolean; magicLinkToken: boolean }> = [];
    for (let n = 1; n <= 4; n++) {
      const bad = await refresh(st.refresh_token);
      const good = await refresh(ml.body.refresh_token as string);
      log.push({ n, passwordRefreshToken: hasToken(bad), magicLinkToken: hasToken(good) });
      expect(hasToken(bad), `password-origin refresh ${n}`).toBe(false);
      expect(hasToken(good), `magic-link refresh ${n}`).toBe(true);
      expect(claimsOf(good.body.access_token as string).amr, "amr carried unchanged on refresh").toEqual(claimsOf(ml.body.access_token as string).amr);
      ml = good;
    }
    evidence.mixedSessions = { amrOfRefreshedMagicLink: claimsOf(ml.body.access_token as string).amr, interleaved: log };
  });
  it("a Google-style (oauth) session keeps passing the hook over 4 refreshes (function level; no Google on a local stack)", async () => {
    for (let i = 0; i < 4; i++) {
      const e = ev("token_refresh", [{ method: "oauth", provider: "google", timestamp: 1 }]);
      expect(allowed(await hook(e), e)).toBe(true);
    }
  });
  it("ALREADY-ISSUED access tokens: a password-origin access token issued BEFORE the hook still works until its own expiry; measure it", async () => {
    const st = JSON.parse(readFileSync(STATE, "utf8")) as { access_token?: string };
    expect(typeof st.access_token).toBe("string");
    const c = claimsOf(st.access_token as string);
    const res = await fetch(`${E2E_SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${st.access_token}` } });
    evidence.alreadyIssuedAccessToken = { lifetimeSeconds: c.exp - c.iat, secondsLeftWhenChecked: c.exp - Math.floor(Date.now() / 1000), userEndpointStatus: res.status, amr: c.amr };
    // Inside its lifetime it is still accepted; after exp it is not. Blocking takes effect at the NEXT issue or refresh.
    if (c.exp > Math.floor(Date.now() / 1000)) expect(res.status).toBe(200);
  });
});
