import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildDashboardTodo,
  compareTodoItems,
  TODO_PRIORITY,
  type BuildDashboardTodoInput,
  type DashboardTodoItem,
} from "@/lib/dashboard/todo-model";
import type { MissingRecordsAssistant } from "@/lib/dashboard/missing-records-assistant";
import type { ClientsNeedingAttention } from "@/lib/dashboard/clients-needing-attention";
import type { ProcedureActionMetrics } from "@/lib/dashboard/practice-metrics";

// ===========================================================================
// Dashboard V2 Part 2B, ONE To-do model.
// ===========================================================================
//
// These are BEHAVIOURAL tests against the normalizer, not snapshot tests
// against markup. The product law under test:
//
//     Completed work disappears. Unfinished work comes back to To do.
//
// and the structural law:
//
//     four domains → one normalization/dedupe layer → one list

const TODAY = "2026-08-09";

function assistant(
  items: MissingRecordsAssistant["items"],
): MissingRecordsAssistant {
  return { items, hasItems: items.length > 0, totalFound: items.length };
}

function attention(
  clients: ClientsNeedingAttention["clients"],
): ClientsNeedingAttention {
  return { totalClients: clients.length, clients, scanCapped: false };
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

function input(
  over: Partial<BuildDashboardTodoInput> = {},
): BuildDashboardTodoInput {
  return {
    assistant: assistant([]),
    attention: attention([]),
    supplies: [],
    metrics: NO_METRICS,
    studio: NO_STUDIO,
    todayLocal: TODAY,
    ...over,
  };
}

function aftercareItem(clientId: string, clientName: string, sessionId: string) {
  return {
    id: `aftercare:${sessionId}`,
    type: "aftercare" as const,
    priority: 2 as const,
    clientId,
    clientName,
    reason: "Aftercare/risks not marked on the recorded session.",
    date: "2026-08-05T10:00:00.000Z",
    href: `/clients/${clientId}/sessions/${sessionId}`,
    actionLabel: "Review session" as const,
    chip: "Aftercare not marked",
  };
}

function attentionClient(
  clientId: string,
  clientName: string,
  over: Partial<ClientsNeedingAttention["clients"][number]> = {},
) {
  return {
    clientId,
    clientName,
    attentionDate: "2026-08-04T09:00:00.000Z",
    hasWatch: false,
    hasPlan: false,
    notableReactionLabel: null,
    latestToleranceRating: null,
    previewLine: "",
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe("To-do model: all four source domains are still represented", () => {
  const built = buildDashboardTodo(
    input({
      assistant: assistant([aftercareItem("c1", "Maya", "s1")]),
      attention: attention([
        attentionClient("c2", "Dana", { hasWatch: true }),
      ]),
      supplies: [
        {
          id: "sup1",
          item_description: "Sterile probes",
          manufacturer_name: "Acme",
          expiry_date: "2026-07-01",
        },
      ],
      studio: { ...NO_STUDIO, intakesAwaitingReviewCount: 2 },
    }),
  );

  it.each([
    ["Follow-up assistant (record gaps)", "aftercare"],
    ["Action needed (clinical treatment memory)", "treatment_memory"],
    ["Supplies expiring", "supply_expiry"],
    ["Needs attention (studio blockers)", "intake_review"],
  ])("%s survives into the unified list", (_label, kind) => {
    expect(built.items.map((i) => i.kind)).toContain(kind);
  });

  it("produces ONE list, not four groups", () => {
    expect(built.items).toHaveLength(4);
    expect(built.hasItems).toBe(true);
  });

  it("every row answers who / why / what-next", () => {
    for (const item of built.items) {
      expect(item.subject.label, `${item.id} has no subject`).toBeTruthy();
      expect(item.reason, `${item.id} has no reason`).toBeTruthy();
      expect(item.action.label, `${item.id} has no action label`).toBeTruthy();
      expect(item.action.href, `${item.id} has no action href`).toBeTruthy();
    }
  });
});

describe("To-do model: deterministic ordering", () => {
  it("orders by priority tier, and the tiers are the documented ones", () => {
    // Blocking (10s) < record gaps (20s) < context (30s) < soft nudges (40s).
    expect(TODO_PRIORITY.intake_review).toBeLessThan(TODO_PRIORITY.charting);
    expect(TODO_PRIORITY.charting).toBeLessThan(TODO_PRIORITY.aftercare);
    expect(TODO_PRIORITY.aftercare).toBeLessThan(TODO_PRIORITY.probe_lot);
    expect(TODO_PRIORITY.probe_lot).toBeLessThan(
      TODO_PRIORITY.intake_incomplete,
    );
    expect(TODO_PRIORITY.intake_incomplete).toBeLessThan(
      TODO_PRIORITY.treatment_memory,
    );
    expect(TODO_PRIORITY.treatment_memory).toBeLessThan(
      TODO_PRIORITY.payment_setup,
    );
  });

  it("the assistant's own 1..5 relative order is preserved, not re-litigated", () => {
    const order = (
      ["charting", "aftercare", "probe_lot", "intake_incomplete"] as const
    ).map((k) => TODO_PRIORITY[k]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("a blocking studio item outranks every record gap", () => {
    const built = buildDashboardTodo(
      input({
        assistant: assistant([aftercareItem("c1", "Maya", "s1")]),
        studio: { ...NO_STUDIO, intakesAwaitingReviewCount: 1 },
      }),
    );
    expect(built.items[0].kind).toBe("intake_review");
  });

  it("expired stock is blocking; expiring-soon is not", () => {
    const built = buildDashboardTodo(
      input({
        assistant: assistant([aftercareItem("c1", "Maya", "s1")]),
        supplies: [
          {
            id: "expired",
            item_description: "Old probes",
            manufacturer_name: "Acme",
            expiry_date: "2026-07-01",
          },
          {
            id: "soon",
            item_description: "New probes",
            manufacturer_name: "Acme",
            expiry_date: "2026-08-20",
          },
        ],
      }),
    );
    const kinds = built.items.map((i) => i.id);
    expect(kinds.indexOf("supply_expiry:expired")).toBeLessThan(
      kinds.indexOf("aftercare:c1"),
    );
    expect(kinds.indexOf("aftercare:c1")).toBeLessThan(
      kinds.indexOf("supply_expiry:soon"),
    );
  });

  it("ties break newest-first, then by id, a TOTAL order", () => {
    const mk = (id: string, occurredAt: string | null): DashboardTodoItem => ({
      id,
      kind: "aftercare",
      subject: { kind: "client", id, label: id },
      reason: "r",
      detail: null,
      action: { href: "/x", label: "Go" },
      priority: 21,
      occurredAt,
      tone: "normal",
    });
    const older = mk("aftercare:a", "2026-01-01T00:00:00.000Z");
    const newer = mk("aftercare:b", "2026-06-01T00:00:00.000Z");
    expect(compareTodoItems(newer, older)).toBeLessThan(0);

    // Same timestamp -> id decides, deterministically and symmetrically.
    const sameA = mk("aftercare:a", "2026-06-01T00:00:00.000Z");
    const sameB = mk("aftercare:b", "2026-06-01T00:00:00.000Z");
    expect(compareTodoItems(sameA, sameB)).toBeLessThan(0);
    expect(compareTodoItems(sameB, sameA)).toBeGreaterThan(0);
    expect(compareTodoItems(sameA, sameA)).toBe(0);

    // Nulls sort last within their tier.
    expect(compareTodoItems(mk("aftercare:c", null), older)).toBeGreaterThan(0);
  });

  it("is stable: the same input always yields the same order", () => {
    const build = () =>
      buildDashboardTodo(
        input({
          assistant: assistant([
            aftercareItem("c1", "Maya", "s1"),
            { ...aftercareItem("c2", "Dana", "s2"), type: "probe_lot" as const, priority: 3 as const, chip: "Probe lot missing", id: "probe_lot:s2" },
          ]),
          attention: attention([
            attentionClient("c3", "Ari", { hasWatch: true }),
          ]),
        }),
      );
    expect(build().items.map((i) => i.id)).toEqual(
      build().items.map((i) => i.id),
    );
  });
});

describe("To-do model: deduplication is on DOMAIN IDENTITY", () => {
  it("PINNED: the same unresolved aftercare cannot appear twice for one client", () => {
    // Two aftercare rows reach the normalizer for the SAME client, the exact
    // shape the old dashboard produced when the assistant listed a session and
    // the Action-needed tile counted the same gap over a different window.
    const built = buildDashboardTodo(
      input({
        assistant: assistant([
          aftercareItem("c1", "Maya", "s1"),
          aftercareItem("c1", "Maya", "s2"),
        ]),
        // ...and the completeness sweep also saw it.
        metrics: { ...NO_METRICS, aftercareNotMarked: 4, reviewedSessions: 40 },
      }),
    );
    const aftercare = built.items.filter((i) => i.kind === "aftercare");
    expect(aftercare).toHaveLength(1);
    expect(aftercare[0].id).toBe("aftercare:c1");
  });

  it("the aftercare COUNT never becomes a competing row", () => {
    // `aftercareNotMarked` and `missingProbeLots` must not create To-do rows:
    // they are the same conditions the assistant itemizes.
    const built = buildDashboardTodo(
      input({
        metrics: {
          reviewedSessions: 40,
          incompleteRecords: 9,
          missingProbeLots: 7,
          aftercareNotMarked: 5,
          recordsMissingDetails: 0,
        },
      }),
    );
    expect(built.items).toHaveLength(0);
    expect(built.hasItems).toBe(false);
  });

  it("dedupe is NOT by rendered text, identical text for two clients stays two rows", () => {
    const built = buildDashboardTodo(
      input({
        assistant: assistant([
          aftercareItem("c1", "Maya", "s1"),
          aftercareItem("c2", "Maya", "s2"), // same displayed name AND reason
        ]),
      }),
    );
    expect(built.items).toHaveLength(2);
    expect(built.items.map((i) => i.subject.id).sort()).toEqual(["c1", "c2"]);
  });

  it("two genuinely distinct unresolved items for ONE client remain two", () => {
    const built = buildDashboardTodo(
      input({
        assistant: assistant([
          aftercareItem("c1", "Maya", "s1"),
          {
            ...aftercareItem("c1", "Maya", "s1"),
            id: "probe_lot:s1",
            type: "probe_lot" as const,
            priority: 3 as const,
            chip: "Probe lot missing",
          },
        ]),
      }),
    );
    expect(built.items).toHaveLength(2);
    expect(built.items.map((i) => i.kind).sort()).toEqual([
      "aftercare",
      "probe_lot",
    ]);
  });

  it("intake AWAITING REVIEW and intake INCOMPLETE are never collapsed", () => {
    // Different states of different rows, different actions. The assistant
    // deliberately excludes submitted intakes; that must survive normalization.
    const built = buildDashboardTodo(
      input({
        assistant: assistant([
          {
            id: "intake:c1",
            type: "intake" as const,
            priority: 4 as const,
            clientId: "c1",
            clientName: "Dana",
            reason: "Intake started but not submitted.",
            date: null,
            href: "/clients/c1",
            actionLabel: "Open client" as const,
            chip: "Intake incomplete",
          },
        ]),
        studio: { ...NO_STUDIO, intakesAwaitingReviewCount: 1 },
      }),
    );
    expect(built.items.map((i) => i.kind).sort()).toEqual([
      "intake_incomplete",
      "intake_review",
    ]);
  });

  // DASH-TRUTH-01. A plan for the next visit is CLINICAL MEMORY. It is not
  // unresolved work merely because nothing has been rebooked, so it neither
  // creates a To-do nor contributes a reason to one.
  it("P1 plan-only produces NO treatment-memory To-do at all", () => {
    const built = buildDashboardTodo(
      input({
        attention: attention([attentionClient("c1", "Maya", { hasPlan: true })]),
      }),
    );
    expect(built.items).toHaveLength(0);
    expect(built.hasItems).toBe(false);
  });

  it("P3 watch + plan keeps the row for the WATCH, and never names the plan", () => {
    const built = buildDashboardTodo(
      input({
        attention: attention([
          attentionClient("c1", "Maya", { hasPlan: true, hasWatch: true }),
        ]),
      }),
    );
    expect(built.items).toHaveLength(1);
    expect(built.items[0].kind).toBe("treatment_memory");
    expect(built.items[0].reason).toContain("Watch note");
    expect(built.items[0].reason).not.toContain("Plan for next visit");
  });

  it("P4 reaction + plan keeps the row for the REACTION, and never names the plan", () => {
    const built = buildDashboardTodo(
      input({
        attention: attention([
          attentionClient("c1", "Maya", {
            hasPlan: true,
            notableReactionLabel: "Blistering",
          }),
        ]),
      }),
    );
    expect(built.items).toHaveLength(1);
    expect(built.items[0].reason).toContain("Blistering");
    expect(built.items[0].reason).not.toContain("Plan for next visit");
  });

  it("no To-do reason anywhere can name the plan", () => {
    const built = buildDashboardTodo(
      input({
        attention: attention([
          attentionClient("c1", "Maya", { hasPlan: true, hasWatch: true }),
          attentionClient("c2", "Ada", { hasPlan: true }),
        ]),
      }),
    );
    for (const i of built.items) {
      expect(i.reason).not.toMatch(/Plan for next visit/);
    }
  });
});

describe("To-do model: one client's item never adopts another's identity", () => {
  it("subject, href and id all stay bound to the same client", () => {
    const built = buildDashboardTodo(
      input({
        assistant: assistant([
          aftercareItem("client-a", "Ana", "sess-a"),
          {
            ...aftercareItem("client-b", "Ben", "sess-b"),
            id: "charting:appt-b",
            type: "charting" as const,
            priority: 1 as const,
            chip: "Charting needed",
            href: "/clients/client-b/sessions/new?appointment_id=appt-b",
            actionLabel: "Chart appointment" as const,
          },
        ]),
        attention: attention([
          attentionClient("client-c", "Cara", { hasWatch: true }),
        ]),
      }),
    );
    for (const item of built.items) {
      expect(item.id).toContain(item.subject.id);
      if (item.subject.kind === "client") {
        expect(
          item.action.href,
          `${item.id} links to a different client`,
        ).toContain(item.subject.id);
      }
    }
    const byClient = new Map(built.items.map((i) => [i.subject.id, i]));
    expect(byClient.get("client-a")!.subject.label).toBe("Ana");
    expect(byClient.get("client-b")!.subject.label).toBe("Ben");
    expect(byClient.get("client-c")!.subject.label).toBe("Cara");
  });
});

describe("To-do model: completed work disappears", () => {
  it.each([
    [
      "the assistant's gap is filled",
      () => input({ assistant: assistant([aftercareItem("c1", "Maya", "s1")]) }),
      () => input({ assistant: assistant([]) }),
    ],
    [
      "the intake queue is cleared",
      () => input({ studio: { ...NO_STUDIO, intakesAwaitingReviewCount: 3 } }),
      () => input({ studio: { ...NO_STUDIO, intakesAwaitingReviewCount: 0 } }),
    ],
    [
      "a service is added",
      () => input({ studio: { ...NO_STUDIO, activeServicesCount: 0 } }),
      () => input({ studio: { ...NO_STUDIO, activeServicesCount: 1 } }),
    ],
    [
      "the record details are filled in",
      () =>
        input({
          metrics: { ...NO_METRICS, recordsMissingDetails: 2, reviewedSessions: 9 },
        }),
      () => input({ metrics: NO_METRICS }),
    ],
    [
      "the expiring supply is replaced",
      () =>
        input({
          supplies: [
            {
              id: "s",
              item_description: "Probes",
              manufacturer_name: "Acme",
              expiry_date: "2026-07-01",
            },
          ],
        }),
      () =>
        input({
          supplies: [
            {
              id: "s",
              item_description: "Probes",
              manufacturer_name: "Acme",
              expiry_date: "2027-07-01",
            },
          ],
        }),
    ],
  ])("%s → the row is gone", (_label, unresolved, resolved) => {
    expect(buildDashboardTodo(unresolved()).items.length).toBeGreaterThan(0);
    expect(buildDashboardTodo(resolved()).items).toHaveLength(0);
  });

  it("a supply with no expiry recorded never becomes a to-do", () => {
    const built = buildDashboardTodo(
      input({
        supplies: [
          {
            id: "s",
            item_description: "Probes",
            manufacturer_name: "Acme",
            expiry_date: null,
          },
        ],
      }),
    );
    expect(built.items).toHaveLength(0);
  });
});

describe("To-do model: existing actions are preserved, none are dead", () => {
  it("the assistant's deep links survive verbatim", () => {
    const deep = "/clients/c1/sessions/new?appointment_id=appt-1";
    const built = buildDashboardTodo(
      input({
        assistant: assistant([
          {
            id: "charting:appt-1",
            type: "charting" as const,
            priority: 1 as const,
            clientId: "c1",
            clientName: "Maya",
            reason: "Completed appointment, charting needed.",
            date: "2026-08-05T10:00:00.000Z",
            href: deep,
            actionLabel: "Chart appointment" as const,
            chip: "Charting needed",
          },
        ]),
      }),
    );
    expect(built.items[0].action).toEqual({
      href: deep,
      label: "Chart appointment",
    });
  });

  it.each([
    ["intake_review", "/clients", { intakesAwaitingReviewCount: 1 }],
    ["no_services", "/settings/services", { activeServicesCount: 0 }],
  ])("%s keeps its route", (kind, href, over) => {
    const built = buildDashboardTodo(
      input({ studio: { ...NO_STUDIO, ...over } }),
    );
    const item = built.items.find((i) => i.kind === kind)!;
    expect(item.action.href).toBe(href);
  });

  it("the payment nudge keeps its precedence ladder and its route", () => {
    const at = (over: Record<string, boolean>) =>
      buildDashboardTodo(
        input({
          studio: {
            ...NO_STUDIO,
            paymentStatus: {
              hasAccount: true,
              onboardingCompleted: true,
              payoutsEnabled: true,
              ...over,
            },
          },
        }),
      ).items.find((i) => i.kind === "payment_setup");

    expect(at({ hasAccount: false })!.reason).toBe("Stripe not connected yet");
    expect(at({ onboardingCompleted: false })!.reason).toBe(
      "Stripe setup not finished",
    );
    expect(at({ payoutsEnabled: false })!.reason).toBe(
      "Payout setup needs attention",
    );
    expect(at({})).toBeUndefined();
    // Only ever ONE payment row, even when several steps are unmet.
    const many = buildDashboardTodo(
      input({
        studio: {
          ...NO_STUDIO,
          paymentStatus: {
            hasAccount: false,
            onboardingCompleted: false,
            payoutsEnabled: false,
          },
        },
      }),
    );
    expect(many.items.filter((i) => i.kind === "payment_setup")).toHaveLength(1);
  });

  it("non-owners never see owner-only setup items", () => {
    const built = buildDashboardTodo(
      input({
        studio: {
          isOwner: false,
          intakesAwaitingReviewCount: 0,
          activeServicesCount: 0,
          paymentStatus: {
            hasAccount: false,
            onboardingCompleted: false,
            payoutsEnabled: false,
          },
        },
      }),
    );
    expect(built.items).toHaveLength(0);
  });

  it("every emitted action href is a real internal route, never a placeholder", () => {
    const built = buildDashboardTodo(
      input({
        assistant: assistant([aftercareItem("c1", "Maya", "s1")]),
        attention: attention([attentionClient("c2", "Dana", { hasWatch: true })]),
        supplies: [
          {
            id: "s",
            item_description: "Probes",
            manufacturer_name: "Acme",
            expiry_date: "2026-07-01",
          },
        ],
        metrics: { ...NO_METRICS, recordsMissingDetails: 1, reviewedSessions: 5 },
        studio: {
          ...NO_STUDIO,
          intakesAwaitingReviewCount: 1,
          activeServicesCount: 0,
          paymentStatus: {
            hasAccount: false,
            onboardingCompleted: false,
            payoutsEnabled: false,
          },
        },
      }),
    );
    expect(built.items.length).toBeGreaterThanOrEqual(6);
    for (const item of built.items) {
      expect(item.action.href, `${item.id}`).toMatch(/^\/[a-z]/);
      expect(item.action.href).not.toMatch(/^#|undefined|null/);
    }
  });
});

describe("To-do model: empty state", () => {
  it("nothing unresolved => no items at all", () => {
    const built = buildDashboardTodo(input());
    expect(built.items).toEqual([]);
    expect(built.hasItems).toBe(false);
  });

  it("the list component renders ONE empty state, not four", () => {
    const src = readFileSync(
      join(process.cwd(), "app/(app)/dashboard/todo-list.tsx"),
      "utf8",
    );
    const emptyBranches = src.match(/hasItems/g) ?? [];
    expect(emptyBranches).toHaveLength(1);
    expect(src).toMatch(/Nothing to do right now/);
  });
});

describe("To-do model: no I/O, no N+1", () => {
  const SRC = readFileSync(
    join(process.cwd(), "lib/dashboard/todo-model.ts"),
    "utf8",
  );

  it("the normalizer is synchronous and pure, it cannot query", () => {
    expect(buildDashboardTodo(input())).not.toBeInstanceOf(Promise);
    expect(SRC).not.toMatch(/\bawait\b/);
    expect(SRC).not.toMatch(/\basync\b/);
    expect(SRC).not.toMatch(/createClient|supabase|\.from\(/);
    expect(SRC).not.toMatch(/new Date\(|Date\.now\(/);
  });

  it("the rendered list issues no query inside its row loop", () => {
    const view = readFileSync(
      join(process.cwd(), "app/(app)/dashboard/todo-list.tsx"),
      "utf8",
    );
    const loop = view.slice(view.indexOf("todo.items.map("));
    expect(loop.length).toBeGreaterThan(0);
    expect(loop).not.toMatch(/\bawait\b/);
    expect(loop).not.toMatch(/createClient|supabase|\.from\(/);
    expect(view).not.toMatch(/\basync\b/);
  });

  it("the page gained NO loader for the unified list", () => {
    const page = readFileSync(
      join(process.cwd(), "app/(app)/dashboard/page.tsx"),
      "utf8",
    );
    // buildDashboardTodo is called once, and it is not awaited.
    expect(page.match(/buildDashboardTodo\(/g) ?? []).toHaveLength(1);
    expect(page).not.toMatch(/await buildDashboardTodo/);
    // The four domain loaders are still called exactly once each.
    for (const re of [
      /getMissingRecordsAssistant\(/g,
      /getClientsNeedingAttention\(/g,
      /getExpiringSterileItems\(/g,
      /getPracticeDashboardMetrics\(/g,
    ]) {
      expect(page.match(re) ?? []).toHaveLength(1);
    }
  });
});
