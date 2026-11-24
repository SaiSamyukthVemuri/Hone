import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, asRole, asUser, closePool, seedMember, seedStudio, type SeededStudio } from "./helpers/harness";
import { closeOlderContactCommands, reopenOlderContactCommands } from "./helpers/older-contact-commands";

// The receptionist desk's database boundary, by DIRECT calls to the three read functions as each kind of caller: this
// is what a signed-in person can do outside the app. Synthetic fixtures only. Names are never printed: assertions on
// them are booleans.
//
// Part 1 is the refusal matrix. Part 2 pins the name rule as it behaves on a database built from the repository's
// migrations, which include it (0380): a receptionist sees the preferred name, else the regular client name, and the fixed
// words 'Name on file' only when both are blank; the order is the displayed name, then id. This file runs only against repository-chain stacks. What
// the hosted database does is recorded in the production record (docs/production), not here. If the rule is ever removed
// from the chain, this test fails, loudly, on purpose.

const STORED_M = `Mango Fixture ${randomUUID().slice(0, 8)}`;
const STORED_A = `Aardvark Fixture ${randomUUID().slice(0, 8)}`;
const STORED_Z = `Zebra Fixture ${randomUUID().slice(0, 8)}`;

let third = "";
let second = "";
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
  await reopenOlderContactCommands(); // closed by 0381; reopened for this file only to prove the reviewed body
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
  second = randomUUID();
  while (second <= studio.clientId) second = randomUUID();
  await adminQuery(`insert into public.clients (id, studio_id, name) values ($1, $2, $3)`, [second, studio.studioId, STORED_A]);
  // A third client is inserted LAST but with the SMALLEST id, so insert (heap) order is [first, second, third] while id order is [third, first, second]
  // and stored-name order is [second (Aardvark), third (Mango), first (Zebra)]. Three different orders: only an explicit id tie-break gives id order,
  // so dropping it from the database function turns the order test red (equal keys otherwise come back in insert order).
  third = randomUUID();
  while (third >= studio.clientId) third = randomUUID();
  await adminQuery(`insert into public.clients (id, studio_id, name) values ($1, $2, $3)`, [third, studio.studioId, STORED_M]);
  await adminQuery(
    `insert into public.appointments (id, studio_id, practitioner_id, client_id, starts_at, ends_at, duration_minutes, buffer_minutes_snapshot, blocked_ends_at)
     values ($1, $2, $3, $4, now() + interval '2 days', now() + interval '2 days 1 hour', 60, 0, now() + interval '2 days 1 hour')`,
    [randomUUID(), studio.studioId, studio.practitionerId, studio.clientId],
  );
});
afterAll(async () => {
  await closeOlderContactCommands();
  await closePool();
});

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

describe("part 2: the name rule (0380): the database shows a receptionist the preferred name, else the regular name", () => {
  it("the directory shows each client's regular name (none has a preferred name here), never the fixed words", async () => {
    const r = await callAs(who.receptionist, "directory");
    expect("rows" in r).toBe(true);
    const rows = ("rows" in r ? r.rows : []) as Array<{ display_name: string; name_on_file?: boolean }>;
    const text = JSON.stringify(rows);
    for (const n of [STORED_Z, STORED_A, STORED_M]) expect(text.includes(n), "directory shows the regular name").toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.every((x) => x.display_name !== "Name on file" && x.name_on_file === false)).toBe(true);
  });

  it("the schedule shows the client's regular name, flagged as having a name", async () => {
    const r = await callAs(who.receptionist, "schedule");
    const rows = ("rows" in r ? r.rows : []) as Array<{ display_name?: string; name_on_file?: boolean }>;
    expect(rows.length).toBe(1);
    expect(rows[0].display_name).toBe(STORED_Z);
    expect(rows[0].name_on_file).toBe(false);
  });

  it("the directory's default order is by the displayed name, then id: not the insert order and not the id order (non-vacuity)", async () => {
    const r = await callAs(who.receptionist, "directory");
    const rows = ("rows" in r ? r.rows : []) as Array<{ client_id: string }>;
    const mine = rows.map((x) => String(x.client_id)).filter((id) => id === studio.clientId || id === third || id === second);
    // by name: [second (Aardvark), third (Mango), first (Zebra)]; insert order is [first, second, third]; id order is [third, first, second]
    expect(mine).toEqual([second, third, studio.clientId]);
  });
});
