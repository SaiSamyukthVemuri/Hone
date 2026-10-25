import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { captureConsole } from "../../lib/sms/helpers/log-capture";
import { classifyDbFailure, userFacingDbFailure } from "@/lib/logging/user-facing-db-failure";

// MSG-LOG-RAW-ERROR (F3). Server actions that RETURN a failure to the page
// must not put a database error's text in the result. Eleven sites across
// treatment-plans-actions.ts and settings/data/actions.ts. Every case below
// feeds a fake error whose message, details and hint all carry synthetic text
// (an address, a phone number, a constraint name and an
// "invalid input syntax ... \"<value>\"" sentence) and asserts none of it
// reaches the returned result or the log; known SQLSTATEs keep a distinct
// fixed sentence. Synthetic values only.

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const EMAIL = "leak.probe@example.test";
const HOSTILE = `invalid input syntax for type uuid: "${EMAIL}" +1 555 010 0199 violates constraint "clients_email_key"`;
const LEAKS = ["leak.probe", "example.test", "555 010", "5550100199", "clients_email_key", "invalid input syntax"];

type Hostile = { code?: string; message: string; details: string; hint: string };
const hostile = (code?: string): Hostile => ({ code, message: HOSTILE, details: HOSTILE, hint: HOSTILE });

// A scripted, chainable stand-in for the user-scoped Supabase client. Every
// builder method returns the same proxy; awaiting it (or .single/.maybeSingle)
// answers from the script, which sees the table and the first verb used.
type Answer = { data: unknown; error: Hostile | null };
const world = vi.hoisted(() => ({
  script: (_table: string, _verb: string): { data: unknown; error: unknown } => ({ data: null, error: null }),
}));

function makeClient() {
  return {
    from(table: string) {
      let verb = "select";
      let selected = "id";
      const answer = () => Promise.resolve(world.script(table, verb));
      const proxy: unknown = new Proxy(function () {}, {
        get(_t, prop: string) {
          if (prop === "then") return (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => answer().then(res, rej);
          if (prop === "single" || prop === "maybeSingle") return () => answer();
          // The export reads the executed select off the built request (provenance).
          if (prop === "url") return { searchParams: new URLSearchParams({ select: selected }) };
          return (..._a: unknown[]) => {
            if (prop === "insert" || prop === "update" || prop === "delete" || prop === "upsert") verb = prop;
            if (prop === "select" && typeof _a[0] === "string") selected = _a[0].replace(/\s+/g, "");
            return proxy;
          };
        },
      });
      return proxy;
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => makeClient() }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { id: "pr1", role: "owner", active: true },
    studio: { id: "s1", name: "Willow Studio" },
  }),
}));

