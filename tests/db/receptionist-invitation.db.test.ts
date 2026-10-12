import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, asUser, closePool } from "./helpers/harness";
import { dropSynthStudio, seedSynthStudioB, type SynthStudio } from "./helpers/synth-fleet";
import { randomUUID } from "node:crypto";

// ===========================================================================
// STUDIO-READY-02b (#824) — migration 0218: inviting a receptionist, against
// the real acceptance commands (0141's reconcile_my_pending_invitation and
// admin_accept_pending_invitation, which 0218 does NOT re-emit) and 0218's
// re-emitted link_invited_membership.
// ===========================================================================

let S: SynthStudio;
const users: string[] = [];

const owner = () => S.practitioners.find((p) => p.role === "owner")!;
const P1 = () => S.practitioners.filter((p) => p.role !== "owner")[0];
const errCode = (e: unknown) => (e as { code?: string }).code;

async function seedAuthUser(label: string): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = `${label}-${id.slice(0, 8)}@harness.local`;
  await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [id, email]);
  users.push(id);
  return { id, email };
}

async function invite(email: string, role: string, displayName = "Desk Person"): Promise<string> {
  const r = await adminQuery(
    `insert into public.pending_invitations (studio_id, email, invited_by, role, display_name, status)
     values ($1, $2, $3, $4, $5, 'pending') returning id`,
    [S.studioId, email, owner().practitionerId, role, displayName],
  );
  return r.rows[0].id as string;
}

const accept = (userId: string) =>
  adminQuery(`select public.admin_accept_pending_invitation($1) as r`, [userId]).then((r) => r.rows[0].r as Record<string, unknown>);

const inviteStatus = (id: string) =>
  adminQuery(`select status from public.pending_invitations where id = $1`, [id]).then((r) => r.rows[0].status as string);

const memberships = (userId: string) =>
  adminQuery(
    `select (select count(*)::int from public.practitioners where studio_id = $1 and user_id = $2) as practitioners,
            (select count(*)::int from public.studio_receptionists where studio_id = $1 and user_id = $2 and active) as desk`,
    [S.studioId, userId],
  ).then((r) => r.rows[0] as { practitioners: number; desk: number });

beforeAll(async () => {
  S = await seedSynthStudioB();
});

afterAll(async () => {
  if (S) {
    await adminQuery(`delete from public.studio_receptionists where studio_id = $1`, [S.studioId]);
    await adminQuery(`delete from public.pending_invitations where studio_id = $1`, [S.studioId]);
    await dropSynthStudio(S);
  }
  for (const id of users) await adminQuery(`delete from auth.users where id = $1`, [id]);
  await closePool();
});

describe("0218: a receptionist invitation becomes a receptionist membership, never a practitioner", () => {
  it("a receptionist-only user is routed to EXPLICIT acceptance (no reusable practitioner evidence)", async () => {
    const u = await seedAuthUser("desk-reconcile");
    const inv = await invite(u.email, "receptionist");
    const r = await asUser(u.id, (q) => q(`select public.reconcile_my_pending_invitation() as r`));
    expect(r.rows[0].r).toMatchObject({ status: "acceptance_required", role: "receptionist" });
    expect(await inviteStatus(inv)).toBe("pending");
    expect(await memberships(u.id)).toEqual({ practitioners: 0, desk: 0 });
  });

  it("explicit acceptance creates an ACTIVE receptionist row with fresh agreement evidence, and no practitioners row", async () => {
    const u = await seedAuthUser("desk-accept");
    const inv = await invite(u.email, "receptionist", "Front Desk One");
    const r = await accept(u.id);
    expect(r).toEqual({ status: "linked", choose_studio: false, studio_name: expect.any(String), role: "receptionist" });
    expect(await inviteStatus(inv)).toBe("accepted");
    expect(await memberships(u.id)).toEqual({ practitioners: 0, desk: 1 });
    const row = await adminQuery(
      `select display_name, email, created_by_practitioner_id,
              terms_accepted_at is not null as terms, terms_version = public.current_terms_version() as terms_current,
              privacy_accepted_at is not null as privacy, privacy_version = public.current_privacy_version() as privacy_current
         from public.studio_receptionists where studio_id = $1 and user_id = $2`,
      [S.studioId, u.id],
    );
    expect(row.rows[0]).toEqual({
      display_name: "Front Desk One",
      email: u.email,
      created_by_practitioner_id: owner().practitionerId,
      terms: true,
      terms_current: true,
      privacy: true,
      privacy_current: true,
    });
    // ...and the new receptionist reaches exactly the 0216 projections.
    const cal = await asUser(u.id, (q) =>
      q(`select count(*)::int as n from public.receptionist_calendar($1, now(), now() + interval '7 days')`, [S.studioId]),
    );
    expect(cal.rows[0].n).toBeGreaterThanOrEqual(0);
  });

  it("re-inviting a deactivated receptionist reactivates the SAME row in place", async () => {
    const u = await seedAuthUser("desk-again");
    await invite(u.email, "receptionist");
    await accept(u.id);
    const first = await adminQuery(`select id from public.studio_receptionists where studio_id = $1 and user_id = $2`, [
      S.studioId,
      u.id,
    ]);
    const id = first.rows[0].id as string;
    expect(
      (await adminQuery(`select public.set_studio_receptionist_active($1, $2, $3, false) as r`, [
        S.studioId,
        owner().practitionerId,
        id,
      ])).rows[0].r,
    ).toBe("updated");
    await invite(u.email, "receptionist", "Renamed Desk");
    expect(await accept(u.id)).toMatchObject({ status: "linked", role: "receptionist" });
    const again = await adminQuery(
      `select id, active, deactivated_at, display_name from public.studio_receptionists where studio_id = $1 and user_id = $2`,
      [S.studioId, u.id],
    );
    expect(again.rows).toEqual([{ id, active: true, deactivated_at: null, display_name: "Renamed Desk" }]);
  });
});

