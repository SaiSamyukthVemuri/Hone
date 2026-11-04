import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { adminQuery, closePool, seedStudio } from "./helpers/harness";
import { E2E_SERVICE_ROLE_KEY, E2E_SUPABASE_URL, E2E_WEB_SERVER_ENV } from "../../e2e/helpers/local-env";
import { claimsFromAccessToken } from "@/lib/auth/email-proof";
import { sessionMailboxProof } from "@/lib/auth/session-email-proof";
import { changeEmailKeepingCompletion, stackAuthConfig } from "./helpers/auth-email-change";

// The stack's effective auth config is part of every result: a pass under one config says nothing about the other.
beforeAll(async () => { console.log(`[auth-config] ${JSON.stringify(await stackAuthConfig())} ${new URL(process.env.E2E_SUPABASE_URL ?? "http://x").host}`); });

// S-2b end to end on a REAL stack, through BOTH gates (Insurance Z-1/G-3, A-1, A-2):
//   * getUser() (GET /auth/v1/user, what supabase-js getUser calls) carries email_change_sent_at and the email identity's
//     updated_at once a real change has set them;
//   * the magic-link attacker's OLD session is refused by the app rule (mailboxProofMethod) AND by 0291 over PostgREST, and a fresh
//     victim sign-in is accepted by both;
//   * A-2: a fresh sign-in made immediately after a change (no delay) is accepted by both gates, all 20 times.
// Synthetic addresses on a reserved test domain; local stack only.
const ANON = E2E_WEB_SERVER_ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const evidence: Record<string, unknown> = {};
afterAll(async () => {
  if (process.env.AUTH_S2B_GATES_EVIDENCE) writeFileSync(process.env.AUTH_S2B_GATES_EVIDENCE, JSON.stringify(evidence, null, 2));
  await closePool();
});

