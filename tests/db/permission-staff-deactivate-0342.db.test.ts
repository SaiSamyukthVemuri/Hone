import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, adminTx, asRole, asUser, closePool, seedMember, seedStudio, type SeededStudio } from "./helpers/harness";

// 0342 (Roles S2): deactivate_staff_member / reactivate_staff_member and the RF-1 lock. Synthetic data only.
// NOT RUN until an OPS slot is granted and 0342 is on an owned isolated stack (paired E2E_SUPABASE_URL + HONE_LOCAL_DB_URL).
// The 'keep' and 'reassign' policies are exercised by installing a replacement perm_upcoming_policy and restoring 0342's 'block' in afterAll.

type J = Record<string, any>;
const REASON = "Left the studio at the end of the month";
const call = async (userId: string, sql: string, params: unknown[]): Promise<J> => asUser(userId, async (q) => (await q(sql, params)).rows[0].r as J);
const deact = (u: string, s: string, m: string, kind: string, reason: string | null = REASON) => call(u, "select public.deactivate_staff_member($1,$2,$3,$4) as r", [s, m, kind, reason]);
const react = (u: string, s: string, m: string, kind: string, reason: string | null = REASON) => call(u, "select public.reactivate_staff_member($1,$2,$3,$4) as r", [s, m, kind, reason]);
const openGate = (studioId: string) =>
  adminQuery("insert into public.permission_ship_gates(studio_id,gate,met) values ($1,'staff_role_change',true) on conflict (studio_id,gate) do update set met=true", [studioId]);
const setPolicy = (v: "block" | "keep" | "reassign") => adminQuery(`create or replace function public.perm_upcoming_policy() returns text language sql immutable set search_path = '' as $$ select '${v}'::text $$`, []);
const activeOf = async (table: "practitioners" | "studio_receptionists", id: string) => (await adminQuery(`select active from public.${table} where id=$1`, [id])).rows[0].active as boolean;
const audit = async (studioId: string, kind: string) => (await adminQuery("select * from public.permission_audit where studio_id=$1 and kind=$2 order by id", [studioId, kind])).rows;

let slot = 0;
async function seedAppt(s: SeededStudio, practitionerId: string, o: { status?: string; offsetDays?: number } = {}) {
  const clientId = randomUUID();
  await adminQuery("insert into public.clients(id,studio_id,name) values ($1,$2,$3)", [clientId, s.studioId, "Client 0342"]);
  await adminQuery(
    `insert into public.appointments (id, studio_id, practitioner_id, client_id, starts_at, ends_at, duration_minutes, status)
     values ($1,$2,$3,$4, now() + ($5 || ' days')::interval + ($7 || ' hours')::interval, now() + ($5 || ' days')::interval + ($7 || ' hours')::interval + interval '30 minutes', 30, $6)`,
    [randomUUID(), s.studioId, practitionerId, clientId, String(o.offsetDays ?? 3), o.status ?? "confirmed", String((slot += 1) * 2)],
  );
}
async function seedDesk(s: SeededStudio, label: string) {
  const userId = randomUUID();
  await adminQuery("insert into auth.users(id,email) values ($1,$2)", [userId, `${label}-${userId.slice(0, 8)}@harness.local`]);
  const r = await adminQuery("insert into public.studio_receptionists(studio_id,user_id,display_name,email,active) values ($1,$2,$3,$4,true) returning id", [s.studioId, userId, `Desk ${label}`, `${label}-${userId.slice(0, 8)}@harness.local`]);
  return { userId, id: r.rows[0].id as string };
}

afterAll(async () => {
  await setPolicy("keep"); // 0342's shipped value
  await closePool();
});