let logs: ReturnType<typeof captureConsole>;
beforeEach(() => {
  logs = captureConsole();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function expectNoLeak(result: unknown, text = logs.text()) {
  const out = JSON.stringify(result);
  for (const leak of LEAKS) {
    expect(out, `result carries "${leak}"`).not.toContain(leak);
    expect(text, `log carries "${leak}"`).not.toContain(leak);
  }
}

function form(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

const PLAN_OK = { id: "plan1", status: "active", client_id: "c1", studio_id: "s1" };
const STAGE_FIELDS = {
  plan_id: "plan1",
  client_id: "c1",
  stage_id: "st1",
  name: "Stage one",
  how_often_unit: "weekly",
  visit_length_minutes: "30",
  stage_length_value: "4",
  stage_length_unit: "weeks",
};

async function plans() {
  return import("@/app/(app)/clients/[id]/treatment-plans-actions");
}

// Script helper: the plan check passes; the named table/verb fails.
function failAt(table: string, verb: string, error: Hostile): void {
  world.script = (t, v) => {
    if (t === "treatment_plans" && v === "select") return { data: PLAN_OK, error: null };
    if (t === "clients" && v === "select") return { data: { id: "c1" }, error: null };
    if (t === table && v === verb) return { data: null, error };
    return { data: v === "select" ? null : [], error: null };
  };
}

describe("the classifier", () => {
  it("maps SQLSTATE classes to distinct fixed sentences and everything else to the generic one", () => {
    expect(classifyDbFailure("42501")).toBe("permission");
    for (const c of ["40001", "40P01", "55P03", "57014"]) expect(classifyDbFailure(c)).toBe("busy");
    for (const c of ["23502", "23503", "23505", "23514", "23P01"]) expect(classifyDbFailure(c)).toBe("conflict");
    for (const c of ["22P02", "XX000", "unknown", "42P01"]) expect(classifyDbFailure(c)).toBe("generic");
  });

  it("returns a fixed sentence per class, logs only the closed code, and never echoes the error", () => {
    const sentences = new Set<string>();
    for (const code of ["42501", "40001", "23505", "22P02"]) {
      const s = userFacingDbFailure("add the stage", hostile(code), "ev");
      sentences.add(s);
      expectNoLeak({ s });
    }
    expect(sentences.size).toBe(4);
    expect([...sentences].join("|")).toContain("You do not have permission to add the stage.");
    expect(logs.events().map((e) => e.code)).toEqual(["42501", "40001", "23505", "22P02"]);
  });

  it("an error with no usable code logs 'unknown' and gets the generic sentence", () => {
    const s = userFacingDbFailure("close the plan", { code: HOSTILE, message: HOSTILE }, "ev");
    expect(s).toBe("Could not close the plan. Try again, and contact support if it keeps happening.");
    expect(logs.events()[0].code).toBe("unknown");
    expectNoLeak({ s });
  });
});

describe("treatment-plans-actions.ts: no database text reaches the returned result", () => {
  it(":219 the client lookup", async () => {
    world.script = (t) => (t === "clients" ? { data: null, error: hostile("22P02") } : { data: null, error: null });
    const { createTreatmentPlanAction } = await plans();
    const r = await createTreatmentPlanAction(form({ client_id: "c1", name: "Plan" }));
    expect(r).toEqual({ ok: false, error: expect.stringContaining("check the client") });
    expectNoLeak(r);
    expect(logs.events()[0]).toMatchObject({ event: "treatment_plan_client_lookup_failed", code: "22P02" });
  });

  it(":241 the plan insert, including a null error object", async () => {
    failAt("treatment_plans", "insert", hostile("23505"));
    const { createTreatmentPlanAction } = await plans();
    const r = await createTreatmentPlanAction(form({ client_id: "c1", name: "Plan" }));
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("conflicts with existing records") });
    expectNoLeak(r);
    expect(logs.events()[0]).toMatchObject({ event: "treatment_plan_create_failed", code: "23505" });
  });

  it(":278 the stage setup insert (and the plan is still closed afterwards)", async () => {
    const verbs: string[] = [];
    world.script = (t, v) => {
      verbs.push(`${t}:${v}`);
      if (t === "clients") return { data: { id: "c1" }, error: null };
      if (t === "treatment_plans" && v === "insert") return { data: { id: "plan1" }, error: null };
      if (t === "treatment_plan_stages" && v === "insert") return { data: null, error: hostile("40001") };
      return { data: null, error: null };
    };
    const { createTreatmentPlanAction } = await plans();
    const r = await createTreatmentPlanAction(form({ client_id: "c1", name: "Plan" }));
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("the record is busy") });
    expectNoLeak(r);
    expect(verbs).toContain("treatment_plans:update");
  });

  it(":331 closing the plan", async () => {
    failAt("treatment_plans", "update", hostile("42501"));
    const { closeTreatmentPlanAction } = await plans();
    const r = await closeTreatmentPlanAction(form({ plan_id: "plan1", client_id: "c1" }));
    expect(r).toEqual({ ok: false, error: "You do not have permission to close the plan." });
    expectNoLeak(r);
  });

  it(":478 the plan lookup used by every plan-mutating action", async () => {
    world.script = (t, v) => (t === "treatment_plans" && v === "select" ? { data: null, error: hostile("22P02") } : { data: null, error: null });
    const { closeTreatmentPlanAction } = await plans();
    const r = await closeTreatmentPlanAction(form({ plan_id: "plan1", client_id: "c1" }));
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("load the plan") });
    expectNoLeak(r);
    expect(logs.events()[0]).toMatchObject({ event: "treatment_plan_lookup_failed", code: "22P02" });
  });

  it(":640 saving the notes", async () => {
    failAt("treatment_plans", "update", hostile("23514"));
    const { updateTreatmentPlanNotesAction } = await plans();
    const r = await updateTreatmentPlanNotesAction(form({ plan_id: "plan1", client_id: "c1", practitioner_notes: "note" }));
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("save the plan notes") });
    expectNoLeak(r);
  });

  it(":728 adding a stage", async () => {
    failAt("treatment_plan_stages", "insert", hostile("22P02"));
    const { createTreatmentPlanStageAction } = await plans();
    const r = await createTreatmentPlanStageAction(form(STAGE_FIELDS));
    expect(r).toEqual({ ok: false, error: "Could not add the stage. Try again, and contact support if it keeps happening." });
    expectNoLeak(r);
  });

  it(":807 updating a stage", async () => {
    failAt("treatment_plan_stages", "update", hostile("55P03"));
    const { updateTreatmentPlanStageAction } = await plans();
    const r = await updateTreatmentPlanStageAction(form(STAGE_FIELDS));
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("update the stage because the record is busy") });
    expectNoLeak(r);
  });

  it(":833 removing a stage", async () => {
    failAt("treatment_plan_stages", "delete", hostile("23503"));
    const { deleteTreatmentPlanStageAction } = await plans();
    const r = await deleteTreatmentPlanStageAction(form(STAGE_FIELDS));
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("remove the stage because the change conflicts") });
    expectNoLeak(r);
  });

  it("the deliberate non-database sentences are unchanged", async () => {
    world.script = (t, v) => (t === "treatment_plans" && v === "select" ? { data: { ...PLAN_OK, status: "closed" }, error: null } : { data: null, error: null });
    const { closeTreatmentPlanAction } = await plans();
    expect(await closeTreatmentPlanAction(form({ plan_id: "plan1", client_id: "c1" }))).toEqual({
      ok: false,
      error: "This plan is closed and cannot be edited.",
    });
    world.script = () => ({ data: null, error: null });
    expect(await closeTreatmentPlanAction(form({ plan_id: "plan1", client_id: "c1" }))).toEqual({ ok: false, error: "Plan not found." });
  });
});

