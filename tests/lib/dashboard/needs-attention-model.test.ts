import { describe, expect, it } from "vitest";
import { buildNeedsAttention } from "@/lib/dashboard/needs-attention-model";
import { buildMissingRecordsAssistant } from "@/lib/dashboard/missing-records-assistant";
import type { DashboardTodo, DashboardTodoItem } from "@/lib/dashboard/todo-model";

// Synthetic fixtures only.

const NO_TODO: DashboardTodo = { items: [], hasItems: false, moreCount: 0 };

function todoItem(kind: DashboardTodoItem["kind"], id: string): DashboardTodoItem {
  return {
    id,
    kind,
    subject: { id, label: `Subject ${id}` } as DashboardTodoItem["subject"],
    reason: "reason",
    detail: null,
    action: { label: "Open", href: "/somewhere" },
    priority: 1,
    occurredAt: null,
    tone: "normal",
  };
}

const session = (over: Record<string, unknown>) => ({
  sessionId: "s1",
  clientId: "c1",
  clientName: "Client One",
  startedAt: "2026-10-10T15:00:00.000Z",
  hasTreatmentArea: true,
  aftercareMarked: true,
  probeLotMissing: false,
  ...over,
});

describe("buildNeedsAttention grouping", () => {
  it("folds aftercare and probe-lot gaps on ONE session into one entry", () => {
    const assistant = buildMissingRecordsAssistant({
      unchartedAppointments: [],
      incompleteIntakes: [],
      sessions: [session({ aftercareMarked: false, probeLotMissing: true })],
    });
    const out = buildNeedsAttention({
      assistant,
      intakesAwaitingReview: [],
      todo: NO_TODO,
    });
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0].id).toBe("session:c1:s1");
    expect(out.entries[0].issues.map((i) => i.kind).sort()).toEqual([
      "aftercare",
      "probe_lot",
    ]);
    expect(out.issueCount).toBe(2);
  });

  it("keeps two sessions of one client, and two clients, as separate entries", () => {
    const assistant = buildMissingRecordsAssistant({
      unchartedAppointments: [],
      incompleteIntakes: [],
      sessions: [
        session({ sessionId: "s1", aftercareMarked: false }),
        session({ sessionId: "s2", aftercareMarked: false }),
        session({ sessionId: "s3", clientId: "c2", clientName: "Client Two", aftercareMarked: false }),
      ],
    });
    const out = buildNeedsAttention({ assistant, intakesAwaitingReview: [], todo: NO_TODO });
    expect(out.entries.map((e) => e.id).sort()).toEqual([
      "session:c1:s1",
      "session:c1:s2",
      "session:c2:s3",
    ]);
  });

  it("puts preparation (intake) before documentation, then newest first", () => {
    const assistant = buildMissingRecordsAssistant({
      unchartedAppointments: [
        { appointmentId: "ap1", clientId: "c1", clientName: "Client One", startedAt: "2026-10-12T15:00:00.000Z" },
      ],
      incompleteIntakes: [],
      sessions: [session({ sessionId: "s9", clientId: "c3", clientName: "Client Three", aftercareMarked: false, startedAt: "2026-10-01T15:00:00.000Z" })],
    });
    const out = buildNeedsAttention({
      assistant,
      intakesAwaitingReview: [
        { clientId: "c2", clientName: "Client Two", submittedAt: "2026-09-01T10:00:00Z" },
      ],
      todo: NO_TODO,
    });
    expect(out.entries.map((e) => e.id)).toEqual([
      "intake:c2",
      "appointment:c1:ap1",
      "session:c3:s9",
    ]);
  });

  it("merges an intake-review and an incomplete-intake issue for one client", () => {
    const assistant = buildMissingRecordsAssistant({
      unchartedAppointments: [],
      sessions: [],
      incompleteIntakes: [{ clientId: "c1", clientName: "Client One" }],
    });
    const out = buildNeedsAttention({
      assistant,
      intakesAwaitingReview: [
        { clientId: "c1", clientName: "Client One", submittedAt: "2026-10-02T10:00:00Z" },
      ],
      todo: NO_TODO,
    });
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0].issues).toHaveLength(2);
  });

  it("keeps non-grouped to-do items reachable as 'others' and drops grouped kinds", () => {
    const out = buildNeedsAttention({
      assistant: buildMissingRecordsAssistant({
        unchartedAppointments: [],
        sessions: [],
        incompleteIntakes: [],
      }),
      intakesAwaitingReview: [],
      todo: {
        hasItems: true,
        moreCount: 0,
        items: [
          todoItem("treatment_memory", "tm1"),
          todoItem("charting", "ch1"),
          todoItem("intake_review", "ir1"),
        ],
      },
    });
    expect(out.others.map((i) => i.id)).toEqual(["tm1"]);
  });

  it("reports a source cap instead of implying the list is complete", () => {
    const out = buildNeedsAttention({
      assistant: {
        items: [],
        totalFound: 12,
        allItems: [],
        allTotal: 12,
      } as never,
      intakesAwaitingReview: [],
      todo: NO_TODO,
    });
    expect(out.notReturnedCount).toBe(12);
  });

  it("empty inputs give an empty, honest result", () => {
    const out = buildNeedsAttention({
      assistant: buildMissingRecordsAssistant({
        unchartedAppointments: [],
        sessions: [],
        incompleteIntakes: [],
      }),
      intakesAwaitingReview: [],
      todo: NO_TODO,
    });
    expect(out).toMatchObject({ entries: [], issueCount: 0, others: [], notReturnedCount: 0 });
  });
});
