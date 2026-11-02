import { afterAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { adminQuery, asRole, closePool, seedMember, seedStudio } from "./helpers/harness";

// 0277 (HON-44, Sam decision 3): mark_appointment_complete is assigned-only for a non-owner.
// Owner: any appointment in the studio. Practitioner: only one assigned to them; unassigned is
// owner-only. Completion touches no payment table. Time is relative to now(), never a literal.

const tokenHash = () => createHash("sha256").update(randomUUID()).digest("hex");

// Distinct windows per appointment: the studio-wide overlap exclusion constraint rejects overlaps.
let slot = 0;
async function seedAppointment(studioId: string, clientId: string, practitionerId: string | null): Promise<string> {
  const hoursAgo = 2 + 2 * slot++; // started, 30 minutes long, never overlapping another in the studio
  const r = await adminQuery(
    `insert into public.appointments
       (id, studio_id, practitioner_id, client_id, starts_at, ends_at, duration_minutes, status,
        cancellation_token_hash, buffer_minutes_snapshot, blocked_ends_at)
     values (gen_random_uuid(), $1, $2, $3,
             now() - ($5::text || ' hours')::interval,
             now() - ($5::text || ' hours')::interval + interval '30 minutes', 30, 'confirmed', $4,
             15, now() - ($5::text || ' hours')::interval + interval '45 minutes')
     returning id`,
    [studioId, practitionerId, clientId, tokenHash(), hoursAgo],
  );
  return r.rows[0].id as string;
}

const complete = (id: string, studioId: string, practitionerId: string) =>
  adminQuery(`select public.mark_appointment_complete($1,$2,$3)`, [id, studioId, practitionerId]);

const statusOf = async (id: string) =>
  (await adminQuery(`select status from public.appointments where id = $1`, [id])).rows[0].status as string;

const auditCount = async (id: string) =>
  Number((await adminQuery(`select count(*)::int as n from public.appointment_audit where appointment_id = $1 and action = 'marked_complete'`, [id])).rows[0].n);

async function fixture() {
  const s = await seedStudio("c277");
  const a = await seedMember(s, "c277a");
  const b = await seedMember(s, "c277b");
  const mine = await seedAppointment(s.studioId, s.clientId, a.practitionerId);
  const theirs = await seedAppointment(s.studioId, s.clientId, b.practitionerId);
  const unassigned = await seedAppointment(s.studioId, s.clientId, null);
  return { s, a, b, mine, theirs, unassigned };
}

afterAll(async () => {
  await closePool();
});

describe("0277 completion is assigned-only", () => {
  it("a practitioner completes an appointment assigned to them, with an audit row", async () => {
    const f = await fixture();
    await complete(f.mine, f.s.studioId, f.a.practitionerId);
    expect(await statusOf(f.mine)).toBe("completed");
    expect(await auditCount(f.mine)).toBe(1);
  });

  it("a practitioner is refused on a colleague's appointment (42501), nothing changes", async () => {
    const f = await fixture();
    await expect(complete(f.theirs, f.s.studioId, f.a.practitionerId)).rejects.toMatchObject({ code: "42501" });
    expect(await statusOf(f.theirs)).toBe("confirmed");
    expect(await auditCount(f.theirs)).toBe(0);
  });

  it("a practitioner is refused on an UNASSIGNED appointment", async () => {
    const f = await fixture();
    await expect(complete(f.unassigned, f.s.studioId, f.a.practitionerId)).rejects.toMatchObject({ code: "42501" });
    expect(await statusOf(f.unassigned)).toBe("confirmed");
  });

  it("the owner completes any appointment in the studio: assigned elsewhere and unassigned", async () => {
    const f = await fixture();
    await complete(f.theirs, f.s.studioId, f.s.practitionerId);
    await complete(f.unassigned, f.s.studioId, f.s.practitionerId);
    expect(await statusOf(f.theirs)).toBe("completed");
    expect(await statusOf(f.unassigned)).toBe("completed");
    const actor = await adminQuery(
      `select actor_id from public.appointment_audit where appointment_id = $1 and action = 'marked_complete'`,
      [f.theirs],
    );
    expect(actor.rows[0].actor_id).toBe(f.s.practitionerId);
  });

  it("cross-studio is refused both ways, and a practitioner of another studio learns nothing", async () => {
    const f = await fixture();
    const other = await seedStudio("c277x");
    const otherMember = await seedMember(other, "c277xm");
    // other studio's owner and member, naming THEIR studio with this studio's appointment: not found
    await expect(complete(f.mine, other.studioId, other.practitionerId)).rejects.toMatchObject({ code: "P0002" });
    await expect(complete(f.mine, other.studioId, otherMember.practitionerId)).rejects.toMatchObject({ code: "P0002" });
    // naming THIS studio with a practitioner who is not its member
    await expect(complete(f.mine, f.s.studioId, other.practitionerId)).rejects.toMatchObject({ code: "42501" });
    await expect(complete(f.mine, f.s.studioId, otherMember.practitionerId)).rejects.toMatchObject({ code: "42501" });
    expect(await statusOf(f.mine)).toBe("confirmed");
  });

  it("an inactive practitioner is refused even on their own appointment", async () => {
    const f = await fixture();
    await adminQuery(`update public.practitioners set active = false where id = $1`, [f.a.practitionerId]);
    await expect(complete(f.mine, f.s.studioId, f.a.practitionerId)).rejects.toMatchObject({ code: "42501" });
  });

  it("the state rules are unchanged: a non-confirmed appointment is still refused for its assignee", async () => {
    const f = await fixture();
    await adminQuery(`update public.appointments set status = 'cancelled' where id = $1`, [f.mine]);
    await expect(complete(f.mine, f.s.studioId, f.a.practitionerId)).rejects.toMatchObject({ code: "P0002" });
  });

  it("completion writes no payment data", async () => {
    const f = await fixture();
    await complete(f.mine, f.s.studioId, f.a.practitionerId);
    const n = await adminQuery(
      `select (select count(*) from public.appointment_settlements where appointment_id = $1)::int as settlements`,
      [f.mine],
    );
    expect(n.rows[0].settlements).toBe(0);
  });
});

describe("0277 reassignment, owner-as-assignee, refusal order (Insurance Q-3)", () => {
  it("reassignment takes effect at once: the old assignee is refused, the new one completes", async () => {
    const f = await fixture();
    await adminQuery(`update public.appointments set practitioner_id = $2 where id = $1`, [f.mine, f.b.practitionerId]);
    await expect(complete(f.mine, f.s.studioId, f.a.practitionerId)).rejects.toMatchObject({ code: "42501" });
    expect(await statusOf(f.mine)).toBe("confirmed");
    await complete(f.mine, f.s.studioId, f.b.practitionerId);
    expect(await statusOf(f.mine)).toBe("completed");
  });

  it("an owner who is also the assignee completes exactly as a plain assignee does", async () => {
    const f = await fixture();
    const own = await seedAppointment(f.s.studioId, f.s.clientId, f.s.practitionerId);
    await complete(own, f.s.studioId, f.s.practitionerId);
    expect(await statusOf(own)).toBe("completed");
    expect(await auditCount(own)).toBe(1);
  });

  it("the refusal comes BEFORE the status and time checks: a non-assignee gets 42501, not P0002", async () => {
    const f = await fixture();
    // already completed (owner completes it), then a non-assignee tries: 42501, not a state error
    await complete(f.theirs, f.s.studioId, f.s.practitionerId);
    await expect(complete(f.theirs, f.s.studioId, f.a.practitionerId)).rejects.toMatchObject({ code: "42501" });
    // cancelled, same
    await adminQuery(`update public.appointments set status = 'cancelled' where id = $1`, [f.unassigned]);
    await expect(complete(f.unassigned, f.s.studioId, f.a.practitionerId)).rejects.toMatchObject({ code: "42501" });
    // not yet started (future), same
    const future = await adminQuery(
      `insert into public.appointments
         (id, studio_id, practitioner_id, client_id, starts_at, ends_at, duration_minutes, status,
          cancellation_token_hash, buffer_minutes_snapshot, blocked_ends_at)
       values (gen_random_uuid(), $1, $2, $3, now() + interval '30 days', now() + interval '30 days 30 minutes',
               30, 'confirmed', $4, 15, now() + interval '30 days 45 minutes')
       returning id`,
      [f.s.studioId, f.b.practitionerId, f.s.clientId, tokenHash()],
    );
    await expect(complete(future.rows[0].id as string, f.s.studioId, f.a.practitionerId)).rejects.toMatchObject({
      code: "42501",
    });
  });
});

// Privacy C3: completion by the owner and by the assignee changes no payment row. The snapshot is
// every public table with a studio_id column whose name says payment, settlement, charge, refund,
// fee, card or stripe, so a payment table added later is covered without editing this test.
describe("0277 completion touches no payment data (Privacy C3)", () => {
  async function paymentSnapshot(studioId: string): Promise<Record<string, string>> {
    const tables = await adminQuery(
      `select c.table_name from information_schema.columns c
         join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
        where c.table_schema = 'public' and c.column_name = 'studio_id' and t.table_type = 'BASE TABLE'
          and c.table_name ~ '(payment|settlement|charge|refund|fee|card|stripe)'
        order by 1`,
    );
    const out: Record<string, string> = {};
    for (const { table_name } of tables.rows as { table_name: string }[]) {
      const r = await adminQuery(
        `select count(*)::int as n, coalesce(md5(string_agg(x::text, '|' order by x::text)), '') as h
           from public."${table_name}" x where studio_id = $1`,
        [studioId],
      );
      out[table_name] = `${r.rows[0].n}:${r.rows[0].h}`;
    }
    return out;
  }

  it("a settlement on another visit exists, and owner and assignee completions leave every payment table identical", async () => {
    const f = await fixture();
    // a recorded disposition on a decoy completed visit, so the snapshot is not vacuously empty
    const decoy = await seedAppointment(f.s.studioId, f.s.clientId, f.a.practitionerId);
    await complete(decoy, f.s.studioId, f.s.practitionerId);
    await adminQuery(
      `insert into public.appointment_settlements
         (studio_id, appointment_id, method, amount_cents, recorded_by_practitioner_id)
       values ($1,$2,'paid_cash',5000,$3)`,
      [f.s.studioId, decoy, f.s.practitionerId],
    );
    const before = await paymentSnapshot(f.s.studioId);
    expect(before.appointment_settlements.startsWith("1:")).toBe(true);
    await complete(f.mine, f.s.studioId, f.a.practitionerId); // assignee
    await complete(f.theirs, f.s.studioId, f.s.practitionerId); // owner
    expect(await paymentSnapshot(f.s.studioId)).toEqual(before);
  });
});

describe("0277 grants: service_role only", () => {
  it("anon and authenticated cannot execute; service_role can", async () => {
    const f = await fixture();
    const call = (q: (t: string, p?: unknown[]) => Promise<unknown>) =>
      q(`select public.mark_appointment_complete($1,$2,$3)`, [f.mine, f.s.studioId, f.a.practitionerId]);
    await expect(asRole("anon", call)).rejects.toMatchObject({ code: "42501" });
    await expect(asRole("authenticated", call)).rejects.toMatchObject({ code: "42501" });
    await expect(asRole("service_role", call)).resolves.toBeDefined();
  });
});