describe("deactivate_staff_member", () => {
  it("ships with the policy 'keep' (today's behaviour): a practitioner with upcoming appointments is removed, the count is reported, the appointments stay", async () => {
    expect((await adminQuery("select public.perm_upcoming_policy() p", [])).rows[0].p).toBe("keep"); // before any test changes it
    const s = await seedStudio("d342z");
    const m = await seedMember(s, "dz");
    await seedAppt(s, m.practitionerId);
    await seedAppt(s, m.practitionerId);
    expect(await deact(s.userId, s.studioId, m.practitionerId, "practitioner")).toMatchObject({ ok: true, upcoming: 2, active: false });
    expect((await adminQuery("select count(*)::int n from public.appointments where studio_id=$1 and practitioner_id=$2", [s.studioId, m.practitionerId])).rows[0].n).toBe(2);
    expect((await audit(s.studioId, "staff_deactivated"))[0].after).toMatchObject({ active: false, upcoming_kept: 2 });
  });
  it("deactivates a practitioner, audits it with the reason, deletes nothing, and leaves another studio alone", async () => {
    await setPolicy("block");
    const s = await seedStudio("d342a");
    const other = await seedStudio("d342b");
    const m = await seedMember(s, "d1");
    const o = await seedMember(other, "d1o");
    const r = await deact(s.userId, s.studioId, m.practitionerId, "practitioner");
    expect(r).toMatchObject({ ok: true, kind: "practitioner", active: false });
    expect(await activeOf("practitioners", m.practitionerId)).toBe(false);
    expect(await activeOf("practitioners", o.practitionerId)).toBe(true);
    const rows = await audit(s.studioId, "staff_deactivated");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ membership_id: m.practitionerId, membership_kind: "practitioner", reason: REASON, actor_user_id: s.userId });
    expect(rows[0].before).toEqual({ active: true });
  });
  it("S2-4: deactivating a practitioner revokes their private calendar feed, and restoring them does not bring the old link back", async () => {
    const s = await seedStudio("d342f");
    await openGate(s.studioId);
    const m = await seedMember(s, "f1");
    const bystander = await seedMember(s, "f2");
    const hash = "a".repeat(64);
    const otherHash = "b".repeat(64);
    await adminQuery("update public.practitioners set calendar_feed_token_hash=$2 where id=$1", [m.practitionerId, hash]);
    await adminQuery("update public.practitioners set calendar_feed_token_hash=$2 where id=$1", [bystander.practitionerId, otherHash]);
    const feed = async (id: string) => (await adminQuery("select calendar_feed_token_hash h from public.practitioners where id=$1", [id])).rows[0].h;
    // A refused removal revokes nothing (the revoke is part of the same statement as the deactivation, not a side effect of trying).
    expect(await deact(m.userId, s.studioId, m.practitionerId, "practitioner")).toMatchObject({ ok: false, code: "refused" });
    expect(await feed(m.practitionerId)).toBe(hash);
    expect(await deact(s.userId, s.studioId, m.practitionerId, "practitioner")).toMatchObject({ ok: true, active: false });
    expect(await feed(m.practitionerId)).toBeNull();
    expect(await feed(bystander.practitionerId)).toBe(otherHash);
    expect(await react(s.userId, s.studioId, m.practitionerId, "practitioner")).toMatchObject({ ok: true, active: true });
    expect(await feed(m.practitionerId)).toBeNull();
  });

  it("deactivates a receptionist (a path that did not exist), stamping deactivated_at", async () => {
    const s = await seedStudio("d342r");
    const d = await seedDesk(s, "d2");
    expect(await deact(s.userId, s.studioId, d.id, "receptionist")).toMatchObject({ ok: true, kind: "receptionist" });
    const row = (await adminQuery("select active, deactivated_at from public.studio_receptionists where id=$1", [d.id])).rows[0];
    expect(row.active).toBe(false);
    expect(row.deactivated_at).not.toBeNull();
  });
  it("refuses: a non-owner, a stranger studio's owner, an owner target, self, an unknown id, an unknown kind, an inactive target", async () => {
    const s = await seedStudio("d342c");
    const m = await seedMember(s, "d3");
    const m2 = await seedMember(s, "d3b");
    const other = await seedStudio("d342d");
    expect(await deact(m.userId, s.studioId, m2.practitionerId, "practitioner")).toEqual({ ok: false, code: "refused" });
    expect(await deact(other.userId, s.studioId, m.practitionerId, "practitioner")).toEqual({ ok: false, code: "refused" });
    expect(await deact(s.userId, s.studioId, s.practitionerId, "practitioner")).toMatchObject({ code: "owner_role_fixed" });
    expect(await deact(s.userId, s.studioId, randomUUID(), "practitioner")).toMatchObject({ code: "not_found" });
    expect(await deact(s.userId, s.studioId, m.practitionerId, "admin")).toMatchObject({ code: "unknown_role" });
    expect(await deact(s.userId, s.studioId, m.practitionerId, "receptionist")).toMatchObject({ code: "not_found" }); // wrong table for this id
    expect(await deact(s.userId, s.studioId, m.practitionerId, "practitioner")).toMatchObject({ ok: true });
    expect(await deact(s.userId, s.studioId, m.practitionerId, "practitioner")).toMatchObject({ code: "not_active" });
    expect(await audit(s.studioId, "staff_deactivated")).toHaveLength(1); // only the one success
  });
  it("a receptionist cannot deactivate anyone, themselves included", async () => {
    const s = await seedStudio("d342e");
    const d = await seedDesk(s, "d5");
    expect(await deact(d.userId, s.studioId, d.id, "receptionist")).toEqual({ ok: false, code: "refused" });
    expect(await activeOf("studio_receptionists", d.id)).toBe(true);
  });
  it("needs a meaningful reason, and a refusal never depends on it", async () => {
    const s = await seedStudio("d342f");
    const m = await seedMember(s, "d6");
    expect(await deact(s.userId, s.studioId, m.practitionerId, "practitioner", null)).toMatchObject({ code: "reason_required" });
    expect(await deact(s.userId, s.studioId, m.practitionerId, "practitioner", "   ")).toMatchObject({ code: "reason_required" });
    expect(await deact(s.userId, s.studioId, m.practitionerId, "practitioner", "n/a")).toMatchObject({ code: "reason_invalid" });
    expect(await activeOf("practitioners", m.practitionerId)).toBe(true);
    expect(await deact(s.userId, s.studioId, s.practitionerId, "practitioner", null)).toMatchObject({ code: "owner_role_fixed" });
  });
  it("policy block: a non-cancelled future appointment blocks (count reported); cancelled and past do not", async () => {
    await setPolicy("block");
    const s = await seedStudio("d342g");
    const m = await seedMember(s, "d7");
    await seedAppt(s, m.practitionerId, { status: "cancelled" });
    await seedAppt(s, m.practitionerId, { offsetDays: -2 });
    await seedAppt(s, m.practitionerId, { status: "no_show" });
    expect(await deact(s.userId, s.studioId, m.practitionerId, "practitioner")).toMatchObject({ ok: false, code: "has_upcoming_appointments", count: 1 });
    expect(await activeOf("practitioners", m.practitionerId)).toBe(true);
    expect(await audit(s.studioId, "staff_deactivated")).toHaveLength(0);
  });
  it("policy keep: deactivates and leaves the appointment where it was (today's behaviour); policy reassign refuses with its own code", async () => {
    const s = await seedStudio("d342h");
    const m = await seedMember(s, "d8");
    await seedAppt(s, m.practitionerId);
    await setPolicy("reassign");
    expect(await deact(s.userId, s.studioId, m.practitionerId, "practitioner")).toMatchObject({ code: "reassign_required", count: 1 });
    await setPolicy("keep");
    expect(await deact(s.userId, s.studioId, m.practitionerId, "practitioner")).toMatchObject({ ok: true, upcoming: 1 });
    expect((await adminQuery("select count(*)::int n from public.appointments where studio_id=$1 and practitioner_id=$2", [s.studioId, m.practitionerId])).rows[0].n).toBe(1);
    await setPolicy("keep");
  });
  it("RF-1: an appointment inserted by a concurrent session AFTER the command started is not missed", async () => {
    await setPolicy("block");
    const s = await seedStudio("d342i");
    const m = await seedMember(s, "d9");
    const clientId = randomUUID();
    await adminQuery("insert into public.clients(id,studio_id,name) values ($1,$2,'Client race')", [clientId, s.studioId]);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const gotLock = new Promise<void>((r) => (locked = r));
    // session B: holds the studio capacity lock, as every appointment writer does, and will insert an appointment before committing
    const writer = adminTx(async (q) => {
      await q("select public.acquire_studio_capacity_lock($1)", [s.studioId]);
      locked();
      await held;
      await q(
        `insert into public.appointments (id, studio_id, practitioner_id, client_id, starts_at, ends_at, duration_minutes, status)
         values ($1,$2,$3,$4, now() + interval '5 days', now() + interval '5 days 30 minutes', 30, 'confirmed')`,
        [randomUUID(), s.studioId, m.practitionerId, clientId],
      );
    });
    await gotLock;
    const command = deact(s.userId, s.studioId, m.practitionerId, "practitioner"); // blocks on the lock
    await new Promise((r) => setTimeout(r, 500));
    release();
    await writer;
    expect(await command).toMatchObject({ ok: false, code: "has_upcoming_appointments", count: 1 });
    expect(await activeOf("practitioners", m.practitionerId)).toBe(true);
  });
  it("RF-1 for change_staff_role: the same race is not missed there either", async () => {
    await setPolicy("block");
    const s = await seedStudio("d342j");
    await openGate(s.studioId);
    const m = await seedMember(s, "d10");
    const clientId = randomUUID();
    await adminQuery("insert into public.clients(id,studio_id,name) values ($1,$2,'Client race2')", [clientId, s.studioId]);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const gotLock = new Promise<void>((r) => (locked = r));
    const writer = adminTx(async (q) => {
      await q("select public.acquire_studio_capacity_lock($1)", [s.studioId]);
      locked();
      await held;
      await q(
        `insert into public.appointments (id, studio_id, practitioner_id, client_id, starts_at, ends_at, duration_minutes, status)
         values ($1,$2,$3,$4, now() + interval '6 days', now() + interval '6 days 30 minutes', 30, 'confirmed')`,
        [randomUUID(), s.studioId, m.practitionerId, clientId],
      );
    });
    await gotLock;
    const command = call(s.userId, "select public.change_staff_role($1,$2,'receptionist','practitioner',null) as r", [s.studioId, m.practitionerId]);
    await new Promise((r) => setTimeout(r, 500));
    release();
    await writer;
    expect(await command).toMatchObject({ ok: false, code: "has_upcoming_appointments", count: 1 });
  });
  it("a deactivated practitioner loses the clinical read gate at once (active is the single flag)", async () => {
    const s = await seedStudio("d342k");
    const m = await seedMember(s, "d11");
    const can = () => asUser(m.userId, async (q) => (await q("select public.has_studio_permission($1,'clin.view_records',null,null,null) r", [s.studioId])).rows[0].r as boolean);
    expect(await can()).toBe(true); // control: the member holds the key before
    await deact(s.userId, s.studioId, m.practitionerId, "practitioner");
    expect(await can()).toBe(false);
  });
});

