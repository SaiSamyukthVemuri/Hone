import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, adminTx, asRole, closePool, seedStudio, userQueryWithClaims } from "./helpers/harness";
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

  it("session binding (CHANGED account): no session_id, a malformed one, another user's session, or a deleted session is proof_required", async () => {
    const u = await invitedUser();
    const other = await invitedUser();
    await emailIdentity(u, at(-60_000), at(0)); // changed at T
    const mine = await newSession(u.id, at(2_000));
    await set(u.id, { recovery_sent_at: at(1_000) }); // a credential inside (change, session): the control passes
    const q = (sid: unknown) => userQueryWithClaims(u.id, { amr: [{ method: "otp", timestamp: 1 }], ...(sid === undefined ? {} : { session_id: sid }) }, `select public.my_pending_invitation() as r`).then((r) => r.rows[0].r as Record<string, unknown>);
    expect((await q(mine)).status, "control: its own live session").toBe("ok");
    for (const sid of [undefined, "not-a-uuid", "'; select 1 --", 42, sessions.get(other.id)]) expect(await q(sid), JSON.stringify(sid)).toEqual({ status: "proof_required" });
    await adminQuery(`delete from auth.sessions where id = $1`, [mine]);
    expect(await q(mine), "a signed-out (deleted) session").toEqual({ status: "proof_required" });
    await assertNothingChanged(u);
  });

  it("AW1(b): a NEVER-CHANGED account is decided without auth.sessions: proven with no session_id, and while auth.sessions is LOCKED", async () => {
    const never = await invitedUser();
    await emailIdentity(never, at(0));
    const changed = await invitedUser();
    await emailIdentity(changed, at(-60_000), at(0));
    const sid = await newSession(changed.id, at(2_000));
    await set(changed.id, { recovery_sent_at: at(1_000) });
    // No session_id at all (the never-changed branch never looks): proven, as the app's pure rule says.
    expect((await userQueryWithClaims(never.id, { amr: [{ method: "otp", timestamp: 1 }] }, `select public.session_link_proof_is_current() as ok`)).rows[0].ok).toBe(true);
    // Hold an ACCESS EXCLUSIVE lock on auth.sessions in another transaction: any statement that so much as plans a read of it
    // blocks. The never-changed caller must answer at once; the changed caller must block (its lock_timeout fires). This is
    // the same isolation a hosted privilege failure on auth.sessions would get: only changed accounts can be affected.
    const call = (userId: string, claims: Record<string, unknown>) =>
      userQueryWithClaims(userId, claims, `select public.session_link_proof_is_current() as ok`);
    await adminTx(async (q) => {
      await q(`lock table auth.sessions in access exclusive mode`);
      const t0 = Date.now();
      const r = await call(never.id, { amr: [{ method: "otp", timestamp: 1 }], session_id: randomUUID() });
      expect(r.rows[0].ok, "never-changed: proven while auth.sessions is locked").toBe(true);
      expect(Date.now() - t0, "never-changed: answered without waiting on the lock").toBeLessThan(2_000);
      const blocked = await Promise.race([
        call(changed.id, { amr: [{ method: "otp", timestamp: 1 }], session_id: sid }).then(() => "answered", () => "error"),
        new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 1_500)),
      ]);
      expect(blocked, "changed: must read auth.sessions, so it waits on the lock").toBe("blocked");
    });
    // After the lock is released the changed caller's (queued) read completes normally.
    expect((await call(changed.id, { amr: [{ method: "otp", timestamp: 1 }], session_id: sid })).rows[0].ok).toBe(true);
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

  const stamp = (userId: string, sid: string | undefined) =>
    userQueryWithClaims(userId, { amr: [{ method: "otp", timestamp: 1 }], ...(sid ? { session_id: sid } : {}) }, `select public.stamp_session_link_proof() as ok`).then((r) => r.rows[0].ok as boolean);
  const stamps = (sid: string) => adminQuery(`select count(*)::int as n from public.auth_session_link_proofs where session_id = $1`, [sid]).then((r) => r.rows[0].n as number);

  it("CODEX-P2 CONFIRMED (unstamped): a later link request that moves recovery_sent_at past the session un-proves it", async () => {
    const u = await invitedUser();
    await emailIdentity(u, at(-60_000), at(0));
    await newSession(u.id, at(2_000));
    await set(u.id, { recovery_sent_at: at(1_000) });
    expect(await OK(u), "control: proven while its own credential is the latest").toBe("ok");
    await set(u.id, { recovery_sent_at: at(5_000) }); // a second device asked for a link; not redeemed
    expect(await pending(u.id, [{ method: "otp", timestamp: 1 }]), "the unstamped session lost proof (the Codex P2 finding)").toEqual({ status: "proof_required" });
  });

  it("CODEX-P2 FIX: a session stamped while its window held KEEPS proof after another device's request; a NEW change voids the stamp", async () => {
    const u = await invitedUser();
    await emailIdentity(u, at(-60_000), at(0));
    const sid = await newSession(u.id, at(2_000));
    await set(u.id, { recovery_sent_at: at(1_000) });
    expect(await stamp(u.id, sid), "the stamp is written while the window holds").toBe(true);
    expect(await stamps(sid)).toBe(1);
    await set(u.id, { recovery_sent_at: at(5_000) });
    expect(await OK(u), "still proven after a later link request (session-bound)").toBe("ok");
    expect(await stamp(u.id, sid), "re-stamping is a read of the existing stamp, no new proof").toBe(true);
    await set(u.id, { email_change_sent_at: at(6_000) }); // new email-change activity moves the anchor
    expect(await pending(u.id, [{ method: "otp", timestamp: 1 }]), "a new change voids the stamp").toEqual({ status: "proof_required" });
    expect(await stamp(u.id, sid), "and it cannot be re-stamped against the new anchor").toBe(false);
  });

  it("CODEX-P2: no stamp is ever written outside the window (completion shape, pre-change session, foreign or missing session)", async () => {
    const u = await invitedUser();
    await emailIdentity(u, at(-60_000), at(0));
    await set(u.id, { email_change_sent_at: at(-1_000), recovery_sent_at: at(-30_000) });
    const completion = await newSession(u.id, at(10));
    expect(await stamp(u.id, completion), "completion shape").toBe(false);
    expect(await stamps(completion)).toBe(0);
    const before = await newSession(u.id, at(-500));
    expect(await stamp(u.id, before), "pre-change session").toBe(false);
    expect(await stamps(before)).toBe(0);
    const other = await invitedUser();
    expect(await stamp(u.id, sessions.get(other.id)), "another user's session id").toBe(false);
    expect(await stamp(u.id, undefined), "no session id").toBe(false);
    expect(await adminQuery(`select count(*)::int as n from public.auth_session_link_proofs where user_id = $1`, [u.id]).then((r) => r.rows[0].n)).toBe(0);
  });

  it("BC1 / S-1 residual: a PASSWORD session can be stamped (the recorder checks the window, not the amr), but a password amr never passes session_proves_mailbox, stamped or not", async () => {
    const u = await invitedUser();
    await emailIdentity(u, at(-60_000), at(0));
    const sid = await newSession(u.id, at(2_000));
    await set(u.id, { recovery_sent_at: at(1_000) }); // an unredeemed recovery request inside the window
    const PASSWORD = [{ method: "password", timestamp: 1 }];
    const st = await userQueryWithClaims(u.id, { amr: PASSWORD, session_id: sid }, `select public.stamp_session_link_proof() as ok`).then((r) => r.rows[0].ok as boolean);
    expect(st, "measured residual (BC1): the password session's window holds, so it is stamped").toBe(true);
    expect(await stamps(sid)).toBe(1);
    for (const amr of [PASSWORD, [{ method: "password", timestamp: 1 }, { method: "mfa/totp", timestamp: 2 }], []]) {
      expect(await pending(u.id, amr), `stamped, still no proof: ${JSON.stringify(amr)}`).toEqual({ status: "proof_required" });
      expect(await reconcile(u.id, amr)).toEqual({ status: "proof_required", choose_studio: false });
    }
    await set(u.id, { recovery_sent_at: at(5_000) }); // the stamp outlives a later request (the residual), and still proves nothing
    expect(await pending(u.id, PASSWORD)).toEqual({ status: "proof_required" });
    await assertNothingChanged(u);
  });

  it("CODEX-P2: a never-changed account's stamp call is true and writes nothing", async () => {
    const u = await invitedUser();
    await emailIdentity(u, at(0));
    expect(await stamp(u.id, sessions.get(u.id))).toBe(true);
    expect(await adminQuery(`select count(*)::int as n from public.auth_session_link_proofs where user_id = $1`, [u.id]).then((r) => r.rows[0].n)).toBe(0);
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

  it("CODEX-P2 privileges: stamp_session_link_proof is EXECUTE for authenticated only; the stamp table is closed to every API role", async () => {
    const g = await adminQuery(
      `select r.rolname, has_function_privilege(r.rolname, 'public.stamp_session_link_proof()', 'execute') as ok,
              has_table_privilege(r.rolname, 'public.auth_session_link_proofs', 'select') as sel,
              has_table_privilege(r.rolname, 'public.auth_session_link_proofs', 'insert') as ins
         from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role') order by 1`);
    expect(g.rows).toEqual([
      { rolname: "anon", ok: false, sel: false, ins: false },
      { rolname: "authenticated", ok: true, sel: false, ins: false },
      { rolname: "service_role", ok: false, sel: false, ins: false },
    ]);
    const acl = await adminQuery(`select coalesce(array_to_string(proacl, ','), '') as acl from pg_proc where oid = 'public.stamp_session_link_proof()'::regprocedure`);
    expect(acl.rows[0].acl, "no PUBLIC (=X) entry").not.toMatch(/(^|,)=X/);
    await expect(asRole("authenticated", (q) => q(`select count(*) from public.auth_session_link_proofs`))).rejects.toThrow(/permission denied|42501/i);
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
