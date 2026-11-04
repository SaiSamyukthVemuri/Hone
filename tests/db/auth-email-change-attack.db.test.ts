import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { adminQuery, closePool } from "./helpers/harness";
import { E2E_SERVICE_ROLE_KEY, E2E_SUPABASE_URL, E2E_WEB_SERVER_ENV } from "../../e2e/helpers/local-env";
import { listMessageIds } from "../../e2e/helpers/mail";
import { claimsFromAccessToken, mailboxProofMethod } from "@/lib/auth/email-proof";
import { changeEmailKeepingCompletion, fastVerifyLink, stackAuthConfig } from "./helpers/auth-email-change";

// S-2b on a REAL GoTrue, written for the HOSTED shape (Confirm email ON) and valid for either double_confirm_changes value
// (auth-worker, #1333 rule fix). It pins the three attack sessions the whole-second rules got wrong, and the normal sign-ins they
// broke, through the APP rule (lib/auth/email-proof.ts). The database rule (held 0291) is #1338's and is asserted there.
//   * the attacker's session created BEFORE an applied change, in the SAME whole second as the change (Codex P1 on `>=`);
//   * the session GoTrue returns to whoever clicks the LAST confirm link (implicit flow: amr `otp`, ~10 ms after the change);
//   * refresh of either keeps it refused.
// Every precondition is asserted, so no case can pass because its attack never happened. Synthetic addresses; local stack only.
const ANON = E2E_WEB_SERVER_ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const evidence: Record<string, unknown> = {};
beforeAll(async () => { console.log(`[auth-config] ${JSON.stringify(await stackAuthConfig())} ${new URL(process.env.E2E_SUPABASE_URL ?? "http://x").host}`); });
afterAll(async () => {
  if (process.env.AUTH_EMAIL_CHANGE_ATTACK_EVIDENCE) writeFileSync(process.env.AUTH_EMAIL_CHANGE_ATTACK_EVIDENCE, JSON.stringify(evidence, null, 2));
  await closePool();
});

