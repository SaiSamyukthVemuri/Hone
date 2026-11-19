import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, adminTx, closePool, seedStudio } from "./helpers/harness";

// Codex P2 4623898452 (0361 perm_review_timing). A key that is RELEASED but whose prerequisite is NOT (the prerequisite stays at its snapshot) is capped
// by that prerequisite: the owner's stored value is saved, but it is not in force. The review reached the one remaining branch of perm_review_timing,
// which raises review_changed as a race, on EVERY try: a dead end for a valid choice. These tests assert the CORRECT behaviour (the value is stored and
// labelled capped_by_prerequisite), so they are RED while the dead end exists. A real race (a release that commits after the save's transaction began) must
// still refuse as review_changed. Releases are operator-only: everything that releases runs in a transaction that is rolled back. Synthetic data.

let releaseRows: { key: string; released_at: unknown; release_tag: string; release_kind: string }[] = [];
beforeAll(async () => {
  releaseRows = (await adminQuery(`select key, released_at, release_tag, release_kind from public.permission_key_release`)).rows as typeof releaseRows;
});
afterAll(async () => {
  for (const r of releaseRows) await adminQuery(`update public.permission_key_release set released_at = $2, release_tag = $3, release_kind = $4 where key = $1`, [r.key, r.released_at, r.release_tag, r.release_kind]);
  await closePool();
});

type Q = (t: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
class Rollback extends Error {}
type Row = { role: string; key: string; written: boolean; effective_before: string; effective_after: string; timing: string };
type Result = { ok?: boolean; code?: string; review?: Row[]; review_hash?: string };

const inTx = async (fn: (q: Q) => Promise<void>) => {
  try {
    await adminTx(async (q) => {
      await fn(q as Q);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
};
const asOwner = async <T>(q: Q, userId: string, fn: () => Promise<T>): Promise<T> => {
  await q("set local role authenticated");
  await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated" })]);
  try {
    return await fn();
  } finally {
    await q("reset role").catch(() => undefined);
  }
};
const call = async (q: Q, fn: string, args: unknown[]): Promise<Result> =>
  (await q(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0].r as Result;
const adm = async (q: Q, text: string, params?: unknown[]) => {
  await q("reset role");
  try {
    return await q(text, params);
  } finally {
    await q("set local role authenticated");
  }
};
const versionOf = async (q: Q, studioId: string) => Number((await adm(q, `select version from public.studio_permission_policy where studio_id = $1`, [studioId])).rows[0]?.version ?? 0);

// clin.view_photos is releasable and requires client.view_directory, which has NO release row (it can never be released) and whose receptionist snapshot is
// Off. On a new-studio studio the owner may turn the receptionist's clin.view_photos On (the intended prerequisite is On); once the key is released its value
// is capped by the prerequisite's effective Off. (0360 lets the choice be stored; this is what the review then says about it.)
const CHANGES = { receptionist: { "clin.view_photos": "studio" } };

describe("precondition: the catalog and the release rows are what the scenario needs", () => {
  it("clin.view_photos is releasable (one unreleased row) and requires client.view_directory, which has no release row", async () => {
    const c = (await adminQuery(`select requires from public.permission_catalog where key = 'clin.view_photos'`)).rows[0] as { requires: string[] };
    expect(c.requires).toContain("client.view_directory");
    const rel = (await adminQuery(`select key, released_at from public.permission_key_release where key in ('clin.view_photos', 'client.view_directory')`)).rows as { key: string; released_at: unknown }[];
    expect(rel).toEqual([{ key: "clin.view_photos", released_at: null }]);
  });
});

describe("a released key capped by a prerequisite that is NOT in force is stored and labelled, not refused as a race", () => {
  it("preview: ok, the dependent's timing is capped_by_prerequisite and its effective value stays Off", async () => {
    const st = await seedStudio("capped-prereq-preview");
    await inTx(async (q) => {
      await q(`select public.mark_permissions_released(array['clin.view_photos'], 'T-cap', 'full')`);
      await asOwner(q, st.userId, async () => {
        const v = await versionOf(q, st.studioId);
        const p = await call(q, "preview_role_changes_at", [st.studioId, CHANGES, v]);
        expect(p.ok, JSON.stringify(p)).toBe(true);
        expect(p.review?.find((r) => r.key === "clin.view_photos")).toMatchObject({ written: true, effective_before: "off", effective_after: "off", timing: "capped_by_prerequisite" });
      });
    });
  });

  it("save: the reviewed save succeeds on the first try, stores the row, and no one's effective access moves", async () => {
    const st = await seedStudio("capped-prereq-save");
    await inTx(async (q) => {
      await q(`select public.mark_permissions_released(array['clin.view_photos'], 'T-cap', 'full')`);
      await asOwner(q, st.userId, async () => {
        const v = await versionOf(q, st.studioId);
        const before = (await adm(q, `select public.perm_effective_map($1, 'receptionist') as m`, [st.studioId])).rows[0].m;
        const p = await call(q, "preview_role_changes_at", [st.studioId, CHANGES, v]);
        expect(p.ok, JSON.stringify(p)).toBe(true);
        const res = await call(q, "save_role_permissions_reviewed", [st.studioId, v, CHANGES, null, false, p.review_hash]);
        expect(res.ok, JSON.stringify(res)).toBe(true);
        const rows = (await adm(q, `select key, scope from public.studio_role_permissions where studio_id = $1 and role = 'receptionist' order by key`, [st.studioId])).rows;
        expect(rows).toEqual([{ key: "clin.view_photos", scope: "studio" }]);
        expect((await adm(q, `select public.perm_effective_map($1, 'receptionist') as m`, [st.studioId])).rows[0].m).toEqual(before);
      });
    });
  });
});

describe("controls: the other labels and the real race are unchanged", () => {
  it("a LOWERING of a fully released key that is not capped keeps applies_on_save", async () => {
    const st = await seedStudio("capped-prereq-lower");
    await inTx(async (q) => {
      await q(`select public.mark_permissions_released(array['appt.cancel'], 'T-low', 'full')`);
      await asOwner(q, st.userId, async () => {
        const v = await versionOf(q, st.studioId);
        const p = await call(q, "preview_role_changes_at", [st.studioId, { practitioner: { "appt.cancel": "off" } }, v]);
        expect(p.ok, JSON.stringify(p)).toBe(true);
        expect(p.review?.find((r) => r.key === "appt.cancel")?.timing).toBe("applies_on_save");
      });
    });
  });

  it("a REAL race (the key's release is later than the save's transaction, with no prerequisite cap) still refuses as review_changed and writes nothing", async () => {
    const st = await seedStudio("capped-prereq-race");
    await inTx(async (q) => {
      await q(`select public.mark_permissions_released(array['appt.book'], 'T-later', 'full')`);
      await q(`update public.permission_key_release set released_at = now() + interval '1 hour' where key = 'appt.book'`);
      await asOwner(q, st.userId, async () => {
        const v = await versionOf(q, st.studioId);
        const ch = { receptionist: { "appt.book": "studio" } };
        const r = await call(q, "save_role_permissions_reviewed", [st.studioId, v, ch, null, false, "0".repeat(64)]);
        expect(r).toMatchObject({ ok: false, code: "review_changed" });
        expect(Number((await adm(q, `select count(*) n from public.studio_role_permissions where studio_id = $1`, [st.studioId])).rows[0].n)).toBe(0);
      });
    });
  });
});
