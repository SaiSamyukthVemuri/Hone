import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { adminQuery, adminTx, closePool, seedMember, seedStudio, type SeededStudio } from "./helpers/harness";

// 0356: ONE review table, built by the database, for the exact policy version a save will check. Synthetic data. Anything that releases a key or
// writes inside a transaction below is rolled back (releasing is operator-only and must never persist on a shared stack).
// Releases are operator-only and must never persist on a stack: a test that commits one (the two-session and F4 cases) or a mutant that lets one through
// is undone here, from the rows as they were before the file ran.
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
const rank = (s: string) => (s === "off" ? 0 : s === "own" ? 1 : 2);

type Row = {
  role: string;
  key: string;
  stored_before: string | null;
  shown_before: string;
  requested: string;
  stored_after: string | null;
  written: boolean;
  effective_before: string;
  effective_after: string;
  timing: string;
};
type Result = {
  ok?: boolean;
  code?: string;
  version?: number;
  new_version?: number;
  current_version?: number;
  review?: Row[];
  review_version?: number;
  review_hash?: string;
  changes?: unknown;
  affected?: unknown;
  sensitive_keys?: unknown;
  reason_required?: unknown;
};

async function asOwner<T>(q: Q, userId: string, fn: () => Promise<T>): Promise<T> {
  await q("set local role authenticated");
  await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated" })]);
  try {
    return await fn();
  } finally {
    // A failed statement aborts the transaction; do not let this mask the real error.
    await q("reset role").catch(() => undefined);
  }
}
const call = async (q: Q, fn: string, args: unknown[]): Promise<Result> =>
  (await q(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0].r as Result;
// Read as the table owner even when called inside asOwner (the API role cannot select the policy table), then restore the caller's role.
const version = async (q: Q, studioId: string) => {
  const was = String((await q("select current_user as u")).rows[0].u);
  if (was !== "postgres") await q("reset role");
  const n = Number((await q(`select version from public.studio_permission_policy where studio_id = $1`, [studioId])).rows[0]?.version ?? 0);
  if (was !== "postgres") await q(`set local role ${was}`);
  return n;
};
const adm = async (q: Q, text: string, params?: unknown[]) => {
  const was = String((await q("select current_user as u")).rows[0].u);
  if (was !== "postgres") await q("reset role");
  try {
    return await q(text, params);
  } finally {
    if (was !== "postgres") await q(`set local role ${was}`);
  }
};
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

let s: SeededStudio;
const studio = async () => (s ??= await seedStudio("review-authority"));

describe("contract: the existing result keys and types are unchanged; the table is additive", () => {
  it("preview_role_changes_at and the old preview return the same six keys with the same types; only the new one carries review, review_version, review_hash", async () => {
    const st = await studio();
    await inTx(async (q) => {
      await asOwner(q, st.userId, async () => {
        const v = await version(q, st.studioId);
        const changes = { practitioner: { "appt.cancel": "off" } };
        const at = await call(q, "preview_role_changes_at", [st.studioId, changes, v]);
        const old = await call(q, "preview_role_changes", [st.studioId, changes]);
        for (const r of [at, old]) {
          expect(r.ok).toBe(true);
          expect(typeof r.version).toBe("number");
          expect(typeof r.changes).toBe("object");
          expect(typeof r.affected).toBe("object");
          expect(Array.isArray(r.sensitive_keys)).toBe(true);
          expect(typeof r.reason_required).toBe("boolean");
        }
        expect(Object.keys(old).sort()).toEqual(["affected", "changes", "ok", "reason_required", "sensitive_keys", "version"]);
        expect(Object.keys(at).sort()).toEqual(["affected", "changes", "ok", "reason_required", "review", "review_hash", "review_version", "sensitive_keys", "version"]);
        expect(at.review_version).toBe(at.version);
        expect(at.review_hash).toMatch(/^[0-9a-f]{64}$/);
      });
    });
  });

  it("a reviewed save returns new_version (a number) and every preview key", async () => {
    const st = await studio();
    await inTx(async (q) => {
      await asOwner(q, st.userId, async () => {
        const v = await version(q, st.studioId);
        const changes = { practitioner: { "appt.cancel": "own" } };
        const p = await call(q, "preview_role_changes_at", [st.studioId, changes, v]);
        const saved = await call(q, "save_role_permissions_reviewed", [st.studioId, v, changes, null, false, p.review_hash]);
        expect(saved.ok, JSON.stringify(saved)).toBe(true);
        expect(saved.new_version).toBe(v + 1);
        for (const k of ["version", "changes", "affected", "reason_required", "sensitive_keys"]) expect(saved, k).toHaveProperty(k);
      });
    });
  });
});

describe("the delegator perm_run_changes returns exactly what the 0355 body returned", () => {
  it("on a set of requests (preview and error paths), the delegator equals the sealed 0355 body installed under another name", async () => {
    const st = await studio();
    const src = readFileSync("supabase/migrations/0355_roles_save_inert_denial.sql", "utf8");
    const from = src.indexOf("create or replace function public.perm_run_changes(");
    const fn = src.slice(from, src.indexOf("$$;", src.indexOf("as $$", from)) + 3).replace("public.perm_run_changes(", "public.zz_run_changes_0355(");
    const cases: Record<string, unknown>[] = [
      { practitioner: { "avail.manage_own": "off" } },
      { practitioner: { "appt.cancel": "off", "avail.manage_own": "off" } },
      { receptionist: { "appt.book": "studio" } },
      { practitioner: { "appt.cancel": "own" }, receptionist: { "appt.book": "off" } },
      { practitioner: { "appt.cancel": "studio" } },
      { practitioner: { "no.such.key": "off" } },
      { janitor: {} },
    ];
    await inTx(async (q) => {
      await q(fn);
      await q(`grant execute on function public.zz_run_changes_0355(uuid, jsonb, text, boolean, bigint, boolean, boolean) to authenticated`);
      await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: st.userId, role: "authenticated" })]);
      {
        for (const c of cases) {
          const a = (await q(`select public.zz_run_changes_0355($1, $2, null, false, null, false, false) as r`, [st.studioId, c])).rows[0].r;
          const b = (await q(`select public.perm_run_changes($1, $2, null, false, null, false, false) as r`, [st.studioId, c])).rows[0].r;
          expect(b, JSON.stringify(c)).toEqual(a);
        }
      }
    });
  });
});