type Json = Record<string, unknown>;
async function gotrue(method: string, path: string, body: Json | undefined, key: string, bearer?: string) {
  const r = await fetch(`${E2E_SUPABASE_URL}/auth/v1/${path}`, { method, headers: { apikey: key, Authorization: `Bearer ${bearer ?? key}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Json };
}
const addr = (t: string) => `eca-${t}-${randomUUID().slice(0, 8)}@harness.local`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pkce = () => { const verifier = randomBytes(48).toString("base64url"); return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") }; };
const claimsOf = (t: string) => claimsFromAccessToken(t) as { amr?: { method: string; timestamp: number }[]; session_id?: string } | null;
const methods = (t: string) => (claimsOf(t)?.amr ?? []).map((e) => e.method);
const amrSecond = (t: string) => Math.max(...(claimsOf(t)?.amr ?? []).map((e) => Math.floor(Number(e.timestamp) || 0)));
const getUser = async (t: string) => (await gotrue("GET", "user", undefined, ANON, t)).body;
/** The app rule exactly as the server applies it: verified claims + the getUser() account. */
const appGate = async (t: string) => mailboxProofMethod(claimsFromAccessToken(t), (await getUser(t)) as never);
const refresh = async (rt: unknown) => {
  const r = await gotrue("POST", "token?grant_type=refresh_token", { refresh_token: rt }, ANON);
  expect(r.status, "setup: the session is still refreshable").toBe(200);
  return r.body.access_token as string;
};

async function confirmedUser(t: string) {
  const email = addr(t);
  const c = await gotrue("POST", "admin/users", { email, email_confirm: true }, E2E_SERVICE_ROLE_KEY);
  expect(c.status).toBe(200);
  return { email, id: c.body.id as string };
}
async function linkSession(email: string) {
  const l = await gotrue("POST", "admin/generate_link", { type: "magiclink", email }, E2E_SERVICE_ROLE_KEY);
  expect(l.status).toBe(200);
  const s = await gotrue("POST", "verify", { type: "magiclink", token_hash: l.body.hashed_token as string }, ANON);
  expect(s.status).toBe(200);
  return s.body as { access_token: string; refresh_token: string };
}
/** microsecond times, read from the database: the change anchor and the session's creation */
async function times(userId: string, token: string) {
  const r = await adminQuery(
    `select extract(epoch from greatest(u.email_change_sent_at, (select max(i.updated_at) from auth.identities i where i.user_id = u.id and i.provider = 'email')))::float8 as anchor,
            (select extract(epoch from s.created_at)::float8 from auth.sessions s where s.id = $2::uuid and s.user_id = u.id) as s_created
       from auth.users u where u.id = $1`, [userId, claimsOf(token)?.session_id ?? null]);
  return r.rows[0] as { anchor: number; s_created: number | null };
}
async function pkceLinkSession(email: string, createUser = false) {
  const p = pkce();
  const seen = await listMessageIds(email);
  expect((await gotrue("POST", "otp", { email, create_user: createUser, code_challenge: p.challenge, code_challenge_method: "s256" }, ANON)).status).toBe(200);
  const link = await fastVerifyLink(email, seen);
  expect(link, "setup: the sign-in link was mailed").toBeTruthy();
  const r = await fetch(link as string, { redirect: "manual" });
  const code = new URL(r.headers.get("location") ?? "", "http://x").searchParams.get("code");
  const s = await gotrue("POST", "token?grant_type=pkce", { auth_code: code, code_verifier: p.verifier }, ANON);
  expect(s.status).toBe(200);
  return s.body as { access_token: string; refresh_token: string };
}

describe("ATTACK: the session the LAST confirm click returns is not proof of the new address", () => {
  for (const lastHalf of ["current", "new"] as const) {
    it(`implicit flow, ${lastHalf === "current" ? "the OLD address (attacker) clicks last" : "the NEW address (victim) clicks last"}`, async () => {
      const { doubleConfirm, mailerAutoconfirm } = await stackAuthConfig();
      const attacker = await confirmedUser(`c-${lastHalf}`);
      const victim = addr(`cv-${lastHalf}`);
      const old = await linkSession(attacker.email);
      await sleep(1100);
      const done = await changeEmailKeepingCompletion(old.access_token, attacker.id, attacker.email, victim, { lastHalf });
      expect(done.applied, "setup: the change applied").toBe(true);
      expect(done.completionToken, "precondition: GoTrue returned a session to the completing click").toBeTruthy();
      const token = done.completionToken as string;
      // Confirm ON (hosted): with double confirm the LAST clicker completes it; without, only the new address is mailed and its click
      // completes it. Confirm OFF (MEASURED): GoTrue applies the change on the FIRST click of EITHER link, double confirm or not, so
      // there the completer is recorded, not predicted. Either way the completion session must be refused.
      if (mailerAutoconfirm === false) expect(done.completedBy, "precondition: the expected half completed the change").toBe(doubleConfirm === true ? lastHalf : "new");
      else expect(done.completedBy, "precondition: some click completed the change").not.toBeNull();
      expect(methods(token), "precondition: the completion session carries `otp`, a proof-set method (the dangerous shape)").toContain("otp");
      const t = await times(attacker.id, token);
      expect(t.s_created, "precondition: the completion session was created AFTER the change (microseconds)").toBeGreaterThan(t.anchor);
      evidence[`completion_implicit_${lastHalf}`] = { mailerAutoconfirm, doubleConfirm, completedBy: done.completedBy, amr: claimsOf(token)?.amr, sessionMinusAnchorMs: Math.round(((t.s_created as number) - t.anchor) * 1000 * 100) / 100, amrSecondMinusAnchorSecond: amrSecond(token) - Math.floor(t.anchor) };
      expect(await appGate(token), "SECURE: the completion session does not prove the new address").toBeNull();
      expect(await appGate(await refresh(done.completionRefreshToken)), "SECURE: nor does its refresh").toBeNull();
    }, 60_000);
  }

  it("PKCE flow (control): the completion session's amr is `email_change`, outside the proof set", async () => {
    const attacker = await confirmedUser("cp");
    const victim = addr("cpv");
    const old = await linkSession(attacker.email);
    await sleep(1100);
    const done = await changeEmailKeepingCompletion(old.access_token, attacker.id, attacker.email, victim, { lastHalf: "current", pkce: pkce() });
    expect(done.applied, "setup: the change applied").toBe(true);
    expect(done.completionToken, "precondition: the code exchange returned a session").toBeTruthy();
    expect(methods(done.completionToken as string)).toEqual(["email_change"]);
    expect(await appGate(done.completionToken as string)).toBeNull();
  }, 60_000);
});

describe("ATTACK: a session created BEFORE the change, in the SAME whole second as it (Codex P1)", () => {
  it("is refused, and so is its refresh (precondition reached by bounded retries; never skipped)", async () => {
    const tries: Json[] = [];
    let reached: { token: string; refreshToken: string; userId: string } | null = null;
    for (let i = 0; i < 12 && !reached; i++) {
      const a = await confirmedUser(`ss${i}`);
      const victim = addr(`ssv${i}`);
      // Start just after a second boundary so the sign-in and the whole change can fit inside one second.
      await sleep(1000 - (Date.now() % 1000) + 5);
      const s0 = await linkSession(a.email);
      const done = await changeEmailKeepingCompletion(s0.access_token, a.id, a.email, victim, { lastHalf: "new" });
      const t = await times(a.id, s0.access_token);
      const row = { applied: done.applied, amrSecond: amrSecond(s0.access_token), anchorSecond: Math.floor(t.anchor), sessionBeforeAnchorMs: t.s_created === null ? null : Math.round((t.anchor - t.s_created) * 100000) / 100 };
      tries.push(row);
      if (done.applied && row.amrSecond === row.anchorSecond && t.s_created !== null && t.s_created < t.anchor) reached = { token: s0.access_token, refreshToken: s0.refresh_token, userId: a.id };
    }
    evidence.sameSecond = tries;
    expect(reached, `precondition: a pre-change session in the change's own second was produced (tries: ${JSON.stringify(tries)})`).not.toBeNull();
    const r = reached as NonNullable<typeof reached>;
    expect(await appGate(r.token), "SECURE: the same-second pre-change session is refused").toBeNull();
    expect(await appGate(await refresh(r.refreshToken)), "SECURE: refresh does not launder it").toBeNull();
  }, 120_000);
});

