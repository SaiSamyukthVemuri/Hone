import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import {
  adminQuery,
  asUser,
  closePool,
  resolveLocalDbUrl,
  routeFor,
  seedSession,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

// ===========================================================================
// 0350 — a NULL element in a machine's installed options never lets an
// option-gated mode through.
//
// THE RULE. A mode that requires an installed option may be recorded only when
// the machine's option list holds that option. A list that holds a NULL element
// and not the option is "not fitted": the save is refused (check_violation).
//
// WHY IT NEEDS A TEST OF ITS OWN. `x = any (array)` is NULL, not false, when the
// array holds a NULL and has no match, and `not NULL` is NULL, so the refusing
// IF did not fire. `register_studio_machine` stores a NULL element as given, so
// the case is reachable through ordinary registration. The negative control at
// the bottom installs the previous body and shows the same save is ACCEPTED
// there, so the refusals above it come from the fix and not from the fixture.
//
// SYNTHETIC DATA ONLY: a fixture profile id, seeded studios, no real client.
// ===========================================================================

const PROFILE = "fixture:db-null-option";
const VERSION = 1;
const OPTION = "fixture-option";
const GATED = "gated";
const OPEN_MODE = "open";

const ROOT = join(__dirname, "..", "..");
const NEW_FILE = readFileSync(join(ROOT, "supabase/migrations/0350_setup_option_check_null_element.sql"), "utf8");
const DOWN_FILE = readFileSync(join(ROOT, "supabase/rollbacks/0350_setup_option_check_null_element.down.sql"), "utf8");
const OLD_FILE = readFileSync(join(ROOT, "supabase/migrations/0237_machine_native_text_readings.sql"), "utf8");

const FIXED = "and (v_requires_option = any (coalesce(p_installed_options, '{}'::text[]))) is not true then";
const BUGGY = "and not (v_requires_option = any (coalesce(p_installed_options, '{}'::text[]))) then";

const functionBlock = (sql: string): string => {
  const start = sql.indexOf("create or replace function public.record_setup_group_in_scope(");
  const end = sql.indexOf("\n$$;", start);
  if (start < 0 || end < 0) throw new Error("record_setup_group_in_scope block not found");
  return sql.slice(start, end + "\n$$;".length);
};

afterAll(async () => {
  await closePool();
});

async function publishContract(): Promise<void> {
  const fields = JSON.stringify([
    { field_key: "current", native_unit: "µA", decimals: 0, quantity: "current", optional: true },
  ]);
  await adminQuery(`select public.sync_machine_profile_contract($1,$2,$3,$4,$5,$6::jsonb)`, [
    PROFILE, VERSION, GATED, 4, OPTION, fields,
  ]);
  await adminQuery(`select public.sync_machine_profile_contract($1,$2,$3,$4,$5,$6::jsonb)`, [
    PROFILE, VERSION, OPEN_MODE, 4, null, fields,
  ]);
}

async function machineWith(studio: SeededStudio, options: Array<string | null>): Promise<string> {
  await publishContract();
  return asUser(studio.userId, async (q) => {
    const r = await q(`select public.register_studio_machine($1,$2,$3,$4,$5::text[]) as id`, [
      studio.studioId, PROFILE, VERSION, `Room ${randomUUID().slice(0, 6)}`, options,
    ]);
    return r.rows[0].id as string;
  });
}

const groupsJson = () =>
  JSON.stringify([
    {
      new_group_ref: "g1",
      channels: [1],
      readings: [{ field_key: "current", value: "120", observation_source: "practitioner-entered" }],
    },
  ]);

const SAVE_SQL = `select public.record_treatment_setup_submission($1,$2,$3,$4,$5::jsonb,$6::uuid,$7::uuid) as r`;

async function arrange(options: Array<string | null>) {
  const studio = await seedStudio();
  const { blockId } = await seedSession(studio);
  const machineId = await machineWith(studio, options);
  const route = await routeFor(blockId);
  const args = (mode: string) => [blockId, machineId, mode, `k-${randomUUID()}`, groupsJson(), route.sessionId, route.clientId];
  return { studio, blockId, machineId, args };
}

const save = (userId: string, args: unknown[]) =>
  asUser(userId, async (q) => (await q(SAVE_SQL, args)).rows[0].r as { groups: number; readings: number });

const countReadings = async (blockId: string) =>
  Number(
    (await adminQuery(
      `select count(*)::int as n from public.treatment_setup_captures where session_block_id = $1`,
      [blockId],
    )).rows[0].n,
  );

describe("0350 · an option-gated mode and the installed options list", () => {
  const REFUSED = [
    ["an empty list", [] as Array<string | null>],
    ["a list with only a NULL element", [null]],
    ["a list with a NULL element and an unrelated option", [null, "other-option"]],
  ] as const;

  for (const [label, options] of REFUSED) {
    it(`refuses the gated mode for ${label}, and stores nothing`, async () => {
      const a = await arrange([...options]);
      await expect(save(a.studio.userId, a.args(GATED))).rejects.toMatchObject({ code: "23514" });
      expect(await countReadings(a.blockId)).toBe(0);
    });
  }

  const ACCEPTED = [
    ["the option alone", [OPTION]],
    ["a NULL element and the option", [null, OPTION]],
    ["the option and a NULL element", [OPTION, null]],
  ] as const;

  for (const [label, options] of ACCEPTED) {
    it(`accepts the gated mode for ${label}`, async () => {
      const a = await arrange([...options]);
      const r = await save(a.studio.userId, a.args(GATED));
      expect(r.groups).toBe(1);
      expect(r.readings).toBe(1);
      expect(await countReadings(a.blockId)).toBe(1);
    });
  }

  it("still accepts an ungated mode when the list holds a NULL element", async () => {
    const a = await arrange([null]);
    const r = await save(a.studio.userId, a.args(OPEN_MODE));
    expect(r.groups).toBe(1);
  });
});

/**
 * Runs `fn` as the signed-in member inside ONE transaction that is always rolled back, after installing `installSql` as the
 * owner. Nothing it does, including the installed function, persists.
 */
async function rolledBackAs<T>(userId: string, installSql: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: resolveLocalDbUrl() });
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(installSql);
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId, role: "authenticated" }),
    ]);
    return await fn(client);
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
    await pool.end();
  }
}

describe("NEGATIVE CONTROL: with the 0237 body installed, the same {NULL} save to a gated mode is ACCEPTED", () => {
  it("the old condition lets it through (so the refusals above come from 0350)", async () => {
    const a = await arrange([null]);
    const accepted = await rolledBackAs(a.studio.userId, functionBlock(OLD_FILE), async (c) => {
      const r = await c.query(SAVE_SQL, a.args(GATED));
      return r.rows[0].r as { groups: number; readings: number };
    });
    expect(accepted.readings).toBe(1);
  });

  it("and the 0350 body installed the same way refuses it", async () => {
    const a = await arrange([null]);
    await expect(
      rolledBackAs(a.studio.userId, functionBlock(NEW_FILE), async (c) => {
        await c.query(SAVE_SQL, a.args(GATED));
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
