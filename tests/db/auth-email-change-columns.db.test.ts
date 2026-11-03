import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { adminQuery, closePool } from "./helpers/harness";
import { E2E_SERVICE_ROLE_KEY, E2E_SUPABASE_URL, E2E_WEB_SERVER_ENV } from "../../e2e/helpers/local-env";
import { claimsFromAccessToken } from "@/lib/auth/email-proof";

// S-2b follow-up (Insurance Z-1 / G-3). The attack: an attacker who really owns a mailbox signs in by magic link (a PROVEN
// session), asks to change the account email to the victim's address, and the victim confirms. The attacker's existing session
// then belongs to an account whose address is the victim's.
// The fix under design: a session's mailbox proof counts only when the session was authenticated AT OR AFTER the account's last
// email change. Which column records that time on the pinned GoTrue is MEASURED here, not assumed:
//   part 1: for each routine and email-change event, which candidate columns moved;
//   part 2: the magic-link attacker end to end, with the candidate rule evaluated on the real values.
// Synthetic addresses on a reserved test domain.
const ANON = E2E_WEB_SERVER_ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const evidence: Record<string, unknown> = {};
afterAll(async () => {
  if (process.env.AUTH_COLUMNS_EVIDENCE) writeFileSync(process.env.AUTH_COLUMNS_EVIDENCE, JSON.stringify(evidence, null, 2));
  await closePool();
});