describe("after an applied change, the APP rule alone is fail-closed for that account (the database rule, held 0291, decides)", () => {
  it("the attacker's older session and its refresh are refused; a fresh link sign-in to the new address is ALSO refused by the app rule alone", async () => {
    const attacker = await confirmedUser("fv");
    const victim = addr("fvv");
    const old = await linkSession(attacker.email);
    expect(await appGate(old.access_token), "control: proven before any change").toBe("email_link_or_otp");
    await sleep(1100);
    expect((await changeEmailKeepingCompletion(old.access_token, attacker.id, attacker.email, victim, { lastHalf: "new" })).applied, "setup: applied").toBe(true);
    expect(await appGate(await refresh(old.refresh_token)), "SECURE: refresh does not launder the old session").toBeNull();
    await sleep(1100);
    const fresh = await pkceLinkSession(victim);
    expect(methods(fresh.access_token), "setup: a real PKCE magic link to the new address").toEqual(["magiclink"]);
    expect(await appGate(fresh.access_token), "the app rule alone cannot tell this from the attacker's, so it refuses (Google still proves)").toBeNull();
  }, 60_000);
});

describe("NORMAL ACCESS under the hosted config (never-changed accounts), through the app rule", () => {
  it("an existing account (older than a second) signs in by PKCE magic link and by implicit link; both survive refresh", async () => {
    const admin = await confirmedUser("adm");
    await sleep(1300);
    const p = await pkceLinkSession(admin.email);
    expect(methods(p.access_token)).toEqual(["magiclink"]);
    expect(await appGate(p.access_token)).toBe("email_link_or_otp");
    expect(await appGate(await refresh(p.refresh_token)), "refresh keeps the proven state").toBe("email_link_or_otp");
    const i = await linkSession(admin.email);
    expect(await appGate(i.access_token)).toBe("email_link_or_otp");
  }, 60_000);

  it("email OTP code (admin generate_link email_otp, verify type email) on an existing account", async () => {
    const u = await confirmedUser("otp");
    const l = await gotrue("POST", "admin/generate_link", { type: "magiclink", email: u.email }, E2E_SERVICE_ROLE_KEY);
    expect(typeof l.body.email_otp, "setup: GoTrue issued a code").toBe("string");
    const s = await gotrue("POST", "verify", { type: "email", email: u.email, token: l.body.email_otp as string }, ANON);
    expect(s.status).toBe(200);
    expect(methods(s.body.access_token as string)).toEqual(["otp"]);
    expect(await appGate(s.body.access_token as string)).toBe("email_link_or_otp");
  }, 60_000);

  it("a brand-new account's first link sign-in in the SAME second as its creation (the case strict `>` refused)", async () => {
    const tries: Json[] = [];
    let ok = false;
    for (let i = 0; i < 6 && !ok; i++) {
      await sleep(1000 - (Date.now() % 1000) + 5);
      const u = await confirmedUser(`first${i}`);
      const s = await linkSession(u.email);
      const t = await adminQuery(`select extract(epoch from i.updated_at)::float8 as upd, extract(epoch from i.created_at)::float8 as cre from auth.identities i where i.user_id = $1 and i.provider = 'email'`, [u.id]);
      const row = { amrSecond: amrSecond(s.access_token), identitySecond: Math.floor(t.rows[0].upd as number), identityUpdatedEqualsCreated: t.rows[0].upd === t.rows[0].cre };
      tries.push(row);
      if (row.amrSecond !== row.identitySecond) continue;
      ok = true;
      expect(row.identityUpdatedEqualsCreated, "measured: creation is not an update").toBe(true);
      expect(await appGate(s.access_token), "the first sign-in is proven").toBe("email_link_or_otp");
    }
    evidence.firstSignIn = tries;
    expect(ok, `precondition: a first sign-in in the creation second was produced (${JSON.stringify(tries)})`).toBe(true);
  }, 60_000);

  it("an admin-invited user's first session, then their re-link by PKCE magic link 1.5 s later", async () => {
    const email = addr("inv");
    const seen = await listMessageIds(email);
    expect((await gotrue("POST", "invite", { email }, E2E_SERVICE_ROLE_KEY)).status).toBe(200);
    const link = await fastVerifyLink(email, seen);
    expect(link, "setup: the invite was mailed").toBeTruthy();
    const r = await fetch(link as string, { redirect: "manual" });
    const token = new URLSearchParams(new URL(r.headers.get("location") ?? "", "http://x").hash.slice(1)).get("access_token");
    expect(token, "setup: the invite link redirects with a session").toBeTruthy();
    expect(methods(token as string)).toEqual(["otp"]);
    expect(await appGate(token as string), "the invited user's first session is proven").toBe("email_link_or_otp");
    await sleep(1500);
    const re = await pkceLinkSession(email);
    expect(methods(re.access_token)).toEqual(["magiclink"]);
    expect(await appGate(re.access_token), "the re-link is proven").toBe("email_link_or_otp");
  }, 60_000);
});
