import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, asRole, closePool, seedMember, seedStudio, type SeededStudio, type UserQuery } from "./helpers/harness";

// HON-58: the calendar quick-create action checks only `practitioner.active` in the app, so whether a
// receptionist can add a client through it rests on the row-level policy "clients: members insert" (0087), which is
// is_studio_member(studio_id), true only for an ACTIVE practitioners row. A receptionist is a studio_receptionists row, never
// a practitioners row. This file proves the consequence with a real login: the receptionist's INSERT into clients is refused
// and writes nothing, a stranger's is too, and an active practitioner's succeeds (the positive control, so a refusal is not a
// broken fixture). Synthetic ids only.

let A: SeededStudio;
let member: { userId: string };
let receptionist: { userId: string };
let stranger: { userId: string };

async function newUser(label: string): Promise<string> {
  const id = randomUUID();
  await adminQuery("insert into auth.users (id,email) values ($1,$2)", [id, `${label}-${id.slice(0, 8)}@harness.local`]);
  return id;
}
async function asJwt<T>(userId: string, fn: (q: UserQuery) => Promise<T>): Promise<T> {
  return asRole("authenticated", async (q) => {
    await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated" })]);
    return fn(q);
  });
}
async function tryInsertClient(userId: string, name: string): Promise<{ code: string | null; id: string | null }> {
  return asJwt(userId, async (q) => {
    await q("savepoint probe");
    try {
      const r = await q("insert into public.clients (studio_id, name) values ($1, $2) returning id", [A.studioId, name]);
      await q("rollback to savepoint probe");
      return { code: null, id: String((r.rows as Array<{ id: string }>)[0]?.id ?? "") };
    } catch (e) {
      await q("rollback to savepoint probe");
      return { code: (e as { code?: string }).code ?? "?", id: null };
    }
  });
}

beforeAll(async () => {
  A = await seedStudio("g1-ins");
  member = await seedMember(A, "g1-ins-m");
  receptionist = { userId: await newUser("g1-ins-desk") };
  stranger = { userId: await newUser("g1-ins-stranger") };
  await adminQuery(
    "insert into public.studio_receptionists(studio_id,user_id,display_name,active) values ($1,$2,'Synthetic Front Desk',true)",
    [A.studioId, receptionist.userId],
  );
});
afterAll(async () => { await closePool(); });

describe("clients INSERT row policy (0087) and the calendar quick-create", () => {
  it("an active practitioner can insert a client (positive control)", async () => {
    const r = await tryInsertClient(member.userId, "Synthetic Control Client");
    expect(r.code, "the control insert must succeed or this file proves nothing").toBeNull();
  });
  it("a receptionist is refused by the row policy and nothing is written", async () => {
    const name = `Synthetic Desk ${randomUUID().slice(0, 8)}`;
    const r = await tryInsertClient(receptionist.userId, name);
    expect(r.code).toBe("42501");
    const rows = await adminQuery("select count(*)::int as n from public.clients where studio_id = $1 and name = $2", [A.studioId, name]);
    expect((rows.rows as Array<{ n: number }>)[0].n).toBe(0);
  });
  it("a user with no membership is refused the same way", async () => {
    const r = await tryInsertClient(stranger.userId, "Synthetic Stranger Client");
    expect(r.code).toBe("42501");
  });
});
