import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
  asUser,
  closePool,
  seedMember,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

// 0269 / HON-59. Real database, real roles. An ASSIGNED appointment can have a
// second practitioner link their own chart only after the OWNER records them as
// a participant. Nothing here touches money.

const studios: SeededStudio[] = [];
afterAll(async () => {
  for (const s of studios) {
    for (const sql of [
      `delete from public.sessions where studio_id=$1`,
      `delete from public.appointment_participants where studio_id=$1`,
      `delete from public.appointments where studio_id=$1`,
      `delete from public.studios where id=$1`,
    ]) await adminQuery(sql, [s.studioId]).catch(() => undefined);
  }
  await closePool();
});

let slot = 0;
async function setup(label: string) {
  const owner = await seedStudio(`part-${label}`);
  studios.push(owner);
  const a = await seedMember(owner, `${label}-a`); // assigned practitioner
  const b = await seedMember(owner, `${label}-b`); // second practitioner
  slot += 2;
  const appt = randomUUID();
  await adminQuery(
    `insert into public.appointments
       (id,studio_id,client_id,practitioner_id,starts_at,ends_at,duration_minutes,status)
     values ($1,$2,$3,$4,now()-make_interval(hours=>$5+1),now()-make_interval(hours=>$5),60,'confirmed')`,
    [appt, owner.studioId, owner.clientId, a.practitionerId, slot],
  );
  return { owner, a, b, appt };
}

const add = (userId: string, studioId: string, appt: string, pract: string) =>
  asUser(userId, (q) =>
    q(`select * from public.add_appointment_participant($1,$2,$3)`, [studioId, appt, pract]),
  ).then((r) => r.rows[0].result as string);

const start = (userId: string, studioId: string, clientId: string, appt: string) =>
  asUser(userId, (q) =>
    q(`select * from public.start_session($1,'electrolysis',$2,90,$3)`, [clientId, appt, studioId]),
  );

describe("start_session on an ASSIGNED appointment", () => {
  it("refuses a practitioner who is not the assignee and not a participant (unchanged)", async () => {
    const { owner, b, appt } = await setup("refuse");
    await expect(start(b.userId, owner.studioId, owner.clientId, appt)).rejects.toThrow(
      /assigned to a different practitioner/,
    );
  });

  it("the assignee still links their own chart", async () => {
    const { owner, a, appt } = await setup("assignee");
    const r = await start(a.userId, owner.studioId, owner.clientId, appt);
    expect(r.rows).toHaveLength(1);
  });

  it("an owner-recorded participant links their OWN chart; two authors, one visit", async () => {
    const { owner, a, b, appt } = await setup("join");
    expect(await add(owner.userId, owner.studioId, appt, b.practitionerId)).toBe("added");
    const sa = await start(a.userId, owner.studioId, owner.clientId, appt);
    const sb = await start(b.userId, owner.studioId, owner.clientId, appt);
    expect(sa.rows[0].session_id).not.toBe(sb.rows[0].session_id);
    const rows = await adminQuery(
      `select practitioner_id from public.sessions where appointment_id=$1 order by practitioner_id`,
      [appt],
    );
    expect(rows.rows.map((r) => r.practitioner_id).sort()).toEqual(
      [a.practitionerId, b.practitionerId].sort(),
    );
  });

  it("being a participant does not open a DIFFERENT appointment", async () => {
    const { owner, a, b, appt } = await setup("scope");
    await add(owner.userId, owner.studioId, appt, b.practitionerId);
    slot += 2;
    const other = randomUUID();
    await adminQuery(
      `insert into public.appointments
         (id,studio_id,client_id,practitioner_id,starts_at,ends_at,duration_minutes,status)
       values ($1,$2,$3,$4,now()-make_interval(hours=>$5+1),now()-make_interval(hours=>$5),60,'confirmed')`,
      [other, owner.studioId, owner.clientId, a.practitionerId, slot],
    );
    await expect(start(b.userId, owner.studioId, owner.clientId, other)).rejects.toThrow(
      /assigned to a different practitioner/,
    );
  });
});

describe("add_appointment_participant", () => {
  it("is OWNER only: the assigned practitioner and other members get not_owner", async () => {
    const { owner, a, b, appt } = await setup("owner");
    expect(await add(a.userId, owner.studioId, appt, b.practitionerId)).toBe("not_owner");
    expect(await add(b.userId, owner.studioId, appt, b.practitionerId)).toBe("not_owner");
    const n = await adminQuery(`select count(*)::int n from public.appointment_participants where appointment_id=$1`, [appt]);
    expect(n.rows[0].n).toBe(0);
  });

  it("is idempotent and refuses the assignee, an unknown practitioner and an unknown appointment", async () => {
    const { owner, a, b, appt } = await setup("edge");
    expect(await add(owner.userId, owner.studioId, appt, b.practitionerId)).toBe("added");
    expect(await add(owner.userId, owner.studioId, appt, b.practitionerId)).toBe("already_participant");
    expect(await add(owner.userId, owner.studioId, appt, a.practitionerId)).toBe("already_assigned");
    expect(await add(owner.userId, owner.studioId, appt, randomUUID())).toBe("practitioner_not_found");
    expect(await add(owner.userId, owner.studioId, randomUUID(), b.practitionerId)).toBe("not_found");
  });

  it("never crosses studios", async () => {
    const x = await setup("xa");
    const y = await setup("xb");
    // owner of studio X cannot add anyone to studio Y's appointment, and cannot
    // name studio Y at all.
    await expect(add(x.owner.userId, y.owner.studioId, y.appt, y.b.practitionerId)).rejects.toThrow();
    expect(await add(x.owner.userId, x.owner.studioId, y.appt, x.b.practitionerId)).toBe("not_found");
    expect(await add(x.owner.userId, x.owner.studioId, x.appt, y.b.practitionerId)).toBe("practitioner_not_found");
  });
});

describe("the table and its privileges", () => {
  it("no runtime role can write it directly; a member can read their studio's rows", async () => {
    const { owner, a, b, appt } = await setup("priv");
    await add(owner.userId, owner.studioId, appt, b.practitionerId);
    await expect(
      asUser(owner.userId, (q) =>
        q(
          `insert into public.appointment_participants (studio_id,appointment_id,practitioner_id,added_by_practitioner_id) values ($1,$2,$3,$4)`,
          [owner.studioId, appt, a.practitionerId, owner.practitionerId],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(owner.userId, (q) => q(`delete from public.appointment_participants where appointment_id=$1`, [appt])),
    ).rejects.toThrow(/permission denied/);
    const seen = await asUser(a.userId, (q) =>
      q(`select practitioner_id from public.appointment_participants where appointment_id=$1`, [appt]),
    );
    expect(seen.rows).toHaveLength(1);
  });

  it("an outsider sees none of it", async () => {
    const { owner, appt, b } = await setup("rls");
    await add(owner.userId, owner.studioId, appt, b.practitionerId);
    const other = await seedStudio("part-rls-other");
    studios.push(other);
    const seen = await asUser(other.userId, (q) =>
      q(`select 1 from public.appointment_participants where appointment_id=$1`, [appt]),
    );
    expect(seen.rows).toHaveLength(0);
  });
});
