import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { captureConsole } from "../../lib/sms/helpers/log-capture";

// MSG-LOG-RAW-ERROR (UI-DB-TEXT-2). The remaining places that RETURN database
// text to the page (or to a caller that throws or prints it): the client
// birthday, budget, personal-notes and treatment-goal actions, the onboarding
// state writer, the service reorder, the team invite, the area removal, the
// recurring-break cron response and the payment-webhook attempt lookup. Every
// case feeds a fake error whose message, details and hint carry synthetic text
// and asserts none of it reaches the returned value, a thrown message or the
// log; each site goes red when its old line is restored (see the PR's
// mutation record). Synthetic values only.

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const EMAIL = "leak.probe@example.test";
const HOSTILE = `invalid input syntax for type uuid: "${EMAIL}" +1 555 010 0199 violates constraint "clients_email_key"`;
const LEAKS = ["leak.probe", "example.test", "555 010", "5550100199", "clients_email_key", "invalid input syntax"];

type Hostile = { code?: string; message: string; details: string; hint: string };
const hostile = (code?: string): Hostile => ({ code, message: HOSTILE, details: HOSTILE, hint: HOSTILE });

const world = vi.hoisted(() => ({
  script: (_table: string, _verb: string): { data: unknown; error: unknown } => ({ data: null, error: null }),
}));

function makeClient() {
  const builder = (table: string) => {
    let verb = "select";
    let selected = "id";
    const answer = () => Promise.resolve(world.script(table, verb));
    const proxy: unknown = new Proxy(function () {}, {
      get(_t, prop: string) {
        if (prop === "then") return (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => answer().then(res, rej);
        if (prop === "single" || prop === "maybeSingle") return () => answer();
        if (prop === "url") return { searchParams: new URLSearchParams({ select: selected }) };
        return (...a: unknown[]) => {
          if (prop === "insert" || prop === "update" || prop === "delete" || prop === "upsert") verb = prop;
          if (prop === "select" && typeof a[0] === "string") selected = a[0].replace(/\s+/g, "");
          return proxy;
        };
      },
    });
    return proxy;
  };
  return {
    from: (table: string) => builder(table),
    rpc: (name: string) => Promise.resolve(world.script(`rpc:${name}`, "rpc")),
  };
}

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => makeClient() }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => makeClient() }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { id: "pr1", role: "owner", active: true, display_name: "Owner", email: "owner@example.test" },
    studio: { id: "s1", name: "Willow Studio" },
  }),
}));
vi.mock("@/lib/sessions/session-lineage", () => ({ assertSessionForClient: async () => {} }));
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: async () => {} }));
vi.mock("@/lib/cron/auth", () => ({ isAuthorizedCronRequest: () => true }));
vi.mock("@/lib/cron/reminder-heartbeat", () => ({ recordReminderSchedulerHealthAlert: async () => {} }));

