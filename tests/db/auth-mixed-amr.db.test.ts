import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { closePool } from "./helpers/harness";
import { E2E_SERVICE_ROLE_KEY, E2E_SUPABASE_URL, E2E_WEB_SERVER_ENV } from "../../e2e/helpers/local-env";
import { claimsFromAccessToken } from "@/lib/auth/email-proof";
import { stackAuthConfig } from "./helpers/auth-email-change";

// The stack's effective auth config is part of every result: a pass under one config says nothing about the other.
beforeAll(async () => { console.log(`[auth-config] ${JSON.stringify(await stackAuthConfig())} ${new URL(process.env.E2E_SUPABASE_URL ?? "http://x").host}`); });

// Privacy P1 / G3 (and Insurance G-2): can GoTrue ever put a password entry and a mailbox entry in ONE session's amr, in the
// flows Hone uses? MEASUREMENT: each probe records the amr of every session it touches; the evidence states `mixedObserved`.
// It never changes behaviour. Where a mixed amr is observed, 0291 and the app rule would count the session as proven (any
// mailbox entry); the 0292 hook is what refuses password-origin tokens, so the two must stay paired.
const ANON = E2E_WEB_SERVER_ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const evidence: Record<string, unknown> = {};
const seenAmrs: unknown[][] = [];
afterAll(async () => {
  const methods = (a: unknown[]) => a.map((e) => (e as { method?: string }).method);
  const mixed = seenAmrs.filter((a) => methods(a).includes("password") && methods(a).some((m) => m !== "password"));
  evidence.mixedObserved = mixed.length > 0;
  evidence.mixedAmrs = mixed;
  evidence.allDistinctAmrShapes = [...new Set(seenAmrs.map((a) => JSON.stringify(methods(a))))];
  if (process.env.AUTH_MIXED_AMR_EVIDENCE) writeFileSync(process.env.AUTH_MIXED_AMR_EVIDENCE, JSON.stringify(evidence, null, 2));
  await closePool();
});

type Json = Record<string, unknown>;
async function gotrue(method: string, path: string, body: Json | undefined, key: string, bearer?: string) {
  const r = await fetch(`${E2E_SUPABASE_URL}/auth/v1/${path}`, { method, headers: { apikey: key, Authorization: `Bearer ${bearer ?? key}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Json };
}
const addr = (t: string) => `mx-${t}-${randomUUID().slice(0, 8)}@harness.local`;
const PW = `Pw-${randomUUID()}`;
const amr = (s: Json): unknown[] => {
  const a = (claimsFromAccessToken(s.access_token as string) as { amr?: unknown[] } | null)?.amr ?? [];
  seenAmrs.push(a);
  return a;
};
async function linkSession(email: string, type = "magiclink", bearer?: string) {
  const l = await gotrue("POST", "admin/generate_link", { type, email }, E2E_SERVICE_ROLE_KEY);
  expect(l.status).toBe(200);
  return gotrue("POST", "verify", { type, token_hash: l.body.hashed_token as string }, ANON, bearer);
}
const passwordSession = (email: string) => gotrue("POST", "token?grant_type=password", { email, password: PW }, ANON);
const newUser = async (t: string) => {
  const email = addr(t);
  const su = await gotrue("POST", "signup", { email, password: PW }, ANON);
  expect([200, 201]).toContain(su.status);
  return email;
};

describe("amr composition across the flows Hone uses (measurement)", () => {
  it("a link redeemed while HOLDING a password session: the new session's amr, and the old one's after refresh", async () => {
    const email = await newUser("hold");
    const pw = await passwordSession(email);
    const link = await linkSession(email, "magiclink", pw.body.access_token as string);
    const refreshedPw = await gotrue("POST", "token?grant_type=refresh_token", { refresh_token: pw.body.refresh_token }, ANON);
    evidence.linkWhileHoldingPassword = { linkSessionAmr: amr(link.body), passwordSessionAmr: amr(pw.body), passwordSessionAfterRefresh: amr(refreshedPw.body) };
    expect(link.status).toBe(200);
  });

  it("a password sign-in on an account that already has a magic-link session", async () => {
    const email = await newUser("after");
    const link = await linkSession(email);
    const pw = await passwordSession(email);
    evidence.passwordAfterLink = { linkAmr: amr(link.body), passwordAmr: amr(pw.body) };
    expect(pw.status).toBe(200);
  });

  it("setting a password FROM a magic-link session, then refreshing that session", async () => {
    const email = addr("setpw");
    expect((await gotrue("POST", "admin/users", { email, email_confirm: true }, E2E_SERVICE_ROLE_KEY)).status).toBe(200);
    const link = await linkSession(email);
    const set = await gotrue("PUT", "user", { password: PW }, ANON, link.body.access_token as string);
    const refreshed = await gotrue("POST", "token?grant_type=refresh_token", { refresh_token: link.body.refresh_token }, ANON);
    const pwAfter = await passwordSession(email);
    evidence.passwordSetFromLinkSession = { setStatus: set.status, linkAmr: amr(link.body), linkAmrAfterRefresh: refreshed.status === 200 ? amr(refreshed.body) : `refresh status ${refreshed.status}`, passwordSignInAmr: pwAfter.status === 200 ? amr(pwAfter.body) : `status ${pwAfter.status}` };
  });

  it("reauthentication (nonce) from a password session, and from a link session", async () => {
    const email = await newUser("reauth");
    const pw = await passwordSession(email);
    const re = await gotrue("GET", "reauthenticate", undefined, ANON, pw.body.access_token as string);
    evidence.reauthenticateFromPassword = { status: re.status, passwordAmr: amr(pw.body) };
    const link = await linkSession(email);
    const re2 = await gotrue("GET", "reauthenticate", undefined, ANON, link.body.access_token as string);
    evidence.reauthenticateFromLink = { status: re2.status, linkAmr: amr(link.body) };
  });

  it("a recovery link redeemed on an account with a password, then a password sign-in and a refresh of each", async () => {
    const email = await newUser("recov");
    const rec = await linkSession(email, "recovery");
    const pw = await passwordSession(email);
    const r1 = await gotrue("POST", "token?grant_type=refresh_token", { refresh_token: rec.body.refresh_token }, ANON);
    const r2 = await gotrue("POST", "token?grant_type=refresh_token", { refresh_token: pw.body.refresh_token }, ANON);
    evidence.recoveryThenPassword = { recoveryAmr: amr(rec.body), passwordAmr: amr(pw.body), recoveryRefreshed: amr(r1.body), passwordRefreshed: amr(r2.body) };
  });

  it("an admin-issued password change on an account with live link and password sessions (what hardening does): what re-issue yields", async () => {
    const email = await newUser("harden");
    const link = await linkSession(email);
    const id = ((await gotrue("GET", "user", undefined, ANON, link.body.access_token as string)).body as { id?: string }).id;
    const upd = await gotrue("PUT", `admin/users/${id}`, { password: `Pw-${randomUUID()}` }, E2E_SERVICE_ROLE_KEY);
    const reissued = await linkSession(email);
    evidence.adminPasswordChangeThenReissue = { adminStatus: upd.status, reissuedAmr: amr(reissued.body) };
  });
});
