import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, asRole, asUser, closePool, enableFrontDesk, seedStudio, type SeededStudio } from "./helpers/harness";

// 0390: the per-studio Front Desk switch and admin-granted receptionist seats, proved on the real migrated database. Synthetic values only.
// The seat is STUDIO CAPACITY; one rule everywhere (invite, accept, reactivate): active receptionists + pending receptionist invitations + 1 <= limit.
// Access is refused AT THE DATABASE (receptionist_actor_id), so revoking a seat, expiring it or switching the studio off stops a live receptionist's own
// JWT on its very next call, whatever the page does.

const TZFN = "public.receptionist_studio_timezone(uuid)";
const ACTOR = ["00000000-0000-4000-8000-0000000000aa", "fixture-admin@harness.local"] as const;

let S: SeededStudio;
const users: string[] = [];

const authUser = async (label: string) => {
  const id = randomUUID();
  const email = `${label}-${id.slice(0, 8)}@harness.local`;
  await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [id, email]);
  users.push(id);
  return { id, email };
};
const invite = (email: string, studioId = S.studioId) =>
  adminQuery(
    `insert into public.pending_invitations (studio_id, email, invited_by, role, display_name, status)
     values ($1, $2, $3, 'receptionist', 'Desk', 'pending') returning id`,
    [studioId, email, S.practitionerId],
  ).then((r) => r.rows[0].id as string);
const addDesk = (userId: string, email: string) =>
  adminQuery(`select public.add_studio_receptionist($1,$2,$3,'Desk',$4) as id`, [S.studioId, S.practitionerId, userId, email]).then((r) => r.rows[0].id as string);
const grant = (seats: number, expires: string | null = null) =>
  adminQuery(`select public.admin_grant_front_desk_seats($1,$2,'pilot','fixture grant',$3,$4,$5) as id`, [S.studioId, seats, expires, ACTOR[0], ACTOR[1]]).then((r) => r.rows[0].id as string);
const revoke = (seatId: string) =>
  adminQuery(`select public.admin_revoke_front_desk_seats($1,'fixture revoke',$2,$3) as r`, [seatId, ACTOR[0], ACTOR[1]]).then((r) => r.rows[0].r as Record<string, unknown>);
const setActive = (receptionistId: string, active: boolean) =>
  adminQuery(`select public.set_studio_receptionist_active($1,$2,$3,$4) as r`, [S.studioId, S.practitionerId, receptionistId, active]).then((r) => r.rows[0].r as string);
const accept = (userId: string) => adminQuery(`select public.admin_accept_pending_invitation($1) as r`, [userId]).then((r) => r.rows[0].r as Record<string, unknown>);
const deskTz = (userId: string) => asUser(userId, (x) => x(`select ${TZFN.replace("(uuid)", "")}($1) as tz`, [S.studioId]));
const access = (userId: string) => asUser(userId, (x) => x(`select * from public.front_desk_access()`)).then((r) => r.rows.map((row) => Object.values(row)[0] as string));
const clear = async () => {
  await adminQuery(`delete from public.pending_invitations where studio_id = $1`, [S.studioId]);
  await adminQuery(`delete from public.studio_receptionists where studio_id = $1`, [S.studioId]);
  await adminQuery(`delete from public.studio_front_desk_seats where studio_id = $1`, [S.studioId]);
  await adminQuery(`delete from public.platform_rollout_studios where rollout_key = 'front_desk' and studio_id = $1`, [S.studioId]);
};
const switchOn = () => adminQuery(`select public.add_platform_rollout_studio('front_desk',$1,$2,$3)`, [S.studioId, ACTOR[0], ACTOR[1]]);

beforeAll(async () => {
  await adminQuery(`update public.platform_rollouts set mode = 'pilot' where key = 'front_desk' and mode = 'off'`);
  S = await seedStudio("fd-seats", { frontDesk: false });
});
afterAll(async () => {
  if (S) {
    await clear();
    await adminQuery(`delete from public.practitioners where studio_id = $1`, [S.studioId]);
    await adminQuery(`delete from public.clients where studio_id = $1`, [S.studioId]);
    await adminQuery(`delete from public.studios where id = $1`, [S.studioId]);
  }
  for (const id of users) await adminQuery(`delete from auth.users where id = $1`, [id]);
  await closePool();
});