describe("reactivate_staff_member", () => {
  it("is refused while the staff_role_change gate is off, changes nothing", async () => {
    const s = await seedStudio("r342a");
    const m = await seedMember(s, "r1");
    await deact(s.userId, s.studioId, m.practitionerId, "practitioner");
    expect(await react(s.userId, s.studioId, m.practitionerId, "practitioner")).toMatchObject({ ok: false, code: "gate_unmet", gate: "staff_role_change" });
    expect(await activeOf("practitioners", m.practitionerId)).toBe(false);
  });
  it("restores a practitioner and a receptionist with a reason and an audit row; refuses an active one, a non-owner, a missing reason", async () => {
    const s = await seedStudio("r342b");
    await openGate(s.studioId);
    const m = await seedMember(s, "r2");
    const d = await seedDesk(s, "r2d");
    await deact(s.userId, s.studioId, m.practitionerId, "practitioner");
    await deact(s.userId, s.studioId, d.id, "receptionist");
    expect(await react(m.userId, s.studioId, m.practitionerId, "practitioner")).toEqual({ ok: false, code: "refused" });
    expect(await react(s.userId, s.studioId, m.practitionerId, "practitioner", null)).toMatchObject({ code: "reason_required" });
    expect(await react(s.userId, s.studioId, m.practitionerId, "practitioner")).toMatchObject({ ok: true, active: true });
    expect(await react(s.userId, s.studioId, m.practitionerId, "practitioner")).toMatchObject({ code: "already_active" });
    expect(await react(s.userId, s.studioId, d.id, "receptionist")).toMatchObject({ ok: true });
    const row = (await adminQuery("select active, deactivated_at from public.studio_receptionists where id=$1", [d.id])).rows[0];
    expect(row).toMatchObject({ active: true, deactivated_at: null });
    expect(await audit(s.studioId, "staff_reactivated")).toHaveLength(2);
  });
  it("refuses to give one person two active memberships (restoring the old row while a new one is active)", async () => {
    const s = await seedStudio("r342c");
    await openGate(s.studioId);
    const m = await seedMember(s, "r3");
    const moved = await call(s.userId, "select public.change_staff_role($1,$2,'receptionist','practitioner',null) as r", [s.studioId, m.practitionerId]);
    expect(moved).toMatchObject({ ok: true });
    expect(await react(s.userId, s.studioId, m.practitionerId, "practitioner")).toMatchObject({ ok: false, code: "other_membership_active" });
    expect(await activeOf("practitioners", m.practitionerId)).toBe(false);
  });
});

