import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { E2E_SERVICE_ROLE_KEY, E2E_SUPABASE_URL, E2E_WEB_SERVER_ENV } from "../../e2e/helpers/local-env";
import { claimsFromAccessToken, mailboxProofMethod } from "@/lib/auth/email-proof";

// Y-4 guard (Insurance condition 2(a) on #1333). The app rule (lib/auth/email-proof.ts, S-2b) reads email_change_sent_at and the
// email identity's updated_at from getUser() (GET /auth/v1/user, what supabase-js getUser calls). If a Supabase CLI or GoTrue bump
// stopped returning them, the rule would silently fail OPEN for an email-changed account (no change time = no constraint). This
// file is under tests/db, so `npm run test:db` (the CI db-integration lane, which starts a real GoTrue) runs it: the getUser
// assertions go red the day the fields vanish. Through the APP rule only; the database rule (held 0291) is #1338's.
// Synthetic addresses on a reserved test domain; local stack only.
const ANON = E2E_WEB_SERVER_ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY;

type Json = Record<string, unknown>;
async function gotrue(method: string, path: string, body: Json | undefined, key: string, bearer?: string) {
  const r = await fetch(`${E2E_SUPABASE_URL}/auth/v1/${path}`, {
    method,
    headers: { apikey: key, Authorization: `Bearer ${bearer ?? key}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Json };
}
const addr = (t: string) => `gu-${t}-${randomUUID().slice(0, 8)}@harness.local`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const getUser = async (token: string) => (await gotrue("GET", "user", undefined, ANON, token)).body;
const appGate = (token: string, user: Json) => mailboxProofMethod(claimsFromAccessToken(token), user as never);

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
/** the attacker asks for the victim's address and both halves get confirmed */
async function applyChange(accessToken: string, from: string, to: string) {
  expect((await gotrue("PUT", "user", { email: to }, ANON, accessToken)).status).toBe(200);
  for (const type of ["email_change_new", "email_change_current"]) {
    const l = await gotrue("POST", "admin/generate_link", { type, email: from, new_email: to }, E2E_SERVICE_ROLE_KEY);
    if (l.status === 200) await gotrue("POST", "verify", { type: "email_change", token_hash: l.body.hashed_token as string }, ANON);
  }
}

describe("Y-4 GUARD: getUser carries the email-change timestamps the app rule reads", () => {
  it("getUser returns email_change_sent_at and the email identity's updated_at after a real change; the attacker's old session is refused and a fresh victim sign-in (a later second) is accepted", async () => {
    const attacker = await newConfirmedUser("atk");
    const victim = addr("vic");

    const old = await linkSession(attacker.email);
    const oldToken = old.body.access_token as string;
    const pre = await getUser(oldToken);
    expect(appGate(oldToken, pre), "control: before any change the link session is proven (absent or null = no constraint)").toBe("email_link_or_otp");

    await sleep(1100);
    await applyChange(oldToken, attacker.email, victim);
    await sleep(1100);

    // The old session survives and is refreshed (a refresh keeps the amr timestamp).
    const refreshed = await gotrue("POST", "token?grant_type=refresh_token", { refresh_token: old.body.refresh_token }, ANON);
    expect(refreshed.status).toBe(200);
    const oldNow = refreshed.body.access_token as string;

    const u = await getUser(oldNow);
    const emailIdentity = ((u.identities as Json[]) ?? []).find((i) => i.provider === "email") as Json | undefined;
    expect(u.email, "setup: the change applied").toBe(victim);
    expect(typeof u.email_change_sent_at, "getUser carries email_change_sent_at after a real change").toBe("string");
    expect(typeof emailIdentity?.updated_at, "getUser carries the email identity's updated_at after a real change").toBe("string");

    expect(appGate(oldNow, u), "app rule refuses the attacker's old session").toBeNull();

    const fresh = await linkSession(victim);
    expect(fresh.status).toBe(200);
    const freshToken = fresh.body.access_token as string;
    expect(appGate(freshToken, await getUser(freshToken)), "a sign-in a later second than the change is proven").toBe("email_link_or_otp");
  }, 60_000);
});
