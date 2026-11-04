import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, asRole, closePool, seedStudio, userQueryWithClaims } from "./helpers/harness";
import { stackAuthConfig } from "./helpers/auth-email-change";

// The stack's effective auth config is part of every result: a pass under one config says nothing about the other.
beforeAll(async () => { console.log(`[auth-config] ${JSON.stringify(await stackAuthConfig())} ${new URL(process.env.E2E_SUPABASE_URL ?? "http://x").host}`); });

// 0291 (HELD): the invitation functions refuse a session that has not proven control of its mailbox, in the DATABASE
// (Insurance S-3, #1333). Every negative states the secure outcome: proof_required, no studio data in the answer, the
// invitation still pending and no membership written. Positive controls run on the same fixture shape, so a refusal is never
// counted unless the same call succeeds with a proof. Synthetic data, local stack only; the JWT claims are presented the way
// PostgREST presents a verified token (the amr strings are the ones pinned against real GoTrue in auth-email-proof.db.test.ts).

afterAll(async () => {
  await closePool();
});

const OTP = [{ method: "otp", timestamp: 1 }];

// S-2b (auth-worker): a link-type proof needs the JWT's session to exist in auth.sessions for this user, so every synthetic caller
// gets a real session row and presents its id as session_id, the way GoTrue's JWT does.
const sessions = new Map<string, string>();
async function newSession(userId: string, createdAt?: string): Promise<string> {
  const sid = randomUUID();
  await adminQuery(`insert into auth.sessions (id, user_id, created_at, updated_at, aal) values ($1, $2, coalesce($3::timestamptz, now()), now(), 'aal1')`, [sid, userId, createdAt ?? null]);
  sessions.set(userId, sid);
  return sid;
}
const claimsFor = (userId: string, amr: unknown) => ({ ...(amr === undefined ? {} : { amr }), ...(sessions.has(userId) ? { session_id: sessions.get(userId) } : {}) });

async function invitedUser(): Promise<{ id: string; email: string; studioId: string; studioName: string }> {
  const studio = await seedStudio("gate");
  const id = randomUUID();
  const email = `gate-${randomUUID().slice(0, 8)}@harness.local`;
  await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [id, email]);
  await newSession(id);
  await adminQuery(
    `insert into public.pending_invitations (studio_id, email, role, display_name) values ($1, $2, 'practitioner', 'Invited User')`,
    [studio.studioId, email],
  );
  const [row] = (await adminQuery(`select name from public.studios where id = $1`, [studio.studioId])).rows as { name: string }[];
  return { id, email, studioId: studio.studioId, studioName: row.name };
}

async function googleIdentity(userId: string, email: string, opts: { verified?: boolean; provider?: string; identityEmail?: string } = {}) {
  await adminQuery(
    `insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
     values ($1, $2, $3::jsonb, $4, now(), now(), now())`,
    [
      randomUUID(),
      userId,
      JSON.stringify({ sub: randomUUID(), email: opts.identityEmail ?? email, email_verified: opts.verified ?? true }),
      opts.provider ?? "google",
    ],
  );
}

const reconcile = (userId: string, amr: unknown) =>
  userQueryWithClaims(userId, claimsFor(userId, amr), `select public.reconcile_my_pending_invitation() as r`).then(
    (r) => r.rows[0].r as Record<string, unknown>,
  );
const pending = (userId: string, amr: unknown) =>
  userQueryWithClaims(userId, claimsFor(userId, amr), `select public.my_pending_invitation() as r`).then(
    (r) => r.rows[0].r as Record<string, unknown>,
  );

async function assertNothingChanged(u: { id: string; email: string; studioId: string }) {
  const inv = await adminQuery(`select status from public.pending_invitations where studio_id = $1 and lower(email) = lower($2)`, [u.studioId, u.email]);
  expect(inv.rows.map((r: { status: string }) => r.status)).toEqual(["pending"]);
  const members = await adminQuery(`select 1 from public.practitioners where user_id = $1`, [u.id]);
  expect(members.rowCount).toBe(0);
}

