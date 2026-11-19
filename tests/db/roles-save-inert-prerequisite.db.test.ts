import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, asUser, closePool, seedStudio, type SeededStudio } from "./helpers/harness";

// Codex P2 4620000794 (0287 perm_run_changes, carried into 0360). A studio on the new_studio basis can turn a receptionist's
// clin.view_photos On: its fixed prerequisite client.view_directory is 'studio' under the studio's chosen defaults. While nothing is
// released, perm_effective_scope returns the prerequisite's SNAPSHOT value ('off'), so the prerequisite check rejects the save with
// prerequisite_unmet and the owner cannot store an otherwise valid inert choice (the prerequisite is not configurable, so it cannot be fixed).
// These tests assert the CORRECT behaviour (the choice is stored, inert), so they are RED at a 0360 that checks release-dependent access.
// Enforcement stays release-gated: effective access does not move. Synthetic data.

let studio: SeededStudio;
beforeAll(async () => {
  studio = await seedStudio("inert-prereq");
  const b = await adminQuery(`select basis from public.studio_permission_policy where studio_id = $1`, [studio.studioId]);
  expect(b.rows[0].basis).toBe("new_studio");
});
afterAll(async () => {
  await closePool();
});

type Outcome = { code: string | null; ok: boolean | null; raw: string };
const callAs = async (userId: string, fn: string, args: unknown[]): Promise<Outcome> => {
  try {
    const r = await asUser(userId, (q) => q(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args));
    const j = r.rows[0].r as { ok?: boolean; code?: string };
    return { code: j.code ?? null, ok: j.ok ?? null, raw: JSON.stringify(j).slice(0, 300) };
  } catch (e) {
    const m = String((e as Error).message);
    return { code: /"code":"([a-z_]+)"/.exec(m)?.[1] ?? null, ok: false, raw: m.slice(0, 300) };
  }
};
const stored = async (studioId: string, role: string) =>
  (await adminQuery(`select key, scope from public.studio_role_permissions where studio_id = $1 and role = $2 order by key`, [studioId, role])).rows;
const effective = async (studioId: string) =>
  JSON.stringify([
    (await adminQuery(`select public.perm_effective_map($1, 'practitioner') as m`, [studioId])).rows[0].m,
    (await adminQuery(`select public.perm_effective_map($1, 'receptionist') as m`, [studioId])).rows[0].m,
  ]);

describe("precondition: the chosen default and the release-dependent value of the prerequisite disagree", () => {
  it("client.view_directory for a receptionist: new-studio default studio, effective access off while unreleased; clin.view_photos requires it", async () => {
    const c = (await adminQuery(`select new_receptionist from public.permission_catalog where key = 'client.view_directory'`)).rows[0];
    expect(c.new_receptionist).toBe("studio");
    const p = (await adminQuery(`select requires from public.permission_catalog where key = 'clin.view_photos'`)).rows[0];
    expect(p.requires).toContain("client.view_directory");
    const eff = (await adminQuery(`select public.perm_effective_scope($1, 'receptionist', 'client.view_directory', array['clin.view_photos']::text[]) as s`, [studio.studioId])).rows[0].s;
    expect(eff).toBe("off");
  });
});

describe("an inert On whose prerequisite is satisfied by the chosen defaults is storable", () => {
  it("the preview does not refuse with prerequisite_unmet", async () => {
    const r = await callAs(studio.userId, "preview_role_changes", [studio.studioId, { receptionist: { "clin.view_photos": "studio" } }]);
    expect(r.code, r.raw).not.toBe("prerequisite_unmet");
  });

  it("the save stores it and no one's effective access moves (enforcement stays release-gated)", async () => {
    const s = await seedStudio("inert-prereq-save");
    const before = await effective(s.studioId);
    const res = await callAs(s.userId, "save_role_permissions", [s.studioId, 0, { receptionist: { "clin.view_photos": "studio" } }, "Allow receptionists to see treatment photos", true]);
    expect(res.ok, res.raw).toBe(true);
    expect(await stored(s.studioId, "receptionist")).toEqual([{ key: "clin.view_photos", scope: "studio" }]);
    expect(await effective(s.studioId)).toBe(before);
  });
});

describe("controls: a prerequisite that is NOT satisfied by the intended policy still refuses", () => {
  it("turning a dependent On while its configurable prerequisite is turned Off in the same request is refused", async () => {
    const s = await seedStudio("inert-prereq-neg");
    // clin.edit_records requires clin.view_records (configurable): the intended result has the prerequisite Off.
    const res = await callAs(s.userId, "save_role_permissions", [s.studioId, 0, { practitioner: { "clin.view_records": "off", "clin.edit_records": "studio" } }, "Test of the prerequisite refusal", true]);
    expect(res.ok).toBe(false);
    expect(res.code, res.raw).toBe("prerequisite_unmet");
    expect(await stored(s.studioId, "practitioner")).toEqual([]);
  });
});
