import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// HON-77 (plan and goal closure). Part 1 characterizes the goal save as it behaves TODAY (named so a later fix flips a test on purpose). Part 2 is a
// binding source guard: a visit count never closes a plan, advances a stage, or marks a goal reached.
type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({ goals: new Map<string, Row>(), practitioner: "prac-A" }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({ practitioner: { id: state.practitioner }, studio: { id: "s1" } }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from(table: string) {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () => Promise.resolve({ data: { id: "c1" }, error: null }),
        upsert: (row: Row, opts: { onConflict: string }) => {
          if (table === "treatment_goals") state.goals.set(String(row[opts.onConflict]), { ...(state.goals.get(String(row[opts.onConflict])) ?? {}), ...row });
          return Promise.resolve({ error: null });
        },
      };
      return chain;
    },
  }),
}));

const form = (status: string) => {
  const f = new FormData();
  f.set("client_id", "c1");
  f.set("estimated_hours", "10");
  f.set("status", status);
  return f;
};
beforeEach(() => {
  state.goals.clear();
  state.practitioner = "prac-A";
});

describe("goal save (today's behaviour)", () => {
  it("there is ONE goal row per client: a second save updates it in place instead of adding a row", async () => {
    const { upsertTreatmentGoalAction } = await import("@/app/(app)/clients/[id]/treatment-time-actions");
    await upsertTreatmentGoalAction(form("active"));
    await upsertTreatmentGoalAction(form("revised"));
    expect(state.goals.size).toBe(1);
  });

  it("created_by is REWRITTEN to whoever saved last, so the original author is lost", async () => {
    const { upsertTreatmentGoalAction } = await import("@/app/(app)/clients/[id]/treatment-time-actions");
    await upsertTreatmentGoalAction(form("active"));
    expect(state.goals.get("c1")?.created_by).toBe("prac-A");
    state.practitioner = "prac-B";
    await upsertTreatmentGoalAction(form("active"));
    expect(state.goals.get("c1")?.created_by).toBe("prac-B");
  });

  it("a goal marked reached can be set back to active and nothing records that it was ever reached", async () => {
    const { upsertTreatmentGoalAction } = await import("@/app/(app)/clients/[id]/treatment-time-actions");
    await upsertTreatmentGoalAction(form("reached"));
    expect(state.goals.get("c1")?.status).toBe("reached");
    await upsertTreatmentGoalAction(form("active"));
    const row = state.goals.get("c1") as Row;
    expect(row.status).toBe("active");
    expect(Object.keys(row).filter((k) => /history|reached_at|previous|audit/i.test(k))).toEqual([]);
  });

  it("an unknown status value is stored as 'active', never as an outcome", async () => {
    const { upsertTreatmentGoalAction } = await import("@/app/(app)/clients/[id]/treatment-time-actions");
    await upsertTreatmentGoalAction(form("completed"));
    expect(state.goals.get("c1")?.status).toBe("active");
  });
});

// --- Part 2: binding source guard -------------------------------------------------------------------------------------------------------------------
const ROOT = path.resolve(__dirname, "../../..");
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}
const SOURCES = ["app", "lib"].flatMap((d) => walk(path.join(ROOT, d)));
const code = (f: string) => readFileSync(f, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const rel = (f: string) => path.relative(ROOT, f);
const ACTIONS = "app/(app)/clients/[id]/treatment-plans-actions.ts";
function fnBody(src: string, name: string): string {
  const m = new RegExp(`export async function ${name}\\b`).exec(src);
  if (!m) throw new Error(`${name} not found`);
  const rest = src.slice(m.index + 1);
  const next = rest.search(/\nexport (async )?function /);
  return next === -1 ? rest : rest.slice(0, next);
}

describe("a visit count never closes or advances anything (binding)", () => {
  it("the scan really sees the source and the actions file (not vacuous)", () => {
    expect(SOURCES.length).toBeGreaterThan(300);
    expect(SOURCES.map(rel)).toContain(ACTIONS);
  });

  it("outside the plan actions file, no file that mentions suggested_visit_count also writes (update, upsert, insert, rpc)", () => {
    const offenders = SOURCES.filter((f) => rel(f) !== ACTIONS && /suggested_visit_count/.test(code(f)) && /\.(update|upsert|insert|rpc)\(/.test(code(f))).map(rel);
    expect(offenders).toEqual([]);
  });

  it("only the plan actions file sets a plan to closed, and only the goal action sets a goal outcome", () => {
    const closers = SOURCES.filter((f) => /from\("treatment_plans"\)[\s\S]{0,200}status:\s*"closed"/.test(code(f))).map(rel);
    expect(closers).toEqual([ACTIONS]);
    const goalWriters = SOURCES.filter((f) => /from\("treatment_goals"\)[\s\S]{0,120}\.(upsert|update|insert)\(/.test(code(f))).map(rel);
    expect(goalWriters).toEqual(["app/(app)/clients/[id]/treatment-time-actions.ts"]);
  });

  it("the close action, the stage actions and the goal action never read a visit count", () => {
    const actions = code(path.join(ROOT, ACTIONS));
    for (const fn of ["closeTreatmentPlanAction", "updateTreatmentPlanStageAction", "createTreatmentPlanStageAction", "deleteTreatmentPlanStageAction", "attachChartEntryToPlanAction", "detachChartEntryFromPlanAction"]) {
      expect(fnBody(actions, fn), fn).not.toMatch(/suggested_visit_count|visit_count|sessionCount|\{\s*count:\s*"exact"/);
    }
    expect(code(path.join(ROOT, "app/(app)/clients/[id]/treatment-time-actions.ts"))).not.toMatch(/suggested_visit_count|visit_count|sessionCount/);
  });

  // The database side. Today NO migration puts a trigger on treatment_plans and none updates a plan to closed, so no database object can close a plan from
  // a count. A future one has to be added to this list deliberately. (The scan strips comment lines and joins statements, so formatting cannot hide a match.)
  it("no migration creates a trigger on treatment_plans or updates a plan to closed", () => {
    const dir = path.join(ROOT, "supabase/migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql"));
    expect(files.length).toBeGreaterThan(200);
    const flat = (f: string) => readFileSync(path.join(dir, f), "utf8").split("\n").filter((l) => !/^\s*--/.test(l)).join(" ");
    const mentions = files.filter((f) => /treatment_plans\b/i.test(flat(f)));
    expect(mentions.length).toBeGreaterThan(5); // the scan reaches the files that name the table
    const triggers = files.filter((f) => /create\s+(or\s+replace\s+)?trigger\s+[\w"]+[^;]{0,200}\bon\s+(public\.)?treatment_plans\b/i.test(flat(f)));
    const closers = files.filter((f) => /update\s+(public\.)?treatment_plans\b[^;]{0,300}['"]closed['"]/i.test(flat(f)));
    expect({ triggers, closers }).toEqual({ triggers: [], closers: [] });
  });

  // Stated bound: the source scans above match the double-quote spelling `status: "closed"` and the `from("table")` call shape. A different spelling (single
  // quotes, a helper that hides the table name) would escape them, which is why the action-body checks and the migration scan also exist.
});
