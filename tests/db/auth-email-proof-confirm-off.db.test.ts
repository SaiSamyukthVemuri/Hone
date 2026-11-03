import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { adminQuery, closePool } from "./helpers/harness";
import { E2E_SERVICE_ROLE_KEY, E2E_SUPABASE_URL, E2E_WEB_SERVER_ENV } from "../../e2e/helpers/local-env";
import { claimsFromAccessToken, mailboxProofMethod } from "@/lib/auth/email-proof";

// INSURANCE S-1 / S-2 NEGATIVE CONTROLS (#1333 review), on a stack with Confirm email OFF (GOTRUE_MAILER_AUTOCONFIRM=true), the
// state the PR exists for. Each test states the SECURE outcome and fails if an attacker session carries a mailbox-looking amr
// without controlling the victim's mailbox. Synthetic addresses on a reserved test domain; no real email.
//  S-1: a password SIGN-UP for a victim address returns a session immediately. What amr does it carry?
//  S-2: an attacker who really controls their OWN mailbox changes the account's email to the victim's address from that session.
//       Does the otp session then count as proof for the victim's address?
const ANON = E2E_WEB_SERVER_ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const evidence: Record<string, unknown> = {};
afterAll(async () => {
  if (process.env.AUTH_CONTROLS_EVIDENCE) writeFileSync(process.env.AUTH_CONTROLS_EVIDENCE, JSON.stringify(evidence, null, 2));
  await closePool();
});

type Json = Record<string, unknown>;
async function gotrue(method: string, path: string, body: Json | undefined, key: string, bearer?: string) {
  const r = await fetch(`${E2E_SUPABASE_URL}/auth/v1/${path}`, { method, headers: { apikey: key, Authorization: `Bearer ${bearer ?? key}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Json };
}
const post = (p: string, b: Json, key = E2E_SERVICE_ROLE_KEY) => gotrue("POST", p, b, key);
const addr = (t: string) => `ct-${t}-${randomUUID().slice(0, 8)}@harness.local`;
const PW = `Pw-${randomUUID()}`;
const amrOf = (token: string) => (claimsFromAccessToken(token) as { amr?: unknown } | null)?.amr;
const userOf = async (token: string) => (await gotrue("GET", "user", undefined, ANON, token)).body as { id?: string; email?: string; identities?: never[]; email_confirmed_at?: string; updated_at?: string };
async function linkSession(email: string) {
  const l = await post("admin/generate_link", { type: "magiclink", email });
  expect(l.status, "setup: generate_link").toBe(200);
  return post("verify", { type: "magiclink", token_hash: l.body.hashed_token as string }, ANON);
}

describe("S-1: password sign-up with Confirm email OFF", () => {
  it("the session a password SIGN-UP returns for a victim address must NOT count as mailbox proof", async () => {
    const victim = addr("s1");
    const s = await post("signup", { email: victim, password: PW }, ANON);
    expect([200, 201]).toContain(s.status);
    const token = s.body.access_token as string | undefined;
    evidence.s1 = { signupStatus: s.status, sessionIssued: typeof token === "string", amr: token ? amrOf(token) : null };
    expect(typeof token, "with Confirm email OFF a sign-up returns a session (the attack surface exists)").toBe("string");
    const user = await userOf(token as string);
    const proof = mailboxProofMethod(claimsFromAccessToken(token as string), user as never);
    (evidence.s1 as Json).proofMethod = proof;
    expect(proof, "SECURE outcome: a password sign-up session proves nothing about the mailbox").toBeNull();
  });
  it("a password SIGN-IN of that account (the auto-confirmed attacker account) also proves nothing", async () => {
    const victim = addr("s1b");
    await post("signup", { email: victim, password: PW }, ANON);
    const s = await post("token?grant_type=password", { email: victim, password: PW }, ANON);
    expect(s.status).toBe(200);
    const proof = mailboxProofMethod(claimsFromAccessToken(s.body.access_token as string), (await userOf(s.body.access_token as string)) as never);
    (evidence.s1 as Json).passwordSignInProof = proof;
    expect(proof).toBeNull();
  });
});

describe("S-1b: what a LEGITIMATE first sign-in by link carries (to know what can safely count)", () => {
  it("records the amr of a brand-new user's first magic-link sign-in and of a confirmed existing user's", async () => {
    const fresh = addr("new");
    const l = await post("admin/generate_link", { type: "magiclink", email: fresh }); // creates the user as the app's OTP flow does
    // A link generated for a user that did not exist is a SIGNUP-type link (verification_type says so).
    const s = await post("verify", { type: l.body.verification_type as string, token_hash: l.body.hashed_token as string }, ANON);
    expect(s.status).toBe(200);
    evidence.s1b = { verificationType: l.body.verification_type, newUserLinkAmr: amrOf(s.body.access_token as string) };
    const proof = mailboxProofMethod(claimsFromAccessToken(s.body.access_token as string), (await userOf(s.body.access_token as string)) as never);
    expect(proof).not.toBeNull();
  });
});

describe("S-1c: a signup CONFIRMATION link redeemed for a password account", () => {
  it("records the amr; a password the registrant set stays unproven by it unless the mailbox was used", async () => {
    const email = addr("conf");
    const l = await post("admin/generate_link", { type: "signup", email, password: PW });
    const s = await post("verify", { type: "signup", token_hash: l.body.hashed_token as string }, ANON);
    expect(s.status).toBe(200);
    evidence.s1c = { signupLinkAmr: amrOf(s.body.access_token as string) };
  });
});

describe("S-2: an attacker changes the account email to the victim's address from a genuine otp session", () => {
  it("the otp session must NOT prove the VICTIM's mailbox after the change", async () => {
    const attacker = addr("atk");
    const victim = addr("vic");
    expect((await post("admin/users", { email: attacker, email_confirm: true })).status).toBe(200);
    const s = await linkSession(attacker); // genuinely proves the ATTACKER's mailbox
    const token = s.body.access_token as string;
    expect(mailboxProofMethod(claimsFromAccessToken(token), (await userOf(token)) as never)).not.toBeNull();

    const change = await gotrue("PUT", "user", { email: victim }, ANON, token);
    const after = await userOf(token);
    // Does GoTrue apply the change at once, or hold it as email_change pending a confirmation?
    const row = (await adminQuery(`select email, email_change, email_confirmed_at, updated_at from auth.users where id=$1`, [after.id])).rows[0];
    evidence.s2 = { changeStatus: change.status, emailNow: row.email === attacker ? "unchanged (change held pending confirmation)" : "CHANGED IMMEDIATELY", pendingChange: row.email_change === victim, amrBefore: amrOf(token) };
    // Refresh so the claims carry whatever GoTrue now thinks the email is.
    const r = await post("token?grant_type=refresh_token", { refresh_token: s.body.refresh_token as string }, ANON);
    const t2 = (r.body.access_token as string) ?? token;
    const u2 = await userOf(t2);
    const proofForVictim = u2.email === victim ? mailboxProofMethod(claimsFromAccessToken(t2), u2 as never) : null;
    (evidence.s2 as Json).afterRefresh = { emailOnAccount: u2.email === victim ? "VICTIM" : "attacker", proofForVictimAddress: proofForVictim, amr: amrOf(t2) };
    expect(proofForVictim, "SECURE outcome: no proof for an address the session never received mail at").toBeNull();
  });
});
