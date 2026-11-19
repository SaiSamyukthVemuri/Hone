import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, asUser, closePool, seedStudio, type SeededStudio } from "./helpers/harness";

// #1637 (Codex P2): two owner tabs can both pass the app's inventory read and register two xCells. With the xCell's FIXED name, the existing
// unique name index (studio_machines_studio_display_name_uniq, 0223) makes the second insert fail atomically. Proved here against the real
// registration command, two connections at once. Synthetic studio only; the local contract row this test adds is removed afterwards.

const PUR = "dectro-apilus:xcell-pur";
const NAME = "Dectro xCell";
let studio: SeededStudio;
let addedContract = false;

beforeAll(async () => {
  studio = await seedStudio("xcell-race");
  const have = await adminQuery(`select 1 from public.machine_profile_mode_contract where machine_profile_id=$1 and machine_profile_version=1 and mode_key='multiplex'`, [PUR]);
  if (have.rows.length === 0) {
    await adminQuery(`insert into public.machine_profile_mode_contract (machine_profile_id, machine_profile_version, mode_key) values ($1, 1, 'multiplex')`, [PUR]);
    addedContract = true;
  }
});

afterAll(async () => {
  await adminQuery(`delete from public.studio_machines where studio_id=$1`, [studio.studioId]).catch(() => undefined);
  if (addedContract) await adminQuery(`delete from public.machine_profile_mode_contract where machine_profile_id=$1 and machine_profile_version=1 and mode_key='multiplex'`, [PUR]).catch(() => undefined);
  await closePool();
});

const register = () =>
  asUser(studio.userId, (q) => q(`select public.register_studio_machine($1,$2,1,$3,'{}') as id`, [studio.studioId, PUR, NAME]));

describe("one xCell per studio, atomically, from the fixed name", () => {
  it("two concurrent owner registrations: exactly one succeeds and the other is refused by the unique name index", async () => {
    const results = await Promise.allSettled([register(), register()]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const bad = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(String(bad[0].reason?.message ?? bad[0].reason)).toMatch(/studio_machines_studio_display_name_uniq|duplicate key/);
    expect((bad[0].reason as { code?: string }).code).toBe("23505");
    const rows = await adminQuery(`select count(*)::int n from public.studio_machines where studio_id=$1 and machine_profile_id=$2`, [studio.studioId, PUR]);
    expect(rows.rows[0].n).toBe(1);
  });

  it("a RETIRED xCell keeps the name reserved (so retiring is not an undo that frees the name)", async () => {
    await adminQuery(`update public.studio_machines set retired_at = now() where studio_id=$1 and machine_profile_id=$2`, [studio.studioId, PUR]);
    await expect(register()).rejects.toMatchObject({ code: "23505" });
  });

  it("another studio is unaffected: it can register its own xCell under the same name", async () => {
    const other = await seedStudio("xcell-race-other");
    try {
      const r = await asUser(other.userId, (q) => q(`select public.register_studio_machine($1,$2,1,$3,'{}') as id`, [other.studioId, PUR, NAME]));
      expect(r.rows[0].id).toBeTruthy();
    } finally {
      await adminQuery(`delete from public.studio_machines where studio_id=$1`, [other.studioId]).catch(() => undefined);
    }
  });
});
