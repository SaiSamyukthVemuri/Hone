import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, asRole, closePool, seedStudio, userQueryWithClaims } from "./helpers/harness";

// 0291 (HELD): the invitation functions refuse a session that has not proven control of its mailbox, in the DATABASE
// (Insurance S-3, #1333). Every negative states the secure outcome: proof_required, no studio data in the answer, the
// invitation still pending and no membership written. Positive controls run on the same fixture shape, so a refusal is never
// counted unless the same call succeeds with a proof. Synthetic data, local stack only; the JWT claims are presented the way
// PostgREST presents a verified token (the amr strings are the ones pinned against real GoTrue in auth-email-proof.db.test.ts).

afterAll(async () => {
  await closePool();
});

const OTP = [{ method: "otp", timestamp: 1 }];

async function invitedUser(): Promise<{ id: string; email: string; studioId: string; studioName: string }> {
  const studio = await seedStudio("gate");
  const id = randomUUID();
  const email = `gate-${randomUUID().slice(0, 8)}@harness.local`;
  await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [id, email]);
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
  userQueryWithClaims(userId, amr === undefined ? {} : { amr }, `select public.reconcile_my_pending_invitation() as r`).then(
    (r) => r.rows[0].r as Record<string, unknown>,
  );
const pending = (userId: string, amr: unknown) =>
  userQueryWithClaims(userId, amr === undefined ? {} : { amr }, `select public.my_pending_invitation() as r`).then(
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

describe("0291 privileges", () => {
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