describe("0291 session_proves_mailbox: unproven sessions are refused by both invitation functions", () => {
  it("POSITIVE CONTROL: an otp session reads the invitation and reconciles it", async () => {
    const u = await invitedUser();
    const p = await pending(u.id, OTP);
    expect(p).toMatchObject({ status: "ok", studio_name: u.studioName, role: "practitioner" });
    const r = await reconcile(u.id, OTP);
    expect(r.status).toBe("acceptance_required"); // a brand-new user has no consent evidence to copy: explicit acceptance
    expect(r.studio_name).toBe(u.studioName);
  });

  it.each([
    ["no amr claim at all", undefined],
    ["a password session", [{ method: "password", timestamp: 1 }]],
    ["an empty amr", []],
    ["an amr that is not an array", "otp"],
    ["an amr that is an object", { method: "otp" }],
    ["method names no real mailbox flow produces: email/signup", [{ method: "email/signup", timestamp: 1 }]],
    ["method names no real mailbox flow produces: invite", [{ method: "invite", timestamp: 1 }]],
    ["a sso/saml entry", [{ method: "sso/saml", timestamp: 1 }]],
    ["an entry with no method", [{ timestamp: 1 }]],
  ])("NEGATIVE: %s is proof_required; no studio data, nothing written", async (_label, amr) => {
    const u = await invitedUser();
    const p = await pending(u.id, amr);
    expect(p).toEqual({ status: "proof_required" });
    expect(JSON.stringify(p)).not.toContain(u.studioName);
    const r = await reconcile(u.id, amr);
    expect(r).toEqual({ status: "proof_required", choose_studio: false });
    await assertNothingChanged(u);
  });

  it.each(["magiclink", "recovery"])("POSITIVE CONTROL: the measured PKCE method %s proves the mailbox", async (method) => {
    const u = await invitedUser();
    expect((await pending(u.id, [{ method, timestamp: 1 }])).status).toBe("ok");
  });

  it("a mixed [password, otp] session counts as proven (the app rule is the same; password-origin sessions are the 0292 hook's job)", async () => {
    const u = await invitedUser();
    const p = await pending(u.id, [{ method: "password", timestamp: 1 }, { method: "otp", timestamp: 2 }]);
    expect(p.status).toBe("ok");
  });
});

describe("0291 session_proves_mailbox: oauth counts only with a verified Google identity for the account's own address", () => {
  const OAUTH = [{ method: "oauth", timestamp: 1 }]; // GoTrue writes no provider on this entry

  it("POSITIVE CONTROL: oauth + a verified Google identity with the account's email", async () => {
    const u = await invitedUser();
    await googleIdentity(u.id, u.email);
    expect((await pending(u.id, OAUTH)).status).toBe("ok");
  });

  it("NEGATIVE: oauth with no identity row", async () => {
    const u = await invitedUser();
    expect(await pending(u.id, OAUTH)).toEqual({ status: "proof_required" });
    await assertNothingChanged(u);
  });

  it("NEGATIVE: the Google identity's email is a different address", async () => {
    const u = await invitedUser();
    await googleIdentity(u.id, u.email, { identityEmail: `other-${randomUUID().slice(0, 8)}@harness.local` });
    expect(await pending(u.id, OAUTH)).toEqual({ status: "proof_required" });
    await assertNothingChanged(u);
  });

  it("NEGATIVE: the Google identity is not email_verified", async () => {
    const u = await invitedUser();
    await googleIdentity(u.id, u.email, { verified: false });
    expect(await pending(u.id, OAUTH)).toEqual({ status: "proof_required" });
  });

  it("NEGATIVE: a verified identity from another provider does not count", async () => {
    const u = await invitedUser();
    await googleIdentity(u.id, u.email, { provider: "github" });
    expect(await pending(u.id, OAUTH)).toEqual({ status: "proof_required" });
  });

  it("NEGATIVE: a Google identity with NO oauth amr entry (for example a password session) does not count", async () => {
    const u = await invitedUser();
    await googleIdentity(u.id, u.email);
    expect(await pending(u.id, [{ method: "password", timestamp: 1 }])).toEqual({ status: "proof_required" });
  });

  it("NEGATIVE: another user's Google identity does not prove this caller's mailbox", async () => {
    const victim = await invitedUser();
    const attacker = await invitedUser();
    await googleIdentity(victim.id, victim.email);
    expect(await pending(attacker.id, OAUTH)).toEqual({ status: "proof_required" });
  });
});

