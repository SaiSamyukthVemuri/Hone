import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  closePool,
  seedMember,
  seedStudio,
  userQuery,
  type SeededStudio,
} from "./helpers/harness";
import { randomUUID } from "node:crypto";
import { CLIENT_BUDGET_LEVELS } from "@/lib/budget/levels";

// Migration 0183 — client_budget_context, proven on the REAL migrated local
// database rather than by reading the SQL.
//
// The properties that actually matter:
//   1. ONE current budget per client, enforced by the primary key.
//   2. studio_id is DERIVED from the parent client, so a caller cannot author
//      it, and the composite FK makes a mismatched pair unrepresentable.
//   3. RLS refuses a foreign studio's rows for read and write.
//   4. ATTRIBUTION IS VERIFIED AT THE DATABASE BOUNDARY. A member cannot name
//      a colleague as the updater, cannot erase attribution, and — when they
//      hold memberships in two studios — must use the practitioner identity
//      belonging to the client's own studio.
//   5. The level vocabulary in the database is exactly the one the app ships.

let a: SeededStudio; // studio A
let b: SeededStudio; // studio B
let aSecond: { userId: string; practitionerId: string }; // colleague in A
let aInactive: { userId: string; practitionerId: string }; // inactive in A
// One human with legitimate active practitioner rows in BOTH studios.
let dual: { userId: string; inA: string; inB: string };

beforeAll(async () => {
  a = await seedStudio("budget-a");
  b = await seedStudio("budget-b");
  aSecond = await seedMember(a, "budget-a-colleague");

  aInactive = await seedMember(a, "budget-a-inactive");
  await adminQuery(
    "update public.practitioners set active = false where id = $1",
    [aInactive.practitionerId],
  );

  // Dual membership: the exact configuration behind the 0181 incident.
  const dualUser = randomUUID();
  const inA = randomUUID();
  const inB = randomUUID();
  await adminQuery("insert into auth.users (id, email) values ($1, $2)", [
    dualUser,
    `budget-dual-${dualUser.slice(0, 8)}@harness.local`,
  ]);
  for (const [pid, studio] of [
    [inA, a.studioId],
    [inB, b.studioId],
  ] as const) {
    await adminQuery(
      `insert into public.practitioners
         (id, studio_id, user_id, display_name, email, role, active)
       values ($1, $2, $3, $4, $5, 'practitioner', true)`,
      [
        pid,
        studio,
        dualUser,
        "Dual Member",
        `budget-dual-${pid.slice(0, 8)}@harness.local`,
      ],
    );
  }
  dual = { userId: dualUser, inA, inB };
});

afterAll(async () => {
  await closePool();
});

async function clearBudget(clientId: string): Promise<void> {
  await adminQuery(
    "delete from public.client_budget_context where client_id = $1",
    [clientId],
  );
}

// Service-role seed helper. Bypasses RLS deliberately: these set up state for
// the assertions rather than being the thing under test.
async function seedBudget(
  studio: SeededStudio,
  opts: { level?: string | null; notes?: string; actor?: string } = {},
): Promise<void> {
  await clearBudget(studio.clientId);
  await adminQuery(
    `insert into public.client_budget_context
       (client_id, studio_id, budget_level, budget_notes, updated_by_practitioner_id)
     values ($1, $2, $3, $4, $5)`,
    [
      studio.clientId,
      studio.studioId,
      opts.level ?? null,
      opts.notes ?? "",
      opts.actor ?? studio.practitionerId,
    ],
  );
}

async function budgetRow(clientId: string) {
  const res = await adminQuery(
    `select budget_level, budget_notes, studio_id, updated_by_practitioner_id,
            created_at, updated_at
       from public.client_budget_context where client_id = $1`,
    [clientId],
  );
  return res.rows[0];
}

describe("0183: one current budget per client", () => {
  it("a second row for the same client is refused by the primary key", async () => {
    await seedBudget(a, { level: "somewhat_limited", notes: "first" });
    await expect(
      adminQuery(
        `insert into public.client_budget_context
           (client_id, studio_id, budget_level, budget_notes, updated_by_practitioner_id)
         values ($1, $2, 'severely_limited', 'second', $3)`,
        [a.clientId, a.studioId, a.practitionerId],
      ),
    ).rejects.toThrow();

    const res = await adminQuery(
      "select budget_level, budget_notes from public.client_budget_context where client_id = $1",
      [a.clientId],
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({
      budget_level: "somewhat_limited",
      budget_notes: "first",
    });
  });

  it("an upsert on the conflict target REPLACES rather than accumulating", async () => {
    await clearBudget(a.clientId);
    for (const level of CLIENT_BUDGET_LEVELS) {
      await adminQuery(
        `insert into public.client_budget_context
           (client_id, studio_id, budget_level, budget_notes, updated_by_practitioner_id)
         values ($1, $2, $3, 'n', $4)
         on conflict (client_id) do update set budget_level = excluded.budget_level`,
        [a.clientId, a.studioId, level, a.practitionerId],
      );
    }
    const res = await adminQuery(
      "select budget_level from public.client_budget_context where client_id = $1",
      [a.clientId],
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].budget_level).toBe(
      CLIENT_BUDGET_LEVELS[CLIENT_BUDGET_LEVELS.length - 1],
    );
  });

  it("deleting the parent client cascades the budget row away", async () => {
    const tmp = await seedStudio("budget-cascade");
    await seedBudget(tmp, { notes: "x" });
    await adminQuery("delete from public.clients where id = $1", [
      tmp.clientId,
    ]);
    const res = await adminQuery(
      "select 1 from public.client_budget_context where client_id = $1",
      [tmp.clientId],
    );
    expect(res.rows).toHaveLength(0);
  });
});

