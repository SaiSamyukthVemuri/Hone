import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildMissingRecordsAssistant,
  type IncompleteIntake,
  type MissingRecordsInput,
  type RecordedSession,
  type UnchartedAppointment,
} from "@/lib/dashboard/missing-records-assistant";

// Missing Records / Follow-up Assistant V1 (PR #249). Rules-based only
// (no AI, no model, no provider). The pure builder is tested directly;
// the loader's no-write / no-sensitive-surface / no-provider guarantees
// and the dashboard wiring are source-pinned at the bottom.

function appt(over: Partial<UnchartedAppointment> = {}): UnchartedAppointment {
  return {
    appointmentId: "ap1",
    clientId: "c1",
    clientName: "Maya R.",
    startedAt: "2026-06-10T15:00:00.000Z",
    ...over,
  };
}

function session(over: Partial<RecordedSession> = {}): RecordedSession {
  return {
    sessionId: "s1",
    clientId: "c1",
    clientName: "Maya R.",
    startedAt: "2026-06-10T15:00:00.000Z",
    hasTreatmentArea: true,
    aftercareMarked: true,
    probeLotMissing: false,
    ...over,
  };
}

function intake(over: Partial<IncompleteIntake> = {}): IncompleteIntake {
  return { clientId: "c1", clientName: "Maya R.", ...over };
}

function build(over: Partial<MissingRecordsInput> = {}) {
  return buildMissingRecordsAssistant({
    unchartedAppointments: [],
    sessions: [],
    incompleteIntakes: [],
    ...over,
  });
}

describe("buildMissingRecordsAssistant item types", () => {
  it("flags a completed appointment with no charted session", () => {
    const item = build({ unchartedAppointments: [appt()] }).items[0];
    expect(item.type).toBe("charting");
    expect(item.priority).toBe(1);
    expect(item.chip).toBe("Charting needed");
    expect(item.actionLabel).toBe("Chart appointment");
    expect(item.href).toBe("/clients/c1/sessions/new?appointment_id=ap1");
  });

  it("flags aftercare/risks not marked on a recorded session with a treatment area", () => {
    const item = build({
      sessions: [session({ aftercareMarked: false })],
    }).items[0];
    expect(item.type).toBe("aftercare");
    expect(item.priority).toBe(2);
    expect(item.chip).toBe("Aftercare not marked");
    expect(item.href).toBe("/clients/c1/sessions/s1");
  });

  it("does NOT flag aftercare when the session has no recorded treatment area", () => {
    const a = build({
      sessions: [session({ aftercareMarked: false, hasTreatmentArea: false })],
    });
    expect(a.hasItems).toBe(false);
  });

  it("flags a probe lot missing from a recorded treatment area", () => {
    const item = build({
      sessions: [session({ probeLotMissing: true })],
    }).items[0];
    expect(item.type).toBe("probe_lot");
    expect(item.priority).toBe(3);
    expect(item.chip).toBe("Probe lot missing");
    expect(item.href).toBe("/clients/c1/sessions/s1");
  });

  it("flags an incomplete (in-progress) intake", () => {
    const item = build({ incompleteIntakes: [intake()] }).items[0];
    expect(item.type).toBe("intake");
    expect(item.priority).toBe(4);
    expect(item.chip).toBe("Intake incomplete");
    expect(item.href).toBe("/clients/c1");
  });

  // DASH-TRUTH-01: a for-next-visit note with nothing booked is clinical
  // memory, not a missing record. The assistant must not manufacture a task
  // from it — the note itself is untouched and still shows in Today/Remember,
  // Treatment Memory, appointment prep and history.
  // Review 3779063526. This used to be proved by passing a plan into the
  // builder and asserting nothing came out. The plan fields are gone from this
  // loader entirely, so the guarantee is now STRUCTURAL and strictly stronger:
  // the builder cannot express a plan, so it cannot manufacture a task from one
  // and cannot transport the text.
  it("P2 a plan for the next visit cannot even reach this builder", () => {
    const built = buildMissingRecordsAssistant({
      unchartedAppointments: [],
      sessions: [session({})],
      incompleteIntakes: [],
    });
    expect(built.items).toHaveLength(0);
    expect(built.totalFound).toBe(0);

    const shape = session({}) as Record<string, unknown>;
    expect(Object.keys(shape)).not.toContain("nextVisitNote");
    expect(Object.keys(shape)).not.toContain("hasUpcomingAppointment");
  });
});

