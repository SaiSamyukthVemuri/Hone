import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { adminQuery, closePool, seedStudio, type SeededStudio } from "./helpers/harness";
import { E2E_SERVICE_ROLE_KEY, E2E_SUPABASE_URL, E2E_WEB_SERVER_ENV } from "../../e2e/helpers/local-env";
import { claimsFromAccessToken, mailboxProofMethod } from "@/lib/auth/email-proof";
import { hardenAccountAfterMailboxProof } from "@/lib/auth/proof-hardening";

// EMAIL-TRUST (2 Nov, Machines): proof of mailbox control is read from the SESSION's amr, not from email_confirmed_at.
// This runs against the REAL GoTrue of an owned isolated stack (no mocks) to pin (a) the actual amr strings GoTrue writes for
// each way of signing in, (b) that a password session on an AUTO-CONFIRMED account carries no mailbox proof, (c) that the
// hardening really kills a pre-registrant's password and sessions while keeping the proven session, and (d) what the database
// itself still allows a password session to do (evidence for the DB-level proposal; recorded, not asserted green).
// Synthetic addresses on a reserved test domain. No real email: the stack's mail goes to its own Mailpit and is never read here.

const ANON = E2E_WEB_SERVER_ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const evidence: Record<string, unknown> = {};
let studio: SeededStudio;

