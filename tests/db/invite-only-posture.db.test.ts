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
// trigger (invitation -> practitioner). No normal authenticated user —
// and especially no "no-studio" user (an uninvited sign-in: an
// auth.users row with no practitioner) — can create a studio, add
// themselves as a practitioner, write an invitation, or escalate a role.

let s: SeededStudio; // an established studio + owner
let member: { userId: string; practitionerId: string };
let foreign: SeededStudio; // a different studio's owner
let noStudioUserId: string; // authenticated, but no practitioner row

beforeAll(async () => {
  s = await seedStudio("inviteonly");
  member = await seedMember(s, "inviteonly-member");
  foreign = await seedStudio("inviteonly-foreign");
  // A bare auth user with NO practitioner row — the uninvited-sign-in case.
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
    ).rejects.toThrow(/row-level security/i);
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
  it("cannot INSERT a practitioner (owner-only)", async () => {
    await expect(
      userQuery(
        member.userId,
        `insert into public.practitioners
           (id, studio_id, user_id, display_name, email, role, active)
         values ($1, $2, $3, 'Member Add', 'memberadd@example.com', 'practitioner', true)`,
        [randomUUID(), s.studioId, randomUUID()],
      ),
    ).rejects.toThrow(/row-level security/i);
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

  it("cannot escalate their own role to owner (owner-only UPDATE)", async () => {
    const r = await userQuery(
      member.userId,
      `update public.practitioners set role = 'owner' where id = $1`,
      [member.practitionerId],
    );
    expect(r.rowCount).toBe(0);
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

  it("handle_new_user provisions a practitioner from an invitation (the invited first sign-in)", async () => {
    // Mirror the production path: invitation row, then an auth user with
    // that email. The SECURITY DEFINER trigger creates the practitioner.
    const studioId = s.studioId;
    const email = `inviteflow-${randomUUID().slice(0, 8)}@harness.local`;
    await adminQuery(
      `insert into public.pending_invitations (studio_id, email, role, display_name)
       values ($1, $2, 'practitioner', 'Invited Tech')`,
      [studioId, email],
    );
    await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [
      randomUUID(),
      email,
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
