import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { countVersion, isRepoMax, versionsAbove } from "./helpers/migration-state";

// 0181: multi-studio command authority. STATIC contract.
//
// Behaviour is proved against a real database in
// tests/db/multi-studio-session-authority.db.test.ts. This file pins what a
// behavioural test cannot see: what the migration must contain, what it must
// never contain, and that NO SECURITY DEFINER command anywhere in the chain
// still resolves an acting studio from auth.uid() with an unconstrained
// LIMIT 1. That last point is the reason this migration exists.

const ROOT = join(__dirname, "..", "..");
const FILE = "supabase/migrations/0181_multi_studio_command_authority.sql";
const SQL = readFileSync(join(ROOT, FILE), "utf8");

// EXECUTABLE SQL ONLY: line comments stripped. The header deliberately QUOTES
// the removed unsafe query, so a raw-text assertion would fail on the very
// prose documenting the defect.
const EXEC = SQL.split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

describe("0181: migration state", () => {
  it("is the current repository maximum and consumes exactly one number", () => {
    expect(isRepoMax("0181")).toBe(true);
    expect(versionsAbove("0181")).toEqual([]);
    expect(countVersion("0181")).toBe(1);
  });

  it("leaves 0182 free", () => {
    expect(countVersion("0182")).toBe(0);
  });

  it("never reintroduces 0158, which is permanently skipped", () => {
    expect(countVersion("0158")).toBe(0);
  });
});

describe("0181, production truth: APPLIED (CURRENT STATE, moves on the next apply)", () => {
  const rec = JSON.parse(
    readFileSync(join(ROOT, "docs/production/migration-state.json"), "utf8"),
  );

  // THE HAND-OFF HAPPENED. This block previously asserted the PRE-APPLY state
  // (hosted still 0180, 0181 pending) and was written to go red the moment the
  // rollout ran, so the apply could not be recorded without updating the
  // canonical hosted-state record in the same change. The migration-first
  // rollout completed on 2026-08-13: 0181 was pushed to the linked production
  // project BEFORE #573 was merged, and the old application was verified
  // healthy against the new database in between.
  it("is applied: hosted max is 0181", () => {
    expect(rec.hosted_migration_max).toBe("0181");
  });

  it("repo and hosted agree, with nothing pending", () => {
    expect(isRepoMax("0181")).toBe(true);
    expect(versionsAbove("0181")).toEqual([]);
    expect(Number.parseInt(rec.hosted_migration_max, 10)).toBe(181);
  });
});

describe("0181: transaction envelope", () => {
  it("opens its own transaction and arms lock_timeout INSIDE it", () => {
    const lines = SQL.split("\n").map((l) => l.trim()).filter(Boolean);
    const begin = lines.findIndex((l) => l === "begin;");
    const lock = lines.findIndex((l) => l.startsWith("set local lock_timeout"));
    const commit = lines.findIndex((l) => l === "commit;");
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(lock).toBeGreaterThan(begin);
    expect(commit).toBeGreaterThan(lock);
  });
});

describe("0181: the defect is removed, not reordered", () => {
  it("contains NO unconstrained active-membership LIMIT 1", () => {
    // The exact 0167 shape: practitioners by auth.uid() + active, then LIMIT 1,
    // with no studio predicate in between. Adding `order by` would NOT satisfy
    // this, there is no correct ordering rule, which is the whole point.
    const unconstrained =
      /from\s+public\.practitioners[\s\S]{0,200}?limit\s+1/gi;
    for (const m of EXEC.matchAll(unconstrained)) {
      expect(m[0]).toMatch(/studio_id\s*=/i);
    }
  });

  it("never resolves a studio by ordering memberships", () => {
    expect(EXEC).not.toMatch(/order\s+by\s+p\.(created_at|role|id)/i);
  });
});

