import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { countVersion, isRepoMax, versionsAbove } from "./helpers/migration-state";

// 0181 — multi-studio command authority. STATIC contract.
//
// Behaviour is proved against a real database in
// tests/db/multi-studio-session-authority.db.test.ts. This file pins what a
// behavioural test cannot see: what the migration must contain, what it must
// never contain, and — the reason this migration exists — that NO SECURITY
// DEFINER command anywhere in the chain still resolves an acting studio from
// auth.uid() with an unconstrained LIMIT 1.

const ROOT = join(__dirname, "..", "..");
const FILE = "supabase/migrations/0181_multi_studio_command_authority.sql";
const SQL = readFileSync(join(ROOT, FILE), "utf8");

// EXECUTABLE SQL ONLY — line comments stripped. The header deliberately QUOTES
// the removed unsafe query, so a raw-text assertion would fail on the very
// prose documenting the defect.
const EXEC = SQL.split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

describe("0181 — migration state", () => {
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

describe("0181 — production truth: AUTHORED, NOT YET APPLIED", () => {
  const rec = JSON.parse(
    readFileSync(join(ROOT, "docs/production/migration-state.json"), "utf8"),
  );

  // The migration-first rollout has not run. This is the EXPECTED pre-apply
  // state and it is asserted, not tolerated: hosted must still read 0180 so
  // nobody can claim parity before the apply record is written.
  it("hosted max is still 0180 — 0181 is pending", () => {
    expect(rec.hosted_migration_max).toBe("0180");
  });

  it("repo is ahead of hosted by exactly this migration", () => {
    expect(isRepoMax("0181")).toBe(true);
    expect(Number.parseInt(rec.hosted_migration_max, 10)).toBe(180);
  });
});

describe("0181 — transaction envelope", () => {
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

describe("0181 — the defect is removed, not reordered", () => {
  it("contains NO unconstrained active-membership LIMIT 1", () => {
    // The exact 0167 shape: practitioners by auth.uid() + active, then LIMIT 1,
    // with no studio predicate in between. Adding `order by` would NOT satisfy
    // this — there is no correct ordering rule, which is the whole point.
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

describe("0181 — explicit studio command", () => {
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

describe("0181 — legacy compatibility wrapper", () => {
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

describe("0181 — privileges", () => {
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

describe("0181 — no data migration", () => {
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
