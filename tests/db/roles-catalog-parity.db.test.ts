import { afterAll, describe, expect, it } from "vitest";
import { CATALOG, type PermissionDef } from "@/lib/permissions/catalog";
import { adminQuery, adminTx, closePool } from "./helpers/harness";

// The Roles page's "shown" map (core-parse parseState) takes a key's basis value from the TypeScript CATALOG, while the database compares the request
// with permission_catalog (0287). If they drift, the page shows one value and the server judges another. This is the contract that stops that.
afterAll(async () => {
  await closePool();
});

type Row = {
  key: string;
  scopes: string[];
  snapshot_practitioner: string;
  snapshot_receptionist: string;
  new_practitioner: string;
  new_receptionist: string;
  offered_practitioner: boolean;
  offered_receptionist: boolean;
};
const SQL = `select key, scopes, snapshot_practitioner, snapshot_receptionist, new_practitioner, new_receptionist, offered_practitioner, offered_receptionist from public.permission_catalog order by key`;
const defs = CATALOG as readonly PermissionDef[];

/** Every difference between the TypeScript catalog and a table snapshot, as readable strings. Empty = parity. */
export function catalogDifferences(rows: Row[]): string[] {
  const out: string[] = [];
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const tsKeys = new Set(defs.map((d) => d.key));
  for (const d of defs) if (!byKey.has(d.key)) out.push(`${d.key}: in TypeScript, not in permission_catalog`);
  for (const r of rows) if (!tsKeys.has(r.key)) out.push(`${r.key}: in permission_catalog, not in TypeScript`);
  for (const d of defs) {
    const r = byKey.get(d.key);
    if (!r) continue;
    const pairs: [string, unknown, unknown][] = [
      ["snapshot practitioner", d.existingSnapshot.practitioner, r.snapshot_practitioner],
      ["snapshot receptionist", d.existingSnapshot.receptionist, r.snapshot_receptionist],
      ["new-studio practitioner", d.newStudioDefault.practitioner, r.new_practitioner],
      ["new-studio receptionist", d.newStudioDefault.receptionist, r.new_receptionist],
      ["offered practitioner", d.offeredTo.practitioner, r.offered_practitioner],
      ["offered receptionist", d.offeredTo.receptionist, r.offered_receptionist],
      ["scopes", [...d.scopes].sort().join(","), [...r.scopes].sort().join(",")],
    ];
    for (const [what, ts, db] of pairs) if (ts !== db) out.push(`${d.key}: ${what}: TypeScript ${String(ts)}, database ${String(db)}`);
  }
  return out;
}

describe("the TypeScript catalog and permission_catalog agree on every key and role", () => {
  it("same key set, same snapshot and new-studio values for both roles, same scopes and offered flags", async () => {
    const rows = (await adminQuery(SQL)).rows as Row[];
    expect(rows.length).toBeGreaterThan(50);
    expect(catalogDifferences(rows)).toEqual([]);
    // keys an offline pattern can miss are compared too
    for (const k of ["appt.view_calendar", "pay.view_appointment"]) {
      expect(rows.some((r) => r.key === k), k).toBe(true);
      expect(defs.some((d) => d.key === k), k).toBe(true);
    }
  });

  it("the comparison sees drift (mutation, in a rolled-back transaction): a flipped snapshot, a flipped default, an offered flag, a scope, and a missing key each show up", async () => {
    class Rollback extends Error {}
    const key = defs.find((d) => d.offeredTo.practitioner && d.scopes.length === 2)!.key;
    const mutate = async (sql: string, expectText: RegExp) => {
      try {
        await adminTx(async (q) => {
          await q(sql, [key]);
          const diffs = catalogDifferences((await q(SQL)).rows as Row[]);
          expect(diffs.length, sql).toBeGreaterThan(0);
          expect(diffs.join("\n"), sql).toMatch(expectText);
          throw new Rollback();
        });
      } catch (e) {
        if (!(e instanceof Rollback)) throw e;
      }
    };
    await mutate(`update public.permission_catalog set snapshot_practitioner = case when snapshot_practitioner = 'off' then 'studio' else 'off' end where key = $1`, /snapshot practitioner/);
    await mutate(`update public.permission_catalog set new_receptionist = case when new_receptionist = 'off' then 'studio' else 'off' end where key = $1`, /new-studio receptionist/);
    await mutate(`update public.permission_catalog set offered_practitioner = not offered_practitioner where key = $1`, /offered practitioner/);
    await mutate(`update public.permission_catalog set scopes = array['off','own','studio']::text[] where key = $1 and scopes <> array['off','own','studio']::text[]`, /scopes/);
    // a key missing from the table (drop FK-free: the catalog row is referenced, so hide it from the snapshot instead)
    const hidden = catalogDifferences(((await adminQuery(SQL)).rows as Row[]).filter((r) => r.key !== key));
    expect(hidden.join("\n")).toContain(`${key}: in TypeScript, not in permission_catalog`);
    // and a key only the database has
    const extra = catalogDifferences([...((await adminQuery(SQL)).rows as Row[]), { ...((await adminQuery(SQL)).rows[0] as Row), key: "zz.only_in_db" }]);
    expect(extra.join("\n")).toContain("zz.only_in_db: in permission_catalog, not in TypeScript");
  });
});
