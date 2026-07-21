import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
  asRole,
  closePool,
  seedStudio,
  userQuery,
} from "./helpers/harness";

// Migration 0141 — existing-user invitation reconciliation, proven on the real
// migrated DB. Covers the required cases A–N: evidence rules (copy vs. require
// explicit acceptance, never fabricate), idempotency, conflict, concurrency,
// authorization, forged-args impossibility, and transactional atomicity.

const CURRENT = "2026-05-22";
const STALE = "2025-01-01";
const EVIDENCE_TS = "2026-06-01T10:00:00.000Z";

afterAll(async () => {
  await closePool();
});

async function newAuthUser(email: string): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [
    id,
    email,
  ]);
  return { id, email };
}

async function inviteTo(
  studioId: string,
  email: string,
  role: "owner" | "practitioner" = "practitioner",
): Promise<void> {
  await adminQuery(
    `insert into public.pending_invitations (studio_id, email, role, display_name)
     values ($1, $2, $3, $4)`,
    [studioId, email, role, "Invited User"],
  );
}

async function addPractitioner(
  studioId: string,
  userId: string,
  email: string,
  opts: {
    termsAt?: string | null;
    termsVer?: string | null;
    privAt?: string | null;
    privVer?: string | null;
    active?: boolean;
  } = {},
): Promise<string> {
  const {
    termsAt = null,
    termsVer = null,
    privAt = null,
    privVer = null,
    active = true,
  } = opts;
  const id = randomUUID();
  await adminQuery(
    `insert into public.practitioners
       (id, studio_id, user_id, display_name, email, role, active,
        terms_accepted_at, terms_version, privacy_accepted_at, privacy_version)
     values ($1,$2,$3,'Existing',$4,'practitioner',$5,$6,$7,$8,$9)`,
    [id, studioId, userId, email, active, termsAt, termsVer, privAt, privVer],
  );
  return id;
}

async function reconcile(userId: string): Promise<Record<string, unknown>> {
  const r = await userQuery(
    userId,
    `select public.reconcile_my_pending_invitation() as r`,
  );
  return r.rows[0].r as Record<string, unknown>;
}

async function accept(userId: string): Promise<Record<string, unknown>> {
  const r = await userQuery(
    userId,
    `select public.accept_my_pending_invitation() as r`,
  );
  return r.rows[0].r as Record<string, unknown>;
}

async function inviteStatus(studioId: string, email: string): Promise<string> {
  const r = await adminQuery(
    `select status from public.pending_invitations where studio_id=$1 and lower(email)=lower($2)`,
    [studioId, email],
  );
  return r.rows[0]?.status;
}

async function membershipRows(studioId: string, userId: string) {
  const r = await adminQuery(
    `select terms_accepted_at, terms_version, privacy_accepted_at, privacy_version, active
       from public.practitioners where studio_id=$1 and user_id=$2`,
    [studioId, userId],
  );
  return r.rows;
}

// A validated single evidence row (both policies, current version).
async function seedValidEvidence(userId: string, email: string): Promise<void> {
  const ev = await seedStudio("recon-ev");
  await addPractitioner(ev.studioId, userId, email, {
    termsAt: EVIDENCE_TS,
    termsVer: CURRENT,
    privAt: EVIDENCE_TS,
    privVer: CURRENT,
  });
}

