import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, adminTx, asUser, closePool, seedMember, seedStudio, type SeededStudio } from "./helpers/harness";

// An owner who changes the shown On to Off was dropped as unchanged (0287 perm_run_changes, the v_apply guard). Reproduction on the REAL 0287 chain, synthetic data.
// A studio on the new_studio basis with no override: the catalog's new-studio default for a practitioner's avail.manage_own is 'studio' (On),
// but until the key is released perm_base_scope returns the existing snapshot ('off'). The owner changes On -> Off. The command compares the
// request with the unreleased base, sees no difference, and DROPS it. These tests assert the CORRECT behaviour (the owner's Off is stored as an
// inert choice), so they are RED while the bug exists. A red here is the finding.

let studio: SeededStudio;
beforeAll(async () => {
  studio = await seedStudio("inert-denial");
  await seedMember(studio, "inert-denial-prac");
  const b = await adminQuery(`select basis, version from public.studio_permission_policy where studio_id = $1`, [studio.studioId]);
  expect(b.rows[0].basis).toBe("new_studio"); // the seed trigger default: no override
  const stored = await adminQuery(`select count(*)::int n from public.studio_role_permissions where studio_id = $1`, [studio.studioId]);
  expect(stored.rows[0].n).toBe(0);
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
    const code = /"code":"([a-z_]+)"/.exec(m)?.[1] ?? null;
    return { code, ok: false, raw: m.slice(0, 300) };
  }
};
const storedRows = async (studioId: string) =>
  (await adminQuery(`select key, scope from public.studio_role_permissions where studio_id = $1 and role = 'practitioner' order by key`, [studioId])).rows;

describe("precondition: the default and the unreleased base disagree", () => {
  it("avail.manage_own: new-studio default is studio, the unreleased base is off", async () => {
    const c = (await adminQuery(`select new_practitioner, snapshot_practitioner from public.permission_catalog where key = 'avail.manage_own'`)).rows[0];
    expect(c).toEqual({ new_practitioner: "studio", snapshot_practitioner: "off" });
    const base = await adminQuery(`select public.perm_base_scope($1, 'practitioner', 'avail.manage_own') as s`, [studio.studioId]);
    expect(base.rows[0].s).toBe("off");
    const rel = await adminQuery(`select released_at from public.permission_key_release where key = 'avail.manage_own'`);
    expect(rel.rows[0].released_at).toBeNull();
  });
});

describe("the owner's Off on a new-studio default is not dropped", () => {
  it("alone: the preview does not say nothing_changed", async () => {
    const r = await callAs(studio.userId, "preview_role_changes", [studio.studioId, { practitioner: { "avail.manage_own": "off" } }]);
    expect(r.code, r.raw).not.toBe("nothing_changed");
  });

  it("alone: the save stores the Off", async () => {
    const r = await callAs(studio.userId, "save_role_permissions", [studio.studioId, 0, { practitioner: { "avail.manage_own": "off" } }, null, false]);
    expect(r.ok, r.raw).toBe(true);
    expect(await storedRows(studio.studioId)).toEqual([{ key: "avail.manage_own", scope: "off" }]);
  });
});

