import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { buildNeedsAttention } from "@/lib/dashboard/needs-attention-model";
import { buildMissingRecordsAssistant } from "@/lib/dashboard/missing-records-assistant";
import type { DashboardTodo, DashboardTodoItem } from "@/lib/dashboard/todo-model";

vi.mock("next/link", () => ({
  default: (p: { href: string; children?: unknown }) => createElement("a", { href: p.href }, p.children as never),
}));
const { NeedsAttentionPanel, hiddenCardsLabel, NEEDS_ATTENTION_COMPACT_COUNT } = await import(
  "@/app/(app)/dashboard/needs-attention-panel"
);

// Synthetic fixtures only. Insurance PEER-1308 D-2.
const todoItem = (over: Partial<DashboardTodoItem>): DashboardTodoItem => ({
  id: "t",
  kind: "treatment_memory",
  subject: { kind: "client", id: "r1", label: "Reaction Client" },
  reason: "Reaction recorded",
  detail: null,
  action: { label: "Open", href: "/clients/r1" },
  priority: 1,
  occurredAt: "2026-01-01T00:00:00Z",
  tone: "normal",
  ...over,
});

function build(opts: { docClients: number; prepClients?: number; studio?: boolean }) {
  const sessions = Array.from({ length: opts.docClients }, (_, i) => ({
    sessionId: `s${i}`,
    clientId: `d${i}`,
    clientName: `Doc Client ${i}`,
    startedAt: `2026-10-${String(10 + i).padStart(2, "0")}T15:00:00.000Z`,
    hasTreatmentArea: true,
    aftercareMarked: false,
    probeLotMissing: false,
  }));
  const assistant = buildMissingRecordsAssistant({ unchartedAppointments: [], incompleteIntakes: [], sessions });
  const prep = Array.from({ length: opts.prepClients ?? 0 }, (_, i) => ({
    clientId: `p${i}`,
    clientName: `Prep Client ${i}`,
    submittedAt: `2026-10-${String(1 + i).padStart(2, "0")}T00:00:00Z`,
  }));
  const items: DashboardTodoItem[] = [todoItem({})];
  if (opts.studio) {
    items.push(
      todoItem({
        id: "studio1",
        kind: "no_services",
        subject: { kind: "studio", id: "studio", label: "Booking" },
        reason: "No services",
      }),
    );
  }
  const todo: DashboardTodo = { items, hasItems: true, moreCount: 0 };
  return buildNeedsAttention({
    assistant,
    intakesAwaitingReview: prep,
    todo,
    upcomingVisitClientIds: new Set(prep.map((p) => p.clientId)),
  });
}

describe("reaction/watch cards sort ahead of documentation-tier cards", () => {
  it("a reaction-only client that is OLDER than seven documentation clients still sorts before them", () => {
    const out = build({ docClients: 7 });
    expect(out.clients.length).toBe(8);
    expect(out.clients[0].clientId).toBe("r1");
    expect(out.clients[0].items.map((i) => i.kind)).toEqual(["treatment_memory"]);
    expect(out.clients.slice(1).every((c) => c.clientId.startsWith("d"))).toBe(true);
  });
  it("before-visit cards still come first", () => {
    const out = build({ docClients: 2, prepClients: 2 });
    expect(out.clients.slice(0, 2).every((c) => c.tier === "preparation")).toBe(true);
    expect(out.clients[2].clientId).toBe("r1");
  });
});

describe("the compact cut: studio card exempt, button names what it hides", () => {
  it("with 7+ cards the reaction-only client is inside the visible six", () => {
    const html = renderToStaticMarkup(createElement(NeedsAttentionPanel, { needs: build({ docClients: 7 }) }));
    expect(html).toContain('data-attention-client="r1"');
    expect(html).toContain("Show 2 more clients");
    expect(html).not.toContain("including");
    expect((html.match(/data-attention-client=/g) ?? []).length).toBe(NEEDS_ATTENTION_COMPACT_COUNT);
  });
  it("the studio card is always rendered, even when six client cards are shown", () => {
    const html = renderToStaticMarkup(createElement(NeedsAttentionPanel, { needs: build({ docClients: 9, studio: true }) }));
    expect(html).toContain("data-attention-studio");
    expect((html.match(/data-attention-client=/g) ?? []).length).toBe(NEEDS_ATTENTION_COMPACT_COUNT);
    // the studio card is not counted as a hidden client
    expect(html).toContain("Show 4 more clients");
    expect(html).not.toContain("studio items");
  });
  it("a reaction/watch card pushed behind the cut by before-visit cards is named on the button", () => {
    const html = renderToStaticMarkup(createElement(NeedsAttentionPanel, { needs: build({ docClients: 1, prepClients: 7 }) }));
    expect(html).not.toContain('data-attention-client="r1"');
    expect(html).toContain("Show 3 more clients, including 1 reaction/watch");
  });
  it("label wording", () => {
    expect(hiddenCardsLabel(1, 0)).toBe("Show 1 more client");
    expect(hiddenCardsLabel(5, 2)).toBe("Show 5 more clients, including 2 reaction/watch");
  });
});
