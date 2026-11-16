import { afterAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { adminQuery, adminTx, closePool, seedMember, seedStudio, type SeededStudio } from "./helpers/harness";

// 0356: ONE review table, built by the database, for the exact policy version a save will check. Synthetic data. Anything that releases a key or
// writes inside a transaction below is rolled back (releasing is operator-only and must never persist on a shared stack).
afterAll(async () => {
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
    await q("reset role");
  }
}
const call = async (q: Q, fn: string, args: unknown[]): Promise<Result> =>
  (await q(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0].r as Result;
const version = async (q: Q, studioId: string) =>
  Number((await q(`select version from public.studio_permission_policy where studio_id = $1`, [studioId])).rows[0]?.version ?? 0);
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
      await asOwner(q, st.userId, async () => {
        for (const c of cases) {
          const a = (await q(`select public.zz_run_changes_0355($1, $2, null, false, null, false, false) as r`, [st.studioId, c])).rows[0].r;
          const b = (await q(`select public.perm_run_changes($1, $2, null, false, null, false, false) as r`, [st.studioId, c])).rows[0].r;
          expect(b, JSON.stringify(c)).toEqual(a);
        }
      });
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
          const stored = (await q(`select scope from public.studio_role_permissions where studio_id = $1 and role = $2 and key = $3`, [st.studioId, row.role, row.key])).rows[0]?.scope ?? null;
          expect(stored, `${row.role}:${row.key}`).toBe(row.stored_after);
          const eff = (await q(`select public.perm_effective_map($1, $2) as m`, [st.studioId, row.role])).rows[0].m as Record<string, string>;
          expect(eff[row.key], `${row.role}:${row.key}`).toBe(row.effective_after);
        }
      });
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// D1/D2/G6: the timing label is derived independently here from the prose rules, and checked against what the real engine does after release.
// ---------------------------------------------------------------------------------------------------------------------------------------------
type Facts = { released: boolean; kind: "narrow" | "full"; active: boolean; snapshot: string; requested: string; effectiveAfter: string; written: boolean };
function expectedTiming(f: Facts): string {
  if (!f.written) return "no_change";
  if (!f.released) return rank(f.requested) < rank(f.snapshot) ? "at_release" : "not_released";
  if (f.kind === "narrow") {
    if (rank(f.requested) > rank(f.snapshot)) return "waits_for_later_full_release";
    return f.effectiveAfter === f.requested ? "in_force_now" : "capped";
  }
  if (f.effectiveAfter === f.requested) return "in_force_now";
  if (rank(f.effectiveAfter) < rank(f.requested)) {
    return !f.active && rank(f.requested) > rank(f.snapshot) && rank(f.effectiveAfter) <= rank(f.snapshot) ? "waits_for_activation" : "capped";
  }
  return "in_force_now";
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
                    expectedTiming({ released: kind !== "unreleased", kind: kind === "narrow" ? "narrow" : "full", active, snapshot, requested, effectiveAfter: row.effective_after, written: row.written }),
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
                      if (row.timing === "not_released") expect(released, `${label} after ${relKind} release`).toBe(snapshot);
                    }
                  } else if (row.timing === "in_force_now") expect(now, label).toBe(requested);
                  else if (row.timing === "waits_for_later_full_release" || row.timing === "waits_for_activation") expect(rank(now), label).toBeLessThanOrEqual(rank(snapshot));
                });
              });
            }
          }
        }
      }
    }
    // the matrix reaches the labels that a save can produce
    for (const must of ["at_release", "not_released", "in_force_now", "waits_for_later_full_release", "no_change"]) expect([...seen], `reached ${must}`).toContain(must);
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
        expect(Number((await q(`select count(*) n from public.studio_role_permissions where studio_id = $1`, [st.studioId])).rows[0].n)).toBe(0);
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
        expect(Number((await q(`select count(*) n from public.studio_role_permissions where studio_id = $1`, [st.studioId])).rows[0].n)).toBe(0);
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

describe("audit: a reviewed save records its review version and hash inside `after`, and nothing else is added", () => {
  it("reviewed save: after carries _review {version, hash}; the old save carries no _review", async () => {
    const st = await seedStudio("review-authority-audit");
    await inTx(async (q) => {
      await asOwner(q, st.userId, async () => {
        const v = await version(q, st.studioId);
        const ch = { practitioner: { "appt.cancel": "own" } };
        const p = await call(q, "preview_role_changes_at", [st.studioId, ch, v]);
        expect((await call(q, "save_role_permissions_reviewed", [st.studioId, v, ch, null, false, p.review_hash])).ok).toBe(true);
        const rows = (await q(`select after, before from public.permission_audit where studio_id = $1 and kind = 'role_permissions_saved' order by id`, [st.studioId])).rows as { after: Record<string, unknown>; before: Record<string, unknown> }[];
        expect(rows).toHaveLength(1);
        expect(rows[0].after._review).toEqual({ version: v, hash: p.review_hash });
        expect(Object.keys(rows[0].after).sort()).toEqual(["_review", "appt.cancel"]);
        expect(rows[0].before).not.toHaveProperty("_review");
        const v2 = await version(q, st.studioId);
        expect((await call(q, "save_role_permissions", [st.studioId, v2, { practitioner: { "appt.cancel": "off" } }, null, false])).ok).toBe(true);
        const last = (await q(`select after from public.permission_audit where studio_id = $1 and kind = 'role_permissions_saved' order by id desc limit 1`, [st.studioId])).rows[0].after as Record<string, unknown>;
        expect(last).not.toHaveProperty("_review");
      });
    });
  });
});