let logs: ReturnType<typeof captureConsole>;
beforeEach(() => {
  logs = captureConsole();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function expectNoLeak(value: unknown, text = logs.text()) {
  const out = typeof value === "string" ? value : JSON.stringify(value);
  for (const leak of LEAKS) {
    expect(out, `value carries "${leak}"`).not.toContain(leak);
    expect(text, `log carries "${leak}"`).not.toContain(leak);
  }
}

function form(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

// The client row exists; the named table/verb fails.
function failAt(table: string, verb: string, error: Hostile) {
  world.script = (t, v) => {
    if (t === "clients" && v === "select") return { data: { id: "c1" }, error: null };
    if (t === table && v === verb) return { data: null, error };
    return { data: null, error: null };
  };
}
function failClientLookup(error: Hostile) {
  world.script = (t, v) => (t === "clients" && v === "select" ? { data: null, error } : { data: null, error: null });
}

describe("client actions: birthday, budget, personal notes, treatment goal", () => {
  it("birthday: the client lookup (:63 clear, :119 save) and both writes", async () => {
    const { updateClientBirthdayAction } = await import("@/app/(app)/clients/[id]/birthday-actions");
    failClientLookup(hostile("22P02"));
    const clear = await updateClientBirthdayAction(form({ client_id: "c1", birthday_month: "", birthday_day: "" }));
    expect(clear).toMatchObject({ ok: false, error: expect.stringContaining("check the client") });
    expectNoLeak(clear);
    const save = await updateClientBirthdayAction(form({ client_id: "c1", birthday_month: "5", birthday_day: "17" }));
    expect(save).toMatchObject({ ok: false, error: expect.stringContaining("check the client") });
    expectNoLeak(save);

    failAt("clients", "update", hostile("42501"));
    const writeFail = await updateClientBirthdayAction(form({ client_id: "c1", birthday_month: "5", birthday_day: "17" }));
    expect(writeFail).toEqual({ ok: false, error: "You do not have permission to save the birthday." });
    expectNoLeak(writeFail);
    const clearFail = await updateClientBirthdayAction(form({ client_id: "c1", birthday_month: "", birthday_day: "" }));
    expect(clearFail).toMatchObject({ ok: false, error: expect.stringContaining("clear the birthday") });
    expectNoLeak(clearFail);
  });

  it("budget context: the lookup (:94) and the save (:111)", async () => {
    const { updateClientBudgetContextAction } = await import("@/app/(app)/clients/[id]/budget-context-actions");
    failClientLookup(hostile("22P02"));
    const a = await updateClientBudgetContextAction(form({ client_id: "c1", budget_notes: "n", budget_level: "" }));
    expect(a).toMatchObject({ ok: false, error: expect.stringContaining("check the client") });
    expectNoLeak(a);
    failAt("client_budget_context", "upsert", hostile("23514"));
    const b = await updateClientBudgetContextAction(form({ client_id: "c1", budget_notes: "n", budget_level: "" }));
    expect(b).toMatchObject({ ok: false, error: expect.stringContaining("a value could not be accepted") });
    expectNoLeak(b);
  });

  it("personal notes: the lookup (:77) and the save (:96)", async () => {
    const { updateClientPersonalNotesAction } = await import("@/app/(app)/clients/[id]/personal-notes-actions");
    failClientLookup(hostile("22P02"));
    const a = await updateClientPersonalNotesAction(form({ client_id: "c1", personal_notes: "x", private_warnings: "" }));
    expect(a).toMatchObject({ ok: false, error: expect.stringContaining("check the client") });
    expectNoLeak(a);
    failAt("client_personal_notes", "upsert", hostile("40001"));
    const b = await updateClientPersonalNotesAction(form({ client_id: "c1", personal_notes: "x", private_warnings: "" }));
    expect(b).toMatchObject({ ok: false, error: expect.stringContaining("the record is busy") });
    expectNoLeak(b);
  });

  it("treatment goal: the lookup (:52) and the save (:71)", async () => {
    const { upsertTreatmentGoalAction } = await import("@/app/(app)/clients/[id]/treatment-time-actions");
    const fields = { client_id: "c1", estimated_hours: "10", status: "active" };
    failClientLookup(hostile("22P02"));
    const a = await upsertTreatmentGoalAction(form(fields));
    expect(a).toMatchObject({ ok: false, error: expect.stringContaining("check the client") });
    expectNoLeak(a);
    failAt("treatment_goals", "upsert", hostile("23505"));
    const b = await upsertTreatmentGoalAction(form(fields));
    expect(b).toMatchObject({ ok: false, error: expect.stringContaining("save the goal") });
    expectNoLeak(b);
  });
});

describe("PEER-1162 L1: reclassified codes at the new sites", () => {
  it("23502 (not-null) and 23514 (check) say to check the values; 23505 still says conflict", async () => {
    const { updateClientPersonalNotesAction } = await import("@/app/(app)/clients/[id]/personal-notes-actions");
    const fields = { client_id: "c1", personal_notes: "x", private_warnings: "" };
    for (const [code, expected] of [
      ["23502", "a value could not be accepted"],
      ["23514", "a value could not be accepted"],
      ["23505", "conflicts with existing records"],
    ] as const) {
      failAt("client_personal_notes", "upsert", hostile(code));
      const r = await updateClientPersonalNotesAction(form(fields));
      expect(r, code).toMatchObject({ ok: false, error: expect.stringContaining(expected) });
      expectNoLeak(r);
    }
  });
});

describe("lib/onboarding/state.ts :75", () => {
  it("the setup-progress write returns a fixed sentence to the wizard", async () => {
    world.script = (_t, v) => (v === "upsert" ? { data: null, error: hostile("42501") } : { data: null, error: null });
    const { setCurrentStep } = await import("@/lib/onboarding/state");
    const r = await setCurrentStep("s1", "service" as never);
    expect(r).toEqual({ ok: false, error: "You do not have permission to save your setup progress." });
    expectNoLeak(r);
    expect(logs.events().find((e) => e.event === "onboarding_state_save_failed")).toMatchObject({ code: "42501" });
  });
});

describe("settings: service reorder and team invite", () => {
  it("moveServiceAction: a database failure that is not the stale-position signal", async () => {
    world.script = (t) => (t === "rpc:reorder_studio_service" ? { data: null, error: hostile("22P02") } : { data: null, error: null });
    const { moveServiceAction } = await import("@/app/(app)/settings/services/actions");
    const r = await moveServiceAction({ id: "svc1", move: "up", expectedPosition: 1 });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("reorder the services") });
    expectNoLeak(r);
  });

  it("moveServiceAction: the stale-position signal keeps its meaning", async () => {
    world.script = (t) => (t === "rpc:reorder_studio_service" ? { data: null, error: { code: "40001", message: HOSTILE } } : { data: null, error: null });
    const { moveServiceAction } = await import("@/app/(app)/settings/services/actions");
    const r = await moveServiceAction({ id: "svc1", move: "up", expectedPosition: 1 });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("The service order changed") });
    expectNoLeak(r);
  });

  it("invitePractitionerAction: the invitation insert", async () => {
    world.script = (t, v) => (t === "pending_invitations" && v === "insert" ? { data: null, error: hostile("22P02") } : { data: null, error: null });
    const { invitePractitionerAction } = await import("@/app/(app)/settings/team/actions");
    const r = await invitePractitionerAction(form({ email: "new.hire@example.test", role: "practitioner" }));
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("send the invite") });
    expectNoLeak(r);
  });
});

