import { afterAll, describe, expect, it } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { closePool } from "./helpers/harness";
import { E2E_SERVICE_ROLE_KEY, E2E_SUPABASE_URL, E2E_WEB_SERVER_ENV } from "../../e2e/helpers/local-env";
import { listMessageIds, waitForMagicLink } from "../../e2e/helpers/mail";
import { claimsFromAccessToken, mailboxProofMethod } from "@/lib/auth/email-proof";

// The browser's sign-in is the PKCE flow: the login form calls signInWithOtp from the SSR client, GoTrue mails a verify link,
// the link redirects to /auth/callback?code=..., and the app calls exchangeCodeForSession. The earlier amr measurements used the
// implicit verify endpoint and may not describe that path. CI (run 41553749973) showed every browser magic-link session
// refused once the proof set was cut to `otp`. This test measures the amr of EVERY mailbox PKCE flow on the real GoTrue and
// asserts the SECURE-AND-WORKING outcome: each real mailbox sign-in carries proof, a password session never does.
// Synthetic addresses on a reserved test domain; the stack's mail goes to its own Mailpit.
const ANON = E2E_WEB_SERVER_ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const evidence: Record<string, unknown> = {};
afterAll(async () => {
  if (process.env.AUTH_PKCE_EVIDENCE) writeFileSync(process.env.AUTH_PKCE_EVIDENCE, JSON.stringify(evidence, null, 2));
  await closePool();
});

type Json = Record<string, unknown>;
async function gotrue(method: string, path: string, body: Json | undefined, key: string) {
  const r = await fetch(`${E2E_SUPABASE_URL}/auth/v1/${path}`, { method, headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Json };
}
const addr = (t: string) => `pk-${t}-${randomUUID().slice(0, 8)}@harness.local`;
const amrOf = (token: string) => (claimsFromAccessToken(token) as { amr?: unknown } | null)?.amr;
const userOf = async (token: string) => {
  const r = await fetch(`${E2E_SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
  return (await r.json()) as { email?: string; identities?: never[] };
};
const pkce = () => {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

// Follow the mailed verify link WITHOUT following the redirect to the app, take the PKCE `code` from the Location, and exchange it.
async function redeemPkce(email: string, seen: string[], verifier: string) {
  const link = await waitForMagicLink(email, "http://localhost:3000", { excludeIds: seen });
  const r = await fetch(link, { redirect: "manual" });
  const loc = r.headers.get("location") ?? "";
  const code = new URL(loc, "http://x").searchParams.get("code");
  expect(code, `the verify link must redirect with a PKCE code (got ${r.status} ${loc.slice(0, 60)})`).toBeTruthy();
  return gotrue("POST", "token?grant_type=pkce", { auth_code: code, code_verifier: verifier }, ANON);
}
const proof = async (token: string) => mailboxProofMethod(claimsFromAccessToken(token), (await userOf(token)) as never);

describe("real PKCE mailbox sign-ins carry mailbox proof (what /auth/callback actually receives)", () => {
  it("a NEW address asking for a magic link (create_user) -> PKCE session", async () => {
    const email = addr("new");
    const { verifier, challenge } = pkce();
    const seen = await listMessageIds(email);
    const o = await gotrue("POST", "otp", { email, create_user: true, code_challenge: challenge, code_challenge_method: "s256" }, ANON);
    expect(o.status).toBe(200);
    const s = await redeemPkce(email, seen, verifier);
    expect(s.status).toBe(200);
    const token = s.body.access_token as string;
    evidence.newUserPkce = { amr: amrOf(token), proof: await proof(token) };
    expect(await proof(token), "a real mailbox PKCE sign-in must be proven").not.toBeNull();
  });

  it("an EXISTING confirmed address asking for a magic link -> PKCE session", async () => {
    const email = addr("old");
    expect((await gotrue("POST", "admin/users", { email, email_confirm: true }, E2E_SERVICE_ROLE_KEY)).status).toBe(200);
    const { verifier, challenge } = pkce();
    const seen = await listMessageIds(email);
    expect((await gotrue("POST", "otp", { email, create_user: false, code_challenge: challenge, code_challenge_method: "s256" }, ANON)).status).toBe(200);
    const s = await redeemPkce(email, seen, verifier);
    const token = s.body.access_token as string;
    evidence.existingUserPkce = { amr: amrOf(token), proof: await proof(token) };
    expect(await proof(token)).not.toBeNull();
  });

  it("an account recovery link (PKCE) -> session", async () => {
    const email = addr("rec");
    expect((await gotrue("POST", "admin/users", { email, email_confirm: true }, E2E_SERVICE_ROLE_KEY)).status).toBe(200);
    const { verifier, challenge } = pkce();
    const seen = await listMessageIds(email);
    expect((await gotrue("POST", "recover", { email, code_challenge: challenge, code_challenge_method: "s256" }, ANON)).status).toBe(200);
    const s = await redeemPkce(email, seen, verifier);
    const token = s.body.access_token as string;
    evidence.recoveryPkce = { amr: amrOf(token), proof: await proof(token) };
    expect(await proof(token)).not.toBeNull();
  });

  it("a PASSWORD sign-in of an auto-confirmed account is never proof (control, same run)", async () => {
    const email = addr("pw");
    const pw = `Pw-${randomUUID()}`;
    const su = await gotrue("POST", "signup", { email, password: pw }, ANON);
    expect([200, 201]).toContain(su.status);
    const si = await gotrue("POST", "token?grant_type=password", { email, password: pw }, ANON);
    const token = si.body.access_token as string;
    evidence.passwordControl = { amr: amrOf(token), proof: await proof(token) };
    expect(await proof(token)).toBeNull();
  });

  it("amr survives a PKCE session's refresh", async () => {
    const email = addr("ref");
    const { verifier, challenge } = pkce();
    const seen = await listMessageIds(email);
    await gotrue("POST", "otp", { email, create_user: true, code_challenge: challenge, code_challenge_method: "s256" }, ANON);
    const s = await redeemPkce(email, seen, verifier);
    const r = await gotrue("POST", "token?grant_type=refresh_token", { refresh_token: s.body.refresh_token }, ANON);
    const token = r.body.access_token as string;
    evidence.pkceRefreshed = { amr: amrOf(token), proof: await proof(token) };
    expect(await proof(token)).not.toBeNull();
  });
});