describe("alongside another edit the Off is not silently omitted", () => {
  it("the other edit and the Off are both stored", async () => {
    const s2 = await seedStudio("inert-denial-2");
    const res = await callAs(s2.userId, "save_role_permissions", [s2.studioId, 0, { practitioner: { "avail.manage_own": "off", "appt.cancel": "own" } }, null, false]);
    expect(res.ok, res.raw).toBe(true);
    expect(await storedRows(s2.studioId)).toEqual([
      { key: "appt.cancel", scope: "own" },
      { key: "avail.manage_own", scope: "off" },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// 0355 contract: the Off is INERT (no access moves), the existing_snapshot basis is as before, reset and adopt are exercised once each, and
// the grants are those of 0287.
// ---------------------------------------------------------------------------------------------------------------------------------------
const effectiveMaps = async (studioId: string) =>
  JSON.stringify([
    (await adminQuery(`select public.perm_effective_map($1, 'practitioner') as m`, [studioId])).rows[0].m,
    (await adminQuery(`select public.perm_effective_map($1, 'receptionist') as m`, [studioId])).rows[0].m,
  ]);

describe("the stored Off is inert: nobody's access moves", () => {
  it("effective access is identical before and after the save, and the audit row records what the owner saw", async () => {
    const s = await seedStudio("inert-denial-eff");
    const before = await effectiveMaps(s.studioId);
    const res = await callAs(s.userId, "save_role_permissions", [s.studioId, 0, { practitioner: { "avail.manage_own": "off" } }, null, false]);
    expect(res.ok, res.raw).toBe(true);
    expect(await effectiveMaps(s.studioId)).toBe(before);
    const audit = (await adminQuery(`select before, after from public.permission_audit where studio_id = $1 and kind = 'role_permissions_saved'`, [s.studioId])).rows[0];
    expect(audit.before["avail.manage_own"].stored).toBe("studio"); // what the owner saw (the new-studio default)
    expect(audit.after["avail.manage_own"].stored).toBe("off");
    expect(audit.before["avail.manage_own"].effective).toBe(audit.after["avail.manage_own"].effective); // no access moved
  });
});

describe("the existing_snapshot basis behaves as before", () => {
  it("a request equal to the snapshot (what the owner sees) is still nothing_changed; a different one is stored as before", async () => {
    const s = await seedStudio("inert-denial-existing");
    await adminQuery(`update public.studio_permission_policy set basis = 'existing_snapshot' where studio_id = $1`, [s.studioId]);
    const same = await callAs(s.userId, "preview_role_changes", [s.studioId, { practitioner: { "avail.manage_own": "off" } }]);
    expect(same.code, same.raw).toBe("nothing_changed"); // snapshot off = shown off = base off
    const diff = await callAs(s.userId, "save_role_permissions", [s.studioId, 0, { practitioner: { "avail.manage_own": "studio" } }, null, false]);
    expect(diff.ok, diff.raw).toBe(true);
    expect(await storedRows(s.studioId)).toEqual([{ key: "avail.manage_own", scope: "studio" }]);
  });

  it("a request equal to the new-studio default on a new studio is still nothing_changed only when the base already equals it", async () => {
    const s = await seedStudio("inert-denial-default");
    // appt.cancel: new-studio default studio = snapshot studio = base studio, so 'studio' is no change on either basis
    const r = await callAs(s.userId, "preview_role_changes", [s.studioId, { practitioner: { "appt.cancel": "studio" } }]);
    expect(r.code, r.raw).toBe("nothing_changed");
  });
});

describe("reset and adopt are exercised once each and keep their contract (same result on the hosted body and on 0355)", () => {
  it("reset: removes a stored choice that 0287 and 0355 both store, reports ok, and effective access is unchanged", async () => {
    const s = await seedStudio("inert-denial-reset");
    // appt.cancel own differs from the base (studio), so both the hosted body and 0355 store it: this exercise does not depend on the fix
    expect((await callAs(s.userId, "save_role_permissions", [s.studioId, 0, { practitioner: { "appt.cancel": "own" } }, null, false])).ok).toBe(true);
    expect(await storedRows(s.studioId)).toEqual([{ key: "appt.cancel", scope: "own" }]);
    const before = await effectiveMaps(s.studioId);
    const v = (await adminQuery(`select version from public.studio_permission_policy where studio_id = $1`, [s.studioId])).rows[0].version;
    const r = await callAs(s.userId, "reset_role_to_defaults", [s.studioId, "practitioner", Number(v), "Resetting this role to the studio defaults in a test", false]);
    expect(r.ok, r.raw).toBe(true);
    expect(await storedRows(s.studioId)).toEqual([]);
    expect(await effectiveMaps(s.studioId)).toBe(before);
  });

  it("adopt: an existing studio moves to the new-studio basis and the command reports ok", async () => {
    const s = await seedStudio("inert-denial-adopt");
    await adminQuery(`update public.studio_permission_policy set basis = 'existing_snapshot' where studio_id = $1`, [s.studioId]);
    const r = await callAs(s.userId, "adopt_new_defaults", [s.studioId, 0, "Adopting the new defaults in a test", false]);
    expect(r.ok, r.raw).toBe(true);
    expect((await adminQuery(`select basis from public.studio_permission_policy where studio_id = $1`, [s.studioId])).rows[0].basis).toBe("new_studio");
  });
});

describe("grants are those of 0287", () => {
  const priv = async (fn: string, role: string) =>
    (await adminQuery(`select has_function_privilege($1, $2::regprocedure, 'execute') as ok`, [role, fn])).rows[0].ok as boolean;
  it("perm_run_changes is internal: no API role holds EXECUTE; the page's commands keep theirs", async () => {
    const internal = "public.perm_run_changes(uuid, jsonb, text, boolean, bigint, boolean, boolean)";
    for (const role of ["anon", "authenticated", "service_role"]) expect(await priv(internal, role), `${role} ${internal}`).toBe(false);
    const save = "public.save_role_permissions(uuid, bigint, jsonb, text, boolean)";
    expect(await priv(save, "authenticated")).toBe(true);
    expect(await priv(save, "anon")).toBe(false);
    expect(await priv("public.preview_role_changes(uuid, jsonb)", "authenticated")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// Insurance N1 and N3.
// ---------------------------------------------------------------------------------------------------------------------------------------
async function seedPeople(label: string) {
  const s = await seedStudio(label);
  const prac = await seedMember(s, `${label}-prac`);
  const deskUser = randomUUID();
  await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [deskUser, `${label}-desk-${deskUser.slice(0, 8)}@harness.local`]);
  await adminQuery(`insert into public.studio_receptionists (studio_id, user_id, display_name, active) values ($1, $2, 'Synthetic desk', true)`, [s.studioId, deskUser]);
  return { s, prac, deskUser };
}
const asks = async (userId: string, studioId: string, key: string) =>
  (await asUser(userId, (q) => q(`select public.has_studio_permission($1, $2) as ok`, [studioId, key]))).rows[0].ok as boolean;

describe("N1: has_studio_permission (the function the app calls) is identical before and after the inert save, for every affected user", () => {
  it("owner, practitioner and receptionist get the same answer for the saved key and for another key", async () => {
    const { s, prac, deskUser } = await seedPeople("inert-denial-n1");
    const who = { owner: s.userId, practitioner: prac.userId, receptionist: deskUser };
    const keys = ["avail.manage_own", "appt.cancel"];
    const snapshot = async () => {
      const out: Record<string, boolean> = {};
      for (const [name, uid] of Object.entries(who)) for (const k of keys) out[`${name}:${k}`] = await asks(uid, s.studioId, k);
      return out;
    };
    const before = await snapshot();
    const res = await callAs(s.userId, "save_role_permissions", [s.studioId, 0, { practitioner: { "avail.manage_own": "off" } }, null, false]);
    expect(res.ok, res.raw).toBe(true);
    expect(await storedRows(s.studioId)).toEqual([{ key: "avail.manage_own", scope: "off" }]);
    expect(await snapshot()).toEqual(before);
  });
});

describe("N3: receptionist, and a request equal to the base while a stored choice is present", () => {
  it("receptionist: a default that differs from the snapshot is compared with what the owner sees (appt.book: default studio, snapshot off)", async () => {
    const c = (await adminQuery(`select new_receptionist, snapshot_receptionist, offered_receptionist from public.permission_catalog where key = 'appt.book'`)).rows[0];
    expect(c).toEqual({ new_receptionist: "studio", snapshot_receptionist: "off", offered_receptionist: true });
    const { s, deskUser } = await seedPeople("inert-denial-n3a");
    const before = await asks(deskUser, s.studioId, "appt.book");
    const res = await callAs(s.userId, "save_role_permissions", [s.studioId, 0, { receptionist: { "appt.book": "off" } }, null, false]);
    expect(res.ok, res.raw).toBe(true);
    const row = (await adminQuery(`select scope from public.studio_role_permissions where studio_id = $1 and role = 'receptionist' and key = 'appt.book'`, [s.studioId])).rows[0];
    expect(row.scope).toBe("off");
    expect(await asks(deskUser, s.studioId, "appt.book")).toBe(before); // no access moved
  });

  it("a request equal to the base while a stored choice exists replaces the stored choice (the older condition still holds)", async () => {
    const { s } = await seedPeople("inert-denial-n3b");
    expect((await callAs(s.userId, "save_role_permissions", [s.studioId, 0, { practitioner: { "avail.manage_own": "studio" } }, null, false])).ok).toBe(true);
    expect(await storedRows(s.studioId)).toEqual([{ key: "avail.manage_own", scope: "studio" }]);
    const base = (await adminQuery(`select public.perm_base_scope($1, 'practitioner', 'avail.manage_own') as s`, [s.studioId])).rows[0].s;
    expect(base).toBe("off"); // 'off' equals the base, and a stored 'studio' is present
    const v = (await adminQuery(`select version from public.studio_permission_policy where studio_id = $1`, [s.studioId])).rows[0].version;
    const res = await callAs(s.userId, "save_role_permissions", [s.studioId, Number(v), { practitioner: { "avail.manage_own": "off" } }, null, false]);
    expect(res.ok, res.raw).toBe(true);
    expect(await storedRows(s.studioId)).toEqual([{ key: "avail.manage_own", scope: "off" }]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// Insurance N2: a stored Off that is later RELEASED and ACTIVATED must hold. Everything below runs inside ONE transaction that is rolled back
// (releasing is operator-only and must never persist on the shared stack). The release and activation are the real 0287 commands.
// ---------------------------------------------------------------------------------------------------------------------------------------
class Rollback extends Error {}
async function inReleasedTx(opts: { saveOff: boolean }): Promise<{ before: boolean; afterRelease: boolean; afterActivation: boolean; previewKeys: string[]; previewOk: boolean }> {
  const s = await seedStudio(`inert-denial-n2-${opts.saveOff ? "off" : "control"}`);
  const prac = await seedMember(s, "n2-prac");
  if (opts.saveOff) {
    expect((await callAs(s.userId, "save_role_permissions", [s.studioId, 0, { practitioner: { "avail.manage_own": "off" } }, null, false])).ok).toBe(true);
  }
  const out = { before: false, afterRelease: false, afterActivation: false, previewKeys: [] as string[], previewOk: false };
  const asRoleTx = async (q: (t: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>, userId: string, fn: () => Promise<void>) => {
    await q("set local role authenticated");
    await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated" })]);
    await fn();
    await q("reset role");
  };
  const ask = async (q: (t: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) => {
    let ok = false;
    await asRoleTx(q, prac.userId, async () => {
      ok = (await q(`select public.has_studio_permission($1, 'avail.manage_own') as ok`, [s.studioId])).rows[0].ok as boolean;
    });
    return ok;
  };
  try {
    await adminTx(async (q) => {
      out.before = await ask(q);
      await q(`select public.mark_permissions_released(array['avail.manage_own'], 'T-n2', 'full')`);
      out.afterRelease = await ask(q);
      let hash = "";
      let version = 0;
      await asRoleTx(q, s.userId, async () => {
        const prev = (await q(`select public.preview_activation($1, array['avail.manage_own']) as r`, [s.studioId])).rows[0].r as { ok: boolean; keys: string[]; preview_hash: string; version: number };
        out.previewOk = prev.ok;
        out.previewKeys = prev.keys;
        hash = prev.preview_hash;
        version = prev.version;
        const act = (await q(`select public.activate_released_permissions($1, array['avail.manage_own'], $2, $3, $4, true) as r`, [s.studioId, version, "Activating this key in a test", hash])).rows[0].r as { ok: boolean; code?: string };
        expect(act.ok, JSON.stringify(act)).toBe(true);
      });
      out.afterActivation = await ask(q);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return out;
}

describe("N2: a stored Off is not undone by release or activation (rolled-back transaction, real commands)", () => {
  it("with the stored Off the practitioner never gains avail.manage_own; without it, activation applies the new-studio default (so the Off is what holds)", async () => {
    const off = await inReleasedTx({ saveOff: true });
    expect(off.previewOk).toBe(true);
    expect(off.previewKeys).toEqual(["avail.manage_own"]); // the preview names the key; it is not silent about what is being activated
    expect([off.before, off.afterRelease, off.afterActivation]).toEqual([false, false, false]);
    const control = await inReleasedTx({ saveOff: false });
    expect(control.afterActivation).toBe(true); // the default 'studio' takes effect on activation when the owner saved nothing
  });
});