describe("settings/data/actions.ts: the export read failure", () => {
  async function runExport(failTable: string, error: Hostile | { message: string }) {
    world.script = (t) => (t === failTable ? { data: null, error } : { data: [], error: null });
    const { exportStudioDataAction } = await import("@/app/(app)/settings/data/actions");
    return exportStudioDataAction();
  }

  it(":479 a table read error carries no database text and exports nothing", async () => {
    const r = await runExport("clients", hostile("22P02"));
    expect(r).toEqual({
      ok: false,
      error: "Failed to load data for export. Nothing was exported. Try again, and contact support if it keeps happening.",
    });
    expectNoLeak(r);
    expect(logs.events().find((e) => e.event === "studio_export_read_failed")).toMatchObject({ code: "22P02" });
  });

  it(":479 the paginator's own refusal keeps its meaning without echoing its text", async () => {
    const r = await runExport("clients", {
      message: `Export read exceeded 500 pages (500000 rows); refusing to return a partial table. ${EMAIL}`,
    });
    expect(r).toEqual({
      ok: false,
      error: "Failed to load data for export: a table could not be read completely, so nothing was exported. Try again.",
    });
    expectNoLeak(r);
  });

  it(":544 a budget-context read error (not a missing relation) fails the export without database text", async () => {
    const r = await runExport("client_budget_context", hostile("42501"));
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("Failed to load data for export") });
    expectNoLeak(r);
    expect(logs.events().find((e) => e.event === "studio_export_read_failed")).toMatchObject({ code: "42501" });
  });
});
