import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, asRole, asUser, closePool, seedMember, seedStudio, type SeededStudio } from "./helpers/harness";

// The receptionist desk's database boundary, by DIRECT calls to the three read functions as each kind of caller: this
// is what a signed-in person can do outside the app. Synthetic fixtures only. Names are never printed: assertions on
// them are booleans.
//
// Part 1 is the refusal matrix. Part 2 pins the name rule as it behaves on a database built from the repository's
// migrations, which include it: the database returns no stored client name to a receptionist, shows the fixed words
// 'Name on file' instead, and never orders by the stored name. This file runs only against repository-chain stacks. What
// the hosted database does is recorded in the production record (docs/production), not here. If the rule is ever removed
// from the chain, this test fails, loudly, on purpose.

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
  // The second client's id sorts AFTER the first's, while its stored name (Aardvark) sorts BEFORE the first's (Zebra): an ordering by
  // stored name and an ordering by id then disagree, so the order assertion below can only pass for the rule's order (non-vacuity).
  let second = randomUUID();
  while (second <= studio.clientId) second = randomUUID();
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

describe("part 2: the name rule (0374): the database returns no stored name to a receptionist", () => {
  it("the directory carries no stored name; every client without a preferred name reads as the fixed words", async () => {
    const r = await callAs(who.receptionist, "directory");
    expect("rows" in r).toBe(true);
    const rows = ("rows" in r ? r.rows : []) as Array<{ display_name: string; name_on_file?: boolean }>;
    const text = JSON.stringify(rows);
    expect(text.includes(STORED_Z), "directory returns no stored name").toBe(false);
    expect(text.includes(STORED_A), "directory returns no second stored name").toBe(false);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((x) => x.display_name === "Name on file")).toBe(true);
  });

  it("the schedule returns the fixed words, flagged as no name on file, and no stored name", async () => {
    const r = await callAs(who.receptionist, "schedule");
    const rows = ("rows" in r ? r.rows : []) as Array<{ display_name?: string; name_on_file?: boolean }>;
    expect(rows.length).toBe(1);
    expect(JSON.stringify(rows).includes(STORED_Z), "schedule returns no stored name").toBe(false);
    expect(rows[0].display_name).toBe("Name on file");
    expect(rows[0].name_on_file).toBe(true);
  });

  it("the directory's default order never follows the stored name: ties go by id, although the stored names sort the other way (non-vacuity)", async () => {
    const r = await callAs(who.receptionist, "directory");
    const rows = ("rows" in r ? r.rows : []) as Array<{ id?: string; client_id?: string }>;
    const ids = rows.map((x) => String(x.id ?? x.client_id));
    const first = ids.indexOf(studio.clientId); // stored name Zebra, smaller id
    const second = ids.findIndex((x) => x !== studio.clientId && x > studio.clientId);
    expect(first, "the first client is listed").toBeGreaterThanOrEqual(0);
    expect(second, "the second client is listed").toBeGreaterThanOrEqual(0);
    expect(first, "Zebra (smaller id) comes before Aardvark (larger id): order is by id, not by stored name").toBeLessThan(second);
  });
});
