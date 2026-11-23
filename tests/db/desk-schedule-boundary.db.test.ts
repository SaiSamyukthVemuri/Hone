import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, asRole, asUser, closePool, seedMember, seedStudio, type SeededStudio } from "./helpers/harness";

// The receptionist desk's database boundary, by DIRECT calls to the three read functions as each kind of caller: this
// is what a signed-in person can do outside the app. Synthetic fixtures only. Names are never printed: assertions on
// them are booleans.
//
// Part 1 is the refusal matrix. Part 2 is a CHARACTERIZATION of a known limit: the database still returns a client's
// stored name to a receptionist. The desk app never shows it, but this test must FAIL, loudly, the day the database's
// name rule changes, so that whoever changes it also revisits the desk.

const STORED_A = `Aardvark Fixture ${randomUUID().slice(0, 8)}`;
const STORED_Z = `Zebra Fixture ${randomUUID().slice(0, 8)}`;

let studio: SeededStudio;
let other: SeededStudio;
const who: Record<"receptionist" | "otherReceptionist" | "inactiveReceptionist" | "practitioner" | "owner" | "stranger", string> = {} as never;

async function user(label: string): Promise<string> {
  const id = randomUUID();
  await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [id, `${label}-${id.slice(0, 8)}@harness.local`]);
  return id;
}
async function receptionist(studioId: string, userId: string, active: boolean) {
  await adminQuery(
    `insert into public.studio_receptionists (studio_id, user_id, display_name, active, deactivated_at) values ($1, $2, 'Desk', $3, $4)`,
    [studioId, userId, active, active ? null : new Date().toISOString()],
  );
}

const CALLS: Record<string, { sql: string; params: () => unknown[] }> = {
  directory: { sql: `select * from public.receptionist_client_directory($1::uuid, null, null, 'name', 0, 25)`, params: () => [studio.studioId] },
  schedule: {
    sql: `select * from public.receptionist_calendar_v2($1::uuid, now() - interval '1 day', now() + interval '7 days')`,
    params: () => [studio.studioId],
  },
  timezone: { sql: `select * from public.receptionist_studio_timezone($1::uuid)`, params: () => [studio.studioId] },
};

type Outcome = { rows: unknown[] } | { code: string };
const callAs = async (userId: string | "anon", name: string): Promise<Outcome> => {
  const c = CALLS[name];
  const run = userId === "anon" ? asRole("anon", (q) => q(c.sql, c.params())) : asUser(userId, (q) => q(c.sql, c.params()));
  return run.then(
    (r) => ({ rows: r.rows }),
    (e: { code?: string }) => ({ code: e.code ?? "unknown" }),
  );
};

beforeAll(async () => {
  studio = await seedStudio("desk-a");
  other = await seedStudio("desk-b");
  who.owner = studio.userId;
  const member = await seedMember(studio, "desk-prac");
  who.practitioner = member.userId;
  who.stranger = await user("desk-stranger");
  who.receptionist = await user("desk-recep");
  who.inactiveReceptionist = await user("desk-inactive");
  who.otherReceptionist = await user("desk-other");
  await receptionist(studio.studioId, who.receptionist, true);
  await receptionist(studio.studioId, who.inactiveReceptionist, false);
  await receptionist(other.studioId, who.otherReceptionist, true);
  await adminQuery(`update public.clients set name = $2 where id = $1`, [studio.clientId, STORED_Z]);
  const second = randomUUID();
  await adminQuery(`insert into public.clients (id, studio_id, name) values ($1, $2, $3)`, [second, studio.studioId, STORED_A]);
  await adminQuery(
    `insert into public.appointments (id, studio_id, practitioner_id, client_id, starts_at, ends_at, duration_minutes, buffer_minutes_snapshot, blocked_ends_at)
     values ($1, $2, $3, $4, now() + interval '2 days', now() + interval '2 days 1 hour', 60, 0, now() + interval '2 days 1 hour')`,
    [randomUUID(), studio.studioId, studio.practitionerId, studio.clientId],
  );
});
afterAll(closePool);

describe("part 1: who may call the three desk functions directly", () => {
  it("this studio's active receptionist is answered by all three", async () => {
    for (const name of Object.keys(CALLS)) {
      const r = await callAs(who.receptionist, name);
      expect("rows" in r, name).toBe(true);
    }
    const sched = await callAs(who.receptionist, "schedule");
    expect("rows" in sched && sched.rows.length).toBe(1);
  });

  const refused: Array<[string, () => string | "anon"]> = [
    ["another studio's receptionist", () => who.otherReceptionist],
    ["an inactive receptionist of this studio", () => who.inactiveReceptionist],
    ["a practitioner who is not a receptionist", () => who.practitioner],
    ["the studio owner (who is not a receptionist)", () => who.owner],
    ["a signed-in stranger", () => who.stranger],
    ["an anonymous caller", () => "anon"],
  ];
  it.each(refused)("%s is refused by all three, and gets no rows", async (_label, actor) => {
    for (const name of Object.keys(CALLS)) {
      const r = await callAs(actor(), name);
      expect("code" in r, name).toBe(true);
      expect("code" in r && r.code, name).toBe("42501");
    }
  });
});

describe("part 2: KNOWN LIMIT: database still returns the stored name to a receptionist; flips with the name-rule change", () => {
  it("the directory returns a client's stored name to this studio's receptionist (booleans only)", async () => {
    const r = await callAs(who.receptionist, "directory");
    expect("rows" in r).toBe(true);
    const text = "rows" in r ? JSON.stringify(r.rows) : "";
    expect(text.includes(STORED_Z), "directory returns the stored name, as it does today").toBe(true);
    expect(text.includes(STORED_A), "directory returns the second stored name, as it does today").toBe(true);
  });

  it("the schedule returns the stored name too, flagged as the stored name", async () => {
    const r = await callAs(who.receptionist, "schedule");
    const rows = ("rows" in r ? r.rows : []) as Array<{ display_name?: string; name_on_file?: boolean }>;
    expect(rows.length).toBe(1);
    expect(rows[0].display_name === STORED_Z, "schedule returns the stored name, as it does today").toBe(true);
    expect(rows[0].name_on_file).toBe(true);
  });

  it("the directory's default order is by name today (so order alone can reveal name order)", async () => {
    const r = await callAs(who.receptionist, "directory");
    const rows = ("rows" in r ? r.rows : []) as Array<{ display_name: string }>;
    const names = rows.map((x) => x.display_name);
    expect(names.indexOf(STORED_A) !== -1 && names.indexOf(STORED_A) < names.indexOf(STORED_Z)).toBe(true);
  });
});
