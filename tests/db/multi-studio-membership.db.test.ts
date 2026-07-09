import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  asUser,
  closePool,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

// Multi-studio-user robustness. A user may be an active practitioner in more
// than one studio (unique key is (studio_id, user_id), NOT user_id). This proves
// that 2+ active memberships is a REACHABLE state (so the app must not 500 on it)
// and that RLS still isolates studios the user does not belong to (no weakening).

let a: SeededStudio;
let b: SeededStudio;
let c: SeededStudio;

beforeAll(async () => {
  a = await seedStudio("msa"); // a.userId owns studio a
  b = await seedStudio("msb"); // b.userId owns studio b
  c = await seedStudio("msc"); // c.userId owns studio c (a is NOT a member)

  // Give user a a SECOND active membership: an active practitioner row in b.
  await adminQuery(
    `insert into public.practitioners
       (id, studio_id, user_id, display_name, email, role, active)
     values (gen_random_uuid(), $1, $2, 'A in B', $3, 'practitioner', true)`,
    [b.studioId, a.userId, `a-in-b-${a.userId.slice(0, 8)}@harness.local`],
  );
});
afterAll(async () => {
  await closePool();
});

describe("2+ active memberships is a reachable state", () => {
  it("user a has two active practitioner rows across two studios", async () => {
    const { rows } = await adminQuery(
      `select count(*)::int as n from public.practitioners
       where user_id = $1 and active = true`,
      [a.userId],
    );
    expect(rows[0].n).toBe(2);
  });
});

describe("RLS is unchanged (no weakening)", () => {
  it("the user can still see their OWN memberships in both studios", async () => {
    const res = await asUser(a.userId, (q) =>
      q(
        `select studio_id from public.practitioners
         where user_id = $1 and active = true order by studio_id`,
        [a.userId],
      ),
    );
    const studioIds = res.rows.map((r) => r.studio_id as string).sort();
    expect(res.rowCount).toBe(2);
    expect(studioIds).toEqual([a.studioId, b.studioId].sort());
  });

  it("the user still CANNOT see practitioners in a studio they don't belong to", async () => {
    const res = await asUser(a.userId, (q) =>
      q(`select id from public.practitioners where studio_id = $1`, [
        c.studioId,
      ]),
    );
    expect(res.rowCount).toBe(0);
  });
});

describe("switch-action membership verification (RLS-enforced)", () => {
  // Mirrors switchStudioAction's guard: it only sets the cookie if this query
  // (run as the signed-in user) returns a row.
  async function verifySwitch(userId: string, studioId: string) {
    return asUser(userId, (q) =>
      q(
        `select id from public.practitioners
         where user_id = $1 and studio_id = $2 and active = true`,
        [userId, studioId],
      ),
    );
  }

  it("allows switching to a studio the user is an active member of", async () => {
    const res = await verifySwitch(a.userId, b.studioId);
    expect(res.rowCount).toBe(1);
  });

  it("REJECTS switching to a studio the user is not a member of (0 rows -> no cookie)", async () => {
    const res = await verifySwitch(a.userId, c.studioId);
    expect(res.rowCount).toBe(0);
  });
});