describe("the review table states what was stored, what the owner saw, what is written and when it applies", () => {
  it("an inert Off on a new-studio default: stored null, shown studio, written, effective unchanged, not released", async () => {
    const st = await studio();
    await inTx(async (q) => {
      await q(`update public.studio_permission_policy set basis = 'new_studio' where studio_id = $1`, [st.studioId]);
      await asOwner(q, st.userId, async () => {
        const v = await version(q, st.studioId);
        const r = await call(q, "preview_role_changes_at", [st.studioId, { practitioner: { "avail.manage_own": "off" } }, v]);
        expect(r.ok, JSON.stringify(r)).toBe(true);
        expect(r.review).toEqual([
          { role: "practitioner", key: "avail.manage_own", stored_before: null, shown_before: "studio", requested: "off", stored_after: "off", written: true, effective_before: "off", effective_after: "off", timing: "not_released" },
        ]);
      });
    });
  });

  it("a row that is not written says no_change; a stored choice is the stored_before and the shown_before", async () => {
    const st = await studio();
    await inTx(async (q) => {
      await q(`update public.studio_permission_policy set basis = 'existing_snapshot' where studio_id = $1`, [st.studioId]);
      await q(`insert into public.studio_role_permissions (studio_id, role, key, scope) values ($1, 'practitioner', 'appt.cancel', 'own')`, [st.studioId]);
      await asOwner(q, st.userId, async () => {
        const v = await version(q, st.studioId);
        const r = await call(q, "preview_role_changes_at", [st.studioId, { practitioner: { "appt.cancel": "studio", "appt.edit_notes": "studio" } }, v]);
        expect(r.ok, JSON.stringify(r)).toBe(true);
        const byKey = Object.fromEntries((r.review ?? []).map((x) => [x.key, x]));
        expect(byKey["appt.cancel"]).toMatchObject({ stored_before: "own", shown_before: "own", requested: "studio", stored_after: "studio", written: true });
        expect(byKey["appt.edit_notes"]).toMatchObject({ stored_before: null, shown_before: "studio", requested: "studio", stored_after: null, written: false, timing: "no_change" });
      });
    });
  });

  it("after a save, the stored rows and the effective maps are exactly the table's stored_after and effective_after", async () => {
    const st = await studio();
    await inTx(async (q) => {
      await q(`update public.studio_permission_policy set basis = 'new_studio' where studio_id = $1`, [st.studioId]);
      await asOwner(q, st.userId, async () => {
        const v = await version(q, st.studioId);
        const changes = { practitioner: { "avail.manage_own": "off", "appt.cancel": "own" }, receptionist: { "appt.book": "off" } };
        const p = await call(q, "preview_role_changes_at", [st.studioId, changes, v]);
        expect((await call(q, "save_role_permissions_reviewed", [st.studioId, v, changes, null, false, p.review_hash])).ok).toBe(true);
        for (const row of p.review ?? []) {
          const stored = (await adm(q, `select scope from public.studio_role_permissions where studio_id = $1 and role = $2 and key = $3`, [st.studioId, row.role, row.key])).rows[0]?.scope ?? null;
          expect(stored, `${row.role}:${row.key}`).toBe(row.stored_after);
          const eff = (await adm(q, `select public.perm_effective_map($1, $2) as m`, [st.studioId, row.role])).rows[0].m as Record<string, string>;
          expect(eff[row.key], `${row.role}:${row.key}`).toBe(row.effective_after);
        }
      });
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// D1/D2/G6: the timing label is derived independently here from the prose rules, and checked against what the real engine does after release.
// ---------------------------------------------------------------------------------------------------------------------------------------------
type Facts = { released: boolean; kind: "narrow" | "full"; active: boolean; snapshot: string; requested: string; effectiveBefore: string; effectiveAfter: string; written: boolean };
// Derived independently from the engine rules (0287 perm_base_scope), not copied from the SQL.
function expectedTiming(f: Facts): string {
  if (!f.written) return "no_change";
  const raise = rank(f.requested) > rank(f.snapshot);
  if (!f.released) return rank(f.requested) < rank(f.snapshot) ? "at_release" : "not_released";
  if (f.kind === "narrow" && raise) return "waits_for_full_release";
  // in force at the moment of the save (a lowering always, a raise on a full release): the word says whether the effective value moves
  return f.effectiveAfter !== f.effectiveBefore ? "applies_on_save" : "in_force_now";
}

const KEYS: { role: "practitioner" | "receptionist"; key: string }[] = [
  { role: "practitioner", key: "appt.cancel" }, // snapshot studio: a lowering is possible
  { role: "receptionist", key: "appt.book" }, // snapshot off: a raising is possible
];

describe("timing: every release state, activation, prior stored value and request, against the engine", () => {
  it("the label equals an independent derivation, and what the engine does after release agrees with it", async () => {
    const st = await studio();
    const seen = new Set<string>();
    for (const { role, key } of KEYS) {
      const cat = (await adminQuery(`select scopes, snapshot_practitioner, snapshot_receptionist from public.permission_catalog where key = $1`, [key])).rows[0] as {
        scopes: string[];
        snapshot_practitioner: string;
        snapshot_receptionist: string;
      };
      const snapshot = role === "practitioner" ? cat.snapshot_practitioner : cat.snapshot_receptionist;
      const scopes = cat.scopes.filter((x) => !(role === "receptionist" && x === "own"));
      for (const kind of ["unreleased", "narrow", "full"] as const) {
        for (const active of kind === "unreleased" ? [false] : [false, true]) {
          for (const prior of [null, ...scopes]) {
            for (const requested of scopes) {
              await inTx(async (q) => {
                await q(`update public.studio_permission_policy set basis = 'existing_snapshot' where studio_id = $1`, [st.studioId]);
                await q(`delete from public.studio_role_permissions where studio_id = $1`, [st.studioId]);
                if (prior) await q(`insert into public.studio_role_permissions (studio_id, role, key, scope, set_at) values ($1, $2, $3, $4, now() - interval '1 day')`, [st.studioId, role, key, prior]);
                if (kind !== "unreleased") {
                  await q(`select public.mark_permissions_released(array[$1::text], 'T-matrix', $2)`, [key, kind]);
                  if (active) await q(`insert into public.permission_key_activation (studio_id, key, release_tag, activated_by, reason, policy_version) values ($1, $2, 'T-matrix', $3, 'matrix', 0)`, [st.studioId, key, st.userId]);
                }
                await asOwner(q, st.userId, async () => {
                  const v = await version(q, st.studioId);
                  const p = await call(q, "preview_role_changes_at", [st.studioId, { [role]: { [key]: requested } }, v]);
                  if (!p.ok) {
                    expect(p.code, `${role}:${key} ${kind} prior=${prior} req=${requested}`).toBe("nothing_changed");
                    return;
                  }
                  const row = p.review![0];
                  const label = `${role}:${key} ${kind} active=${active} prior=${prior} req=${requested}`;
                  expect(row.timing, label).toBe(
                    expectedTiming({ released: kind !== "unreleased", kind: kind === "narrow" ? "narrow" : "full", active, snapshot, requested, effectiveBefore: row.effective_before, effectiveAfter: row.effective_after, written: row.written }),
                  );
                  seen.add(row.timing);
                  // commit, then ask the ENGINE what is in force (and, for an unreleased key, what is in force once it is released)
                  const saved = await call(q, "save_role_permissions_reviewed", [st.studioId, v, { [role]: { [key]: requested } }, null, false, p.review_hash]);
                  expect(saved.ok, `${label} ${JSON.stringify(saved)}`).toBe(true);
                  const eff = async () => ((await q(`select public.perm_effective_scope($1, $2, $3) as e`, [st.studioId, role, key])).rows[0].e as string);
                  const after = async () => {
                    await q("reset role");
                    const e = await eff();
                    await q("set local role authenticated");
                    return e;
                  };
                  const now = await after();
                  expect(now, `${label} (engine now)`).toBe(row.effective_after);
                  if (kind === "unreleased") {
                    for (const relKind of ["full", "narrow"] as const) {
                      await q("reset role");
                      await q("savepoint rel");
                      await q(`select public.mark_permissions_released(array[$1::text], 'T-matrix', $2)`, [key, relKind]);
                      const released = await eff();
                      await q("rollback to savepoint rel");
                      await q("set local role authenticated");
                      if (row.timing === "at_release") expect(released, `${label} after ${relKind} release`).toBe(requested);
                      // not_released is not checked here: within one transaction set_at = released_at (a tie, which applies at once); evidence cases (1) and (5) cover it.
                    }
                  } else if (row.timing === "in_force_now" || row.timing === "applies_on_save") expect(now, label).toBe(requested);
                  else if (row.timing === "waits_for_full_release" || row.timing === "waits_for_activation") expect(rank(now), label).toBeLessThanOrEqual(rank(snapshot));
                });
              });
            }
          }
        }
      }
    }
    // the matrix reaches the labels that a save can produce
    console.log("TIMING-SEEN " + JSON.stringify([...seen].sort()));
    // T3: the review path can return exactly this set (no_change is covered by the mixed request test): waits_for_activation and capped are unreachable.
    expect([...seen].sort()).toEqual(["applies_on_save", "at_release", "in_force_now", "not_released", "waits_for_full_release"]);
  });
});

describe("RAISE saved AFTER a full release: is it in force at once, or does it wait for activation? (evidence for the page copy)", () => {
  it("full-released key, no activation: a saved raise is in force immediately and activation changes nothing; a raise stored BEFORE the release waits", async () => {
    const st = await studio();
    const out: Record<string, string> = {};
    await inTx(async (q) => {
      await q(`update public.studio_permission_policy set basis = 'existing_snapshot' where studio_id = $1`, [st.studioId]);
      await q(`delete from public.studio_role_permissions where studio_id = $1`, [st.studioId]);
      await q(`select public.mark_permissions_released(array['appt.book'], 'T-raise', 'full')`);
      const eff = async () => (await q(`select public.perm_effective_scope($1, 'receptionist', 'appt.book') as e`, [st.studioId])).rows[0].e as string;
      out.releasedNoChoice = await eff();
      await asOwner(q, st.userId, async () => {
        const v = await version(q, st.studioId);
        const ch = { receptionist: { "appt.book": "studio" } };
        const p = await call(q, "preview_role_changes_at", [st.studioId, ch, v]);
        out.previewTiming = p.review?.[0]?.timing ?? "none";
        const saved = await call(q, "save_role_permissions_reviewed", [st.studioId, v, ch, null, false, p.review_hash]);
        expect(saved.ok, JSON.stringify(saved)).toBe(true);
      });
      out.afterSaveBeforeActivation = await eff();
      await q(`insert into public.permission_key_activation (studio_id, key, release_tag, activated_by, reason, policy_version) values ($1, 'appt.book', 'T-raise', $2, 'evidence', 0)`, [st.studioId, st.userId]);
      out.afterActivation = await eff();
    });
    await inTx(async (q) => {
      await q(`update public.studio_permission_policy set basis = 'existing_snapshot' where studio_id = $1`, [st.studioId]);
      await q(`delete from public.studio_role_permissions where studio_id = $1`, [st.studioId]);
      await q(`insert into public.studio_role_permissions (studio_id, role, key, scope, set_at) values ($1, 'receptionist', 'appt.book', 'studio', now() - interval '1 day')`, [st.studioId]);
      await q(`select public.mark_permissions_released(array['appt.book'], 'T-raise', 'full')`);
      const eff = async () => (await q(`select public.perm_effective_scope($1, 'receptionist', 'appt.book') as e`, [st.studioId])).rows[0].e as string;
      out.storedBeforeRelease_afterRelease = await eff();
      await q(`insert into public.permission_key_activation (studio_id, key, release_tag, activated_by, reason, policy_version) values ($1, 'appt.book', 'T-raise', $2, 'evidence', 0)`, [st.studioId, st.userId]);
      out.storedBeforeRelease_afterActivation = await eff();
    });
    console.log("RAISE-EVIDENCE " + JSON.stringify(out));
    expect(out).toEqual({
      releasedNoChoice: "off",
      previewTiming: "applies_on_save",
      afterSaveBeforeActivation: "studio",
      afterActivation: "studio",
      storedBeforeRelease_afterRelease: "off",
      storedBeforeRelease_afterActivation: "studio",
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Evidence: the engine's own answers for each release state, immediately and after activation. One line per case.
// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("engine evidence: when does a saved choice take effect? (perm_base_scope, 0287 lines 356-404 and the upsert's set_at)", () => {
  const RAISE = { role: "receptionist", key: "appt.book" }; // snapshot off, scope studio is a raise
  const LOWER = { role: "practitioner", key: "appt.cancel" }; // snapshot studio, scope off is a lowering
  const eff = async (q: Q, studioId: string, w: { role: string; key: string }) => (await q(`select public.perm_effective_scope($1, $2, $3) as e`, [studioId, w.role, w.key])).rows[0].e as string;
  const activate = (q: Q, studioId: string, userId: string, key: string) =>
    q(`insert into public.permission_key_activation (studio_id, key, release_tag, activated_by, reason, policy_version) values ($1, $2, 'T-ev', $3, 'evidence', 0)`, [studioId, key, userId]);
  const reset = async (q: Q, studioId: string, basis = "existing_snapshot") => {
    await q(`update public.studio_permission_policy set basis = $2 where studio_id = $1`, [studioId, basis]);
    await q(`delete from public.studio_role_permissions where studio_id = $1`, [studioId]);
  };
  const lines: string[] = [];

  it("(1) stored BEFORE a full release, not activated: a raise waits, a lowering applies; activation then applies the raise", async () => {
    const st = await studio();
    await inTx(async (q) => {
      await reset(q, st.studioId);
      await q(`insert into public.studio_role_permissions (studio_id, role, key, scope, set_at) values ($1, 'receptionist', 'appt.book', 'studio', now() - interval '1 day'), ($1, 'practitioner', 'appt.cancel', 'off', now() - interval '1 day')`, [st.studioId]);
      const before = [await eff(q, st.studioId, RAISE), await eff(q, st.studioId, LOWER)];
      await q(`select public.mark_permissions_released(array['appt.book','appt.cancel'], 'T-ev', 'full')`);
      const released = [await eff(q, st.studioId, RAISE), await eff(q, st.studioId, LOWER)];
      await activate(q, st.studioId, st.userId, "appt.book");
      await activate(q, st.studioId, st.userId, "appt.cancel");
      const activated = [await eff(q, st.studioId, RAISE), await eff(q, st.studioId, LOWER)];
      lines.push(`(1) before release raise=${before[0]} lower=${before[1]}; after full release raise=${released[0]} lower=${released[1]}; after activation raise=${activated[0]} lower=${activated[1]}`);
      expect({ before, released, activated }).toEqual({ before: ["off", "studio"], released: ["off", "off"], activated: ["studio", "off"] });
    });
  });

  it("(2) stored AT or AFTER a full release: in force at once, a raise included, and activation changes nothing; the tie set_at = released_at applies", async () => {
    const st = await studio();
    await inTx(async (q) => {
      await reset(q, st.studioId);
      await q(`select public.mark_permissions_released(array['appt.book'], 'T-ev', 'full')`);
      await q(`insert into public.studio_role_permissions (studio_id, role, key, scope, set_at) values ($1, 'receptionist', 'appt.book', 'studio', now() + interval '1 second')`, [st.studioId]);
      const after = await eff(q, st.studioId, RAISE);
      await activate(q, st.studioId, st.userId, "appt.book");
      const activated = await eff(q, st.studioId, RAISE);
      await q(`update public.studio_role_permissions set set_at = (select released_at from public.permission_key_release where key = 'appt.book') where studio_id = $1`, [st.studioId]);
      const tie = await eff(q, st.studioId, RAISE);
      lines.push(`(2) stored after full release: raise=${after}; after activation=${activated}; tie set_at = released_at (activated) =${tie}`);
      expect({ after, activated, tie }).toEqual({ after: "studio", activated: "studio", tie: "studio" });
    });
    await inTx(async (q) => {
      await reset(q, st.studioId);
      await q(`select public.mark_permissions_released(array['appt.book'], 'T-ev', 'full')`);
      await q(`insert into public.studio_role_permissions (studio_id, role, key, scope, set_at) values ($1, 'receptionist', 'appt.book', 'studio', (select released_at from public.permission_key_release where key = 'appt.book'))`, [st.studioId]);
      const tieNotActivated = await eff(q, st.studioId, RAISE);
      lines.push(`(2b) tie set_at = released_at, NOT activated: raise=${tieNotActivated}`);
      expect(tieNotActivated).toBe("studio");
    });
  });

  it("(3) a narrow release with a raise: it waits for a later full release, activated or not", async () => {
    const st = await studio();
    await inTx(async (q) => {
      await reset(q, st.studioId);
      await q(`insert into public.studio_role_permissions (studio_id, role, key, scope, set_at) values ($1, 'receptionist', 'appt.book', 'studio', now() - interval '1 day')`, [st.studioId]);
      await q(`select public.mark_permissions_released(array['appt.book'], 'T-ev', 'narrow')`);
      const released = await eff(q, st.studioId, RAISE);
      await activate(q, st.studioId, st.userId, "appt.book");
      const activated = await eff(q, st.studioId, RAISE);
      await q(`update public.studio_role_permissions set set_at = now() + interval '1 second' where studio_id = $1`, [st.studioId]);
      const resaved = await eff(q, st.studioId, RAISE);
      lines.push(`(3) narrow release, stored raise: released=${released}; activated=${activated}; re-saved after release=${resaved}`);
      expect({ released, activated, resaved }).toEqual({ released: "off", activated: "off", resaved: "off" });
    });
  });

  it("(4) unreleased: in force at the snapshot, whatever is stored", async () => {
    const st = await studio();
    await inTx(async (q) => {
      await reset(q, st.studioId);
      await q(`insert into public.studio_role_permissions (studio_id, role, key, scope) values ($1, 'receptionist', 'appt.book', 'studio'), ($1, 'practitioner', 'appt.cancel', 'off')`, [st.studioId]);
      const r = [await eff(q, st.studioId, RAISE), await eff(q, st.studioId, LOWER)];
      lines.push(`(4) unreleased with a stored raise and a stored lowering: raise=${r[0]} lower=${r[1]} (snapshots off and studio)`);
      expect(r).toEqual(["off", "studio"]);
    });
  });

  it("(5) a re-save across a release: a pre-release raise re-saved after the release goes in force at once", async () => {
    const st = await studio();
    await inTx(async (q) => {
      await reset(q, st.studioId);
      await q(`insert into public.studio_role_permissions (studio_id, role, key, scope, set_at) values ($1, 'receptionist', 'appt.book', 'studio', now() - interval '1 day')`, [st.studioId]);
      await q(`select public.mark_permissions_released(array['appt.book'], 'T-ev', 'full')`);
      const waiting = await eff(q, st.studioId, RAISE);
      let preview: Row | undefined;
      let resaved = "";
      await asOwner(q, st.userId, async () => {
        const v = await version(q, st.studioId);
        const ch = { receptionist: { "appt.book": "studio" } };
        const p = await call(q, "preview_role_changes_at", [st.studioId, ch, v]);
        preview = p.review?.[0];
        const saved = await call(q, "save_role_permissions_reviewed", [st.studioId, v, ch, null, false, p.review_hash]);
        expect(saved.ok, JSON.stringify(saved)).toBe(true);
      });
      resaved = await eff(q, st.studioId, RAISE);
      lines.push(`(5) pre-release raise after full release: waiting=${waiting}; preview effective_before=${preview?.effective_before} effective_after=${preview?.effective_after} timing=${preview?.timing}; after the re-save=${resaved}`);
      expect({ waiting, resaved, before: preview?.effective_before, after: preview?.effective_after, timing: preview?.timing }).toEqual({
        waiting: "off", resaved: "studio", before: "off", after: "studio", timing: "applies_on_save",
      });
    });
  });

  it("(6) the new-studio default via basis_at: before the release it waits for activation, at or after it applies at once", async () => {
    const st = await studio();
    await inTx(async (q) => {
      await reset(q, st.studioId, "new_studio");
      await q(`select public.mark_permissions_released(array['appt.book'], 'T-ev', 'full')`);
      await q(`update public.studio_permission_policy set basis_at = (select released_at from public.permission_key_release where key = 'appt.book') - interval '1 day' where studio_id = $1`, [st.studioId]);
      const earlier = await eff(q, st.studioId, RAISE);
      await activate(q, st.studioId, st.userId, "appt.book");
      const activated = await eff(q, st.studioId, RAISE);
      await q(`delete from public.permission_key_activation where studio_id = $1`, [st.studioId]);
      await q(`update public.studio_permission_policy set basis_at = (select released_at from public.permission_key_release where key = 'appt.book') where studio_id = $1`, [st.studioId]);
      const tie = await eff(q, st.studioId, RAISE);
      lines.push(`(6) new-studio default (studio, snapshot off), basis_at before release=${earlier}; after activation=${activated}; basis_at = released_at (not activated)=${tie}`);
      expect({ earlier, activated, tie }).toEqual({ earlier: "off", activated: "studio", tie: "studio" });
    });
  });

  it("prints the evidence", () => {
    for (const l of lines) console.log("ENGINE-EVIDENCE " + l);
    expect(lines.length).toBeGreaterThanOrEqual(6);
  });
});

describe("T1: a lowering saved after a full release says it takes effect on save, not that it is in force now", () => {
  it("full-released key, practitioner appt.cancel studio to off: applies_on_save, and after the save it is in force", async () => {
    const st = await studio();
    await inTx(async (q) => {
      await q(`update public.studio_permission_policy set basis = 'existing_snapshot' where studio_id = $1`, [st.studioId]);
      await q(`delete from public.studio_role_permissions where studio_id = $1`, [st.studioId]);
      await q(`select public.mark_permissions_released(array['appt.cancel'], 'T-t1', 'full')`);
      await asOwner(q, st.userId, async () => {
        const v = await version(q, st.studioId);
        const p = await call(q, "preview_role_changes_at", [st.studioId, { practitioner: { "appt.cancel": "off" } }, v]);
        expect(p.review?.[0]).toMatchObject({ effective_before: "studio", effective_after: "off", timing: "applies_on_save" });
      });
    });
  });
});

describe("a state the timing function has no honest word for is a clean refusal (review_changed), never a raw SQL error", () => {
  it("direct call: a released full-release written row whose effective value differs from the request raises PM001 carrying only a perm_fail code", async () => {
    let err: { code?: string; message?: string } | null = null;
    try {
      await adminQuery(`select public.perm_review_timing(true, 'full', 'off', 'studio', 'off', 'off', true, false)`);
    } catch (e) {
      err = e as { code?: string; message?: string };
    }
    expect(err?.code).toBe("PM001");
    expect(JSON.parse(err!.message!)).toMatchObject({ ok: false, code: "review_changed" });
    expect(Object.keys(JSON.parse(err!.message!)).sort()).toEqual(["code", "ok"]);
  });

  it("in one transaction: a key whose released_at is LATER than now() makes a raise unlabellable, and the save is refused (review_changed) with no write, no version bump and no audit row", async () => {
    const st = await seedStudio("review-authority-race2");
    await inTx(async (q) => {
      await q(`select public.mark_permissions_released(array['appt.book'], 'T-later', 'full')`);
      await q(`update public.permission_key_release set released_at = now() + interval '1 hour' where key = 'appt.book'`);
      await asOwner(q, st.userId, async () => {
        const v = await version(q, st.studioId);
        const ch = { receptionist: { "appt.book": "studio" } };
        const r = await call(q, "save_role_permissions_reviewed", [st.studioId, v, ch, null, false, "0".repeat(64)]);
        expect(r).toMatchObject({ ok: false, code: "review_changed" });
        expect(JSON.stringify(r)).not.toMatch(/perm_review_timing|sqlstate|P0001/i);
        expect(Number((await adm(q, `select count(*) n from public.studio_role_permissions where studio_id = $1`, [st.studioId])).rows[0].n)).toBe(0);
        expect(Number((await adm(q, `select count(*) n from public.permission_audit where studio_id = $1`, [st.studioId])).rows[0].n)).toBe(0);
        expect(await version(q, st.studioId)).toBe(v);
        const p = await call(q, "preview_role_changes_at", [st.studioId, ch, v]);
        expect(p).toMatchObject({ ok: false, code: "review_changed" });
      });
    });
  });

  it("save level: a release that committed AFTER this transaction started (its set_at would be earlier than released_at) is refused, with no write, no version bump and no audit row", async () => {
    const st = await seedStudio("review-authority-race");
    const key = "appt.book";
    const ch = { receptionist: { [key]: "studio" } };
    const before = (await adminQuery(`select released_at, release_tag, release_kind from public.permission_key_release where key = $1`, [key])).rows[0] as { released_at: unknown; release_tag: string; release_kind: string };
    expect(before.released_at).toBeNull();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const open = new Promise<void>((r) => (started = r));
    let result: Result | undefined;
    const tx = adminTx(async (q) => {
      await (q as Q)("select now()"); // the transaction's clock is fixed here
      started();
      await gate; // a release commits while this transaction is open
      await asOwner(q as Q, st.userId, async () => {
        const v = await version(q as Q, st.studioId);
        result = await call(q as Q, "save_role_permissions_reviewed", [st.studioId, v, ch, null, false, "0".repeat(64)]);
      });
    });
    await open;
    try {
      await adminQuery(`select public.mark_permissions_released(array[$1::text], 'T-race', 'full')`, [key]);
      release();
      await tx;
      expect(result).toMatchObject({ ok: false, code: "review_changed" });
      expect(JSON.stringify(result)).not.toMatch(/perm_review_timing|sqlstate|P0001/i);
      expect(Number((await adminQuery(`select count(*) n from public.studio_role_permissions where studio_id = $1`, [st.studioId])).rows[0].n)).toBe(0);
      expect(Number((await adminQuery(`select count(*) n from public.permission_audit where studio_id = $1`, [st.studioId])).rows[0].n)).toBe(0);
      expect(Number((await adminQuery(`select version from public.studio_permission_policy where studio_id = $1`, [st.studioId])).rows[0].version)).toBe(0);
    } finally {
      release();
      await tx.catch(() => undefined);
      await adminQuery(`update public.permission_key_release set released_at = null, release_tag = $2, release_kind = $3 where key = $1`, [key, before.release_tag, before.release_kind]);
    }
  });
});

describe("a studio with NO policy row yet can complete its first reviewed save", () => {
  it("preview in one transaction, save in another (the real flow): the save succeeds, and the hash is the same across the two", async () => {
    const st = await seedStudio("review-authority-norow");
    await adminQuery(`delete from public.studio_permission_policy where studio_id = $1`, [st.studioId]); // a studio created before 0287's seed trigger
    const ch = { practitioner: { "appt.cancel": "own" } };
    let hash = "";
    await adminTx(async (q) => {
      await asOwner(q as Q, st.userId, async () => {
        const p = await call(q as Q, "preview_role_changes_at", [st.studioId, ch, 0]);
        expect(p.ok, JSON.stringify(p)).toBe(true);
        hash = p.review_hash!;
      });
    });
    expect(Number((await adminQuery(`select count(*) n from public.studio_permission_policy where studio_id = $1`, [st.studioId])).rows[0].n)).toBe(0); // the preview left no row
    await new Promise((r) => setTimeout(r, 50)); // a later transaction clock, as in real life
    await adminTx(async (q) => {
      await asOwner(q as Q, st.userId, async () => {
        const r = await call(q as Q, "save_role_permissions_reviewed", [st.studioId, 0, ch, null, false, hash]);
        expect(r.ok, JSON.stringify(r)).toBe(true);
      });
    });
    expect(Number((await adminQuery(`select count(*) n from public.studio_permission_policy where studio_id = $1`, [st.studioId])).rows[0].n)).toBe(1);
    await adminQuery(`delete from public.studio_role_permissions where studio_id = $1`, [st.studioId]);
  });

  it("a newly created studio always has its policy row, on new_studio (0287's seed trigger); a missing row is only ever completed as existing_snapshot", async () => {
    const st = await seedStudio("review-authority-seed");
    const row = (await adminQuery(`select basis, version from public.studio_permission_policy where studio_id = $1`, [st.studioId])).rows[0];
    expect(row).toEqual({ basis: "new_studio", version: "0" }); // so the no-row path cannot be a new studio
    await adminQuery(`delete from public.studio_permission_policy where studio_id = $1`, [st.studioId]);
    await inTx(async (q) => {
      await asOwner(q, st.userId, async () => {
        const saved = await call(q, "save_role_permissions_reviewed", [st.studioId, 0, { practitioner: { "appt.cancel": "own" } }, null, false, "0".repeat(64)]);
        expect(saved.code).toBe("review_changed"); // refused on the stamp, but the block already completed the row
      });
      expect((await adm(q, `select basis from public.studio_permission_policy where studio_id = $1`, [st.studioId])).rows[0].basis).toBe("existing_snapshot");
    });
  });

  it("a REFUSED first save writes only the default policy row: no role rows, no audit row, version 0", async () => {
    const st = await seedStudio("review-authority-norow-refused");
    await adminQuery(`delete from public.studio_permission_policy where studio_id = $1`, [st.studioId]);
    await adminTx(async (q) => {
      await asOwner(q as Q, st.userId, async () => {
        const r = await call(q as Q, "save_role_permissions_reviewed", [st.studioId, 0, { practitioner: { "appt.cancel": "own" } }, null, false, "0".repeat(64)]);
        expect(r).toMatchObject({ ok: false, code: "review_changed" });
      });
    });
    expect((await adminQuery(`select basis, version from public.studio_permission_policy where studio_id = $1`, [st.studioId])).rows).toEqual([{ basis: "existing_snapshot", version: "0" }]);
    expect(Number((await adminQuery(`select count(*) n from public.studio_role_permissions where studio_id = $1`, [st.studioId])).rows[0].n)).toBe(0);
    expect(Number((await adminQuery(`select count(*) n from public.permission_audit where studio_id = $1`, [st.studioId])).rows[0].n)).toBe(0);
  });

  it("two previews of the same request in different transactions give the same hash (no now()-derived value is in the input)", async () => {
    const st = await seedStudio("review-authority-stable");
    await adminQuery(`delete from public.studio_permission_policy where studio_id = $1`, [st.studioId]);
    const ch = { practitioner: { "appt.cancel": "own" } };
    const hashes: string[] = [];
    for (const wait of [0, 60]) {
      await new Promise((r) => setTimeout(r, wait));
      await adminTx(async (q) => {
        await asOwner(q as Q, st.userId, async () => {
          hashes.push((await call(q as Q, "preview_role_changes_at", [st.studioId, ch, 0])).review_hash!);
        });
      });
    }
    expect(hashes[0]).toBe(hashes[1]);
    // and on a studio WITH a row (the seeded default is new_studio, whose basis_at is real state): still stable
    const st2 = await seedStudio("review-authority-stable2");
    const hs: string[] = [];
    for (const wait of [0, 60]) {
      await new Promise((r) => setTimeout(r, wait));
      await adminTx(async (q) => {
        await asOwner(q as Q, st2.userId, async () => {
          hs.push((await call(q as Q, "preview_role_changes_at", [st2.studioId, ch, 0])).review_hash!);
        });
      });
    }
    expect(hs[0]).toBe(hs[1]);
  });

  it("on the new_studio basis a changed basis_at DOES change the hash (it is engine state there); on existing_snapshot it does not", async () => {
    const st = await seedStudio("review-authority-basisat");
    const review = [{ role: "practitioner", key: "appt.cancel", requested: "off" }];
    const h = async (q: Q) => (await q(`select public.perm_review_hash($1, 3, $2::jsonb, '[]'::jsonb, false, '{}'::jsonb) as h`, [st.studioId, JSON.stringify(review)])).rows[0].h as string;
    await inTx(async (q) => {
      await q(`update public.studio_permission_policy set basis = 'new_studio', basis_at = now() where studio_id = $1`, [st.studioId]);
      const a = await h(q);
      await q(`update public.studio_permission_policy set basis_at = now() + interval '1 day' where studio_id = $1`, [st.studioId]);
      expect(await h(q)).not.toBe(a);
      await q(`update public.studio_permission_policy set basis = 'existing_snapshot' where studio_id = $1`, [st.studioId]);
      const b = await h(q);
      await q(`update public.studio_permission_policy set basis_at = now() + interval '2 day' where studio_id = $1`, [st.studioId]);
      expect(await h(q)).toBe(b);
    });
  });
});

describe("staleness and the review hash bind the save", () => {
  it("a preview at a version other than the current one is refused stale_version, with nothing written", async () => {
    const st = await studio();
    await inTx(async (q) => {
      await asOwner(q, st.userId, async () => {
        const v = await version(q, st.studioId);
        const r = await call(q, "preview_role_changes_at", [st.studioId, { practitioner: { "appt.cancel": "off" } }, v + 7]);
        expect(r).toMatchObject({ ok: false, code: "stale_version", current_version: v });
        expect(r.review).toBeUndefined();
        expect(Number((await adm(q, `select count(*) n from public.studio_role_permissions where studio_id = $1`, [st.studioId])).rows[0].n)).toBe(0);
      });
    });
  });

  it("refused without a version (version_required), without a hash (review_hash_required), and on a matching version with a different hash (review_changed)", async () => {
    const st = await studio();
    await inTx(async (q) => {
      await asOwner(q, st.userId, async () => {
        const v = await version(q, st.studioId);
        const ch = { practitioner: { "appt.cancel": "off" } };
        const p = await call(q, "preview_role_changes_at", [st.studioId, ch, v]);
        expect((await call(q, "save_role_permissions_reviewed", [st.studioId, null, ch, null, false, p.review_hash])).code).toBe("version_required");
        expect((await call(q, "save_role_permissions_reviewed", [st.studioId, v, ch, null, false, null])).code).toBe("review_hash_required");
        expect((await call(q, "save_role_permissions_reviewed", [st.studioId, v, ch, null, false, "  "])).code).toBe("review_hash_required");
        const wrong = (await call(q, "save_role_permissions_reviewed", [st.studioId, v, ch, null, false, "0".repeat(64)])) as Result;
        expect(wrong).toMatchObject({ ok: false, code: "review_changed" });
        expect(JSON.stringify(wrong)).not.toContain(p.review_hash!); // a refusal does not echo the hash or the table
        expect(wrong.review).toBeUndefined();
        expect(await version(q, st.studioId)).toBe(v); // nothing committed
        expect(Number((await adm(q, `select count(*) n from public.studio_role_permissions where studio_id = $1`, [st.studioId])).rows[0].n)).toBe(0);
        expect(Number((await adm(q, `select count(*) n from public.permission_audit where studio_id = $1`, [st.studioId])).rows[0].n)).toBe(0);
        expect((await call(q, "save_role_permissions_reviewed", [st.studioId, v + 1, ch, null, false, p.review_hash])).code).toBe("stale_version");
      });
    });
  });

  it("a release applied between preview and save is refused (review_changed), and nothing is written", async () => {
    const st = await studio();
    await inTx(async (q) => {
      await asOwner(q, st.userId, async () => {
        const v = await version(q, st.studioId);
        const ch = { practitioner: { "appt.cancel": "off" } };
        const p = await call(q, "preview_role_changes_at", [st.studioId, ch, v]);
        await q("reset role");
        await q(`select public.mark_permissions_released(array['appt.cancel'], 'T-between', 'full')`);
        await q("set local role authenticated");
        await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: st.userId, role: "authenticated" })]);
        const r = await call(q, "save_role_permissions_reviewed", [st.studioId, v, ch, null, false, p.review_hash]);
        expect(r).toMatchObject({ ok: false, code: "review_changed" });
        expect(Number((await adm(q, `select count(*) n from public.studio_role_permissions where studio_id = $1`, [st.studioId])).rows[0].n)).toBe(0);
      });
    });
  });

  it("another studio's hash cannot validate (the studio id is part of the input and is never returned)", async () => {
    const a = await studio();
    const b = await seedStudio("review-authority-b");
    const ch = { practitioner: { "appt.cancel": "off" } };
    let hashA = "";
    await inTx(async (q) => {
      await asOwner(q, a.userId, async () => {
        const p = await call(q, "preview_role_changes_at", [a.studioId, ch, await version(q, a.studioId)]);
        hashA = p.review_hash!;
        expect(JSON.stringify(p)).not.toContain(a.studioId);
      });
      await asOwner(q, b.userId, async () => {
        const vb = await version(q, b.studioId);
        const pb = await call(q, "preview_role_changes_at", [b.studioId, ch, vb]);
        expect(pb.review_hash).not.toBe(hashA);
        expect(await call(q, "save_role_permissions_reviewed", [b.studioId, vb, ch, null, false, hashA])).toMatchObject({ ok: false, code: "review_changed" });
      });
    });
  });

  it("a non-owner is refused before the hash is looked at (the hash is not authorization)", async () => {
    const st = await studio();
    const m = await seedMember(st, "review-authority-prac");
    await inTx(async (q) => {
      const v = await version(q, st.studioId);
      await asOwner(q, m.userId, async () => {
        expect(await call(q, "save_role_permissions_reviewed", [st.studioId, v, { practitioner: { "appt.cancel": "off" } }, null, false, "0".repeat(64)])).toMatchObject({ ok: false, code: "refused" });
        expect(await call(q, "preview_role_changes_at", [st.studioId, { practitioner: { "appt.cancel": "off" } }, v])).toMatchObject({ ok: false, code: "refused" });
      });
    });
  });
});

describe("G2: a release cannot commit while a save holds the share locks", () => {
  it("two sessions: a reviewed save in progress makes mark_permissions_released wait (lock timeout)", async () => {
    const st = await studio();
    const ch = { practitioner: { "appt.cancel": "off" } };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const holding = new Promise<void>((r) => (held = r));
    const tx1 = adminTx(async (q) => {
      await asOwner(q as Q, st.userId, async () => {
        const v = await version(q as Q, st.studioId);
        const p = await call(q as Q, "preview_role_changes_at", [st.studioId, ch, v]);
        expect((await call(q as Q, "save_role_permissions_reviewed", [st.studioId, v, ch, null, false, p.review_hash])).ok).toBe(true);
      });
      held();
      await gate;
      throw new Rollback();
    }).catch((e) => {
      if (!(e instanceof Rollback)) throw e;
    });
    await holding;
    let code: string | undefined;
    try {
      await adminTx(async (q) => {
        await q("set local lock_timeout = '400ms'");
        await q(`select public.mark_permissions_released(array['appt.cancel'], 'T-lock', 'full')`);
      });
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    release();
    await tx1;
    expect(code).toBe("55P03");
    expect((await adminQuery(`select released_at from public.permission_key_release where key = 'appt.cancel'`)).rows[0].released_at).toBeNull();
  });
});

describe("F1: a matching hash bypasses neither the reason nor the sensitive confirmation", () => {
  it("a sensitive raise saved after a full release is refused without confirmation, then without a reason, and accepted with both", async () => {
    const st = await seedStudio("review-authority-sens");
    const cands = (await adminQuery(
      `select key, scopes, 'receptionist' as role, snapshot_receptionist s from public.permission_catalog pc
        where sensitive and owner_configurable and offered_receptionist and snapshot_receptionist <> 'studio' and exists (select 1 from public.permission_key_release r where r.key = pc.key)
       union all
       select key, scopes, 'practitioner', snapshot_practitioner from public.permission_catalog pc
        where sensitive and owner_configurable and offered_practitioner and snapshot_practitioner <> 'studio' and exists (select 1 from public.permission_key_release r where r.key = pc.key)
       order by 1, 3`,
    )).rows as { key: string; scopes: string[]; role: string; s: string }[];
    expect(cands.length, "a sensitive key with a release row whose snapshot is below its maximum").toBeGreaterThan(0);
    let exercised = 0;
    for (const c of cands) {
      const up = c.scopes.filter((x) => rank(x) > rank(c.s)).sort((a, b) => rank(b) - rank(a))[0];
      if (!up) continue;
      await inTx(async (q) => {
        await q(`update public.studio_permission_policy set basis = 'existing_snapshot' where studio_id = $1`, [st.studioId]);
        await q(`select public.mark_permissions_released(array[$1::text], 'T-sens', 'full')`, [c.key]);
        await asOwner(q, st.userId, async () => {
          const v = await version(q, st.studioId);
          const ch = { [c.role]: { [c.key]: up } };
          const p = await call(q, "preview_role_changes_at", [st.studioId, ch, v]);
          if (!p.ok || !(p.sensitive_keys as string[]).includes(c.key)) return; // a prerequisite caps it: not a sensitive rise for this key
          exercised += 1;
          expect(p.reason_required).toBe(true);
          const save = async (reason: string | null, confirmed: boolean) => {
            await q("savepoint s1");
            const r = await call(q, "save_role_permissions_reviewed", [st.studioId, v, ch, reason, confirmed, p.review_hash]);
            await q("rollback to savepoint s1");
            return r;
          };
          expect((await save("because the studio asked for it", false)).code).toBe("sensitive_unconfirmed");
          expect((await save(null, true)).code).toBe("reason_required");
          expect((await save("n/a", true)).code).toBe("reason_required");
          expect((await save("because the studio asked for it", true)).ok).toBe(true);
        });
      });
    }
    expect(exercised, "at least one sensitive key was a real sensitive rise").toBeGreaterThan(0);
  });
});

describe("F2: lock behaviour of release against reviewed saves", () => {
  const holdSave = async (studio: SeededStudio, ch: Record<string, unknown>) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const holding = new Promise<void>((r) => (held = r));
    const done = adminTx(async (q) => {
      await asOwner(q as Q, studio.userId, async () => {
        const v = await version(q as Q, studio.studioId);
        const p = await call(q as Q, "preview_role_changes_at", [studio.studioId, ch, v]);
        expect((await call(q as Q, "save_role_permissions_reviewed", [studio.studioId, v, ch, null, false, p.review_hash])).ok).toBe(true);
      });
      held();
      await gate;
      throw new Rollback();
    }).catch((e) => {
      if (!(e instanceof Rollback)) throw e;
    });
    await holding;
    return { release, done };
  };

  it("a multi-key release that cannot take its lock fails whole (55P03, retryable): neither key is left released", async () => {
    const st = await seedStudio("review-authority-f2a");
    const h = await holdSave(st, { practitioner: { "appt.cancel": "off" } });
    let code: string | undefined;
    try {
      await adminTx(async (q) => {
        await q("set local lock_timeout = '400ms'");
        await q(`select public.mark_permissions_released(array['appt.book', 'appt.cancel'], 'T-f2', 'full')`);
      });
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    h.release();
    await h.done;
    expect(code).toBe("55P03"); // lock_not_available: the operator's retry signal
    const rows = (await adminQuery(`select key, released_at from public.permission_key_release where key in ('appt.book', 'appt.cancel')`)).rows as { released_at: unknown }[];
    expect(rows.map((r) => r.released_at)).toEqual([null, null]);
  });

  it("two reviewed saves in different studios do not block each other (FOR SHARE on release rows only)", async () => {
    const a = await seedStudio("review-authority-f2b");
    const b = await seedStudio("review-authority-f2c");
    const h = await holdSave(a, { practitioner: { "appt.cancel": "off" } });
    let ok = false;
    try {
      await adminTx(async (q) => {
        await q("set local lock_timeout = '1500ms'");
        await asOwner(q as Q, b.userId, async () => {
          const v = await version(q as Q, b.studioId);
          const ch = { practitioner: { "appt.cancel": "off" } };
          const p = await call(q as Q, "preview_role_changes_at", [b.studioId, ch, v]);
          ok = ((await call(q as Q, "save_role_permissions_reviewed", [b.studioId, v, ch, null, false, p.review_hash])) as Result).ok === true;
        });
        throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }
    h.release();
    await h.done;
    expect(ok).toBe(true);
  });
});

describe("F3/F4: a change to the release or the catalog between preview and save is refused (review_changed)", () => {
  it("F3: a catalog change between preview and save", async () => {
    const st = await seedStudio("review-authority-f3");
    await inTx(async (q) => {
      await asOwner(q, st.userId, async () => {
        const v = await version(q, st.studioId);
        const ch = { practitioner: { "appt.cancel": "own" } };
        const p = await call(q, "preview_role_changes_at", [st.studioId, ch, v]);
        await adm(q, `update public.permission_catalog set snapshot_receptionist = 'studio' where key = 'appt.cancel'`);
        expect(await call(q, "save_role_permissions_reviewed", [st.studioId, v, ch, null, false, p.review_hash])).toMatchObject({ ok: false, code: "review_changed" });
        await adm(q, `update public.permission_catalog set sensitive = not sensitive where key = 'appt.cancel'`);
        expect(await call(q, "save_role_permissions_reviewed", [st.studioId, v, ch, null, false, p.review_hash])).toMatchObject({ ok: false, code: "review_changed" });
      });
    });
  });

  it("F4: two transactions: the preview commits first, a release COMMITS after it, and Save refuses on timing alone", async () => {
    const st = await seedStudio("review-authority-f4");
    const key = "appt.mark_no_show";
    const before = (await adminQuery(`select released_at, release_tag, release_kind from public.permission_key_release where key = $1`, [key])).rows[0] as { released_at: Date | null; release_tag: string; release_kind: string };
    expect(before.released_at, "a clean stack: the key starts unreleased").toBeNull();
    const ch = { practitioner: { [key]: "own" } };
    let hash = "";
    let v = 0;
    await adminTx(async (q) => {
      await asOwner(q as Q, st.userId, async () => {
        v = await version(q as Q, st.studioId);
        const p = await call(q as Q, "preview_role_changes_at", [st.studioId, ch, v]);
        expect(p.ok, JSON.stringify(p)).toBe(true);
        hash = p.review_hash!;
      });
    });
    try {
      await adminQuery(`select public.mark_permissions_released(array[$1::text], 'T-f4', 'full')`, [key]); // its own committed transaction, strictly later than the preview
      const after = await adminTx(async (q) => {
        let r!: Result;
        await asOwner(q as Q, st.userId, async () => {
          r = await call(q as Q, "save_role_permissions_reviewed", [st.studioId, v, ch, null, false, hash]);
        });
        return r;
      });
      expect(after).toMatchObject({ ok: false, code: "review_changed" });
      expect(Number((await adminQuery(`select count(*) n from public.studio_role_permissions where studio_id = $1`, [st.studioId])).rows[0].n)).toBe(0);
    } finally {
      await adminQuery(`update public.permission_key_release set released_at = null, release_tag = $2, release_kind = $3 where key = $1`, [key, before.release_tag, before.release_kind]);
    }
    expect((await adminQuery(`select released_at from public.permission_key_release where key = $1`, [key])).rows[0].released_at).toBeNull();
  });
});

describe("dependents: a change to a key moves every key that requires it, and the review covers them (a requested key's DEPENDENTS and what caps them)", () => {
  const VIEW = "clin.view_records";
  const EDIT = "clin.edit_records";
  type Cat = { key: string; requires: string[] };
  const closure = (cat: Cat[], requested: string[]) => {
    const up = new Set(requested);
    for (let grew = true; grew; ) {
      grew = false;
      for (const c of cat) if (!up.has(c.key) && c.requires.some((r) => up.has(r))) (up.add(c.key), (grew = true));
    }
    const all = new Set(up);
    for (let grew = true; grew; ) {
      grew = false;
      for (const c of cat) if (all.has(c.key)) for (const r of c.requires) if (!all.has(r)) (all.add(r), (grew = true));
    }
    return [...all].sort();
  };

  it("the involved set is every requested key, everything that requires one (transitively) and everything any of those require, derived here from the catalog", async () => {
    const cat = (await adminQuery(`select key, requires from public.permission_catalog`)).rows as Cat[];
    for (const requested of [[VIEW], [EDIT], ["appt.view_calendar"], [VIEW, "appt.cancel"], []]) {
      const got = (await adminQuery(`select public.perm_review_involved($1::text[]) as k`, [requested])).rows[0].k as string[];
      expect(got, requested.join(",")).toEqual(closure(cat, requested));
    }
    const forView = (await adminQuery(`select public.perm_review_involved(array[$1]::text[]) as k`, [VIEW])).rows[0].k as string[];
    expect(forView).toContain(EDIT); // the dependent
    expect(forView).toContain("appt.view_calendar"); // what the requested key itself requires
  });

  it("Codex 4585456242: preview View clinical records off (the review shows the dependent falling too), release the dependent, Save is refused (review_changed) and writes nothing", async () => {
    const st = await seedStudio("review-authority-dependent");
    await inTx(async (q) => {
      await adm(q, `insert into public.studio_role_permissions (studio_id, role, key, scope) values ($1, 'practitioner', $2, 'off')`, [st.studioId, EDIT]);
      const rel = (await adm(q, `select key, released_at from public.permission_key_release where key = any($1)`, [[VIEW, EDIT]])).rows as { key: string; released_at: unknown }[];
      expect(rel.find((r) => r.key === EDIT)?.released_at, "precondition: the dependent starts unreleased").toBeNull();
      if (rel.find((r) => r.key === VIEW)?.released_at === null) await adm(q, `select public.mark_permissions_released(array[$1::text], 'T-dep-view', 'full')`, [VIEW]);
      await asOwner(q, st.userId, async () => {
        const v = await version(q, st.studioId);
        const ch = { practitioner: { [VIEW]: "off" } };
        const p = await call(q, "preview_role_changes_at", [st.studioId, ch, v]);
        expect(p.ok, JSON.stringify(p)).toBe(true);
        const moved = ((p.changes as Record<string, { key: string; before: string; after: string }[]>).practitioner ?? []).map((c) => `${c.key}:${c.before}>${c.after}`).sort();
        expect(moved, "the preview shows the dependent falling with the requested key").toEqual(expect.arrayContaining([`${VIEW}:studio>off`, `${EDIT}:studio>off`]));
        await adm(q, `select public.mark_permissions_released(array[$1::text], 'T-dep-edit', 'full')`, [EDIT]); // the dependent's stored denial now applies at once
        const before = await version(q, st.studioId);
        const r = await call(q, "save_role_permissions_reviewed", [st.studioId, v, ch, null, false, p.review_hash]);
        expect(r).toMatchObject({ ok: false, code: "review_changed" });
        expect(await version(q, st.studioId)).toBe(before);
        expect((await adm(q, `select key, scope from public.studio_role_permissions where studio_id = $1 order by key`, [st.studioId])).rows).toEqual([{ key: EDIT, scope: "off" }]);
        expect(Number((await adm(q, `select count(*) n from public.permission_audit where studio_id = $1`, [st.studioId])).rows[0].n)).toBe(0);
        // a fresh preview of the same request is a different review: Save with ITS hash succeeds
        const p2 = await call(q, "preview_role_changes_at", [st.studioId, ch, v]);
        expect(p2.review_hash).not.toBe(p.review_hash);
        expect(await call(q, "save_role_permissions_reviewed", [st.studioId, v, ch, null, false, p2.review_hash])).toMatchObject({ ok: true });
      });
    });
  });

  it("the hash changes when ONLY a dependent's release or activation changes (the requested key's own rows are untouched)", async () => {
    const st = await seedStudio("review-authority-dependent-hash");
    const review = [{ role: "practitioner", key: VIEW, requested: "off" }];
    await inTx(async (q) => {
      const h = async () => (await adm(q, `select public.perm_review_hash($1, 3, $2::jsonb, '[]'::jsonb, false, '{}'::jsonb) as h`, [st.studioId, JSON.stringify(review)])).rows[0].h as string;
      const base = await h();
      expect((await adm(q, `select released_at from public.permission_key_release where key = $1`, [EDIT])).rows[0].released_at).toBeNull();
      await adm(q, `update public.permission_key_release set release_tag = 'T-other' where key = $1`, [EDIT]);
      const retagged = await h();
      expect(retagged, "a dependent's release tag").not.toBe(base);
      await adm(q, `update public.permission_key_release set released_at = now() where key = $1`, [EDIT]);
      const released = await h();
      expect(released, "a dependent's release").not.toBe(retagged);
      await adm(q, `insert into public.permission_key_activation (studio_id, key, release_tag, activated_by, reason, policy_version) values ($1, $2, 'T-other', $3, 'test', 0)`, [st.studioId, EDIT, st.userId]);
      expect(await h(), "a dependent's activation").not.toBe(released);
    });
  });

  it("the hash covers the complete effective diff: role, key, before and after, in a canonical order, and nothing else", async () => {
    const st = await studio();
    const review = [{ role: "practitioner", key: "appt.cancel", requested: "off" }];
    const g = async (changes: unknown) => (await adminQuery(`select public.perm_review_hash($1, 3, $2::jsonb, '[]'::jsonb, false, $3::jsonb) as h`, [st.studioId, JSON.stringify(review), JSON.stringify(changes)])).rows[0].h as string;
    const a = { practitioner: [{ key: "x.b", before: "studio", after: "off", sensitive: true, consequence: "words" }, { key: "x.a", before: "own", after: "off" }], receptionist: [{ key: "x.c", before: "off", after: "studio" }] };
    const base = await g(a);
    expect(await g({ receptionist: a.receptionist, practitioner: [...a.practitioner].reverse() }), "order of roles and rows does not matter").toBe(base);
    expect(await g({ ...a, practitioner: a.practitioner.map((c) => ({ ...c, consequence: "other words", sensitive: false })) }), "consequence text and the sensitive flag are not hashed here").toBe(base);
    expect(await g({ ...a, practitioner: [a.practitioner[0]] }), "a missing row").not.toBe(base);
    expect(await g({ ...a, practitioner: [{ ...a.practitioner[0], after: "own" }, a.practitioner[1]] }), "a different after").not.toBe(base);
    expect(await g({ ...a, practitioner: [{ ...a.practitioner[0], before: "own" }, a.practitioner[1]] }), "a different before").not.toBe(base);
    expect(await g({ ...a, receptionist: [{ ...a.receptionist[0], key: "x.d" }] }), "a different key").not.toBe(base);
    expect(await g({ practitioner: a.practitioner, receptionist: [] }), "a role with no rows").not.toBe(base);
    expect(await g({}), "no changes").not.toBe(base);
  });

  it("the hash input's `changes` field: exact encoding and byte order of a fixed example (uppercase sorts before lowercase, whatever the database collation)", async () => {
    const id = "00000000-0000-4000-8000-000000000356";
    const changes = {
      receptionist: [{ key: "a.x", before: "off", after: "studio", consequence: "words", affected: { count: 3 } }],
      practitioner: [
        { key: "b.y", before: "studio", after: "off" },
        { key: "B.z", before: "own", after: "off", people: ["n"] },
        { key: "a.w", before: "off", after: "own" },
      ],
    };
    const text = (await adminQuery(`select public.perm_review_hash_input($1, 5, '[]'::jsonb, '[]'::jsonb, false, $2::jsonb)::text as t`, [id, JSON.stringify(changes)])).rows[0].t as string;
    expect(text).toBe(
      '{"v": 1, "basis": null, "gates": [], "review": [], "studio": "00000000-0000-4000-8000-000000000356", "catalog": [], "changes": [{"key": "B.z", "role": "practitioner", "after": "off", "before": "own"}, {"key": "a.w", "role": "practitioner", "after": "own", "before": "off"}, {"key": "b.y", "role": "practitioner", "after": "off", "before": "studio"}, {"key": "a.x", "role": "receptionist", "after": "studio", "before": "off"}], "version": 5, "basis_at": null, "releases": [], "activations": [], "sensitive_keys": [], "reason_required": false}',
    );
    expect(text).not.toMatch(/words|people|affected|count/); // no consequence text, people, names or counts
  });

  it("the documented field list equals the input's real keys, and `changes` holds only role, key, before, after", async () => {
    const src = readFileSync("supabase/migrations/0356_roles_review_authority.sql", "utf8");
    const documented = /-- Fields: ([^\n]+)\./.exec(src)![1].split(", ").sort();
    const st = await studio();
    const input = (await adminQuery(`select public.perm_review_hash_input($1, 3, '[]'::jsonb, '[]'::jsonb, false, $2::jsonb) as i`, [st.studioId, JSON.stringify({ practitioner: [{ key: "k", before: "a", after: "b", sensitive: true }] })])).rows[0].i as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual(documented);
    expect((input.changes as Record<string, unknown>[]).map((c) => Object.keys(c).sort())).toEqual([["after", "before", "key", "role"]]);
  });

  it("a mismatch returns only the fixed code (no hash, no changes, no people), and a refusal carries no diff", async () => {
    const st = await seedStudio("review-authority-mismatch");
    await inTx(async (q) => {
      await asOwner(q, st.userId, async () => {
        const v = await version(q, st.studioId);
        const r = await call(q, "save_role_permissions_reviewed", [st.studioId, v, { practitioner: { [VIEW]: "off" } }, null, false, "0".repeat(64)]);
        expect(r).toMatchObject({ ok: false, code: "review_changed" });
        expect(Object.keys(r).sort()).toEqual(["code", "current_version", "message", "ok"].filter((k) => k in r).sort());
        expect(JSON.stringify(r)).not.toMatch(/changes|affected|people|review_hash|consequence|before|after/);
      });
    });
  });

  it("nothing changed between preview and save: a request WITH dependents (and one on a key everything requires) saves with the preview's hash", async () => {
    for (const requested of [{ [VIEW]: "off" }, { "appt.view_calendar": "off" }, { [VIEW]: "off", [EDIT]: "off" }, { [EDIT]: "off" }]) {
      const st = await seedStudio("review-authority-nochange");
      await inTx(async (q) => {
        await asOwner(q, st.userId, async () => {
          const v = await version(q, st.studioId);
          const ch = { practitioner: requested };
          const p = await call(q, "preview_role_changes_at", [st.studioId, ch, v]);
          if (!p.ok) return void expect(p.code, JSON.stringify(requested)).toBeDefined(); // a refusal the engine owns (for example nothing_changed); no hash to compare
          const again = await call(q, "preview_role_changes_at", [st.studioId, ch, v]);
          expect(again.review_hash, "a second preview of the same request is the same review").toBe(p.review_hash);
          const r = await call(q, "save_role_permissions_reviewed", [st.studioId, v, ch, null, false, p.review_hash]);
          expect(r.ok === true || r.code === "sensitive_unconfirmed" || r.code === "reason_required", JSON.stringify([requested, r])).toBe(true);
          expect(r.code, JSON.stringify(requested)).not.toBe("review_changed");
        });
      });
    }
  });

  it("two sessions: a reviewed save of a requested key makes the release of its DEPENDENT wait (the share locks cover dependents)", async () => {
    const st = await seedStudio("review-authority-dependent-lock");
    const ch = { practitioner: { [VIEW]: "off" } };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const holding = new Promise<void>((r) => (held = r));
    const tx1 = adminTx(async (q) => {
      await asOwner(q as Q, st.userId, async () => {
        const v = await version(q as Q, st.studioId);
        const p = await call(q as Q, "preview_role_changes_at", [st.studioId, ch, v]);
        expect((await call(q as Q, "save_role_permissions_reviewed", [st.studioId, v, ch, null, false, p.review_hash])).ok).toBe(true);
      });
      held();
      await gate;
      throw new Rollback();
    }).catch((e) => {
      if (!(e instanceof Rollback)) throw e;
    });
    await holding;
    let code: string | undefined;
    try {
      await adminTx(async (q) => {
        await q("set local lock_timeout = '400ms'");
        await q(`select public.mark_permissions_released(array[$1::text], 'T-dep-lock', 'full')`, [EDIT]);
      });
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    release();
    await tx1;
    expect(code).toBe("55P03");
    expect((await adminQuery(`select released_at from public.permission_key_release where key = $1`, [EDIT])).rows[0].released_at).toBeNull();
  });
});

describe("audit: a reviewed save records its review version and hash inside `after`, and nothing else is added", () => {
  it("reviewed save: after carries _review {version, hash}; the old save carries no _review", async () => {
    const st = await seedStudio("review-authority-audit");
    await inTx(async (q) => {
      await asOwner(q, st.userId, async () => {
        const v = await version(q, st.studioId);
        const ch = { practitioner: { "appt.cancel": "own" } };
        const p = await call(q, "preview_role_changes_at", [st.studioId, ch, v]);
        expect((await call(q, "save_role_permissions_reviewed", [st.studioId, v, ch, null, false, p.review_hash])).ok).toBe(true);
        const rows = (await adm(q, `select after, before from public.permission_audit where studio_id = $1 and kind = 'role_permissions_saved' order by id`, [st.studioId])).rows as { after: Record<string, unknown>; before: Record<string, unknown> }[];
        expect(rows).toHaveLength(1);
        expect(rows[0].after._review).toEqual({ version: v, hash: p.review_hash });
        expect(Object.keys(rows[0].after).sort()).toEqual(["_review", "appt.cancel"]);
        expect(rows[0].before).not.toHaveProperty("_review");
        const v2 = await version(q, st.studioId);
        expect((await call(q, "save_role_permissions", [st.studioId, v2, { practitioner: { "appt.cancel": "off" } }, null, false])).ok).toBe(true);
        const last = (await adm(q, `select after from public.permission_audit where studio_id = $1 and kind = 'role_permissions_saved' order by id desc limit 1`, [st.studioId])).rows[0].after as Record<string, unknown>;
        expect(last).not.toHaveProperty("_review");
      });
    });
  });
});

describe("the hash: algorithm, encoding, field list, determinism", () => {
  it("is sha256 over the UTF-8 of the canonical jsonb text of the fixed input, and the input has exactly the documented fields", async () => {
    const st = await studio();
    const review = [{ role: "practitioner", key: "appt.cancel", requested: "off" }];
    const input = (await adminQuery(`select public.perm_review_hash_input($1, 3, $2::jsonb, '["b","a"]'::jsonb, false, '{}'::jsonb) as i`, [st.studioId, JSON.stringify(review)])).rows[0].i as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual(["activations", "basis", "basis_at", "catalog", "changes", "gates", "releases", "review", "reason_required", "sensitive_keys", "studio", "v", "version"].sort());
    expect(input.sensitive_keys).toEqual(["a", "b"]); // sorted, not as given
    const hash = (await adminQuery(`select public.perm_review_hash($1, 3, $2::jsonb, '["b","a"]'::jsonb, false, '{}'::jsonb) as h`, [st.studioId, JSON.stringify(review)])).rows[0].h;
    const text = (await adminQuery(`select public.perm_review_hash_input($1, 3, $2::jsonb, '["b","a"]'::jsonb, false, '{}'::jsonb)::text as t`, [st.studioId, JSON.stringify(review)])).rows[0].t as string;
    expect(hash).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
    const again = (await adminQuery(`select public.perm_review_hash($1, 3, $2::jsonb, '["b","a"]'::jsonb, false, '{}'::jsonb) as h`, [st.studioId, JSON.stringify(review)])).rows[0].h;
    expect(again).toBe(hash);
    expect((await adminQuery(`select public.perm_review_hash($1, 4, $2::jsonb, '["b","a"]'::jsonb, false, '{}'::jsonb) as h`, [st.studioId, JSON.stringify(review)])).rows[0].h).not.toBe(hash);
  });

  it("a fixed example pins the exact encoding (no policy row, no involved keys)", async () => {
    const id = "00000000-0000-4000-8000-000000000356";
    const text = (await adminQuery(`select public.perm_review_hash_input($1, 5, '[]'::jsonb, '[]'::jsonb, false, '{}'::jsonb)::text as t`, [id])).rows[0].t as string;
    expect(text).toBe(
      '{"v": 1, "basis": null, "gates": [], "review": [], "studio": "00000000-0000-4000-8000-000000000356", "catalog": [], "changes": [], "version": 5, "basis_at": null, "releases": [], "activations": [], "sensitive_keys": [], "reason_required": false}',
    );
    expect((await adminQuery(`select public.perm_review_hash($1, 5, '[]'::jsonb, '[]'::jsonb, false, '{}'::jsonb) as h`, [id])).rows[0].h).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
  });

  it("covers the involved keys' catalog facts, release rows and the basis: changing any of them changes the hash", async () => {
    const st = await studio();
    const review = [{ role: "practitioner", key: "appt.cancel", requested: "off" }];
    const h = async (q: Q) => (await q(`select public.perm_review_hash($1, 3, $2::jsonb, '[]'::jsonb, false, '{}'::jsonb) as h`, [st.studioId, JSON.stringify(review)])).rows[0].h as string;
    await inTx(async (q) => {
      const base = await h(q);
      await q(`update public.permission_catalog set snapshot_practitioner = 'own' where key = 'appt.cancel'`);
      const afterCatalog = await h(q);
      expect(afterCatalog).not.toBe(base);
      await q(`select public.mark_permissions_released(array['appt.cancel'], 'T-hash', 'full')`);
      const afterRelease = await h(q);
      expect(afterRelease).not.toBe(afterCatalog);
      await q(`update public.studio_permission_policy set basis = 'existing_snapshot' where studio_id = $1`, [st.studioId]);
      const afterBasis = await h(q);
      expect(afterBasis).not.toBe(afterRelease);
      await q(`insert into public.permission_key_activation (studio_id, key, release_tag, activated_by, reason, policy_version) values ($1, 'appt.cancel', 'T-hash', $2, 'hash', 0)`, [st.studioId, st.userId]);
      expect(await h(q)).not.toBe(afterBasis); // an activation row changes the hash
      const g = async (sens: string, widen: boolean) => (await q(`select public.perm_review_hash($1, 3, $2::jsonb, $3::jsonb, $4, '{}'::jsonb) as h`, [st.studioId, JSON.stringify(review), sens, widen])).rows[0].h as string;
      expect(await g('["appt.cancel"]', false)).not.toBe(await g("[]", false)); // sensitive_keys
      expect(await g("[]", true)).not.toBe(await g("[]", false)); // reason_required
    });
  });
});

describe("grants and function settings", () => {
  const INTERNAL = [
    "public.perm_review_involved(text[])",
    "public.perm_review_timing(boolean, text, text, text, text, text, boolean, boolean)",
    "public.perm_review_hash_input(uuid, bigint, jsonb, jsonb, boolean, jsonb)",
    "public.perm_review_hash(uuid, bigint, jsonb, jsonb, boolean, jsonb)",
    "public.perm_run_changes_reviewed(uuid, jsonb, text, boolean, bigint, boolean, boolean, text)",
    "public.perm_run_changes(uuid, jsonb, text, boolean, bigint, boolean, boolean)",
  ];
  const COMMANDS = ["public.preview_role_changes_at(uuid, jsonb, bigint)", "public.save_role_permissions_reviewed(uuid, bigint, jsonb, text, boolean, text)"];

  it("internal functions: no API role holds EXECUTE and the ACL is exactly the owner's", async () => {
    for (const f of INTERNAL) {
      for (const role of ["anon", "authenticated", "service_role", "public"]) {
        const r = role === "public" ? `select has_function_privilege('public', '${f}'::regprocedure, 'execute') as ok` : `select has_function_privilege('${role}', '${f}'::regprocedure, 'execute') as ok`;
        expect((await adminQuery(r)).rows[0].ok, `${role} ${f}`).toBe(false);
      }
      expect((await adminQuery(`select proacl::text as a from pg_proc where oid = '${f}'::regprocedure`)).rows[0].a, f).toBe("{postgres=X/postgres}");
    }
  });

  it("the two commands are executable by authenticated only", async () => {
    for (const f of COMMANDS) {
      expect((await adminQuery(`select has_function_privilege('authenticated', '${f}'::regprocedure, 'execute') as ok`)).rows[0].ok, f).toBe(true);
      for (const role of ["anon", "service_role"]) expect((await adminQuery(`select has_function_privilege('${role}', '${f}'::regprocedure, 'execute') as ok`)).rows[0].ok, `${role} ${f}`).toBe(false);
      expect((await adminQuery(`select has_function_privilege('public', '${f}'::regprocedure, 'execute') as ok`)).rows[0].ok, `public ${f}`).toBe(false);
    }
  });

  it("every new function has an empty search_path, and every one but the pure timing function is SECURITY DEFINER", async () => {
    for (const f of [...INTERNAL, ...COMMANDS]) {
      const r = (await adminQuery(`select prosecdef, proconfig from pg_proc where oid = '${f}'::regprocedure`)).rows[0] as { prosecdef: boolean; proconfig: string[] | null };
      expect(r.proconfig, f).toContain('search_path=""');
      if (!f.includes("perm_review_timing")) expect(r.prosecdef, f).toBe(true);
    }
  });
});

describe("rollback", () => {
  it("restores the sealed 0355 body, drops every new function, and the old commands still work", async () => {
    const st = await studio();
    const down = readFileSync("supabase/rollbacks/0356_roles_review_authority.down.sql", "utf8")
      .replace(/^begin;$/m, "")
      .replace(/^commit;$/m, "");
    await inTx(async (q) => {
      await q(down);
      const md5 = (await q(`select md5(prosrc) as m from pg_proc where oid = 'public.perm_run_changes(uuid, jsonb, text, boolean, bigint, boolean, boolean)'::regprocedure`)).rows[0].m;
      expect(md5).toBe("4e65b638a84cfba3d24c1fc44b34daa0");
      for (const f of ["perm_review_involved", "perm_review_timing", "perm_review_hash_input", "perm_review_hash", "perm_run_changes_reviewed", "preview_role_changes_at", "save_role_permissions_reviewed"]) {
        expect(Number((await q(`select count(*) n from pg_proc where proname = $1 and pronamespace = 'public'::regnamespace`, [f])).rows[0].n), f).toBe(0);
      }
      expect((await q(`select proacl::text as a from pg_proc where oid = 'public.perm_run_changes(uuid, jsonb, text, boolean, bigint, boolean, boolean)'::regprocedure`)).rows[0].a).toBe("{postgres=X/postgres}");
      await asOwner(q, st.userId, async () => {
        const r = await call(q, "preview_role_changes", [st.studioId, { practitioner: { "appt.cancel": "off" } }]);
        expect(r.ok, JSON.stringify(r)).toBe(true);
      });
    });
  });
});

void randomUUID;