describe("0218: conflicts and the role-aware chooser signal (Codex on #850)", () => {
  it("refuses a receptionist invitation when ANOTHER user holds an active desk row under that email (P2 4243953169)", async () => {
    const holder = await seedAuthUser("desk-holder");
    const claimant = await seedAuthUser("desk-claimant");
    // The holder already works the desk under the shared address.
    await adminQuery(
      `select public.add_studio_receptionist($1, $2, $3, 'Holder', $4)`,
      [S.studioId, owner().practitionerId, holder.id, `shared-${holder.id.slice(0, 6)}@harness.local`],
    );
    const shared = `shared-${holder.id.slice(0, 6)}@harness.local`;
    await adminQuery(`update auth.users set email = $2 where id = $1`, [claimant.id, shared]);
    const inv = await invite(shared, "receptionist");
    expect(await accept(claimant.id)).toEqual({ status: "conflict", choose_studio: false });
    expect(await inviteStatus(inv)).toBe("pending");
    expect(await memberships(claimant.id)).toEqual({ practitioners: 0, desk: 0 });
  });

  it("choose_studio is TRUE when the person now works the desk at a second studio", async () => {
    const u = await seedAuthUser("two-desks");
    const other = await seedSynthStudioB();
    try {
      await adminQuery(`select public.add_studio_receptionist($1, $2, $3, 'Other desk', $4)`, [
        other.studioId,
        other.practitioners.find((p) => p.role === "owner")!.practitionerId,
        u.id,
        u.email,
      ]);
      await invite(u.email, "receptionist");
      expect(await accept(u.id)).toMatchObject({ status: "linked", role: "receptionist", choose_studio: true });
    } finally {
      await adminQuery(`delete from public.studio_receptionists where studio_id = $1`, [other.studioId]);
      await dropSynthStudio(other);
    }
  });

  it("a practitioner of ANOTHER studio gets role 'receptionist' back, so the adapters route them to the front desk (P2 4243953164)", async () => {
    const other = await seedSynthStudioB();
    try {
      const p = other.practitioners.find((x) => x.role !== "owner")!;
      const email = (await adminQuery(`select email from auth.users where id = $1`, [p.userId])).rows[0].email as string;
      await invite(email, "receptionist");
      expect(await accept(p.userId)).toMatchObject({ status: "linked", role: "receptionist", choose_studio: false });
      expect(await memberships(p.userId)).toEqual({ practitioners: 0, desk: 1 });
    } finally {
      await adminQuery(`delete from public.studio_receptionists where studio_id = $1`, [S.studioId]);
      await dropSynthStudio(other);
    }
  });
});

describe("0218: an invitation never changes a person's role", () => {
  it("an ACTIVE practitioner invited as receptionist is 'already_linked' and stays a practitioner", async () => {
    const p = P1();
    const email = (await adminQuery(`select email from auth.users where id = $1`, [p.userId])).rows[0].email as string;
    const inv = await invite(email, "receptionist");
    expect(await accept(p.userId)).toMatchObject({ status: "already_linked", role: "practitioner" });
    expect(await inviteStatus(inv)).toBe("accepted");
    expect(await memberships(p.userId)).toEqual({ practitioners: 1, desk: 0 });
  });

  it("an active receptionist invited as a practitioner of the SAME studio is refused (23514), and the invitation stays pending", async () => {
    const u = await seedAuthUser("desk-to-practitioner");
    await invite(u.email, "receptionist");
    await accept(u.id);
    const inv = await invite(u.email, "practitioner");
    const code = await accept(u.id).then(() => "accepted", errCode);
    expect(code).toBe("23514");
    expect(await inviteStatus(inv)).toBe("pending");
    expect(await memberships(u.id)).toEqual({ practitioners: 0, desk: 1 });
  });
});

describe("0218: everything else is unchanged", () => {
  it("a practitioner invitation still creates a practitioners row with the invited role", async () => {
    const u = await seedAuthUser("new-practitioner");
    const inv = await invite(u.email, "practitioner");
    expect(await accept(u.id)).toMatchObject({ status: "linked", role: "practitioner" });
    expect(await inviteStatus(inv)).toBe("accepted");
    expect(await memberships(u.id)).toEqual({ practitioners: 1, desk: 0 });
    const onboarding = await adminQuery(`select count(*)::int as n from public.studio_onboarding where studio_id = $1`, [
      S.studioId,
    ]);
    expect(onboarding.rows[0].n).toBe(1);
  });

  it("the role CHECK admits exactly owner, practitioner and receptionist", async () => {
    const u = await seedAuthUser("bad-role");
    const code = await invite(u.email, "admin").then(() => "inserted", errCode);
    expect(code).toBe("23514");
  });

  it("the linker stays service-role only", async () => {
    const r = await adminQuery(
      `select has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('service_role', p.oid, 'execute') as sr
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'link_invited_membership'`,
    );
    expect(r.rows).toEqual([{ anon: false, auth: false, sr: true }]);
  });
});
