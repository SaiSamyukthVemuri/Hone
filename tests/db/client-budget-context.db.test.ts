import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  closePool,
  seedStudio,
  userQuery,
  type SeededStudio,
} from "./helpers/harness";
import { randomUUID } from "node:crypto";
import { CLIENT_BUDGET_LEVELS } from "@/lib/budget/levels";

// Migration 0183 — client_budget_context, proven on the REAL migrated local
// database rather than by reading the SQL.
//
// The four properties that actually matter:
//   1. ONE current budget per client, enforced by the primary key.
//   2. studio_id is DERIVED from the parent client, so a caller cannot author
//      it — this is the guard that makes a forged cross-studio write useless
//      even if the application check were bypassed.
//   3. RLS refuses a foreign studio's rows for both read and write.
//   4. The level vocabulary in the database is exactly the one the
//      application ships.

let a: SeededStudio; // studio A
let b: SeededStudio; // studio B

beforeAll(async () => {
  a = await seedStudio("budget-a");
  b = await seedStudio("budget-b");
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

describe("0183: one current budget per client", () => {
  it("a second row for the same client is refused by the primary key", async () => {
    await clearBudget(a.clientId);
    await adminQuery(
      `insert into public.client_budget_context (client_id, studio_id, budget_level, budget_notes)
       values ($1, $2, 'somewhat_limited', 'first')`,
      [a.clientId, a.studioId],
    );
    await expect(
      adminQuery(
        `insert into public.client_budget_context (client_id, studio_id, budget_level, budget_notes)
         values ($1, $2, 'severely_limited', 'second')`,
        [a.clientId, a.studioId],
      ),
    ).rejects.toThrow();

    const rows = await adminQuery(
      "select budget_level, budget_notes from public.client_budget_context where client_id = $1",
      [a.clientId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      budget_level: "somewhat_limited",
      budget_notes: "first",
    });
  });

  it("an upsert on the conflict target REPLACES rather than accumulating", async () => {
    await clearBudget(a.clientId);
    for (const level of CLIENT_BUDGET_LEVELS) {
      await adminQuery(
        `insert into public.client_budget_context (client_id, studio_id, budget_level, budget_notes)
         values ($1, $2, $3, 'n')
         on conflict (client_id) do update set budget_level = excluded.budget_level`,
        [a.clientId, a.studioId, level],
      );
    }
    const rows = await adminQuery(
      "select budget_level from public.client_budget_context where client_id = $1",
      [a.clientId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].budget_level).toBe(
      CLIENT_BUDGET_LEVELS[CLIENT_BUDGET_LEVELS.length - 1],
    );
  });

  it("deleting the parent client cascades the budget row away", async () => {
    const tmp = await seedStudio("budget-cascade");
    await adminQuery(
      `insert into public.client_budget_context (client_id, studio_id, budget_notes)
       values ($1, $2, 'x')`,
      [tmp.clientId, tmp.studioId],
    );
    await adminQuery("delete from public.clients where id = $1", [
      tmp.clientId,
    ]);
    const rows = await adminQuery(
      "select 1 from public.client_budget_context where client_id = $1",
      [tmp.clientId],
    );
    expect(rows.rows).toHaveLength(0);
  });
});

describe("0183: studio_id is derived, not authored", () => {
  it("a caller-supplied FOREIGN studio_id is overwritten from the parent client", async () => {
    await clearBudget(a.clientId);
    // Deliberately lie about the studio. Even as the service role.
    await adminQuery(
      `insert into public.client_budget_context (client_id, studio_id, budget_notes)
       values ($1, $2, 'forged')`,
      [a.clientId, b.studioId],
    );
    const rows = await adminQuery(
      "select studio_id from public.client_budget_context where client_id = $1",
      [a.clientId],
    );
    expect(rows.rows[0].studio_id).toBe(a.studioId);
    expect(rows.rows[0].studio_id).not.toBe(b.studioId);
  });

  it("an UPDATE touching ONLY studio_id cannot strand the row", async () => {
    // The gap this closes: a trigger scoped to `update of client_id` never
    // fires for this statement, and a practitioner who belongs to BOTH
    // studios satisfies is_studio_member() on both sides of the RLS policy —
    // so neither the narrow trigger nor RLS alone would stop it. 0183 fires
    // the trigger on every update AND carries the composite FK.
    await clearBudget(a.clientId);
    await adminQuery(
      `insert into public.client_budget_context (client_id, studio_id, budget_notes)
       values ($1, $2, 'x')`,
      [a.clientId, a.studioId],
    );
    await adminQuery(
      "update public.client_budget_context set studio_id = $2 where client_id = $1",
      [a.clientId, b.studioId],
    );
    const rows = await adminQuery(
      "select studio_id from public.client_budget_context where client_id = $1",
      [a.clientId],
    );
    // Silently corrected back to the client's real studio, not stranded.
    expect(rows.rows[0].studio_id).toBe(a.studioId);
  });

  it("the composite FK makes a mismatched (client, studio) pair unrepresentable", async () => {
    // Belt to the trigger's braces: prove the constraint independently by
    // disabling the trigger, so a regression that weakened the trigger alone
    // still cannot produce a stranded row.
    await clearBudget(a.clientId);
    await adminQuery(
      "alter table public.client_budget_context disable trigger client_budget_context_set_studio_id",
    );
    try {
      await expect(
        adminQuery(
          `insert into public.client_budget_context (client_id, studio_id, budget_notes)
           values ($1, $2, 'stranded')`,
          [a.clientId, b.studioId],
        ),
      ).rejects.toThrow();
    } finally {
      await adminQuery(
        "alter table public.client_budget_context enable trigger client_budget_context_set_studio_id",
      );
    }
    const rows = await adminQuery(
      "select 1 from public.client_budget_context where client_id = $1",
      [a.clientId],
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("a budget row for a non-existent client is refused", async () => {
    await expect(
      adminQuery(
        `insert into public.client_budget_context (client_id, studio_id, budget_notes)
         values ($1, $2, 'x')`,
        [randomUUID(), a.studioId],
      ),
    ).rejects.toThrow();
  });

  it("updated_at moves on UPDATE without the caller setting it", async () => {
    await clearBudget(a.clientId);
    await adminQuery(
      `insert into public.client_budget_context (client_id, studio_id, budget_notes)
       values ($1, $2, 'one')`,
      [a.clientId, a.studioId],
    );
    const before = await adminQuery(
      "select updated_at from public.client_budget_context where client_id = $1",
      [a.clientId],
    );
    await adminQuery(
      "update public.client_budget_context set budget_notes = 'two' where client_id = $1",
      [a.clientId],
    );
    const after = await adminQuery(
      "select updated_at from public.client_budget_context where client_id = $1",
      [a.clientId],
    );
    expect(
      new Date(after.rows[0].updated_at as string).getTime(),
    ).toBeGreaterThanOrEqual(
      new Date(before.rows[0].updated_at as string).getTime(),
    );
  });
});

describe("0183: RLS", () => {
  it("a member reads and writes their OWN studio's budget context", async () => {
    await clearBudget(a.clientId);
    await userQuery(
      a.userId,
      `insert into public.client_budget_context (client_id, studio_id, budget_level, budget_notes)
       values ($1, $2, 'no_stated_limit', 'mine')`,
      [a.clientId, a.studioId],
    );
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

    const updated = await userQuery(
      a.userId,
      "update public.client_budget_context set budget_level = null where client_id = $1",
      [a.clientId],
    );
    expect(updated.rowCount).toBe(1);
  });

  it("a FOREIGN studio's member cannot READ the row", async () => {
    const read = await userQuery(
      b.userId,
      "select 1 from public.client_budget_context where client_id = $1",
      [a.clientId],
    );
    expect(read.rows).toHaveLength(0);
  });

  it("a FOREIGN studio's member cannot UPDATE the row", async () => {
    const before = await adminQuery(
      "select budget_notes from public.client_budget_context where client_id = $1",
      [a.clientId],
    );
    const res = await userQuery(
      b.userId,
      "update public.client_budget_context set budget_notes = 'stolen' where client_id = $1",
      [a.clientId],
    );
    expect(res.rowCount).toBe(0);
    const after = await adminQuery(
      "select budget_notes from public.client_budget_context where client_id = $1",
      [a.clientId],
    );
    expect(after.rows[0].budget_notes).toBe(before.rows[0].budget_notes);
  });

  it("a FOREIGN studio's member cannot INSERT for another studio's client", async () => {
    await clearBudget(b.clientId);
    await expect(
      userQuery(
        b.userId,
        `insert into public.client_budget_context (client_id, studio_id, budget_notes)
         values ($1, $2, 'forged')`,
        // b's user, but a's client. The trigger stamps studio A, then the
        // WITH CHECK predicate refuses because b is not a member of A.
        [a.clientId, b.studioId],
      ),
    ).rejects.toThrow();
  });

  it("no DELETE route exists for an authenticated member", async () => {
    await clearBudget(a.clientId);
    await adminQuery(
      `insert into public.client_budget_context (client_id, studio_id, budget_notes)
       values ($1, $2, 'keep')`,
      [a.clientId, a.studioId],
    );
    // No delete policy: the statement is refused outright (privilege) or
    // matches nothing (RLS). Either way the row survives.
    await userQuery(
      a.userId,
      "delete from public.client_budget_context where client_id = $1",
      [a.clientId],
    ).catch(() => undefined);
    const rows = await adminQuery(
      "select budget_notes from public.client_budget_context where client_id = $1",
      [a.clientId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].budget_notes).toBe("keep");
  });
});

describe("0183: privileges", () => {
  it("anon holds NO privilege on the table", async () => {
    const res = await adminQuery(
      `select privilege_type
         from information_schema.role_table_grants
        where table_schema = 'public'
          and table_name = 'client_budget_context'
          and grantee = 'anon'`,
    );
    expect(res.rows).toHaveLength(0);
  });

  it("service_role holds NO privilege on the table", async () => {
    const res = await adminQuery(
      `select privilege_type
         from information_schema.role_table_grants
        where table_schema = 'public'
          and table_name = 'client_budget_context'
          and grantee = 'service_role'`,
    );
    expect(res.rows).toHaveLength(0);
  });

  it("authenticated holds SELECT/INSERT/UPDATE but NOT DELETE or TRUNCATE", async () => {
    const res = await adminQuery(
      `select privilege_type
         from information_schema.role_table_grants
        where table_schema = 'public'
          and table_name = 'client_budget_context'
          and grantee = 'authenticated'`,
    );
    const granted = res.rows.map((r) => r.privilege_type as string);
    expect(granted).toEqual(
      expect.arrayContaining(["SELECT", "INSERT", "UPDATE"]),
    );
    // The security-relevant half: no row-removal privilege of any kind.
    // (REFERENCES and TRIGGER survive from Supabase's default grants here
    // exactly as they do on client_clinical_notes; neither reads or removes
    // data, and revoking them would diverge from every sibling table.)
    expect(granted).not.toContain("DELETE");
    expect(granted).not.toContain("TRUNCATE");
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
      await clearBudget(a.clientId);
      await adminQuery(
        `insert into public.client_budget_context (client_id, studio_id, budget_level, budget_notes)
         values ($1, $2, $3, '')`,
        [a.clientId, a.studioId, level],
      );
      const rows = await adminQuery(
        "select budget_level from public.client_budget_context where client_id = $1",
        [a.clientId],
      );
      expect(rows.rows[0].budget_level).toBe(level);
    }
  });

  it("refuses a level outside the vocabulary", async () => {
    await clearBudget(a.clientId);
    for (const bad of ["unlimited", "Somewhat_limited", "moderate", ""]) {
      await expect(
        adminQuery(
          `insert into public.client_budget_context (client_id, studio_id, budget_level, budget_notes)
           values ($1, $2, $3, '')`,
          [a.clientId, a.studioId, bad],
        ),
      ).rejects.toThrow();
    }
  });

  it("budget_notes defaults to empty and rejects NULL", async () => {
    await clearBudget(a.clientId);
    await adminQuery(
      `insert into public.client_budget_context (client_id, studio_id)
       values ($1, $2)`,
      [a.clientId, a.studioId],
    );
    const rows = await adminQuery(
      "select budget_notes, budget_level from public.client_budget_context where client_id = $1",
      [a.clientId],
    );
    expect(rows.rows[0].budget_notes).toBe("");
    expect(rows.rows[0].budget_level).toBeNull();

    await expect(
      adminQuery(
        "update public.client_budget_context set budget_notes = null where client_id = $1",
        [a.clientId],
      ),
    ).rejects.toThrow();
  });

  it("enforces the 20000-character ceiling", async () => {
    await clearBudget(a.clientId);
    await adminQuery(
      `insert into public.client_budget_context (client_id, studio_id, budget_notes)
       values ($1, $2, $3)`,
      [a.clientId, a.studioId, "x".repeat(20000)],
    );
    await expect(
      adminQuery(
        "update public.client_budget_context set budget_notes = $2 where client_id = $1",
        [a.clientId, "x".repeat(20001)],
      ),
    ).rejects.toThrow();
  });

  it("a level and free text are INDEPENDENT — neither requires the other", async () => {
    await clearBudget(a.clientId);
    // Level only.
    await adminQuery(
      `insert into public.client_budget_context (client_id, studio_id, budget_level, budget_notes)
       values ($1, $2, 'severely_limited', '')`,
      [a.clientId, a.studioId],
    );
    // Notes only.
    await adminQuery(
      `update public.client_budget_context
          set budget_level = null, budget_notes = 'prose only'
        where client_id = $1`,
      [a.clientId],
    );
    const rows = await adminQuery(
      "select budget_level, budget_notes from public.client_budget_context where client_id = $1",
      [a.clientId],
    );
    expect(rows.rows[0]).toMatchObject({
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
    const rows = await adminQuery(
      "select budget_notes from public.treatment_plans where id = $1",
      [planId],
    );
    expect(rows.rows[0].budget_notes).toBe("about $50 a week");
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
    const rows = await adminQuery(
      "select 1 from public.client_budget_context where client_id = $1",
      [tmp.clientId],
    );
    expect(rows.rows).toHaveLength(0);
  });
});