describe("0181: explicit studio command", () => {
  it("declares the five-argument signature with p_studio_id", () => {
    expect(EXEC).toMatch(
      /create\s+or\s+replace\s+function\s+public\.start_session\([^)]*p_studio_id\s+uuid[^)]*\)/i,
    );
  });

  it("gives p_studio_id NO default, so PostgREST can never see two candidates", () => {
    // A default would let a four-key payload match both overloads (PGRST203).
    expect(EXEC).not.toMatch(/p_studio_id\s+uuid\s+default/i);
  });

  it("re-proves active membership through the studio-scoped actor helper", () => {
    expect(EXEC).toMatch(/session_actor_practitioner\(\s*v_studio_id\s*\)/);
  });

  it("refuses a null studio rather than picking one", () => {
    expect(EXEC).toMatch(/if\s+p_studio_id\s+is\s+null\s+then[\s\S]{0,200}raise\s+exception/i);
  });

  it("keeps every 0167 invariant it must not weaken", () => {
    expect(EXEC).toMatch(/Client not found in this studio\./);
    expect(EXEC).toMatch(/Appointment is not in your studio\./);
    expect(EXEC).toMatch(/Appointment is for a different client\./);
    expect(EXEC).toMatch(/Appointment is assigned to a different practitioner\./);
    expect(EXEC).toMatch(/Unsupported session modality\./);
    // Coalesce window still takes the row FOR UPDATE, keyed on the studio.
    expect(EXEC).toMatch(/for update/i);
    expect(EXEC).toMatch(/s\.studio_id\s*=\s*v_studio_id/);
    // Electrolysis-only exactly-one-active-plan auto-attach survives.
    expect(EXEC).toMatch(/v_plan_count\s*=\s*1/);
  });

  it("is SECURITY DEFINER with an empty search_path and fully-qualified relations", () => {
    const definers = EXEC.match(/security\s+definer/gi) ?? [];
    const paths = EXEC.match(/set\s+search_path\s*=\s*''/gi) ?? [];
    expect(definers.length).toBeGreaterThanOrEqual(2);
    expect(paths.length).toBe(definers.length);
    // No bare table references inside the bodies.
    expect(EXEC).not.toMatch(/\bfrom\s+(clients|sessions|practitioners|appointments|treatment_plans)\b/);
  });

  it("never accepts a practitioner id from the caller", () => {
    expect(EXEC).not.toMatch(/p_practitioner_id/);
  });
});