describe("area removal: only the function's own sentences are shown", () => {
  const input = { clientId: "c1", sessionId: "se1", blockId: "b1", reason: "entered on the wrong client" };

  it("a table CHECK failure (same 23514) carrying database text is the generic message", async () => {
    world.script = (t) => (t === "rpc:soft_delete_session_area" ? { data: null, error: hostile("23514") } : { data: null, error: null });
    const { removeSessionAreaAction } = await import("@/app/(app)/clients/[id]/sessions/[sessionId]/block-actions");
    const r = await removeSessionAreaAction(input as never);
    expect(r).toEqual({ ok: false, error: "Couldn't remove the area right now. Please try again." });
    expectNoLeak(r);
  });

  it("consistent with the L1 classes: area removal never claims a conflict or 'check the values' for a 23514 it cannot vouch for", async () => {
    for (const code of ["23514", "23502", "23505"]) {
      world.script = (t) => (t === "rpc:soft_delete_session_area" ? { data: null, error: hostile(code) } : { data: null, error: null });
      const { removeSessionAreaAction } = await import("@/app/(app)/clients/[id]/sessions/[sessionId]/block-actions");
      const r = await removeSessionAreaAction(input as never);
      expect(r, code).toEqual({ ok: false, error: "Couldn't remove the area right now. Please try again." });
    }
  });

  it("the function's own sentence still reaches the person", async () => {
    world.script = (t) =>
      t === "rpc:soft_delete_session_area"
        ? { data: null, error: { code: "23514", message: "Finalized records cannot be edited" } }
        : { data: null, error: null };
    const { removeSessionAreaAction } = await import("@/app/(app)/clients/[id]/sessions/[sessionId]/block-actions");
    const r = await removeSessionAreaAction(input as never);
    expect(r).toEqual({ ok: false, error: "Finalized records cannot be edited" });
  });
});

describe("the recurring-break cron response", () => {
  it("failures[] in the response body carry a closed code, never the RPC's message", async () => {
    world.script = (t) => {
      if (t === "studio_recurring_break_rules") {
        return { data: [{ id: "r1", studio_id: "s1", studio: { timezone: "America/Toronto" } }], error: null };
      }
      if (t === "rpc:materialize_recurring_break_rule") return { data: null, error: hostile("23P01") };
      return { data: null, error: null };
    };
    const { GET } = await import("@/app/api/cron/materialize-recurring-breaks/route");
    const res = await GET(new Request("http://localhost/api/cron/materialize-recurring-breaks"));
    const body = await res.json();
    expect(body.failures).toEqual([{ rule_id: "r1", studio_id: "s1", error: "23P01", code: "23P01" }]);
    expectNoLeak(body);
  });
});

describe("payment webhook attempt lookup (payment path)", () => {
  it("a lookup failure throws a closed code, not the database text", async () => {
    world.script = (t) => (t === "payment_charge_attempts" ? { data: null, error: hostile("23505") } : { data: null, error: null });
    const { handlePaymentIntentSucceeded } = await import("@/lib/billing/payment-webhook-reconciliation");
    const event = {
      id: "evt_1",
      type: "payment_intent.succeeded",
      livemode: false,
      data: { object: { id: "pi_1", metadata: { hone_payment_charge_attempt_id: "a1" } } },
    };
    const ctx = { studioId: "s1", stripeAccountId: "acct_1", livemode: false };
    const err = await handlePaymentIntentSucceeded(event as never, ctx).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toBe("payment_intent_succeeded_lookup_failed:23505");
    expectNoLeak(err?.message ?? "");
  });
});
