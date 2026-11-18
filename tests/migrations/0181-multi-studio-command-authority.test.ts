import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// 0181 — multi-studio command authority. Behaviour is proved against a real
// database in tests/db/multi-studio-session-authority.db.test.ts. This file
// keeps the chain census: no migration, including any future one, resolves an
// acting studio from auth.uid() with an unconstrained LIMIT 1.

const ROOT = join(__dirname, "..", "..");

// ---------------------------------------------------------------------------
// CHAIN-WIDE CENSUS GUARD.
//
// The reason this class of bug survived from 0167 to a production P1 is that
// nothing asserted its absence. This walks EVERY migration and fails if any
// actor resolution keyed on auth.uid() reaches a LIMIT 1 without a studio
// predicate first — with an explicit allow-list of the historical files whose
// later migrations already superseded them.
// ---------------------------------------------------------------------------
describe("chain census — no unconstrained actor LIMIT 1 survives", () => {
  // Files whose unsafe text is SUPERSEDED by a later migration. Applied
  // migrations are frozen, so the historical bytes stay; the LIVE function is
  // what matters and is proved in tests/db/.
  const SUPERSEDED: Record<string, string> = {
    // treatment_image_actor() — replaced by the studio-scoped
    // treatment_image_actor(p_studio_id uuid) in 0178.
    "0168_treatment_image_write_commands.sql": "0178",
    // start_session 4-arg — replaced by this migration.
    "0167_session_write_commands.sql": "0181",
  };

  it("finds no unconstrained resolver outside the superseded allow-list", () => {
    const dir = join(ROOT, "supabase/migrations");
    const offenders: string[] = [];
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      const text = readFileSync(join(dir, f), "utf8")
        .split("\n")
        .map((l) => l.replace(/--.*$/, ""))
        .join("\n");
      for (const m of text.matchAll(
        /from\s+public\.practitioners[\s\S]{0,220}?limit\s+1/gi,
      )) {
        const blk = m[0];
        if (!/auth\.uid\(\)|p_actor_user_id|v_uid/.test(blk)) continue;
        if (/studio_id\s*=/i.test(blk)) continue;
        if (/count\s*\(/i.test(blk)) continue; // membership counts are not picks
        if (f in SUPERSEDED) continue;
        offenders.push(`${f}: ${blk.replace(/\s+/g, " ").slice(0, 120)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