describe("grants and append-only history", () => {
  it("authenticated may execute the three commands; anon and service_role are refused by name; the policy function is internal", async () => {
    for (const f of ["public.deactivate_staff_member(uuid,uuid,text,text)", "public.reactivate_staff_member(uuid,uuid,text,text)", "public.change_staff_role(uuid,uuid,text,text,text)"]) {
      expect((await adminQuery("select has_function_privilege('authenticated',$1,'execute') p", [f])).rows[0].p, f).toBe(true);
      for (const role of ["anon", "service_role"]) expect((await adminQuery("select has_function_privilege($1,$2,'execute') p", [role, f])).rows[0].p, `${role} ${f}`).toBe(false);
    }
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect((await adminQuery("select has_function_privilege($1,'public.perm_upcoming_policy()','execute') p", [role])).rows[0].p, role).toBe(false);
    }
    await expect(asRole("anon", (q) => q("select public.deactivate_staff_member($1,$1,'practitioner','x')", [randomUUID()]))).rejects.toThrow(/permission denied/i);
  });
  it("the audit stays append-only and accepts only known kinds (negative control: an unknown kind is refused by the CHECK)", async () => {
    const s = await seedStudio("a342");
    await expect(adminQuery("insert into public.permission_audit(studio_id,kind,before,after) values ($1,'staff_deleted','{}','{}')", [s.studioId])).rejects.toThrow(/permission_audit_kind_check|check constraint/i);
    const m = await seedMember(s, "a1");
    await deact(s.userId, s.studioId, m.practitionerId, "practitioner");
    await expect(adminQuery("update public.permission_audit set reason='x' where studio_id=$1", [s.studioId])).rejects.toThrow();
  });
});
