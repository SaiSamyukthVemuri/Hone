import { describe, expect, it } from "vitest";
import {
  buildClientsNeedingAttention,
  type AttentionBlockInput,
  type AttentionSessionInput,
} from "@/lib/dashboard/clients-needing-attention";
import {
  buildDashboardTodo,
  type BuildDashboardTodoInput,
} from "@/lib/dashboard/todo-model";
import type { ProcedureActionMetrics } from "@/lib/dashboard/practice-metrics";
import { buildTodayWorkflow, type TodayWorkflowInput } from "@/lib/dashboard/today-workflow";

// DASH-TRUTH-01 / P2. THE PRODUCT LAW, stated once and proved end to end:
//
//   A plan for the next visit is NOT To-do content — not as inclusion, not as
//   ranking, not as a reason, not as detail, not as preview.
//
// It remains valid clinical memory everywhere else, so the last test proves we
// removed it from ONE surface rather than deleting the field.
//
// Every case uses a unique literal so "absent" is checked against the whole
// serialized item, not against a hand-picked field that might not be the one
// that leaks.
const SENTINEL = "PLAN_SECRET_SENTINEL_9274";

function session(
  id: string,
  clientId: string,
  startedAt: string,
  note: string | null = null,
): AttentionSessionInput {
  return {
    id,
    client_id: clientId,
    client_name: `Client ${clientId}`,
    started_at: startedAt,
    next_session_note: note,
  };
}

function block(
  sessionId: string,
  over: Partial<AttentionBlockInput> = {},
): AttentionBlockInput {
  return {
    session_id: sessionId,
    caution_for_next_session: false,
    caution_note: null,
    reaction_type: null,
    tolerance_rating: null,
    ...over,
  };
}

const NO_METRICS: ProcedureActionMetrics = {
  reviewedSessions: 0,
  incompleteRecords: 0,
  missingProbeLots: 0,
  aftercareNotMarked: 0,
  recordsMissingDetails: 0,
};

const NO_STUDIO: BuildDashboardTodoInput["studio"] = {
  isOwner: true,
  intakesAwaitingReviewCount: 0,
  activeServicesCount: 3,
  paymentStatus: {
    hasAccount: true,
    onboardingCompleted: true,
    payoutsEnabled: true,
  },
};

// The To-do model takes the attention output; every other domain is empty so
// the only rows under test are treatment-memory ones. Built from the REAL
// input type — an `as unknown as` cast here would let a wrong fixture compile
// and prove nothing.
function todoFor(
  sessions: AttentionSessionInput[],
  blocks: AttentionBlockInput[],
) {
  const attention = buildClientsNeedingAttention(sessions, blocks);
  const todo = buildDashboardTodo({
    assistant: { items: [], hasItems: false, totalFound: 0 },
    attention,
    supplies: [],
    metrics: NO_METRICS,
    studio: NO_STUDIO,
    todayLocal: "2026-06-11",
  });
  return { attention, todo };
}

describe("plan for next visit never becomes To-do content", () => {
  it("P1 plan-only: excluded at the source, and absent from the To-do list", () => {
    const { attention, todo } = todoFor(
      [session("s1", "planny", "2026-06-10T10:00:00Z", SENTINEL)],
      [block("s1")],
    );
    expect(attention.totalClients).toBe(0);
    expect(attention.clients).toHaveLength(0);
    expect(JSON.stringify(todo)).not.toContain(SENTINEL);
    expect(todo.items.some((i) => i.subject.id === "planny")).toBe(false);
  });

  it("P2 watch + plan: the row exists because of the WATCH, with no plan text anywhere", () => {
    const { attention, todo } = todoFor(
      [session("s1", "c1", "2026-06-10T10:00:00Z", SENTINEL)],
      [block("s1", { caution_note: "Go gentler on the chin." })],
    );
    expect(attention.totalClients).toBe(1);
    const row = todo.items.find((i) => i.subject.id === "c1")!;
    expect(row).toBeDefined();
    // included, and for the right reason
    expect(row.reason).toContain("Watch note");
    // the plan is nowhere in the reason, the detail, or anything else
    expect(row.reason).not.toContain(SENTINEL);
    expect(row.detail ?? "").not.toContain(SENTINEL);
    expect(JSON.stringify(row)).not.toContain(SENTINEL);
  });

  it("P3 reaction + plan, no watch: the row exists because of the REACTION", () => {
    // This is the case the P2 finding was actually about: with no watch text,
    // the plan used to be the next fallback and became the row's detail.
    const { attention, todo } = todoFor(
      [session("s1", "c1", "2026-06-10T10:00:00Z", SENTINEL)],
      [block("s1", { reaction_type: "swelling" })],
    );
    expect(attention.totalClients).toBe(1);
    const row = todo.items.find((i) => i.subject.id === "c1")!;
    expect(row).toBeDefined();
    // the reaction context survives — we removed the plan, not the signal
    expect(`${row.reason} ${row.detail ?? ""}`).toMatch(/Swelling/i);
    expect(row.reason).not.toContain(SENTINEL);
    expect(row.detail ?? "").not.toContain(SENTINEL);
    expect(JSON.stringify(row)).not.toContain(SENTINEL);
  });

  it("P4 watch + reaction + plan: still actionable, sentinel absent from the ENTIRE item", () => {
    const { todo } = todoFor(
      [session("s1", "c1", "2026-06-10T10:00:00Z", SENTINEL)],
      [
        block("s1", {
          caution_for_next_session: true,
          caution_note: "Watch the upper lip.",
          reaction_type: "irritation",
          tolerance_rating: 2,
        }),
      ],
    );
    const row = todo.items.find((i) => i.subject.id === "c1")!;
    expect(row).toBeDefined();
    expect(row.reason).toContain("Watch note");
    expect(row.action.href).toBe("/clients/c1");
    expect(JSON.stringify(row)).not.toContain(SENTINEL);
  });

  it("P5 the SAME plan still reaches Today → Remember — this is a To-do change, not a deletion", () => {
    // Proves the field itself is intact. If this ever goes red at the same
    // time as P1–P4 go green, we deleted clinical memory instead of relocating
    // a presentation decision.
    const base: TodayWorkflowInput = {
      appointmentId: "appt-1",
      clientId: "c1",
      clientName: "A Client",
      timeLabel: "9:00 AM",
      status: "confirmed",
      serviceName: "Electrolysis 30",
      unavailable: false,
      hasHistory: true,
      nextVisitNote: SENTINEL,
      cautionNote: null,
      setupLine: null,
      reminders: [],
      intake: "reviewed",
      charting: "none",
    };
    const workflow = buildTodayWorkflow([base]);
    expect(workflow.items).toHaveLength(1);
    expect(workflow.items[0].remember).toBe(SENTINEL);
  });

  it("the To-do path cannot reach plan TEXT at all — the field is not carried", () => {
    // Structural, not a promise: the attention row has no plan-text field, so
    // no future edit to presentation can re-leak it. `hasPlan` (whether one
    // exists) is retained as context and is a boolean, never the note.
    const { attention } = todoFor(
      [session("s1", "c1", "2026-06-10T10:00:00Z", SENTINEL)],
      [block("s1", { caution_note: "watch" })],
    );
    const row = attention.clients[0] as Record<string, unknown>;
    expect(row.hasPlan).toBe(true);
    expect(Object.keys(row)).not.toContain("planText");
    expect(JSON.stringify(attention)).not.toContain(SENTINEL);
  });
});
