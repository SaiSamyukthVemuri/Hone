import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { closePool } from "./helpers/harness";
import { E2E_SERVICE_ROLE_KEY, E2E_SUPABASE_URL, E2E_WEB_SERVER_ENV } from "../../e2e/helpers/local-env";
import { listMessageIds, waitForMagicLink } from "../../e2e/helpers/mail";
import { claimsFromAccessToken, mailboxProofMethod } from "@/lib/auth/email-proof";
import { stackAuthConfig } from "./helpers/auth-email-change";

// The stack's effective auth config is part of every result: a pass under one config says nothing about the other.
beforeAll(async () => { console.log(`[auth-config] ${JSON.stringify(await stackAuthConfig())} ${new URL(process.env.E2E_SUPABASE_URL ?? "http://x").host}`); });

// Insurance Z-2: the amr of the mailbox flows not yet recorded, on a stack with Confirm email ON (a signup sends a confirmation):
//   * password SIGN-UP confirmation link, PKCE (the code_challenge is sent with /signup) and implicit;
//   * an admin INVITE link (inviteUserByEmail has no PKCE: the link redirects with the tokens in the URL fragment).
// Asserts the SECURE-AND-WORKING outcome: a real mailbox redemption is proven, and the unconfirmed password sign-in is not.
// If the stack has Confirm OFF the signup returns a session at once and the signup cases record that and stop.
const ANON = E2E_WEB_SERVER_ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const evidence: Record<string, unknown> = {};
afterAll(async () => {
  if (process.env.AUTH_SIGNUP_AMR_EVIDENCE) writeFileSync(process.env.AUTH_SIGNUP_AMR_EVIDENCE, JSON.stringify(evidence, null, 2));
  await closePool();
});
type Json = Record<string, unknown>;
async function gotrue(method: string, path: string, body: Json | undefined, key: string) {
  const r = await fetch(`${E2E_SUPABASE_URL}/auth/v1/${path}`, { method, headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Json };
}
const addr = (t: string) => `z2-${t}-${randomUUID().slice(0, 8)}@harness.local`;
const PW = `Pw-${randomUUID()}`;
const amrOf = (token: string) => (claimsFromAccessToken(token) as { amr?: unknown } | null)?.amr;
const userOf = async (token: string) => (await (await fetch(`${E2E_SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } })).json()) as { email?: string };
const proof = async (token: string) => mailboxProofMethod(claimsFromAccessToken(token), (await userOf(token)) as never);
const pkce = () => {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};
const tokenFromFragment = (loc: string) => new URLSearchParams(new URL(loc, "http://x").hash.slice(1)).get("access_token");

describe("signup-confirmation and invite amr (Confirm email ON)", () => {
  it("PKCE signup confirmation: the amr of the session the code exchange returns", async () => {
    const email = addr("pkce");
    const { verifier, challenge } = pkce();
    const seen = await listMessageIds(email);
    const su = await gotrue("POST", "signup", { email, password: PW, code_challenge: challenge, code_challenge_method: "s256" }, ANON);
    expect([200, 201]).toContain(su.status);
    if (typeof su.body.access_token === "string") {
      evidence.signupPkce = { note: "Confirm email is OFF on this stack: signup returned a session, no confirmation mail", amr: amrOf(su.body.access_token) };
      return;
    }
    const link = await waitForMagicLink(email, "http://localhost:3000", { excludeIds: seen });
    const r = await fetch(link, { redirect: "manual" });
    const loc = r.headers.get("location") ?? "";
    const code = new URL(loc, "http://x").searchParams.get("code");
    expect(code, `confirmation link must redirect with a PKCE code (${r.status} ${loc.slice(0, 80)})`).toBeTruthy();
    const s = await gotrue("POST", "token?grant_type=pkce", { auth_code: code, code_verifier: verifier }, ANON);
    const token = s.body.access_token as string;
    evidence.signupPkce = { amr: amrOf(token), proof: await proof(token) };
    // Measured: a PKCE password sign-up confirmation is amr `email/signup`. Hone has no UI for it, and the proof set is closed
    // on purpose (Z-2 decision, not widened): it stays UNPROVEN, and the 0292 hook allow-list matches.
    expect((amrOf(token) as { method: string }[]).map((e) => e.method)).toEqual(["email/signup"]);
    expect(await proof(token)).toBeNull();
  });

  it("implicit signup confirmation link: the amr of the session the redirect carries", async () => {
    const email = addr("impl");
    const seen = await listMessageIds(email);
    const su = await gotrue("POST", "signup", { email, password: PW }, ANON);
    expect([200, 201]).toContain(su.status);
    if (typeof su.body.access_token === "string") {
      evidence.signupImplicit = { note: "Confirm email is OFF on this stack", amr: amrOf(su.body.access_token) };
      return;
    }
    // Before confirmation the password sign-in must not work or carry proof.
    const pre = await gotrue("POST", "token?grant_type=password", { email, password: PW }, ANON);
    evidence.passwordBeforeConfirm = { status: pre.status, error: (pre.body.error_code as string) ?? null };
    expect(typeof pre.body.access_token).not.toBe("string");
    const link = await waitForMagicLink(email, "http://localhost:3000", { excludeIds: seen });
    const r = await fetch(link, { redirect: "manual" });
    const token = tokenFromFragment(r.headers.get("location") ?? "");
    expect(token, "implicit confirmation redirects with access_token in the fragment").toBeTruthy();
    evidence.signupImplicit = { amr: amrOf(token as string), proof: await proof(token as string) };
    expect(await proof(token as string)).not.toBeNull();
  });

  it("admin invite link: the amr of the session", async () => {
    const email = addr("inv");
    const seen = await listMessageIds(email);
    const inv = await gotrue("POST", "invite", { email }, E2E_SERVICE_ROLE_KEY);
    expect(inv.status).toBe(200);
    const link = await waitForMagicLink(email, "http://localhost:3000", { excludeIds: seen });
    const r = await fetch(link, { redirect: "manual" });
    const loc = r.headers.get("location") ?? "";
    const token = tokenFromFragment(loc);
    expect(token, `invite link redirects with access_token in the fragment (${r.status} ${loc.slice(0, 80)})`).toBeTruthy();
    evidence.invite = { amr: amrOf(token as string), proof: await proof(token as string) };
    expect(await proof(token as string)).not.toBeNull();
  });
});
