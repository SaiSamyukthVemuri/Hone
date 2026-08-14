import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  asUser,
  closePool,
  seedMember,
  seedStudio,
  userQuery,
  type SeededStudio,
} from "./helpers/harness";
import { randomUUID } from "node:crypto";

// PR #253: invite-only posture, proven at the RLS layer on the real
// migrated DB. Studio creation and owner membership happen ONLY via the
// service-role new-studio path + the SECURITY DEFINER handle_new_user
// trigger (invitation -> practitioner). No normal authenticated user,
// and especially no "no-studio" user (an uninvited sign-in: an
// auth.users row with no practitioner), can create a studio, add
// themselves as a practitioner, write an invitation, or escalate a role.

let s: SeededStudio; // an established studio + owner
let member: { userId: string; practitionerId: string };
let foreign: SeededStudio; // a different studio's owner
let noStudioUserId: string; // authenticated, but no practitioner row

beforeAll(async () => {
  s = await seedStudio("inviteonly");
  member = await seedMember(s, "inviteonly-member");
  foreign = await seedStudio("inviteonly-foreign");
  // A bare auth user with NO practitioner row, the uninvited-sign-in case.
  noStudioUserId = randomUUID();
  await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [
    noStudioUserId,
    `inviteonly-nostudio-${noStudioUserId.slice(0, 8)}@harness.local`,
  ]);
});

afterAll(async () => {
  await closePool();
});

describe("a no-studio authenticated user cannot bootstrap access", () => {
  it("cannot INSERT a studio (no INSERT policy on studios)", async () => {
    await expect(
      userQuery(
        noStudioUserId,
        `insert into public.studios (id, name, owner_email)
         values ($1, 'Rogue Studio', 'rogue@example.com')`,
        [randomUUID()],
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("cannot INSERT a practitioner to add themselves to an existing studio", async () => {
    await expect(
      userQuery(
        noStudioUserId,
        `insert into public.practitioners
           (id, studio_id, user_id, display_name, email, role, active)
         values ($1, $2, $3, 'Self Add', 'self@example.com', 'owner', true)`,
        [randomUUID(), s.studioId, noStudioUserId],
      ),
      // 0178: refused by PRIVILEGE now, a stranger cannot even reach the
      // policy layer to be rejected by it.
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("cannot INSERT a pending invitation for any studio", async () => {
    await expect(
      userQuery(
        noStudioUserId,
        `insert into public.pending_invitations (studio_id, email, role)
         values ($1, 'invitee@example.com', 'owner')`,
        [s.studioId],
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("sees no studio, practitioner, or invitation rows (cross-studio default-deny)", async () => {
    await asUser(noStudioUserId, async (q) => {
      const studios = await q(`select id from public.studios`);
      const pracs = await q(`select id from public.practitioners`);
      const invs = await q(`select id from public.pending_invitations`);
      expect(studios.rowCount).toBe(0);
      expect(pracs.rowCount).toBe(0);
      expect(invs.rowCount).toBe(0);
    });
  });
});

describe("a non-owner member cannot create memberships or escalate", () => {
  it("cannot INSERT a practitioner: now refused by PRIVILEGE, not RLS", async () => {
    // 0178 revoked INSERT on public.practitioners from every runtime role, so
    // this is refused one layer EARLIER than it used to be: `42501 permission
    // denied` instead of a policy violation. The property this test exists for,
    // a non-owner cannot manufacture a membership, is unchanged and is now
    // enforced by something RLS cannot be misconfigured around.
    await expect(
      userQuery(
        member.userId,
        `insert into public.practitioners
           (id, studio_id, user_id, display_name, email, role, active)
         values ($1, $2, $3, 'Member Add', 'memberadd@example.com', 'practitioner', true)`,
        [randomUUID(), s.studioId, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("cannot INSERT an invitation (owner-only)", async () => {
    await expect(
      userQuery(
        member.userId,
        `insert into public.pending_invitations (studio_id, email, role)
         values ($1, 'memberinvite@example.com', 'owner')`,
        [s.studioId],
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("cannot escalate their own role to owner, now a hard error, not a silent no-op", async () => {
    // THIS ASSERTION USED TO READ `expect(r.rowCount).toBe(0)`.
    //
    // That is the shape 0178 exists to remove: under the owner-gated policy the
    // statement SUCCEEDED and simply matched no row, so a refusal and a
    // no-op were indistinguishable, the same ambiguity that made three
    // "self-service" profile actions silently do nothing for non-owners.
    // With UPDATE revoked the escalation attempt now fails loudly.
    await expect(
      userQuery(
        member.userId,
        `update public.practitioners set role = 'owner' where id = $1`,
        [member.practitionerId],
      ),
    ).rejects.toMatchObject({ code: "42501" });

    const after = await adminQuery(
      `select role from public.practitioners where id = $1`,
      [member.practitionerId],
    );
    expect(after.rows[0].role).toBe("practitioner");
  });
});

describe("the supported invited-owner flow still works (positive controls)", () => {
  it("an owner CAN write an invitation in their own studio; a foreign owner cannot", async () => {
    const ok = await userQuery(
      s.userId,
      `insert into public.pending_invitations (studio_id, email, role)
       values ($1, $2, 'practitioner')`,
      [s.studioId, `invited-${randomUUID().slice(0, 8)}@example.com`],
    );
    expect(ok.rowCount).toBe(1);

    await expect(
      userQuery(
        foreign.userId,
        `insert into public.pending_invitations (studio_id, email, role)
         values ($1, 'cross@example.com', 'owner')`,
        [s.studioId],
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("an invited first sign-in provisions NOTHING from the trigger; explicit acceptance links it", async () => {
    // handle_new_user is a NO-OP (migration 0141): creating the auth user must
    // not fabricate a membership. Provisioning + consent happen via the
    // service-role acceptance command (the authoritative event).
    const studioId = s.studioId;
    const email = `inviteflow-${randomUUID().slice(0, 8)}@harness.local`;
    await adminQuery(
      `insert into public.pending_invitations (studio_id, email, role, display_name)
       values ($1, $2, 'practitioner', 'Invited Tech')`,
      [studioId, email],
    );
    const userId = randomUUID();
    await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [
      userId,
      email,
    ]);
    // Trigger did nothing; invite still pending.
    const afterSignin = await adminQuery(
      `select count(*)::int as n from public.practitioners p
         join auth.users u on u.id = p.user_id where lower(u.email) = lower($1)`,
      [email],
    );
    expect(afterSignin.rows[0].n).toBe(0);

    // Explicit acceptance (service-role only) links exactly one practitioner.
    await adminQuery(`select public.admin_accept_pending_invitation($1)`, [
      userId,
    ]);
    const created = await adminQuery(
      `select p.role, p.studio_id from public.practitioners p
         join auth.users u on u.id = p.user_id
        where lower(u.email) = lower($1)`,
      [email],
    );
    expect(created.rowCount).toBe(1);
    expect(created.rows[0].studio_id).toBe(studioId);
    expect(created.rows[0].role).toBe("practitioner");
  });
});
