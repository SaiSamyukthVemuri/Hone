import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { adminQuery, adminTx, closePool, seedStudio, type SeededStudio, type UserQuery } from "./helpers/harness";

// 0279: removing a receptionist also revokes their outstanding invitations. Before it, accepting an old pending
// invitation REACTIVATED the removed row (link_invited_membership, 0218). Synthetic values only.

let studio: SeededStudio;
let deskUser: string;
let deskEmail: string;
let receptionistId: string;

const asServiceRole = <T>(fn: (x: UserQuery) => Promise<T>) =>
  adminTx(async (x) => {
    await x("set local role service_role");
    return fn(x);
  });
const remove = () =>
  asServiceRole(async (x) => (await x("select public.set_studio_receptionist_active($1,$2,$3,false) as r", [studio.studioId, studio.practitionerId, receptionistId])).rows[0].r as string);
const accept = () =>
  asServiceRole(async (x) => (await x("select public.admin_accept_pending_invitation($1) as r", [deskUser])).rows[0].r as { status: string });
const row = async () => (await adminQuery("select active, deactivated_at from public.studio_receptionists where id=$1", [receptionistId])).rows[0];
const invite = (email = deskEmail) =>
  adminQuery(
    "insert into public.pending_invitations(studio_id,email,invited_by,role,display_name,status) values ($1,$2,$3,'receptionist','Synthetic Front Desk','pending') returning id",
    [studio.studioId, email, studio.practitionerId],
  );
const statusOf = async (id: string) => (await adminQuery("select status from public.pending_invitations where id=$1", [id])).rows[0].status as string;

beforeEach(async () => {
  studio = await seedStudio("desk-rm-inv");
  deskUser = randomUUID();
  deskEmail = `desk-rm-inv-${deskUser.slice(0, 8)}@harness.local`;
  await adminQuery("insert into auth.users(id,email) values ($1,$2)", [deskUser, deskEmail]);
  const r = await adminQuery(
    "insert into public.studio_receptionists(studio_id,user_id,display_name,email,active) values ($1,$2,'Synthetic Front Desk',$3,true) returning id",
    [studio.studioId, deskUser, deskEmail],
  );
  receptionistId = r.rows[0].id as string;
});

afterAll(async () => {
  await closePool();
});

describe("0279: removal closes outstanding invitations", () => {
  it("CONTROL: an invitation issued after the removal is deliberate and still re-admits (the accept path is unchanged)", async () => {
    expect(await remove()).toBe("updated");
    expect((await row()).active).toBe(false);
    await invite();
    expect((await accept()).status).toBe("linked");
    expect((await row()).active).toBe(true);
  });

  it("a pending invitation is revoked by the removal, and accepting it afterwards does NOT reactivate the membership", async () => {
    const inv = (await invite()).rows[0].id as string;
    expect(await remove()).toBe("updated");
    expect(await statusOf(inv)).toBe("revoked");
    expect((await accept()).status).toBe("no_invitation");
    const r = await row();
    expect(r.active).toBe(false);
    expect(r.deactivated_at).not.toBeNull();
  });

  it("matches the address case-insensitively and touches nothing else: other emails, other studios, practitioner invitations", async () => {
    const same = (await invite(deskEmail.toUpperCase())).rows[0].id as string;
    const other = (await invite(`someone-else-${deskUser.slice(0, 8)}@harness.local`)).rows[0].id as string;
    const otherStudio = await seedStudio("desk-rm-inv-2");
    const elsewhere = (
      await adminQuery("insert into public.pending_invitations(studio_id,email,invited_by,role,status) values ($1,$2,$3,'practitioner','pending') returning id", [
        otherStudio.studioId, `prac-${deskUser.slice(0, 8)}@harness.local`, otherStudio.practitionerId,
      ])
    ).rows[0].id as string;
    await remove();
    expect(await statusOf(same)).toBe("revoked");
    expect(await statusOf(other)).toBe("pending");
    expect(await statusOf(elsewhere)).toBe("pending");
  });

  it("is idempotent and also cleans up on a repeat removal (no_change): an invitation issued in between is revoked", async () => {
    expect(await remove()).toBe("updated");
    const inv = (await invite()).rows[0].id as string;
    expect(await remove()).toBe("no_change");
    expect(await statusOf(inv)).toBe("revoked");
    expect((await accept()).status).toBe("no_invitation");
  });

  it("reactivation (p_active = true) revokes nothing", async () => {
    await remove();
    const inv = (await invite(`later-${deskUser.slice(0, 8)}@harness.local`)).rows[0].id as string;
    await asServiceRole((x) => x("select public.set_studio_receptionist_active($1,$2,$3,true)", [studio.studioId, studio.practitionerId, receptionistId]));
    expect((await row()).active).toBe(true);
    expect(await statusOf(inv)).toBe("pending");
  });

  it("stays service_role only", async () => {
    for (const role of ["anon", "authenticated"]) {
      await expect(
        adminTx(async (x) => {
          await x(`set local role ${role}`);
          return x("select public.set_studio_receptionist_active($1,$2,$3,false)", [studio.studioId, studio.practitionerId, receptionistId]);
        }),
      ).rejects.toThrow(/permission denied/i);
    }
    const p = await adminQuery(
      "select has_function_privilege('service_role','public.set_studio_receptionist_active(uuid,uuid,uuid,boolean)','execute') as s, has_function_privilege('authenticated','public.set_studio_receptionist_active(uuid,uuid,uuid,boolean)','execute') as a",
    );
    expect(p.rows[0]).toEqual({ s: true, a: false });
  });
});