describe("0141 reconcile — evidence rules", () => {
  it("A: existing user, zero memberships, no evidence -> acceptance_required", async () => {
    const u = await newAuthUser(`a-${randomUUID().slice(0, 8)}@harness.local`);
    const t = await seedStudio("recon-a");
    await inviteTo(t.studioId, u.email);

    const res = await reconcile(u.id);
    expect(res.status).toBe("acceptance_required");
    // Nothing linked; invite recoverable.
    expect(await membershipRows(t.studioId, u.id)).toHaveLength(0);
    expect(await inviteStatus(t.studioId, u.email)).toBe("pending");
  });

  it("B: one coherent current-version evidence row -> EXACT timestamps copied", async () => {
    const u = await newAuthUser(`b-${randomUUID().slice(0, 8)}@harness.local`);
    await seedValidEvidence(u.id, u.email);
    const t = await seedStudio("recon-b");
    await inviteTo(t.studioId, u.email);

    const res = await reconcile(u.id);
    expect(res.status).toBe("linked");

    const rows = await membershipRows(t.studioId, u.id);
    expect(rows).toHaveLength(1);
    // The COPIED evidence, not now().
    expect(new Date(rows[0].terms_accepted_at).toISOString()).toBe(EVIDENCE_TS);
    expect(new Date(rows[0].privacy_accepted_at).toISOString()).toBe(EVIDENCE_TS);
    expect(rows[0].terms_version).toBe(CURRENT);
    expect(rows[0].privacy_version).toBe(CURRENT);
    expect(await inviteStatus(t.studioId, u.email)).toBe("accepted");
  });

  it("C: stale terms/privacy version -> acceptance_required (no copy)", async () => {
    const u = await newAuthUser(`c-${randomUUID().slice(0, 8)}@harness.local`);
    const ev = await seedStudio("recon-c-ev");
    await addPractitioner(ev.studioId, u.id, u.email, {
      termsAt: EVIDENCE_TS,
      termsVer: STALE, // stale
      privAt: EVIDENCE_TS,
      privVer: CURRENT,
    });
    const t = await seedStudio("recon-c");
    await inviteTo(t.studioId, u.email);

    expect((await reconcile(u.id)).status).toBe("acceptance_required");
    expect(await membershipRows(t.studioId, u.id)).toHaveLength(0);
  });

  it("D: only one policy accepted -> acceptance_required", async () => {
    const u = await newAuthUser(`d-${randomUUID().slice(0, 8)}@harness.local`);
    const ev = await seedStudio("recon-d-ev");
    await addPractitioner(ev.studioId, u.id, u.email, {
      termsAt: EVIDENCE_TS,
      termsVer: CURRENT,
      privAt: null, // privacy not accepted
      privVer: null,
    });
    const t = await seedStudio("recon-d");
    await inviteTo(t.studioId, u.email);

    expect((await reconcile(u.id)).status).toBe("acceptance_required");
  });

  it("E: evidence split across different rows -> acceptance_required", async () => {
    const u = await newAuthUser(`e-${randomUUID().slice(0, 8)}@harness.local`);
    const ev1 = await seedStudio("recon-e-ev1");
    await addPractitioner(ev1.studioId, u.id, u.email, {
      termsAt: EVIDENCE_TS,
      termsVer: CURRENT,
      privAt: null,
      privVer: null,
    });
    const ev2 = await seedStudio("recon-e-ev2");
    await addPractitioner(ev2.studioId, u.id, u.email, {
      termsAt: null,
      termsVer: null,
      privAt: EVIDENCE_TS,
      privVer: CURRENT,
    });
    const t = await seedStudio("recon-e");
    await inviteTo(t.studioId, u.email);

    // No SINGLE row has both -> must not link.
    expect((await reconcile(u.id)).status).toBe("acceptance_required");
    expect(await membershipRows(t.studioId, u.id)).toHaveLength(0);
  });

  it("F: case-variant invitation email -> matched (and linked with evidence)", async () => {
    const base = `f-${randomUUID().slice(0, 8)}@harness.local`;
    const u = await newAuthUser(base.toLowerCase());
    await seedValidEvidence(u.id, u.email);
    const t = await seedStudio("recon-f");
    await inviteTo(t.studioId, base.toUpperCase()); // different case

    expect((await reconcile(u.id)).status).toBe("linked");
    expect(await membershipRows(t.studioId, u.id)).toHaveLength(1);
  });
});

describe("0141 reconcile — existing membership + conflict", () => {
  it("G: existing same-user active membership -> idempotent (already_linked, no dup)", async () => {
    const u = await newAuthUser(`g-${randomUUID().slice(0, 8)}@harness.local`);
    const t = await seedStudio("recon-g");
    await addPractitioner(t.studioId, u.id, u.email, {
      termsAt: EVIDENCE_TS,
      termsVer: CURRENT,
      privAt: EVIDENCE_TS,
      privVer: CURRENT,
    });
    await inviteTo(t.studioId, u.email);

    expect((await reconcile(u.id)).status).toBe("already_linked");
    // Run again: the invite is now consumed, so it's a no-op ('no_invitation');
    // the invariant is that nothing duplicates.
    await reconcile(u.id);
    expect(await membershipRows(t.studioId, u.id)).toHaveLength(1);
    expect(await inviteStatus(t.studioId, u.email)).toBe("accepted");
  });

  it("H: target membership belongs to ANOTHER user -> conflict, no mutation", async () => {
    const t = await seedStudio("recon-h");
    // Another user already holds a membership in T under the invited email.
    const other = await newAuthUser(`h-other-${randomUUID().slice(0, 8)}@harness.local`);
    const invitedEmail = `h-${randomUUID().slice(0, 8)}@harness.local`;
    await addPractitioner(t.studioId, other.id, invitedEmail, {
      termsAt: EVIDENCE_TS,
      termsVer: CURRENT,
      privAt: EVIDENCE_TS,
      privVer: CURRENT,
    });
    const u = await newAuthUser(invitedEmail);
    await seedValidEvidence(u.id, u.email);
    await inviteTo(t.studioId, invitedEmail);

    const res = await reconcile(u.id);
    expect(res.status).toBe("conflict");
    // No membership for the caller, invite untouched, other user's row intact.
    expect(await membershipRows(t.studioId, u.id)).toHaveLength(0);
    expect(await inviteStatus(t.studioId, invitedEmail)).toBe("pending");
    expect(await membershipRows(t.studioId, other.id)).toHaveLength(1);
  });
});