type Json = Record<string, unknown>;
async function gotrue(method: string, path: string, body: Json | undefined, key: string, bearer?: string) {
  const r = await fetch(`${E2E_SUPABASE_URL}/auth/v1/${path}`, { method, headers: { apikey: key, Authorization: `Bearer ${bearer ?? key}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Json };
}
const addr = (t: string) => `s2b-${t}-${randomUUID().slice(0, 8)}@harness.local`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const amrTs = (token: string): number => ((claimsFromAccessToken(token) as { amr?: { timestamp?: number }[] } | null)?.amr ?? []).reduce((m, e) => Math.max(m, Number(e.timestamp) || 0), 0);

async function newConfirmedUser(t: string) {
  const email = addr(t);
  const c = await gotrue("POST", "admin/users", { email, email_confirm: true }, E2E_SERVICE_ROLE_KEY);
  expect(c.status).toBe(200);
  return { email, id: (c.body as { id: string }).id };
}
async function linkSession(email: string, type = "magiclink") {
  const l = await gotrue("POST", "admin/generate_link", { type, email }, E2E_SERVICE_ROLE_KEY);
  expect(l.status).toBe(200);
  return gotrue("POST", "verify", { type, token_hash: l.body.hashed_token as string }, ANON);
}
/** the attacker asks for the victim's address and both halves get confirmed by their MAILED links (Confirm ON or OFF, either double_confirm) */
async function applyChange(accessToken: string, from: string, to: string) {
  const id = (await adminQuery(`select id from auth.users where lower(email) = lower($1)`, [from])).rows[0]?.id as string;
  const done = await changeEmailKeepingCompletion(accessToken, id, from, to, { lastHalf: "new" });
  expect(done.applied, "setup: the change applied").toBe(true);
  return done;
}
const getUser = async (token: string) => (await gotrue("GET", "user", undefined, ANON, token)).body;
async function dbGate(token: string): Promise<Json> {
  const r = await fetch(`${E2E_SUPABASE_URL}/rest/v1/rpc/my_pending_invitation`, { method: "POST", headers: { apikey: ANON, Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" });
  expect(r.status).toBe(200);
  return (await r.json()) as Json;
}
/** The app's real reader: the pure rule, and for a changed account the 0291 RPC session_link_proof_is_current over PostgREST. */
const appGate = async (token: string, user: Json) => {
  const client = {
    auth: { getUser: async () => ({ data: { user }, error: null }), getClaims: async () => ({ data: { claims: claimsFromAccessToken(token) }, error: null }) },
    rpc: async (fn: string) => {
      const r = await fetch(`${E2E_SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: ANON, Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" });
      return r.ok ? { data: await r.json(), error: null } : { data: null, error: { status: r.status } };
    },
  };
  return (await sessionMailboxProof(client as never)).method;
};

// Y-4 (Insurance): the app rule reads email_change_sent_at and the email identity's updated_at from getUser(). If a Supabase CLI or
// GoTrue bump stopped returning them, the rule would silently fail OPEN for an email-changed account. This file is under tests/db, so
// `npm run test:db` (the CI DB lane, which starts a real GoTrue) runs it: the first case below goes red the day the fields vanish.
describe("S-2b through both gates on a real stack", () => {
  it("Y-4 GUARD: getUser carries the two timestamps once set; the attacker's old session is refused by the app rule AND 0291; a fresh victim sign-in is accepted by both", async () => {
    const studio = await seedStudio("s2b");
    const attacker = await newConfirmedUser("atk");
    const victim = addr("vic");
    await adminQuery(`insert into public.pending_invitations (studio_id, email, role, display_name) values ($1, $2, 'practitioner', 'Victim Invite')`, [studio.studioId, victim]);

    const old = await linkSession(attacker.email);
    const oldToken = old.body.access_token as string;
    const preUser = await getUser(oldToken);
    const preKeys = { email_change_sent_at: "email_change_sent_at" in preUser, identityUpdatedAt: ((preUser.identities as Json[]) ?? []).map((i) => "updated_at" in i) };
    expect(await appGate(oldToken, preUser), "control: before any change the link session is proven (absent or null = no constraint)").toBe("email_link_or_otp");

    await sleep(1100);
    await applyChange(oldToken, attacker.email, victim);
    await sleep(1100);

    // The old session survives and is refreshed (a refresh keeps the amr timestamp).
    const refreshed = await gotrue("POST", "token?grant_type=refresh_token", { refresh_token: old.body.refresh_token }, ANON);
    expect(refreshed.status).toBe(200);
    const oldNow = refreshed.body.access_token as string;

    const u = await getUser(oldNow);
    const emailIdentity = ((u.identities as Json[]) ?? []).find((i) => i.provider === "email") as Json | undefined;
    evidence.getUserAfterChange = {
      email_is_victim: u.email === victim,
      has_email_change_sent_at: typeof u.email_change_sent_at === "string",
      email_change_sent_at: u.email_change_sent_at ?? null,
      has_identity_updated_at: typeof emailIdentity?.updated_at === "string",
      identity_updated_at: emailIdentity?.updated_at ?? null,
      beforeAnyChange: preKeys,
    };
    expect(u.email, "setup: the change applied").toBe(victim);
    expect(typeof u.email_change_sent_at, "A-1: getUser carries email_change_sent_at after a real change").toBe("string");
    expect(typeof emailIdentity?.updated_at, "A-1: getUser carries the email identity's updated_at after a real change").toBe("string");

    // Both gates, OLD session.
    expect(await appGate(oldNow, u), "app rule refuses the attacker's old session").toBeNull();
    expect(await dbGate(oldNow), "0291 refuses it over PostgREST: no studio data").toEqual({ status: "proof_required" });

    // Both gates, a fresh victim sign-in.
    await sleep(1100);
    const fresh = await linkSession(victim);
    const freshToken = fresh.body.access_token as string;
    const fu = await getUser(freshToken);
    expect(await appGate(freshToken, fu), "app rule accepts the fresh victim sign-in").toBe("email_link_or_otp");
    expect(await dbGate(freshToken)).toMatchObject({ status: "ok", studio_name: expect.any(String) });
    evidence.gates = { oldAmrTs: amrTs(oldNow), freshAmrTs: amrTs(freshToken), app_old: "refused", app_fresh: "accepted", db_old: "proof_required", db_fresh: "ok" };
  });

  it("A-2: a fresh sign-in made IMMEDIATELY after a change is never refused by either gate (20 samples)", async () => {
    const N = 20;
    let refused = 0;
    let equalSecond = 0;
    const samples: { lastChange: number; freshTs: number; app: string | null; db: string }[] = [];
    for (let i = 0; i < N; i++) {
      const studio = await seedStudio("s2ba2");
      const a = await newConfirmedUser("a2");
      const to = addr("a2to");
      await adminQuery(`insert into public.pending_invitations (studio_id, email, role, display_name) values ($1, $2, 'practitioner', 'A2 Invite')`, [studio.studioId, to]);
      const s = await linkSession(a.email);
      await applyChange(s.body.access_token as string, a.email, to);
      const f = await linkSession(to); // no sleep: the boundary case
      const tok = f.body.access_token as string;
      const row = (await adminQuery(
        `select floor(extract(epoch from greatest(u.email_change_sent_at, (select max(i.updated_at) from auth.identities i where i.user_id = u.id and i.provider = 'email'))))::int as since from auth.users u where u.id = $1`,
        [a.id],
      )).rows[0] as { since: number };
      const user = await getUser(tok);
      const app = await appGate(tok, user);
      const db = (await dbGate(tok)).status as string;
      const ts = amrTs(tok);
      if (ts === row.since) equalSecond++;
      if (app === null || db !== "ok") refused++;
      samples.push({ lastChange: row.since, freshTs: ts, app, db });
    }
    evidence.a2 = { count: N, refused, sameSecondAsChange: equalSecond, note: "refused = app rule null OR 0291 not ok on a fresh sign-in made with no delay after the applied change", samples };
    expect(refused, "no fresh sign-in after a change may be refused").toBe(0);
  }, 180_000);
});