describe("0183: studio_id is derived, not authored", () => {
  it("a caller-supplied FOREIGN studio_id is overwritten from the parent client", async () => {
    await clearBudget(a.clientId);
    // Deliberately lie about the studio. Even as the service role.
    await adminQuery(
      `insert into public.client_budget_context
         (client_id, studio_id, budget_notes, updated_by_practitioner_id)
       values ($1, $2, 'forged', $3)`,
      [a.clientId, b.studioId, a.practitionerId],
    );
    expect((await budgetRow(a.clientId)).studio_id).toBe(a.studioId);
  });

  it("an UPDATE touching ONLY studio_id cannot strand the row", async () => {
    // A trigger scoped to `update of client_id` would never fire here, and a
    // practitioner with memberships in BOTH studios satisfies
    // is_studio_member() on both sides — so neither the narrow trigger nor RLS
    // alone would stop it.
    await seedBudget(a, { notes: "x" });
    await adminQuery(
      "update public.client_budget_context set studio_id = $2 where client_id = $1",
      [a.clientId, b.studioId],
    );
    expect((await budgetRow(a.clientId)).studio_id).toBe(a.studioId);
  });

  it("the composite FK makes a mismatched (client, studio) pair unrepresentable", async () => {
    // Belt to the trigger's braces: prove the constraint independently, so a
    // regression that weakened only the trigger still cannot strand a row.
    await clearBudget(a.clientId);
    await adminQuery(
      "alter table public.client_budget_context disable trigger client_budget_context_set_studio_id",
    );
    try {
      await expect(
        adminQuery(
          `insert into public.client_budget_context
             (client_id, studio_id, budget_notes, updated_by_practitioner_id)
           values ($1, $2, 'stranded', $3)`,
          [a.clientId, b.studioId, b.practitionerId],
        ),
      ).rejects.toThrow();
    } finally {
      await adminQuery(
        "alter table public.client_budget_context enable trigger client_budget_context_set_studio_id",
      );
    }
    const res = await adminQuery(
      "select 1 from public.client_budget_context where client_id = $1",
      [a.clientId],
    );
    expect(res.rows).toHaveLength(0);
  });

  it("a budget row for a non-existent client is refused", async () => {
    await expect(
      adminQuery(
        `insert into public.client_budget_context
           (client_id, studio_id, budget_notes, updated_by_practitioner_id)
         values ($1, $2, 'x', $3)`,
        [randomUUID(), a.studioId, a.practitionerId],
      ),
    ).rejects.toThrow();
  });

  it("updated_at moves on UPDATE without the caller setting it", async () => {
    await seedBudget(a, { notes: "one" });
    const before = await budgetRow(a.clientId);
    await adminQuery(
      "update public.client_budget_context set budget_notes = 'two' where client_id = $1",
      [a.clientId],
    );
    const after = await adminQuery(
      "select updated_at from public.client_budget_context where client_id = $1",
      [a.clientId],
    );
    expect(after.rows[0].updated_at).toBeTruthy();
    expect(before).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// ACTOR ATTRIBUTION — verified at the database boundary, not merely supplied
// ---------------------------------------------------------------------------

describe("0183: attribution authority (authenticated writes)", () => {
  it("A. SELF attribution succeeds", async () => {
    await clearBudget(a.clientId);
    const res = await userQuery(
      a.userId,
      `insert into public.client_budget_context
         (client_id, studio_id, budget_level, budget_notes, updated_by_practitioner_id)
       values ($1, $2, 'no_stated_limit', 'mine', $3)`,
      [a.clientId, a.studioId, a.practitionerId],
    );
    expect(res.rowCount).toBe(1);
    expect((await budgetRow(a.clientId)).updated_by_practitioner_id).toBe(
      a.practitionerId,
    );
  });

  it("B. SAME-STUDIO forgery is refused (cannot name a colleague)", async () => {
    await clearBudget(a.clientId);
    await expect(
      userQuery(
        a.userId,
        `insert into public.client_budget_context
           (client_id, studio_id, budget_notes, updated_by_practitioner_id)
         values ($1, $2, 'forged', $3)`,
        [a.clientId, a.studioId, aSecond.practitionerId],
      ),
    ).rejects.toThrow();
    const res = await adminQuery(
      "select 1 from public.client_budget_context where client_id = $1",
      [a.clientId],
    );
    expect(res.rows).toHaveLength(0);
  });

  it("B2. a member cannot UPDATE a colleague's row and leave their name on it", async () => {
    await seedBudget(a, { notes: "written by the colleague", actor: aSecond.practitionerId });
    await expect(
      userQuery(
        a.userId,
        `update public.client_budget_context
            set budget_notes = 'edited', updated_by_practitioner_id = $2
          where client_id = $1`,
        [a.clientId, aSecond.practitionerId],
      ),
    ).rejects.toThrow();
    expect((await budgetRow(a.clientId)).budget_notes).toBe(
      "written by the colleague",
    );
  });

  it("B3. the same UPDATE succeeds when re-attributed to the actual editor", async () => {
    await seedBudget(a, { notes: "written by the colleague", actor: aSecond.practitionerId });
    const res = await userQuery(
      a.userId,
      `update public.client_budget_context
          set budget_notes = 'edited', updated_by_practitioner_id = $2
        where client_id = $1`,
      [a.clientId, a.practitionerId],
    );
    expect(res.rowCount).toBe(1);
    const row = await budgetRow(a.clientId);
    expect(row.budget_notes).toBe("edited");
    expect(row.updated_by_practitioner_id).toBe(a.practitionerId);
  });

  it("C. NULL attribution is refused for an authenticated write", async () => {
    await clearBudget(a.clientId);
    await expect(
      userQuery(
        a.userId,
        `insert into public.client_budget_context
           (client_id, studio_id, budget_notes, updated_by_practitioner_id)
         values ($1, $2, 'anonymous', null)`,
        [a.clientId, a.studioId],
      ),
    ).rejects.toThrow();
  });

  it("C2. attribution cannot be erased by a later UPDATE", async () => {
    await seedBudget(a, { notes: "attributed" });
    await expect(
      userQuery(
        a.userId,
        "update public.client_budget_context set updated_by_practitioner_id = null where client_id = $1",
        [a.clientId],
      ),
    ).rejects.toThrow();
    expect((await budgetRow(a.clientId)).updated_by_practitioner_id).toBe(
      a.practitionerId,
    );
  });

  it("D. CROSS-STUDIO forgery is refused", async () => {
    await clearBudget(a.clientId);
    await expect(
      userQuery(
        a.userId,
        `insert into public.client_budget_context
           (client_id, studio_id, budget_notes, updated_by_practitioner_id)
         values ($1, $2, 'forged', $3)`,
        [a.clientId, a.studioId, b.practitionerId],
      ),
    ).rejects.toThrow();
  });

  it("E. a DUAL-STUDIO member must use the identity of the CLIENT's studio", async () => {
    // Writing studio A's client with the studio A identity: allowed.
    await clearBudget(a.clientId);
    const okA = await userQuery(
      dual.userId,
      `insert into public.client_budget_context
         (client_id, studio_id, budget_notes, updated_by_practitioner_id)
       values ($1, $2, 'in A', $3)`,
      [a.clientId, a.studioId, dual.inA],
    );
    expect(okA.rowCount).toBe(1);
    expect((await budgetRow(a.clientId)).updated_by_practitioner_id).toBe(
      dual.inA,
    );

    // Same human, same session, but the OTHER studio's identity on A's client:
    // refused. This is the cross-attribution the 0181 incident class produces.
    await clearBudget(a.clientId);
    await expect(
      userQuery(
        dual.userId,
        `insert into public.client_budget_context
           (client_id, studio_id, budget_notes, updated_by_practitioner_id)
         values ($1, $2, 'wrong identity', $3)`,
        [a.clientId, a.studioId, dual.inB],
      ),
    ).rejects.toThrow();

    // And the mirror image on studio B's client.
    await clearBudget(b.clientId);
    const okB = await userQuery(
      dual.userId,
      `insert into public.client_budget_context
         (client_id, studio_id, budget_notes, updated_by_practitioner_id)
       values ($1, $2, 'in B', $3)`,
      [b.clientId, b.studioId, dual.inB],
    );
    expect(okB.rowCount).toBe(1);
    await expect(
      userQuery(
        dual.userId,
        `update public.client_budget_context
            set updated_by_practitioner_id = $2 where client_id = $1`,
        [b.clientId, dual.inA],
      ),
    ).rejects.toThrow();
  });

  it("F. an INACTIVE practitioner cannot write, even in their own studio", async () => {
    await clearBudget(a.clientId);
    await expect(
      userQuery(
        aInactive.userId,
        `insert into public.client_budget_context
           (client_id, studio_id, budget_notes, updated_by_practitioner_id)
         values ($1, $2, 'inactive', $3)`,
        [a.clientId, a.studioId, aInactive.practitionerId],
      ),
    ).rejects.toThrow();
  });

  it("F2. an ACTIVE member cannot attribute a write to an INACTIVE colleague", async () => {
    await clearBudget(a.clientId);
    await expect(
      userQuery(
        a.userId,
        `insert into public.client_budget_context
           (client_id, studio_id, budget_notes, updated_by_practitioner_id)
         values ($1, $2, 'x', $3)`,
        [a.clientId, a.studioId, aInactive.practitionerId],
      ),
    ).rejects.toThrow();
  });

  it("the studio_id TRIGGER runs before WITH CHECK, so a lied-about studio still resolves", async () => {
    // The caller claims studio B while writing A's client. The trigger
    // rewrites studio_id to A, and the policy then evaluates the A-scoped
    // actor rule — so the correct A identity is accepted, not rejected by the
    // caller's own false claim.
    await clearBudget(a.clientId);
    const res = await userQuery(
      a.userId,
      `insert into public.client_budget_context
         (client_id, studio_id, budget_notes, updated_by_practitioner_id)
       values ($1, $2, 'claimed B', $3)`,
      [a.clientId, b.studioId, a.practitionerId],
    );
    expect(res.rowCount).toBe(1);
    expect((await budgetRow(a.clientId)).studio_id).toBe(a.studioId);
  });
});

// ---------------------------------------------------------------------------
// CLIENT IDENTITY IMMUTABILITY
//
// The row's identity is frozen after INSERT. Without this, a member could
// PATCH client_id and MOVE a budget record between clients: the studio trigger
// re-derives studio_id from the new client, the update policy passes on both
// sides, and both composite FKs are then satisfied. The source client loses
// its budget and one client's financial notes land on another's record.
//
// ANTI-VACUITY: dropping the immutability trigger must turn the SAME-STUDIO
// and DUAL-STUDIO cases red. Neither is refused by any other rule — in the
// same-studio case BOTH clients are fully accessible to the actor, which is
// exactly why it is the load-bearing proof.
// ---------------------------------------------------------------------------

describe("0183: client_id is immutable", () => {
  let secondClientA: string;

  beforeAll(async () => {
    secondClientA = randomUUID();
    await adminQuery(
      "insert into public.clients (id, studio_id, name) values ($1, $2, 'Second client A')",
      [secondClientA, a.studioId],
    );
  });

  it("A. a SAME-STUDIO move is refused, and neither client is disturbed", async () => {
    await seedBudget(a, {
      level: "severely_limited",
      notes: "sensitive note belonging to client one",
    });
    await adminQuery(
      "delete from public.client_budget_context where client_id = $1",
      [secondClientA],
    );

    await expect(
      userQuery(
        a.userId,
        "update public.client_budget_context set client_id = $2 where client_id = $1",
        [a.clientId, secondClientA],
      ),
    ).rejects.toThrow(/client_id is immutable/i);

    // The source keeps its row, contents untouched.
    const src = await budgetRow(a.clientId);
    expect(src).toBeTruthy();
    expect(src.budget_level).toBe("severely_limited");
    expect(src.budget_notes).toBe("sensitive note belonging to client one");
    // And nothing was attached to the destination.
    const dst = await adminQuery(
      "select 1 from public.client_budget_context where client_id = $1",
      [secondClientA],
    );
    expect(dst.rows).toHaveLength(0);
  });

  it("A2. the move is refused even for the SERVICE ROLE (not merely an RLS artifact)", async () => {
    await seedBudget(a, { notes: "still client one" });
    await expect(
      adminQuery(
        "update public.client_budget_context set client_id = $2 where client_id = $1",
        [a.clientId, secondClientA],
      ),
    ).rejects.toThrow(/client_id is immutable/i);
    expect((await budgetRow(a.clientId)).budget_notes).toBe("still client one");
  });

  it("B. a DUAL-STUDIO move to the other studio's client is refused", async () => {
    await seedBudget(a, { notes: "studio A budget", actor: dual.inA });
    await adminQuery(
      "delete from public.client_budget_context where client_id = $1",
      [b.clientId],
    );

    // Same human, valid identities in both studios, supplying the destination
    // studio's practitioner id — the shape that would otherwise satisfy every
    // remaining check.
    await expect(
      userQuery(
        dual.userId,
        `update public.client_budget_context
            set client_id = $2, updated_by_practitioner_id = $3
          where client_id = $1`,
        [a.clientId, b.clientId, dual.inB],
      ),
    ).rejects.toThrow(/client_id is immutable/i);

    expect((await budgetRow(a.clientId)).budget_notes).toBe("studio A budget");
    const moved = await adminQuery(
      "select 1 from public.client_budget_context where client_id = $1",
      [b.clientId],
    );
    expect(moved.rows).toHaveLength(0);
  });

  it("C. an ORDINARY update of level and notes still works", async () => {
    await seedBudget(a, { level: "somewhat_limited", notes: "before" });
    const res = await userQuery(
      a.userId,
      `update public.client_budget_context
          set budget_level = 'no_stated_limit',
              budget_notes = 'after',
              updated_by_practitioner_id = $2
        where client_id = $1`,
      [a.clientId, a.practitionerId],
    );
    expect(res.rowCount).toBe(1);
    expect(await budgetRow(a.clientId)).toMatchObject({
      budget_level: "no_stated_limit",
      budget_notes: "after",
    });
  });

  it("C2. re-stating the SAME client_id in the SET list is not a move", async () => {
    // The guard compares values, not whether the column was mentioned, so a
    // caller that harmlessly re-sends its own client_id is unaffected.
    await seedBudget(a, { notes: "unchanged identity" });
    const res = await userQuery(
      a.userId,
      `update public.client_budget_context
          set client_id = $1, budget_notes = 'edited'
        where client_id = $1`,
      [a.clientId],
    );
    expect(res.rowCount).toBe(1);
    expect((await budgetRow(a.clientId)).budget_notes).toBe("edited");
  });

  it("D. the application's UPSERT on the same client still works", async () => {
    // This is the shape the server action issues: insert the full row with
    // ON CONFLICT (client_id) DO UPDATE. The conflicting row has the same
    // client_id by definition, so the guard must not fire.
    await seedBudget(a, { level: "somewhat_limited", notes: "first" });
    const res = await userQuery(
      a.userId,
      `insert into public.client_budget_context
         (client_id, studio_id, budget_level, budget_notes, updated_by_practitioner_id)
       values ($1, $2, 'severely_limited', 'upserted', $3)
       on conflict (client_id) do update set
         client_id = excluded.client_id,
         studio_id = excluded.studio_id,
         budget_level = excluded.budget_level,
         budget_notes = excluded.budget_notes,
         updated_by_practitioner_id = excluded.updated_by_practitioner_id`,
      [a.clientId, a.studioId, a.practitionerId],
    );
    expect(res.rowCount).toBe(1);
    expect(await budgetRow(a.clientId)).toMatchObject({
      budget_level: "severely_limited",
      budget_notes: "upserted",
    });
  });

  it("E. a fresh INSERT for a client with no row is unaffected", async () => {
    await adminQuery(
      "delete from public.client_budget_context where client_id = $1",
      [secondClientA],
    );
    const res = await userQuery(
      a.userId,
      `insert into public.client_budget_context
         (client_id, studio_id, budget_notes, updated_by_practitioner_id)
       values ($1, $2, 'brand new', $3)`,
      [secondClientA, a.studioId, a.practitionerId],
    );
    expect(res.rowCount).toBe(1);
    expect((await budgetRow(secondClientA)).budget_notes).toBe("brand new");
    await adminQuery(
      "delete from public.client_budget_context where client_id = $1",
      [secondClientA],
    );
  });
});

// ---------------------------------------------------------------------------
// TIMESTAMP INTEGRITY
//
// created_at and updated_at are database-controlled evidence, not caller-
// authored values. `default now()` alone is NOT a guarantee: a default applies
// only when the caller omits the column, and an authenticated caller issuing
// PostgREST directly can simply supply it. Measured before these guards, a
// direct INSERT supplying both stored BOTH verbatim, and a direct UPDATE
// rewrote created_at.
//
// ANTI-VACUITY: dropping the INSERT guard turns C and D red; dropping the
// immutability trigger turns A (and the client_id cases) red.
// ---------------------------------------------------------------------------

describe("0183: timestamps are database-controlled", () => {
  const FORGED = "2001-01-01T00:00:00Z";
  const forgedYear = 2001;

  function yearOf(v: unknown): number {
    return new Date(v as string).getUTCFullYear();
  }

  it("A. UPDATE cannot rewrite created_at — it is REJECTED, not silently reset", async () => {
    await seedBudget(a, { notes: "original" });
    const before = await budgetRow(a.clientId);
    await expect(
      userQuery(
        a.userId,
        `update public.client_budget_context
            set created_at = $2, updated_by_practitioner_id = $3
          where client_id = $1`,
        [a.clientId, FORGED, a.practitionerId],
      ),
    ).rejects.toThrow(/created_at is immutable/i);
    const after = await budgetRow(a.clientId);
    expect(after.created_at).toEqual(before.created_at);
    expect(yearOf(after.created_at)).not.toBe(forgedYear);
  });

  it("B. UPDATE cannot forge updated_at — set_updated_at wins", async () => {
    await seedBudget(a, { notes: "original" });
    const res = await userQuery(
      a.userId,
      `update public.client_budget_context
          set updated_at = $2, budget_notes = 'edited',
              updated_by_practitioner_id = $3
        where client_id = $1`,
      [a.clientId, FORGED, a.practitionerId],
    );
    expect(res.rowCount).toBe(1);
    // The statement is allowed, but the caller's value does not survive.
    expect(yearOf((await budgetRow(a.clientId)).updated_at)).not.toBe(
      forgedYear,
    );
  });

  it("C. INSERT cannot forge created_at — the default is not the guarantee", async () => {
    await clearBudget(a.clientId);
    const res = await userQuery(
      a.userId,
      `insert into public.client_budget_context
         (client_id, studio_id, budget_notes, updated_by_practitioner_id, created_at)
       values ($1, $2, 'n', $3, $4)`,
      [a.clientId, a.studioId, a.practitionerId, FORGED],
    );
    expect(res.rowCount).toBe(1);
    expect(yearOf((await budgetRow(a.clientId)).created_at)).not.toBe(
      forgedYear,
    );
  });

  it("D. INSERT cannot forge updated_at", async () => {
    await clearBudget(a.clientId);
    await userQuery(
      a.userId,
      `insert into public.client_budget_context
         (client_id, studio_id, budget_notes, updated_by_practitioner_id, created_at, updated_at)
       values ($1, $2, 'n', $3, $4, $4)`,
      [a.clientId, a.studioId, a.practitionerId, FORGED],
    );
    const row = await budgetRow(a.clientId);
    expect(yearOf(row.created_at)).not.toBe(forgedYear);
    expect(yearOf(row.updated_at)).not.toBe(forgedYear);
  });

  it("E. an ORDINARY update leaves created_at alone and advances updated_at", async () => {
    await clearBudget(a.clientId);
    await userQuery(
      a.userId,
      `insert into public.client_budget_context
         (client_id, studio_id, budget_level, budget_notes, updated_by_practitioner_id)
       values ($1, $2, 'somewhat_limited', 'before', $3)`,
      [a.clientId, a.studioId, a.practitionerId],
    );
    const before = await budgetRow(a.clientId);

    const res = await userQuery(
      a.userId,
      `update public.client_budget_context
          set budget_level = 'no_stated_limit',
              budget_notes = 'after',
              updated_by_practitioner_id = $2
        where client_id = $1`,
      [a.clientId, a.practitionerId],
    );
    expect(res.rowCount).toBe(1);

    const after = await budgetRow(a.clientId);
    expect(after.budget_level).toBe("no_stated_limit");
    expect(after.budget_notes).toBe("after");
    expect(after.created_at).toEqual(before.created_at);
    expect(
      new Date(after.updated_at as string).getTime(),
    ).toBeGreaterThanOrEqual(new Date(before.updated_at as string).getTime());
  });

  it("F. the application UPSERT works on BOTH the insert and the update path", async () => {
    // Exactly the payload updateClientBudgetContextAction sends: no
    // timestamps at all, ON CONFLICT (client_id).
    const upsert = (notes: string) =>
      userQuery(
        a.userId,
        `insert into public.client_budget_context
           (client_id, studio_id, budget_level, budget_notes, updated_by_practitioner_id)
         values ($1, $2, 'somewhat_limited', $4, $3)
         on conflict (client_id) do update set
           studio_id = excluded.studio_id,
           budget_level = excluded.budget_level,
           budget_notes = excluded.budget_notes,
           updated_by_practitioner_id = excluded.updated_by_practitioner_id`,
        [a.clientId, a.studioId, a.practitionerId, notes],
      );

    await clearBudget(a.clientId);
    // INSERT path.
    expect((await upsert("first")).rowCount).toBe(1);
    const created = (await budgetRow(a.clientId)).created_at;
    expect((await budgetRow(a.clientId)).budget_notes).toBe("first");

    // UPDATE path — must not trip either immutability guard.
    expect((await upsert("second")).rowCount).toBe(1);
    const after = await budgetRow(a.clientId);
    expect(after.budget_notes).toBe("second");
    expect(after.created_at).toEqual(created);
  });
});

describe("0183: RLS read/write scoping", () => {
  it("a member reads their OWN studio's budget context", async () => {
    await seedBudget(a, { level: "no_stated_limit", notes: "mine" });
    const read = await userQuery(
      a.userId,
      "select budget_level, budget_notes from public.client_budget_context where client_id = $1",
      [a.clientId],
    );
    expect(read.rows).toHaveLength(1);
    expect(read.rows[0]).toMatchObject({
      budget_level: "no_stated_limit",
      budget_notes: "mine",
    });
  });

  it("a FOREIGN studio's member cannot READ the row", async () => {
    await seedBudget(a, { notes: "private" });
    const read = await userQuery(
      b.userId,
      "select 1 from public.client_budget_context where client_id = $1",
      [a.clientId],
    );
    expect(read.rows).toHaveLength(0);
  });

  it("a FOREIGN studio's member cannot UPDATE the row", async () => {
    await seedBudget(a, { notes: "private" });
    const res = await userQuery(
      b.userId,
      "update public.client_budget_context set budget_notes = 'stolen' where client_id = $1",
      [a.clientId],
    ).catch(() => ({ rowCount: 0 }));
    expect(res.rowCount).toBe(0);
    expect((await budgetRow(a.clientId)).budget_notes).toBe("private");
  });

  it("no DELETE route exists for an authenticated member", async () => {
    await seedBudget(a, { notes: "keep" });
    await userQuery(
      a.userId,
      "delete from public.client_budget_context where client_id = $1",
      [a.clientId],
    ).catch(() => undefined);
    const res = await adminQuery(
      "select budget_notes from public.client_budget_context where client_id = $1",
      [a.clientId],
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].budget_notes).toBe("keep");
  });
});

describe("0183: privileges", () => {
  it("anon holds NO privilege on the table", async () => {
    const res = await adminQuery(
      `select privilege_type from information_schema.role_table_grants
        where table_schema = 'public' and table_name = 'client_budget_context'
          and grantee = 'anon'`,
    );
    expect(res.rows).toHaveLength(0);
  });

  it("service_role holds NO privilege on the table", async () => {
    const res = await adminQuery(
      `select privilege_type from information_schema.role_table_grants
        where table_schema = 'public' and table_name = 'client_budget_context'
          and grantee = 'service_role'`,
    );
    expect(res.rows).toHaveLength(0);
  });

  // 0184: the privilege contract is now an ALLOWLIST, asserted EXACTLY.
  //
  // information_schema.role_table_grants is NOT sufficient here: it does not
  // report MAINTAIN (PostgreSQL 17), which is precisely the privilege that
  // 0183's name-and-revoke approach could not have anticipated. These read the
  // raw ACL via aclexplode so a privilege invented by a future PostgreSQL
  // shows up rather than hiding behind an incomplete view.
  async function tableAcl(): Promise<Record<string, string[]>> {
    const res = await adminQuery(
      `select coalesce(nullif(pg_get_userbyid(a.grantee), ''), 'PUBLIC') as grantee,
              a.privilege_type
         from pg_class c, aclexplode(c.relacl) a
        where c.oid = 'public.client_budget_context'::regclass`,
    );
    const out: Record<string, string[]> = {};
    for (const r of res.rows) {
      const g = r.grantee as string;
      (out[g] ??= []).push(r.privilege_type as string);
    }
    for (const k of Object.keys(out)) out[k].sort();
    return out;
  }

  it("authenticated holds EXACTLY select/insert/update — no REFERENCES, TRIGGER or MAINTAIN", async () => {
    const acl = await tableAcl();
    expect(acl.authenticated).toEqual(["INSERT", "SELECT", "UPDATE"]);
    // Named individually so a failure says WHICH privilege drifted back.
    for (const unintended of [
      "DELETE",
      "TRUNCATE",
      "REFERENCES",
      "TRIGGER",
      "MAINTAIN",
    ]) {
      expect(acl.authenticated, unintended).not.toContain(unintended);
    }
  });

  it("anon, service_role and PUBLIC hold NOTHING on the table", async () => {
    const acl = await tableAcl();
    expect(acl.anon).toBeUndefined();
    expect(acl.service_role).toBeUndefined();
    expect(acl.PUBLIC).toBeUndefined();
    // Only the owner and authenticated appear at all.
    expect(Object.keys(acl).sort()).toEqual(["authenticated", "postgres"]);
  });

  it("the three 0183 trigger functions grant EXECUTE to NOBODY but the owner", async () => {
    const res = await adminQuery(
      `select p.proname,
              coalesce(nullif(pg_get_userbyid(a.grantee), ''), 'PUBLIC') as grantee
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         left join lateral aclexplode(p.proacl) a on true
        where n.nspname = 'public'
          and p.proname in ('client_budget_context_set_studio_id',
                            'client_budget_context_immutable_fields',
                            'client_budget_context_server_timestamps')
        order by p.proname`,
    );
    const byFn: Record<string, string[]> = {};
    for (const r of res.rows) {
      (byFn[r.proname as string] ??= []).push(r.grantee as string);
    }
    expect(Object.keys(byFn).sort()).toHaveLength(3);
    for (const [fn, grantees] of Object.entries(byFn)) {
      expect(grantees.sort(), fn).toEqual(["postgres"]);
    }
  });

  it("public.set_updated_at() is deliberately UNTOUCHED by 0184", async () => {
    // A shared helper used by many tables since 0015. Changing it belongs to
    // its own change with its own blast radius, not to a budget repair.
    const res = await adminQuery(
      `select coalesce(nullif(pg_get_userbyid(a.grantee), ''), 'PUBLIC') as grantee
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace,
              aclexplode(p.proacl) a
        where n.nspname = 'public' and p.proname = 'set_updated_at'`,
    );
    const grantees = res.rows.map((r) => r.grantee as string);
    expect(grantees).toEqual(expect.arrayContaining(["authenticated"]));
  });

  it("an authenticated member cannot CREATE A TRIGGER on the table", async () => {
    // The one genuinely exercisable escalation the drift allowed: CREATE
    // TRIGGER needs only table TRIGGER + function EXECUTE, never ownership,
    // so before 0184 a member could attach an existing trigger function here
    // and disrupt writes. Measured succeeding before the repair.
    await expect(
      userQuery(
        a.userId,
        `create trigger zz_forbidden before insert on public.client_budget_context
           for each row execute function public.client_budget_context_server_timestamps()`,
      ),
    ).rejects.toThrow(/permission denied/i);

    const res = await adminQuery(
      `select tgname from pg_trigger
        where tgrelid = 'public.client_budget_context'::regclass and not tgisinternal
        order by tgname`,
    );
    expect(res.rows.map((r) => r.tgname as string)).toEqual([
      "client_budget_context_immutable_fields",
      "client_budget_context_server_timestamps",
      "client_budget_context_set_studio_id",
      "client_budget_context_set_updated_at",
    ]);
  });

  it("a trigger function cannot be invoked as an ordinary RPC", async () => {
    // Refused twice over after 0184: by the privilege layer, and by
    // PostgreSQL's rule that a `returns trigger` function is not callable.
    await expect(
      userQuery(a.userId, "select public.client_budget_context_set_studio_id()"),
    ).rejects.toThrow();
  });

  it("RLS is enabled", async () => {
    const res = await adminQuery(
      `select relrowsecurity from pg_class
        where oid = 'public.client_budget_context'::regclass`,
    );
    expect(res.rows[0].relrowsecurity).toBe(true);
  });
});

describe("0183: constraints", () => {
  it("accepts every level the application ships, and NULL", async () => {
    for (const level of [...CLIENT_BUDGET_LEVELS, null]) {
      await seedBudget(a, { level });
      expect((await budgetRow(a.clientId)).budget_level).toBe(level);
    }
  });

  it("refuses a level outside the vocabulary", async () => {
    await clearBudget(a.clientId);
    for (const bad of ["unlimited", "Somewhat_limited", "moderate", ""]) {
      await expect(
        adminQuery(
          `insert into public.client_budget_context
             (client_id, studio_id, budget_level, budget_notes, updated_by_practitioner_id)
           values ($1, $2, $3, '', $4)`,
          [a.clientId, a.studioId, bad, a.practitionerId],
        ),
      ).rejects.toThrow();
    }
  });

  it("budget_notes defaults to empty and rejects NULL", async () => {
    await clearBudget(a.clientId);
    await adminQuery(
      `insert into public.client_budget_context
         (client_id, studio_id, updated_by_practitioner_id)
       values ($1, $2, $3)`,
      [a.clientId, a.studioId, a.practitionerId],
    );
    const row = await budgetRow(a.clientId);
    expect(row.budget_notes).toBe("");
    expect(row.budget_level).toBeNull();

    await expect(
      adminQuery(
        "update public.client_budget_context set budget_notes = null where client_id = $1",
        [a.clientId],
      ),
    ).rejects.toThrow();
  });

  it("enforces the 20000-character ceiling", async () => {
    await seedBudget(a, { notes: "x".repeat(20000) });
    await expect(
      adminQuery(
        "update public.client_budget_context set budget_notes = $2 where client_id = $1",
        [a.clientId, "x".repeat(20001)],
      ),
    ).rejects.toThrow();
  });

  it("a level and free text are INDEPENDENT — neither requires the other", async () => {
    await seedBudget(a, { level: "severely_limited", notes: "" });
    await adminQuery(
      `update public.client_budget_context
          set budget_level = null, budget_notes = 'prose only'
        where client_id = $1`,
      [a.clientId],
    );
    expect(await budgetRow(a.clientId)).toMatchObject({
      budget_level: null,
      budget_notes: "prose only",
    });
  });
});

describe("0183: the legacy plan column is untouched", () => {
  it("treatment_plans.budget_notes still exists and still holds its value", async () => {
    const planId = randomUUID();
    await adminQuery(
      `insert into public.treatment_plans (id, studio_id, client_id, name, budget_notes)
       values ($1, $2, $3, 'Legacy plan', 'about $50 a week')`,
      [planId, a.studioId, a.clientId],
    );
    const res = await adminQuery(
      "select budget_notes from public.treatment_plans where id = $1",
      [planId],
    );
    expect(res.rows[0].budget_notes).toBe("about $50 a week");
    await adminQuery("delete from public.treatment_plans where id = $1", [
      planId,
    ]);
  });

  it("0183 created NO backfill — a client with a legacy plan note has no budget row", async () => {
    const tmp = await seedStudio("budget-nobackfill");
    await adminQuery(
      `insert into public.treatment_plans (id, studio_id, client_id, name, budget_notes)
       values ($1, $2, $3, 'Legacy', 'historical value')`,
      [randomUUID(), tmp.studioId, tmp.clientId],
    );
    const res = await adminQuery(
      "select 1 from public.client_budget_context where client_id = $1",
      [tmp.clientId],
    );
    expect(res.rows).toHaveLength(0);
  });
});