type Json = Record<string, unknown>;
async function gotrue(method: string, path: string, body: Json | undefined, key: string, bearer?: string) {
  const r = await fetch(`${E2E_SUPABASE_URL}/auth/v1/${path}`, { method, headers: { apikey: key, Authorization: `Bearer ${bearer ?? key}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Json };
}
const addr = (t: string) => `ec-${t}-${randomUUID().slice(0, 8)}@harness.local`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const amrTs = (token: string): number => ((claimsFromAccessToken(token) as { amr?: { timestamp?: number }[] } | null)?.amr ?? []).reduce((m, e) => Math.max(m, Number(e.timestamp) || 0), 0);

type Cols = { email: string; email_change: string | null; users_updated_at: number; email_change_sent_at: number | null; email_confirmed_at: number | null; last_sign_in_at: number | null; confirmation_sent_at: number | null; recovery_sent_at: number | null; identity_updated_at: number | null; identity_email: string | null };
const epoch = "extract(epoch from %s)::float8";
async function cols(id: string): Promise<Cols> {
  const r = await adminQuery(
    `select u.email, nullif(u.email_change,'') as email_change,
            ${epoch.replace("%s", "u.updated_at")} as users_updated_at,
            ${epoch.replace("%s", "u.email_change_sent_at")} as email_change_sent_at,
            ${epoch.replace("%s", "u.email_confirmed_at")} as email_confirmed_at,
            ${epoch.replace("%s", "u.last_sign_in_at")} as last_sign_in_at,
            ${epoch.replace("%s", "u.confirmation_sent_at")} as confirmation_sent_at,
            ${epoch.replace("%s", "u.recovery_sent_at")} as recovery_sent_at,
            ${epoch.replace("%s", "i.updated_at")} as identity_updated_at,
            i.identity_data ->> 'email' as identity_email
       from auth.users u left join auth.identities i on i.user_id = u.id and i.provider = 'email'
      where u.id = $1`,
    [id],
  );
  return r.rows[0] as Cols;
}
const MOVE_KEYS = ["email", "email_change", "users_updated_at", "email_change_sent_at", "email_confirmed_at", "last_sign_in_at", "confirmation_sent_at", "recovery_sent_at", "identity_updated_at", "identity_email"] as const;
const moved = (a: Cols, b: Cols) => MOVE_KEYS.filter((k) => a[k] !== b[k]);

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

describe("part 1: which columns move on which event (real GoTrue, tracked config)", () => {
  it("measures the matrix", async () => {
    const u = await newConfirmedUser("matrix");
    const matrix: Record<string, string[]> = {};
    const probe = async (name: string, act: () => Promise<unknown>) => {
      await sleep(1100); // so a column that moves differs at one-second resolution
      const before = await cols(u.id);
      await act();
      matrix[name] = moved(before, await cols(u.id));
    };
    const s = await linkSession(u.email);
    const token = s.body.access_token as string;
    await probe("otp_request", () => gotrue("POST", "otp", { email: u.email, create_user: false }, ANON));
    await probe("magic_link_sign_in", () => linkSession(u.email));
    await probe("refresh", () => gotrue("POST", "token?grant_type=refresh_token", { refresh_token: s.body.refresh_token }, ANON));
    await probe("metadata_update", () => gotrue("PUT", "user", { data: { note: "x" } }, ANON, token));
    await probe("password_set", () => gotrue("PUT", "user", { password: `Pw-${randomUUID()}` }, ANON, token));
    const victim = addr("victim");
    await probe("email_change_request", () => gotrue("PUT", "user", { email: victim }, ANON, token));
    await probe("email_change_confirm_new_half", async () => {
      const l = await gotrue("POST", "admin/generate_link", { type: "email_change_new", email: u.email, new_email: victim }, E2E_SERVICE_ROLE_KEY);
      return gotrue("POST", "verify", { type: "email_change", token_hash: l.body.hashed_token as string }, ANON);
    });
    await probe("email_change_confirm_current_half", async () => {
      const l = await gotrue("POST", "admin/generate_link", { type: "email_change_current", email: u.email, new_email: victim }, E2E_SERVICE_ROLE_KEY);
      return gotrue("POST", "verify", { type: "email_change", token_hash: l.body.hashed_token as string }, ANON);
    });
    const final = await cols(u.id);
    evidence.matrix = matrix;
    evidence.matrixFinalAccountEmail = final.email === victim ? "VICTIM (change applied)" : "unchanged";
    // Sanity only: the harness actually drove the change. The columns are the finding (read the evidence).
    expect(Object.keys(matrix)).toHaveLength(8);
  });
});

describe("part 2: the magic-link attacker (Insurance Z-1) with the candidate rule on real values", () => {
  it("the attacker's EARLIER session is not bound to the victim's address; a NEW session for the victim's address is", async () => {
    const attacker = await newConfirmedUser("atk");
    const victim = addr("vic");
    const old = await linkSession(attacker.email); // genuinely proven by the attacker's own mailbox
    const oldToken = old.body.access_token as string;
    const oldTs = amrTs(oldToken);
    expect(oldTs).toBeGreaterThan(0);
    await sleep(1100);

    expect((await gotrue("PUT", "user", { email: victim }, ANON, oldToken)).status).toBe(200);
    await sleep(1100);
    // The victim confirms their half; the attacker (who owns the current address) confirms the other.
    for (const type of ["email_change_new", "email_change_current"]) {
      const l = await gotrue("POST", "admin/generate_link", { type, email: attacker.email, new_email: victim }, E2E_SERVICE_ROLE_KEY);
      if (l.status === 200) await gotrue("POST", "verify", { type: "email_change", token_hash: l.body.hashed_token as string }, ANON);
    }
    const after = await cols(attacker.id);
    expect(after.email, "setup: the change applied (the attack's precondition)").toBe(victim);

    // The attacker's old session survives the change: same account, now carrying the victim's address.
    const refreshed = await gotrue("POST", "token?grant_type=refresh_token", { refresh_token: old.body.refresh_token }, ANON);
    const oldAfter = refreshed.status === 200 ? amrTs(refreshed.body.access_token as string) : null;

    // A genuine new magic-link session for the victim's address.
    await sleep(1100);
    const fresh = await linkSession(victim);
    const freshTs = amrTs(fresh.body.access_token as string);

    // Candidate rule: proof counts only if amr timestamp >= the account's last email change. The covering value is the max of the
    // candidate columns that moved on the change in part 1 (read from the real row here).
    const changeTimes = [after.users_updated_at, after.email_change_sent_at, after.identity_updated_at].filter((x): x is number => typeof x === "number");
    const lastChange = Math.max(...changeTimes);
    evidence.magicLinkAttacker = { oldAmrTs: oldTs, oldAmrTsAfterRefresh: oldAfter, freshAmrTs: freshTs, columnsAfterChange: after, lastChangeCovering: lastChange, oldSessionStillRefreshable: refreshed.status === 200 };
    expect(oldTs, "SECURE: the attacker's old session predates the change, so the rule refuses it").toBeLessThan(lastChange);
    expect(freshTs, "WORKS: a new magic-link session for the victim's address postdates the change, so the rule accepts it").toBeGreaterThanOrEqual(lastChange);
    if (oldAfter !== null) expect(oldAfter, "amr timestamp survives refresh, so refreshing does not launder the old proof").toBe(oldTs);
  });
});