describe("the switch and the seat limit, at invite, add and reactivate", () => {
  it("starts empty: switch off refuses an invitation and an add with front_desk_not_enabled", async () => {
    await clear();
    const u = await authUser("off");
    await expect(invite(u.email)).rejects.toMatchObject({ message: expect.stringContaining("front_desk_not_enabled") });
    await expect(addDesk(u.id, u.email)).rejects.toMatchObject({ message: expect.stringContaining("front_desk_not_enabled") });
  });

  it("switch on with no seat refuses with front_desk_seat_limit_reached; one seat admits exactly one reservation", async () => {
    await clear();
    await switchOn();
    const a = await authUser("a");
    const b = await authUser("b");
    await expect(invite(a.email)).rejects.toMatchObject({ message: expect.stringContaining("front_desk_seat_limit_reached") });
    await grant(1);
    await invite(a.email);
    // a pending invitation RESERVES the seat
    await expect(invite(b.email)).rejects.toMatchObject({ message: expect.stringContaining("front_desk_seat_limit_reached") });
  });

  it("accepting the reserved invitation needs no second seat; reactivating a second person is refused with the seat_limit status", async () => {
    await clear();
    await switchOn();
    await grant(1);
    const a = await authUser("acc");
    await invite(a.email);
    await expect(accept(a.id)).resolves.toMatchObject({ status: "linked", role: "receptionist" });
    const rid = (await adminQuery(`select id from public.studio_receptionists where studio_id = $1 and user_id = $2`, [S.studioId, a.id])).rows[0].id as string;
    expect(await setActive(rid, false)).toBe("updated");
    // the seat is free again: another person takes it, so reactivating the first is refused
    const b = await authUser("other");
    await invite(b.email);
    await accept(b.id);
    expect(await setActive(rid, true)).toBe("seat_limit");
  });

  it("reactivate with the switch off answers front_desk_off, and accept leaves the invitation pending with a status", async () => {
    await clear();
    await switchOn();
    await grant(2);
    const a = await authUser("rea");
    await invite(a.email);
    await accept(a.id);
    const rid = (await adminQuery(`select id from public.studio_receptionists where studio_id = $1 and user_id = $2`, [S.studioId, a.id])).rows[0].id as string;
    await setActive(rid, false);
    const b = await authUser("pend");
    const inv = await invite(b.email);
    await adminQuery(`delete from public.platform_rollout_studios where rollout_key = 'front_desk' and studio_id = $1`, [S.studioId]);
    expect(await setActive(rid, true)).toBe("front_desk_off");
    await expect(accept(b.id)).resolves.toMatchObject({ status: "front_desk_off" });
    expect((await adminQuery(`select status from public.pending_invitations where id = $1`, [inv])).rows[0].status).toBe("pending");
  });

  it("two people racing for the LAST seat: exactly one invitation wins", async () => {
    for (let round = 0; round < 5; round++) {
      await clear();
      await switchOn();
      await grant(1);
      const a = await authUser("race-a");
      const b = await authUser("race-b");
      const results = await Promise.allSettled([invite(a.email), invite(b.email)]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(String(lost.reason?.message)).toContain("front_desk_seat_limit_reached");
      expect((await adminQuery(`select count(*)::int as n from public.pending_invitations where studio_id = $1 and status = 'pending'`, [S.studioId])).rows[0].n).toBe(1);
    }
  });
});

describe("revocation, expiry and the switch stop a live receptionist's own token at the database", () => {
  it("seated: the desk RPC answers and front_desk_access lists the studio", async () => {
    await clear();
    await switchOn();
    await grant(1);
    const u = await authUser("live");
    await addDesk(u.id, u.email);
    await expect(deskTz(u.id)).resolves.toBeTruthy();
    expect(await access(u.id)).toEqual([S.studioId]);
  });

  it("revoke: the very next call is refused, the row is untouched, and a re-grant restores access with no data change", async () => {
    await clear();
    await switchOn();
    const seat = await grant(1);
    const u = await authUser("rev");
    const rid = await addDesk(u.id, u.email);
    await expect(deskTz(u.id)).resolves.toBeTruthy();
    expect(await revoke(seat)).toMatchObject({ status: "revoked", seat_limit_after: 0, seats_over_limit: 1 });
    await expect(deskTz(u.id)).rejects.toBeTruthy();
    expect(await access(u.id)).toEqual([]);
    expect((await adminQuery(`select active from public.studio_receptionists where id = $1`, [rid])).rows[0].active).toBe(true);
    await grant(1);
    await expect(deskTz(u.id)).resolves.toBeTruthy();
  });

  it("expiry: a grant past its expiry stops the next call with no write at all", async () => {
    await clear();
    await switchOn();
    const u = await authUser("exp");
    await grant(1);
    await addDesk(u.id, u.email);
    await expect(deskTz(u.id)).resolves.toBeTruthy();
    // A grant is never edited (the guard forbids it), so time passes by replacing the live grant with one that has already expired.
    await adminQuery(`delete from public.studio_front_desk_seats where studio_id = $1`, [S.studioId]);
    await adminQuery(
      `insert into public.studio_front_desk_seats (studio_id, seats, source, reason, granted_by_admin, granted_at, expires_at)
       values ($1, 1, 'pilot', 'fixture expired', 'fixture@harness.local', now() - interval '2 hours', now() - interval '1 hour')`,
      [S.studioId],
    );
    await expect(deskTz(u.id)).rejects.toBeTruthy();
    expect(await access(u.id)).toEqual([]);
  });

  it("switch off: the next call is refused", async () => {
    await clear();
    await switchOn();
    await grant(1);
    const u = await authUser("sw");
    await addDesk(u.id, u.email);
    await expect(deskTz(u.id)).resolves.toBeTruthy();
    await adminQuery(`select public.remove_platform_rollout_studio('front_desk',$1,$2,$3)`, [S.studioId, ACTOR[0], ACTOR[1]]);
    await expect(deskTz(u.id)).rejects.toBeTruthy();
    expect(await access(u.id)).toEqual([]);
  });

  it("over the limit: the OLDEST active receptionist keeps the seat and the newest is refused (rank by created_at, id)", async () => {
    await clear();
    await switchOn();
    const seat = await grant(2);
    const first = await authUser("first");
    const second = await authUser("second");
    await addDesk(first.id, first.email);
    await addDesk(second.id, second.email);
    await revoke(seat);
    await grant(1);
    await expect(deskTz(first.id)).resolves.toBeTruthy();
    await expect(deskTz(second.id)).rejects.toBeTruthy();
    expect(await access(second.id)).toEqual([]);
  });

  it("another studio's receptionist learns nothing about this studio's switch or seats", async () => {
    await clear();
    await switchOn();
    await grant(1);
    const other = await seedStudio("fd-other", { frontDesk: true });
    const u = await authUser("cross");
    await adminQuery(`insert into public.studio_receptionists (studio_id,user_id,display_name,active) values ($1,$2,'Other',true)`, [other.studioId, u.id]);
    expect(await access(u.id)).toEqual([other.studioId]);
    await expect(asUser(u.id, (x) => x(`select ${TZFN.replace("(uuid)", "")}($1)`, [S.studioId]))).rejects.toBeTruthy();
    await adminQuery(`delete from public.studio_receptionists where studio_id = $1`, [other.studioId]);
  });
});

describe("who can call what", () => {
  it("admin commands and the owner summary are service_role only; front_desk_access is authenticated only", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(role, (x) => x(`select public.admin_list_front_desk($1)`, [S.studioId]))).rejects.toMatchObject({ code: "42501" });
      await expect(asRole(role, (x) => x(`select public.owner_front_desk_summary($1,$2)`, [S.studioId, S.practitionerId]))).rejects.toMatchObject({ code: "42501" });
    }
    await expect(asRole("anon", (x) => x(`select * from public.front_desk_access()`))).rejects.toMatchObject({ code: "42501" });
    await expect(asRole("service_role", (x) => x(`select * from public.front_desk_access()`))).rejects.toMatchObject({ code: "42501" });
  });

  it("the owner summary shows only numbers and never a reason; a non-owner is not authorized", async () => {
    await clear();
    await switchOn();
    await grant(3);
    const r = (await adminQuery(`select public.owner_front_desk_summary($1,$2) as r`, [S.studioId, S.practitionerId])).rows[0].r as Record<string, unknown>;
    expect(r).toMatchObject({ status: "ok", switch_on: true, seat_limit: 3, seats_active: 0, seats_reserved: 0, seats_available: 3, seats_over_limit: 0 });
    expect(JSON.stringify(r)).not.toContain("fixture grant");
    const stranger = (await adminQuery(`select public.owner_front_desk_summary($1,$2) as r`, [S.studioId, randomUUID()])).rows[0].r;
    expect(stranger).toEqual({ status: "not_authorized" });
  });
});

describe("the fixture helper", () => {
  it("enableFrontDesk switches a studio on with seats", async () => {
    await clear();
    await enableFrontDesk(S.studioId, 2);
    const r = (await adminQuery(`select public.owner_front_desk_summary($1,$2) as r`, [S.studioId, S.practitionerId])).rows[0].r as Record<string, unknown>;
    expect(r).toMatchObject({ switch_on: true, seat_limit: 2 });
  });
});