describe("the hash: algorithm, encoding, field list, determinism", () => {
  it("is sha256 over the UTF-8 of the canonical jsonb text of the fixed input, and the input has exactly the documented fields", async () => {
    const st = await studio();
    const review = [{ role: "practitioner", key: "appt.cancel", requested: "off" }];
    const input = (await adminQuery(`select public.perm_review_hash_input($1, 3, $2::jsonb, '["b","a"]'::jsonb, false) as i`, [st.studioId, JSON.stringify(review)])).rows[0].i as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual(["activations", "basis", "basis_at", "catalog", "gates", "releases", "review", "reason_required", "sensitive_keys", "studio", "v", "version"].sort());
    expect(input.sensitive_keys).toEqual(["a", "b"]); // sorted, not as given
    const hash = (await adminQuery(`select public.perm_review_hash($1, 3, $2::jsonb, '["b","a"]'::jsonb, false) as h`, [st.studioId, JSON.stringify(review)])).rows[0].h;
    const text = (await adminQuery(`select public.perm_review_hash_input($1, 3, $2::jsonb, '["b","a"]'::jsonb, false)::text as t`, [st.studioId, JSON.stringify(review)])).rows[0].t as string;
    expect(hash).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
    const again = (await adminQuery(`select public.perm_review_hash($1, 3, $2::jsonb, '["b","a"]'::jsonb, false) as h`, [st.studioId, JSON.stringify(review)])).rows[0].h;
    expect(again).toBe(hash);
    expect((await adminQuery(`select public.perm_review_hash($1, 4, $2::jsonb, '["b","a"]'::jsonb, false) as h`, [st.studioId, JSON.stringify(review)])).rows[0].h).not.toBe(hash);
  });

  it("a fixed example pins the exact encoding (no policy row, no involved keys)", async () => {
    const id = "00000000-0000-4000-8000-000000000356";
    const text = (await adminQuery(`select public.perm_review_hash_input($1, 5, '[]'::jsonb, '[]'::jsonb, false)::text as t`, [id])).rows[0].t as string;
    expect(text).toBe(
      '{"v": 1, "basis": null, "gates": [], "studio": "00000000-0000-4000-8000-000000000356", "review": [], "catalog": [], "version": 5, "basis_at": null, "releases": [], "activations": [], "sensitive_keys": [], "reason_required": false}',
    );
    expect((await adminQuery(`select public.perm_review_hash($1, 5, '[]'::jsonb, '[]'::jsonb, false) as h`, [id])).rows[0].h).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
  });

  it("covers the involved keys' catalog facts, release rows and the basis: changing any of them changes the hash", async () => {
    const st = await studio();
    const review = [{ role: "practitioner", key: "appt.cancel", requested: "off" }];
    const h = async (q: Q) => (await q(`select public.perm_review_hash($1, 3, $2::jsonb, '[]'::jsonb, false) as h`, [st.studioId, JSON.stringify(review)])).rows[0].h as string;
    await inTx(async (q) => {
      const base = await h(q);
      await q(`update public.permission_catalog set snapshot_practitioner = 'own' where key = 'appt.cancel'`);
      const afterCatalog = await h(q);
      expect(afterCatalog).not.toBe(base);
      await q(`select public.mark_permissions_released(array['appt.cancel'], 'T-hash', 'full')`);
      const afterRelease = await h(q);
      expect(afterRelease).not.toBe(afterCatalog);
      await q(`update public.studio_permission_policy set basis = 'new_studio' where studio_id = $1`, [st.studioId]);
      expect(await h(q)).not.toBe(afterRelease);
    });
  });
});

describe("grants and function settings", () => {
  const INTERNAL = [
    "public.perm_review_involved(text[])",
    "public.perm_review_timing(boolean, text, text, text, text, boolean, boolean)",
    "public.perm_review_hash_input(uuid, bigint, jsonb, jsonb, boolean)",
    "public.perm_review_hash(uuid, bigint, jsonb, jsonb, boolean)",
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