describe("priority order, dedup, and cap", () => {
  it("orders items by priority", () => {
    const a = build({
      unchartedAppointments: [appt({ appointmentId: "ap1", clientId: "c1" })],
      sessions: [
        session({ sessionId: "s2", clientId: "c2", aftercareMarked: false }),
        session({ sessionId: "s3", clientId: "c3" }),
      ],
      incompleteIntakes: [intake({ clientId: "c4" })],
    });
    expect(a.items.map((i) => i.type)).toEqual([
      "charting", // 1
      "aftercare", // 2
      "intake", // 4
    ]);
  });

  it("dedupes to one item per (client, type), keeping the most recent", () => {
    const a = build({
      sessions: [
        session({
          sessionId: "old",
          aftercareMarked: false,
          startedAt: "2026-06-01T00:00:00.000Z",
        }),
        session({
          sessionId: "new",
          aftercareMarked: false,
          startedAt: "2026-06-12T00:00:00.000Z",
        }),
      ],
    });
    const aftercare = a.items.filter((i) => i.type === "aftercare");
    expect(aftercare).toHaveLength(1);
    expect(aftercare[0].id).toBe("aftercare:new");
  });

  it("caps the displayed items and reports the total found", () => {
    const sessions = Array.from({ length: 10 }, (_, n) =>
      session({ sessionId: `s${n}`, clientId: `c${n}`, aftercareMarked: false }),
    );
    const a = build({ sessions, limit: 6 });
    expect(a.items).toHaveLength(6);
    expect(a.totalFound).toBe(10);
  });

  it("an empty input yields the calm empty state", () => {
    const a = build();
    expect(a.hasItems).toBe(false);
    expect(a.items).toEqual([]);
    expect(a.totalFound).toBe(0);
  });
});

describe("safe routes and wording", () => {
  it("every item links to an existing, safe, studio-scoped /clients route", () => {
    const a = build({
      unchartedAppointments: [appt()],
      sessions: [
        session({
          sessionId: "s2",
          clientId: "c2",
          aftercareMarked: false,
          probeLotMissing: true,
        }),
        session({
          sessionId: "s3",
          clientId: "c3",
        }),
      ],
      incompleteIntakes: [intake({ clientId: "c4" })],
    });
    const safe =
      /^\/clients\/[\w-]+(\/sessions\/[\w-]+|\/sessions\/new\?appointment_id=[\w-]+)?$/;
    for (const item of a.items) {
      expect(item.href).toMatch(safe);
      expect(item.href).not.toMatch(/https?:|token|stripe|exposure/i);
    }
  });

  it("uses recorded-history wording, never clinical advice", () => {
    const a = build({
      unchartedAppointments: [appt()],
      sessions: [
        session({ sessionId: "s2", clientId: "c2", aftercareMarked: false, probeLotMissing: true }),
        session({ sessionId: "s3", clientId: "c3" }),
      ],
      incompleteIntakes: [intake({ clientId: "c4" })],
    });
    const text = a.items.map((i) => `${i.reason} ${i.chip}`).join(" ");
    expect(text).not.toMatch(
      /recommend|\bsafe\b|\bunsafe\b|caused|diagnos|should treat|compliance score|\bperformance\b|monitor/i,
    );
  });
});