describe("0181: legacy compatibility wrapper", () => {
  it("retains the four-argument signature for the migration→deploy window", () => {
    expect(EXEC).toMatch(
      /create\s+or\s+replace\s+function\s+public\.start_session\(\s*p_client_id\s+uuid,\s*p_modality\s+text,\s*p_appointment_id\s+uuid,\s*p_coalesce_minutes\s+integer\s*\)/i,
    );
  });

  it("derives the studio from the CLIENT plus an active membership, never a pick", () => {
    expect(EXEC).toMatch(/select\s+c\.studio_id\s+into\s+v_studio_id/i);
    expect(EXEC).toMatch(/on\s+p\.studio_id\s*=\s*c\.studio_id/i);
    expect(EXEC).toMatch(/p\.active\s*=\s*true/i);
  });

  it("delegates into the explicit command instead of copying the body", () => {
    // One implementation. The wrapper must not re-declare the insert.
    const inserts = EXEC.match(/insert\s+into\s+public\.sessions/gi) ?? [];
    expect(inserts.length).toBe(1);
    expect(EXEC).toMatch(/from\s+public\.start_session\([\s\S]{0,200}v_studio_id/);
  });
});

describe("0181: privileges", () => {
  const SIGS = [
    "public.start_session(uuid, text, uuid, integer, uuid)",
    "public.start_session(uuid, text, uuid, integer)",
  ];

  it("revokes EXECUTE from public, anon and service_role on BOTH signatures", () => {
    // CREATE OR REPLACE re-applies Supabase's default grants, so both must be
    // restated. 0129 leaked `anon`; 0164 left `service_role`.
    for (const sig of SIGS) {
      for (const role of ["public", "anon", "service_role", "authenticated"]) {
        expect(EXEC).toContain(`revoke execute on function ${sig} from ${role};`);
      }
    }
  });

  it("grants EXECUTE only to authenticated", () => {
    for (const sig of SIGS) {
      expect(EXEC).toContain(`grant execute on function ${sig} to authenticated;`);
    }
    expect(EXEC).not.toMatch(/grant execute on function public\.start_session[^;]*to (anon|service_role|public);/i);
  });
});

describe("0181: no data migration", () => {
  it("performs no table DDL, no backfill and no row mutation", () => {
    expect(EXEC).not.toMatch(/\balter\s+table\b/i);
    expect(EXEC).not.toMatch(/\bcreate\s+table\b/i);
    expect(EXEC).not.toMatch(/\bdrop\s+table\b/i);
    expect(EXEC).not.toMatch(/\btruncate\b/i);
    // The only UPDATE is the 0167 appointment-link promotion inside the command.
    const updates = EXEC.match(/\bupdate\s+public\.\w+/gi) ?? [];
    expect(updates).toEqual(["update public.sessions"]);
    // No top-level DML against tables.
    expect(EXEC).not.toMatch(/\bdelete\s+from\b/i);
  });

  it("never touches snapshot_appointment_buffer (standing prohibition)", () => {
    expect(SQL).not.toMatch(/snapshot_appointment_buffer/);
  });
});

// ---------------------------------------------------------------------------
// CHAIN-WIDE CENSUS GUARD.
//
// The reason this class of bug survived from 0167 to a production P1 is that
// nothing asserted its absence. This walks EVERY migration and fails if any
// actor resolution keyed on auth.uid() reaches a LIMIT 1 without a studio
// predicate first, with an explicit allow-list of the historical files whose
// later migrations already superseded them.
// ---------------------------------------------------------------------------
describe("chain census: no unconstrained actor LIMIT 1 survives", () => {
  // Files whose unsafe text is SUPERSEDED by a later migration. Applied
  // migrations are frozen, so the historical bytes stay; the LIVE function is
  // what matters and is proved in tests/db/.
  const SUPERSEDED: Record<string, string> = {
    // treatment_image_actor(): replaced by the studio-scoped
    // treatment_image_actor(p_studio_id uuid) in 0178.
    "0168_treatment_image_write_commands.sql": "0178",
    // start_session 4-arg: replaced by this migration.
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

  it("names why each superseded file is exempt", () => {
    // A bare allow-list rots. This pins that the superseding migration exists.
    for (const [file, by] of Object.entries(SUPERSEDED)) {
      expect(readdirSync(join(ROOT, "supabase/migrations")).some((f) => f.startsWith(by))).toBe(
        true,
      );
      expect(readFileSync(join(ROOT, "supabase/migrations", file), "utf8")).toContain(
        "practitioners",
      );
    }
  });
});

describe("0181: coalesce atomicity is actually closed", () => {
  // 0167 claimed `for update` closed the read-then-insert race. It does not
  // when the coalesce window is EMPTY, `for update` locks rows, and an empty
  // result set locks nothing, so two overlapping FIRST taps both inserted.
  // Raised by Codex on PR #573; proved with two real connections in
  // tests/db/multi-studio-session-start-concurrency.db.test.ts, where removing
  // the lock yields 2 sessions instead of 1.
  it("serializes the coalesce identity with a transaction-scoped advisory lock", () => {
    expect(EXEC).toMatch(/pg_catalog\.pg_advisory_xact_lock\(/);
    // Keyed on the coalesce dimensions, not on something coarser.
    const at = EXEC.indexOf("pg_advisory_xact_lock");
    const key = EXEC.slice(at, EXEC.indexOf(");", at));
    expect(key).toMatch(/v_studio_id/);
    expect(key).toMatch(/p_client_id/);
    expect(key).toMatch(/v_practitioner/);
    expect(key).toMatch(/p_modality/);
  });

  it("takes the lock AFTER authority is proven and BEFORE the lookup", () => {
    const actor = EXEC.indexOf("session_actor_practitioner(v_studio_id)");
    const clientCheck = EXEC.indexOf("Client not found in this studio.");
    const lock = EXEC.indexOf("pg_advisory_xact_lock");
    const lookup = EXEC.indexOf("for update");
    expect(actor).toBeGreaterThan(-1);
    // An unauthenticated or non-member caller must never make the database
    // take a lock on its behalf.
    expect(lock).toBeGreaterThan(actor);
    expect(lock).toBeGreaterThan(clientCheck);
    expect(lock).toBeLessThan(lookup);
  });

  it("is transaction-scoped, so it cannot leak across a pooled connection", () => {
    expect(EXEC).not.toMatch(/pg_advisory_lock\(/); // session-scoped variant
    expect(EXEC).not.toMatch(/pg_advisory_unlock/); // nothing to release by hand
  });

  it("pg_catalog-qualifies the lock helpers, because search_path is empty", () => {
    expect(EXEC).toMatch(/pg_catalog\.pg_advisory_xact_lock/);
    expect(EXEC).toMatch(/pg_catalog\.hashtextextended/);
  });
});