describe("0291 S-2b: the JWT's session must exist, and on a changed account a credential must be issued between the change and the session", () => {
  const T = Date.parse("2026-11-04T01:00:00Z");
  const at = (ms: number) => new Date(T + ms).toISOString(); // millisecond offsets from T; Postgres keeps microseconds
  const set = (id: string, cols: Record<string, string | null>) =>
    adminQuery(`update auth.users set ${Object.keys(cols).map((k, i) => `${k} = $${i + 2}::timestamptz`).join(", ")} where id = $1`, [id, ...Object.values(cols)]);
  async function emailIdentity(u: { id: string; email: string }, created: string, updated = created) {
    await adminQuery(
      `insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
       values ($1, $2, $3::jsonb, 'email', now(), $4::timestamptz, $5::timestamptz)`,
      [u.id, u.id, JSON.stringify({ sub: u.id, email: u.email }), created, updated],
    );
  }
  const OK = async (u: { id: string }, method = "magiclink") => (await pending(u.id, [{ method, timestamp: 1 }])).status;

  it("session binding: no session_id, a malformed one, another user's session, or a deleted session is proof_required", async () => {
    const u = await invitedUser();
    const other = await invitedUser();
    const mine = sessions.get(u.id) as string;
    const q = (sid: unknown) => userQueryWithClaims(u.id, { amr: [{ method: "otp", timestamp: 1 }], ...(sid === undefined ? {} : { session_id: sid }) }, `select public.my_pending_invitation() as r`).then((r) => r.rows[0].r as Record<string, unknown>);
    expect((await q(mine)).status, "control: its own live session").toBe("ok");
    for (const sid of [undefined, "not-a-uuid", "'; select 1 --", 42, sessions.get(other.id)]) expect(await q(sid), JSON.stringify(sid)).toEqual({ status: "proof_required" });
    await adminQuery(`delete from auth.sessions where id = $1`, [mine]);
    expect(await q(mine), "a signed-out (deleted) session").toEqual({ status: "proof_required" });
    await assertNothingChanged(u);
  });

  it("a never-changed account (no email_change_sent_at; email identity updated_at = created_at) is proven by any link method", async () => {
    const u = await invitedUser();
    await emailIdentity(u, at(0));
    for (const m of ["otp", "magiclink", "recovery"]) expect(await OK(u, m), m).toBe("ok");
  });

  it.each(["otp", "magiclink", "recovery"])("%s: a session created BEFORE the change is refused even 100 microseconds before; one made from a credential issued after it is ok", async (method) => {
    const u = await invitedUser();
    await emailIdentity(u, at(-60_000), at(500)); // the change applied at T + 0.500
    await set(u.id, { email_change_sent_at: at(100), recovery_sent_at: at(-30_000) });
    await adminQuery(`update auth.sessions set created_at = $2::timestamptz - interval '100 microseconds' where id = $1`, [sessions.get(u.id), at(500)]);
    expect(await pending(u.id, [{ method, timestamp: Math.floor(T / 1000) }]), "same whole second, 100 us before").toEqual({ status: "proof_required" });
    expect(await reconcile(u.id, [{ method, timestamp: Math.floor(T / 1000) }])).toEqual({ status: "proof_required", choose_studio: false });
    await assertNothingChanged(u);
    await set(u.id, { recovery_sent_at: at(600) });
    await newSession(u.id, at(700));
    expect(await OK(u, method), "a link issued at +0.600 redeemed at +0.700").toBe("ok");
  });

  it("the completion shape: a session created AFTER the change with no credential issued in between is refused", async () => {
    const u = await invitedUser();
    await emailIdentity(u, at(-60_000), at(0));
    await set(u.id, { email_change_sent_at: at(-1_000), recovery_sent_at: at(-30_000) });
    await newSession(u.id, at(10)); // GoTrue's completion session, ~10 ms after the identity update
    expect(await pending(u.id, [{ method: "otp", timestamp: 1 }])).toEqual({ status: "proof_required" });
  });

  it("the credential must fall strictly inside (change, session): before the change, after the session, or exactly on either edge is refused", async () => {
    const u = await invitedUser();
    await emailIdentity(u, at(-60_000), at(0));
    await newSession(u.id, at(1_000));
    for (const rec of [at(-1), at(0), at(1_000), at(1_001)]) {
      await set(u.id, { recovery_sent_at: rec });
      expect(await pending(u.id, [{ method: "otp", timestamp: 1 }]), rec).toEqual({ status: "proof_required" });
    }
    await set(u.id, { recovery_sent_at: at(1) });
    expect(await OK(u)).toBe("ok");
  });

  it("confirmation_sent_at counts as a credential; email_change_sent_at and reauthentication_sent_at do not", async () => {
    const u = await invitedUser();
    await emailIdentity(u, at(-60_000), at(0));
    await newSession(u.id, at(1_000));
    await set(u.id, { reauthentication_sent_at: at(500) });
    expect(await pending(u.id, [{ method: "otp", timestamp: 1 }]), "a reauthentication nonce is not a sign-in credential").toEqual({ status: "proof_required" });
    await set(u.id, { confirmation_sent_at: at(500) });
    expect(await OK(u)).toBe("ok");
  });

  it("uses the LATER of email_change_sent_at and the email identity's updated_at", async () => {
    const u = await invitedUser();
    await emailIdentity(u, at(-60_000), at(0));
    await newSession(u.id, at(2_000));
    await set(u.id, { email_change_sent_at: at(1_500), recovery_sent_at: at(1_000) }); // a newer change REQUEST after the credential
    expect(await pending(u.id, [{ method: "otp", timestamp: 1 }])).toEqual({ status: "proof_required" });
    await set(u.id, { email_change_sent_at: at(-5_000) });
    expect(await OK(u)).toBe("ok");
  });

  it("a pending change alone (email_change_sent_at, identity untouched) already counts as change activity", async () => {
    const u = await invitedUser();
    await emailIdentity(u, at(-60_000));
    await newSession(u.id, at(1_000));
    await set(u.id, { email_change_sent_at: at(0) });
    expect(await pending(u.id, [{ method: "otp", timestamp: 1 }])).toEqual({ status: "proof_required" });
  });

  it("a Google identity's updated_at never makes the account 'changed'", async () => {
    const u = await invitedUser();
    await emailIdentity(u, at(0));
    await googleIdentity(u.id, u.email);
    await adminQuery(`update auth.identities set updated_at = $2::timestamptz where user_id = $1 and provider = 'google'`, [u.id, at(100_000)]);
    expect(await OK(u)).toBe("ok");
  });

  it("oauth is unaffected by the change (bound by the verified Google identity's own address)", async () => {
    const u = await invitedUser();
    await googleIdentity(u.id, u.email);
    await set(u.id, { email_change_sent_at: at(0) });
    expect((await pending(u.id, [{ method: "oauth", timestamp: 1 }])).status).toBe("ok");
  });
});