describe("safety: source pins (helper + loader file)", () => {
  const SRC = readFileSync(
    join(process.cwd(), "lib/dashboard/missing-records-assistant.ts"),
    "utf8",
  );
  const executable = SRC.split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

  it("adds no AI / model / provider integration", () => {
    expect(SRC).not.toMatch(/anthropic|openai|gemini|@ai-sdk|\bllm\b/i);
    // No external fetch; reads go through the studio-scoped supabase client.
    expect(executable).not.toMatch(/fetch\(/);
  });

  it("writes nothing (no insert/update/delete/rpc-mutation/send/charge)", () => {
    expect(executable).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
    expect(executable).not.toMatch(/sendEmail|sendSms|createPaymentIntent|capture|refund/i);
  });

  it("reads no sensitive surface in executable lines (exposure / payment / token / audit)", () => {
    // The header comment legitimately names what it does NOT read; only
    // executable lines are asserted.
    expect(executable).not.toMatch(/exposure|stripe|payment|charge|token|audit/i);
  });

  it("only queries studio-scoped, RLS-backed tables (every .from is studio-filtered)", () => {
    const fromTables = [...executable.matchAll(/\.from\("([^"]+)"\)/g)].map(
      (m) => m[1],
    );
    expect(fromTables.length).toBeGreaterThan(0);
    const allowed = new Set([
      "sessions",
      "session_blocks",
      "appointments",
      "client_intake_forms",
    ]);
    for (const t of fromTables) expect(allowed.has(t)).toBe(true);
    // Every query filters by studio_id (RLS backstop) and uses no
    // service-role / admin client.
    const fromCount = fromTables.length;
    const studioFilterCount = [
      ...executable.matchAll(/\.eq\("studio_id", studioId\)/g),
    ].length;
    expect(studioFilterCount).toBe(fromCount);
    expect(executable).not.toMatch(/service.?role|admin/i);
  });
});

describe("dashboard wiring (source pins)", () => {
  const PAGE = readFileSync(
    join(process.cwd(), "app/(app)/dashboard/page.tsx"),
    "utf8",
  );
  // Dashboard V2 Part 2B: the standalone "Follow-up assistant" card is gone.
  // Its items now flow through the ONE normalized To-do model and render in
  // the single To-do list. The loader and the item contract are unchanged, so
  // these pins moved to the surfaces that actually carry them.
  const LIST = readFileSync(
    join(process.cwd(), "app/(app)/dashboard/todo-list.tsx"),
    "utf8",
  );
  const MODEL = readFileSync(
    join(process.cwd(), "lib/dashboard/todo-model.ts"),
    "utf8",
  );

  it("the dashboard loads the assistant and feeds it to the ONE To-do model", () => {
    expect(PAGE).toMatch(/getMissingRecordsAssistant\(/);
    expect(PAGE).toMatch(/assistant: followUpAssistant/);
    expect(PAGE).toMatch(/<DashboardTodoList todo=\{dashboardTodo\}/);
    // ...and the retired card is really gone, not merely unrendered.
    expect(PAGE).not.toMatch(/FollowUpAssistantCard/);
  });

  it("the existing Daily Prep Brief and Today next actions stay intact", () => {
    // The Daily Prep Brief card is retired; its preparation facts now render
    // once inside the appointment row, from the appointment-bounded prep
    // projection. (This used to pin `buildTodayWorkflow(todayWorkflowInputs)`,
    // which was only ever a proxy for "preparation renders in the row".)
    expect(PAGE).toMatch(/<PreVisitPrepBlock prep=\{prep\}/);
    expect(PAGE).not.toMatch(/DailyPrepBriefCard/);
    expect(PAGE).toMatch(/resolveDayNextAction\(/);
  });

  it("every assistant gap type still reaches the unified list", () => {
    // The five types are mapped 1:1 onto To-do kinds; a dropped mapping would
    // silently stop surfacing that gap.
    for (const t of ["charting", "aftercare", "probe_lot", "intake"]) {
      expect(MODEL, `${t} is not mapped into the To-do model`).toMatch(
        new RegExp(`${t}:`),
      );
    }
  });

  it("the list renders one calm empty state, and the assistant's own actions", () => {
    expect(LIST).toMatch(/Nothing to do right now/);
    // The action label/href come straight off the item; nothing is re-derived.
    expect(MODEL).toMatch(/href: item\.href, label: item\.actionLabel/);
  });

  // The invariant is that the list performs no MUTATION and no I/O: every row's
  // action is a real link, and the list never submits a form, invokes a server
  // action, or fetches. DASH-TRUTH-02 adds one purely presentational disclosure
  // toggle (show/hide already-loaded rows), which mutates nothing and is
  // explicitly permitted — so the check now targets the real hazards.
  it("the unified list stays link-only for ACTIONS (no form, no server action, no fetch)", () => {
    expect(LIST).not.toMatch(/<form|action=|fetch\(/);
    // each row action is still a Link, never a button
    const rowAction = LIST.slice(LIST.indexOf("{item.action.label}") - 800, LIST.indexOf("{item.action.label}"));
    expect(rowAction).toMatch(/<Link/);
    // the only interactive control is the disclosure toggle
    const buttons = LIST.match(/<button/g) ?? [];
    expect(buttons).toHaveLength(1);
    expect(LIST).toMatch(/data-testid="todo-disclosure-toggle"/);
  });
});