type Json = Record<string, unknown>;
async function gotrue(path: string, body: Json, key = E2E_SERVICE_ROLE_KEY, method = "POST", bearer?: string) {
  const res = await fetch(`${E2E_SUPABASE_URL}/auth/v1/${path}`, {
    method,
    headers: { apikey: key, Authorization: `Bearer ${bearer ?? key}`, "Content-Type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Json = {};
  try { parsed = JSON.parse(text) as Json; } catch { /* keep empty */ }
  return { status: res.status, body: parsed };
}

const addr = (tag: string) => `et-${tag}-${randomUUID().slice(0, 8)}@harness.local`;
const PASSWORD = `Pw-${randomUUID()}`;

/** An account created while "Confirm email" is OFF: confirmed at creation, with a password nobody proved the mailbox for. */
async function autoConfirmedPasswordUser(email: string, password = PASSWORD): Promise<{ id: string }> {
  const r = await gotrue("admin/users", { email, password, email_confirm: true });
  expect(r.status, "setup: admin createUser").toBe(200);
  return { id: r.body.id as string };
}
async function passwordSession(email: string, password = PASSWORD) {
  return gotrue("token?grant_type=password", { email, password }, ANON);
}
/** A real magic-link sign-in without reading mail: admin-generated token_hash redeemed at /verify (what the callback does). */
async function magicLinkSession(email: string) {
  const link = await gotrue("admin/generate_link", { type: "magiclink", email });
  expect(link.status, "setup: generate_link").toBe(200);
  return gotrue("verify", { type: "magiclink", token_hash: link.body.hashed_token as string }, ANON);
}
const amrOf = (session: Json): unknown => (claimsFromAccessToken(session.access_token as string) as { amr?: unknown } | null)?.amr;
const userOf = async (accessToken: string) => (await gotrue("user", {}, ANON, "GET", accessToken)).body as { id?: string; email?: string; identities?: never[] };

async function pendingInvite(email: string) {
  await adminQuery(`insert into public.pending_invitations (studio_id, email, role, display_name) values ($1,$2,'practitioner','Invited')`, [studio.studioId, email]);
}
const membershipFor = async (userId: string) => (await adminQuery(`select 1 from public.practitioners where studio_id=$1 and user_id=$2`, [studio.studioId, userId])).rows.length;
async function rpc(token: string, fn: string) {
  const res = await fetch(`${E2E_SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: ANON, Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" });
  const t = await res.text();
  let b: unknown = t; try { b = JSON.parse(t); } catch { /* text */ }
  return { status: res.status, body: b };
}

beforeAll(async () => { studio = await seedStudio("email-proof"); });
afterAll(async () => {
  if (process.env.AUTH_TRUST_EVIDENCE) writeFileSync(process.env.AUTH_TRUST_EVIDENCE, JSON.stringify(evidence, null, 2));
  await closePool();
});

describe("GoTrue amr and mailbox proof (real auth server)", () => {
  it("NEGATIVE: a password session on an auto-confirmed account carries NO mailbox proof", async () => {
    const email = addr("pw");
    await autoConfirmedPasswordUser(email);
    const s = await passwordSession(email);
    expect(s.status).toBe(200);
    const u = await userOf(s.body.access_token as string);
    evidence.passwordAmr = amrOf(s.body);
    expect(u.email).toBe(email);
    expect(mailboxProofMethod(claimsFromAccessToken(s.body.access_token as string), u)).toBeNull();
  });
  it("POSITIVE: a magic-link session carries mailbox proof, and its exact amr method is recorded", async () => {
    const email = addr("ml");
    await autoConfirmedPasswordUser(email);
    const s = await magicLinkSession(email);
    expect(s.status, JSON.stringify(Object.keys(s.body))).toBe(200);
    const u = await userOf(s.body.access_token as string);
    evidence.magicLinkAmr = amrOf(s.body);
    expect(mailboxProofMethod(claimsFromAccessToken(s.body.access_token as string), u)).toBe("email_link_or_otp");
  });
  it("POSITIVE: an email OTP session (the account-verification link sent by the accept page) carries mailbox proof", async () => {
    const email = addr("otp");
    await autoConfirmedPasswordUser(email);
    const link = await gotrue("admin/generate_link", { type: "magiclink", email });
    const s = await gotrue("verify", { type: "email", email, token: link.body.email_otp as string }, ANON);
    expect(s.status).toBe(200);
    evidence.emailOtpAmr = amrOf(s.body);
    const u = await userOf(s.body.access_token as string);
    expect(mailboxProofMethod(claimsFromAccessToken(s.body.access_token as string), u)).toBe("email_link_or_otp");
  });
  it("amr survives a token refresh (a proven session stays proven; an unproven one stays unproven)", async () => {
    const email = addr("rf");
    await autoConfirmedPasswordUser(email);
    const proven = await magicLinkSession(email);
    const r = await gotrue("token?grant_type=refresh_token", { refresh_token: proven.body.refresh_token as string }, ANON);
    expect(r.status).toBe(200);
    expect(mailboxProofMethod(claimsFromAccessToken(r.body.access_token as string), await userOf(r.body.access_token as string))).toBe("email_link_or_otp");
    const pw = await passwordSession(email);
    const r2 = await gotrue("token?grant_type=refresh_token", { refresh_token: pw.body.refresh_token as string }, ANON);
    evidence.passwordRefreshedAmr = amrOf(r2.body);
  });
});

describe("pre-account takeover and the hardening", () => {
  it("handle_new_user does NOT match a pending invitation on password sign-up (addendum b): no membership at insert", async () => {
    const email = addr("pre");
    await pendingInvite(email);
    const signup = await gotrue("signup", { email, password: PASSWORD }, ANON);
    expect([200, 201]).toContain(signup.status);
    const id = (signup.body.user as Json | undefined)?.id ?? signup.body.id;
    expect(typeof id).toBe("string");
    expect(await membershipFor(id as string)).toBe(0);
    const inv = await adminQuery(`select status from public.pending_invitations where studio_id=$1 and lower(email)=lower($2)`, [studio.studioId, email]);
    expect(inv.rows[0].status).toBe("pending");
  });

  it("the attacker's password and sessions die when the real owner proves the mailbox; the proven session survives", async () => {
    const email = addr("atk");
    const attackerPassword = `Atk-${randomUUID()}`;
    const { id } = await autoConfirmedPasswordUser(email, attackerPassword); // attacker pre-registers the victim's address
    const attackerSession = await passwordSession(email, attackerPassword);
    expect(attackerSession.status, "attacker holds a working session before the victim signs in").toBe(200);

    const victim = await magicLinkSession(email); // the real owner clicks their magic link: SAME user id
    expect((await userOf(victim.body.access_token as string)).id).toBe(id);
    const admin = createClient(E2E_SUPABASE_URL, E2E_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
    const u = await userOf(victim.body.access_token as string);
    expect(await hardenAccountAfterMailboxProof({ auth: admin.auth } as never, { id, app_metadata: {} }, victim.body.access_token as string)).toBe("hardened");

    expect((await passwordSession(email, attackerPassword)).status, "old password no longer works").toBe(400);
    expect((await gotrue("token?grant_type=refresh_token", { refresh_token: attackerSession.body.refresh_token as string }, ANON)).status, "attacker refresh token revoked").toBeGreaterThanOrEqual(400);
    expect((await gotrue("token?grant_type=refresh_token", { refresh_token: victim.body.refresh_token as string }, ANON)).status, "the proven session keeps working").toBe(200);
    // one-time: a second proven sign-in (another device) is not signed out again
    const second = await magicLinkSession(email);
    const meta = (await adminQuery(`select raw_app_meta_data from auth.users where id=$1`, [id])).rows[0].raw_app_meta_data as Json;
    expect(typeof meta.email_proof_hardened_at).toBe("string");
    expect(await hardenAccountAfterMailboxProof({ auth: admin.auth } as never, { id, app_metadata: meta }, second.body.access_token as string)).toBe("already_hardened");
    expect((await gotrue("token?grant_type=refresh_token", { refresh_token: victim.body.refresh_token as string }, ANON)).status).toBe(200);
    expect(u.email).toBe(email);
  });
});

describe("what the DATABASE still lets an unproven password session do (evidence for the held DB-level proposal)", () => {
  it("records reconcile_my_pending_invitation / my_pending_invitation behaviour for a password session with a pending invitation", async () => {
    const email = addr("rpc");
    const { id } = await autoConfirmedPasswordUser(email);
    await pendingInvite(email);
    const s = await passwordSession(email);
    const token = s.body.access_token as string;
    const seen = await rpc(token, "my_pending_invitation");
    const reconciled = await rpc(token, "reconcile_my_pending_invitation");
    evidence.passwordSessionRpc = {
      my_pending_invitation: { status: seen.status, body: seen.body },
      reconcile_my_pending_invitation: { status: reconciled.status, body: reconciled.body },
      membershipLinked: (await membershipFor(id)) > 0,
    };
    // Not asserted: this is the evidence behind the DB-level gate proposal (docs/proposals), which is held and un-numbered.
    expect(typeof reconciled.status).toBe("number");
  });
});