describe("0291 privileges", () => {
  it("session_link_proof_is_current: EXECUTE for authenticated only (anon, service_role and PUBLIC revoked by name)", async () => {
    const g = await adminQuery(
      `select r.rolname, has_function_privilege(r.rolname, 'public.session_link_proof_is_current()', 'execute') as ok
         from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role') order by 1`);
    expect(Object.fromEntries(g.rows.map((r: { rolname: string; ok: boolean }) => [r.rolname, r.ok]))).toEqual({ anon: false, authenticated: true, service_role: false });
    const acl = await adminQuery(`select coalesce(array_to_string(proacl, ','), '') as acl from pg_proc where oid = 'public.session_link_proof_is_current()'::regprocedure`);
    expect(acl.rows[0].acl, "no PUBLIC (=X) entry").not.toMatch(/(^|,)=X/);
    for (const role of ["anon", "service_role"] as const) {
      await expect(asRole(role, (q) => q(`select public.session_link_proof_is_current()`))).rejects.toThrow(/permission denied|42501/i);
    }
  });

  it("the helper is callable by no browser or service role", async () => {
    for (const role of ["anon", "authenticated", "service_role"] as const) {
      await expect(asRole(role, (q) => q(`select public.session_proves_mailbox()`))).rejects.toThrow(/permission denied|42501/i);
    }
  });

  it("anon still cannot call either invitation function; authenticated still can (grants unchanged)", async () => {
    for (const fn of ["reconcile_my_pending_invitation", "my_pending_invitation"]) {
      await expect(asRole("anon", (q) => q(`select public.${fn}()`))).rejects.toThrow(/permission denied|42501/i);
      const g = await adminQuery(`select has_function_privilege('authenticated', $1::regprocedure, 'execute') as ok`, [`public.${fn}()`]);
      expect(g.rows[0].ok).toBe(true);
    }
  });

  it("an authenticated caller with no uid still gets the 0141 authentication error, not proof_required", async () => {
    await expect(
      asRole("authenticated", (q) => q(`select public.my_pending_invitation()`)),
    ).rejects.toThrow(/authentication required|28000/i);
  });
});