describe("0141 — concurrency + atomicity", () => {
  it("I: two concurrent reconcile calls -> exactly one membership + one accepted invite", async () => {
    const u = await newAuthUser(`i-${randomUUID().slice(0, 8)}@harness.local`);
    await seedValidEvidence(u.id, u.email);
    const t = await seedStudio("recon-i");
    await inviteTo(t.studioId, u.email);

    const [a, b] = await Promise.all([reconcile(u.id), reconcile(u.id)]);
    const statuses = [a.status, b.status].sort();
    // One links; the other sees it already done.
    expect(statuses).toContain("linked");
    expect(await membershipRows(t.studioId, u.id)).toHaveLength(1);
    expect(await inviteStatus(t.studioId, u.email)).toBe("accepted");
  });

  it("J: two concurrent explicit-accept calls -> exactly one membership + one acceptance", async () => {
    const u = await newAuthUser(`j-${randomUUID().slice(0, 8)}@harness.local`);
    const t = await seedStudio("recon-j");
    await inviteTo(t.studioId, u.email);

    const [a, b] = await Promise.all([accept(u.id), accept(u.id)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toContain("linked");
    expect(await membershipRows(t.studioId, u.id)).toHaveLength(1);
    expect(await inviteStatus(t.studioId, u.email)).toBe("accepted");
  });

  it("N: a failure after the practitioner insert rolls back membership AND invite", async () => {
    // Force the insert inside link_invited_membership to fail: the caller ALREADY
    // has a practitioner in T (so UNIQUE(studio_id,user_id) trips), but under a
    // DIFFERENT email so the email-based existing-membership check misses it and
    // the RPC proceeds to insert. The whole function must roll back atomically.
    const u = await newAuthUser(`n-${randomUUID().slice(0, 8)}@harness.local`);
    const t = await seedStudio("recon-n");
    await addPractitioner(t.studioId, u.id, `n-old-${randomUUID().slice(0, 8)}@harness.local`, {
      termsAt: EVIDENCE_TS,
      termsVer: CURRENT,
      privAt: EVIDENCE_TS,
      privVer: CURRENT,
    });
    await seedValidEvidence(u.id, u.email);
    await inviteTo(t.studioId, u.email);

    await expect(reconcile(u.id)).rejects.toThrow(/duplicate|unique/i);
    // Atomic rollback: still exactly the original row, invite still pending,
    // no studio_onboarding row created by the failed call.
    expect(await membershipRows(t.studioId, u.id)).toHaveLength(1);
    expect(await inviteStatus(t.studioId, u.email)).toBe("pending");
    const ob = await adminQuery(
      `select 1 from public.studio_onboarding where studio_id=$1`,
      [t.studioId],
    );
    expect(ob.rows).toHaveLength(0);
  });
});

describe("0141 — authorization + no forged input", () => {
  it("K: anon cannot execute the reconcile RPC", async () => {
    await expect(
      asRole("anon", (q) =>
        q(`select public.reconcile_my_pending_invitation()`),
      ),
    ).rejects.toThrow(/permission denied|not allowed|42501/i);
  });

  it("L: an authenticated user cannot reconcile another user's invitation", async () => {
    const invited = await newAuthUser(`l-inv-${randomUUID().slice(0, 8)}@harness.local`);
    const t = await seedStudio("recon-l");
    await inviteTo(t.studioId, invited.email);
    // A DIFFERENT signed-in user (no invite for their own email).
    const other = await newAuthUser(`l-other-${randomUUID().slice(0, 8)}@harness.local`);

    expect((await reconcile(other.id)).status).toBe("no_invitation");
    // The invited user's invite is untouched.
    expect(await inviteStatus(t.studioId, invited.email)).toBe("pending");
  });

  it("M: forged caller arguments are impossible (RPC takes none)", async () => {
    const u = await newAuthUser(`m-${randomUUID().slice(0, 8)}@harness.local`);
    await expect(
      userQuery(
        u.id,
        `select public.reconcile_my_pending_invitation('forged-studio-id')`,
      ),
    ).rejects.toThrow(/does not exist|function/i);
  });
});
