import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildNeedsAttention, type UnpaidAttention } from "@/lib/dashboard/needs-attention-model";
import { applyDismissals, headingCount, itemIdentity, unpaidToken } from "@/lib/dashboard/needs-attention-visibility";
import { safeToken } from "@/lib/dashboard/attention-identity";
import type { DashboardTodo, DashboardTodoItem } from "@/lib/dashboard/todo-model";

const EMPTY_ASSISTANT = { items: [], hasItems: false, totalFound: 0, allItems: [], allTotal: 0 } as never;
const todo = (items: DashboardTodoItem[] = []): DashboardTodo => ({ items, moreCount: 0 } as unknown as DashboardTodo);
const setup = (id: string, kind: string, label = "Payments"): DashboardTodoItem =>
  ({
    id, kind, subject: { kind: "studio", id: "studio", label }, reason: "Stripe not connected yet", detail: null,
    action: { label: "Open payments", href: "/settings/payments" }, priority: 10, occurredAt: null, state: "no_account", tone: "normal",
  }) as unknown as DashboardTodoItem;
const unpaid = (id: string, client: string, cents: number | null): UnpaidAttention => ({
  appointmentId: id, clientId: client, clientName: `Client ${client}`, endsAt: "2026-11-01T15:00:00Z",
  balance: cents === null ? { kind: "unavailable" } : { kind: "owed", outstandingCents: cents, currency: "cad" },
});
const intake = (client: string, at: string) => ({ clientId: client, clientName: `Client ${client}`, submittedAt: at }) as never;
const model = (over: Record<string, unknown> = {}) =>
  buildNeedsAttention({ assistant: EMPTY_ASSISTANT, intakesAwaitingReview: [], todo: todo(), ...over } as never);

describe("one count, from what the owner sees", () => {
  it("counts clients and items after dismissals, never a dismissed one", () => {
    const m = model({ intakesAwaitingReview: [intake("c1", "2026-10-30T10:00:00Z"), intake("c2", "2026-10-31T10:00:00Z")], unpaid: [unpaid("a1", "c1", 5000)] });
    expect(headingCount(m)).toEqual({ clients: 2, items: 3 });
    const { shown } = applyDismissals(m, [{ itemKey: "unpaid:a1", instanceToken: unpaidToken(5000) }]);
    expect(headingCount(shown)).toEqual({ clients: 2, items: 2 });
    const { shown: s2 } = applyDismissals(m, [
      { itemKey: "unpaid:a1", instanceToken: unpaidToken(5000) },
      { itemKey: "intake:c1:intake_review", instanceToken: safeToken("2026-10-30T10:00:00Z") },
    ]);
    expect(headingCount(s2)).toEqual({ clients: 1, items: 1 });
  });
});

describe("a new issue for the same client still shows", () => {
  it("a new intake submission reappears; the same submission stays hidden", () => {
    const stored = [{ itemKey: "intake:c1:intake_review", instanceToken: safeToken("2026-10-30T10:00:00Z") }];
    expect(applyDismissals(model({ intakesAwaitingReview: [intake("c1", "2026-10-30T10:00:00Z")] }), stored).shown.clients).toHaveLength(0);
    expect(applyDismissals(model({ intakesAwaitingReview: [intake("c1", "2026-11-03T10:00:00Z")] }), stored).shown.clients).toHaveLength(1);
  });
});

describe("unpaid items", () => {
  const stored = [{ itemKey: "unpaid:a1", instanceToken: unpaidToken(6000) }];
  it("stay dismissed while the balance is at or below what was dismissed", () => {
    expect(applyDismissals(model({ unpaid: [unpaid("a1", "c1", 6000)] }), stored).shown.clients).toHaveLength(0);
    expect(applyDismissals(model({ unpaid: [unpaid("a1", "c1", 2500)] }), stored).shown.clients).toHaveLength(0);
  });
  it("come back when the balance rises", () => {
    const r = applyDismissals(model({ unpaid: [unpaid("a1", "c1", 8500)] }), stored);
    expect(r.shown.clients).toHaveLength(1);
    expect(r.shown.clients[0].items[0].balance).toEqual({ kind: "owed", outstandingCents: 8500, currency: "cad" });
  });
  it("an unknown balance is shown as unavailable, never 0, and cannot be dismissed or hidden", () => {
    const m = model({ unpaid: [unpaid("a1", "c1", null)] });
    const item = m.clients[0].items[0];
    expect(item.balance).toEqual({ kind: "unavailable" });
    expect(itemIdentity(item)).toBeNull();
    expect(applyDismissals(m, [{ itemKey: "unpaid:a1", instanceToken: "unknown" }, ...stored]).shown.clients).toHaveLength(1);
  });
  it("a paid appointment is simply not in the input and does not appear", () => {
    expect(model({ unpaid: [] }).clients).toHaveLength(0);
  });
  it("the Dismissed rows keep the stored token so Restore can name it", () => {
    const r = applyDismissals(model({ unpaid: [unpaid("a1", "c1", 2500)] }), stored);
    expect(r.dismissed).toEqual([expect.objectContaining({ itemKey: "unpaid:a1", instanceToken: unpaidToken(6000), kind: "unpaid" })]);
  });
});

describe("setup reminders are dismissable and only the reminder hides", () => {
  const item = setup("payment_setup:studio", "payment_setup");
  it("hides the studio reminder and lists it as dismissed; the model's source item is untouched", () => {
    const m = model({ todo: todo([item]) });
    expect(m.studioItems).toHaveLength(1);
    const r = applyDismissals(m, [{ itemKey: "payment_setup:studio", instanceToken: "no_account" }]);
    expect(r.shown.studioItems).toHaveLength(0);
    expect(r.dismissed[0]).toEqual(expect.objectContaining({ kind: "studio", who: "Payments", href: "/settings/payments" }));
    // The input model and the todo item (the real setup status carrier) are unchanged.
    expect(m.studioItems).toHaveLength(1);
    expect(item.reason).toBe("Stripe not connected yet");
  });
  it("a supply reminder returns when its expiry date changes", () => {
    const supply = { ...setup("supply_expiry:s1", "supply_expiry", "Gel"), occurredAt: "2026-12-01" } as DashboardTodoItem;
    const stored = [{ itemKey: "supply_expiry:s1", instanceToken: "2026-12-01" }];
    expect(applyDismissals(model({ todo: todo([supply]) }), stored).shown.studioItems).toHaveLength(0);
    const moved = { ...supply, occurredAt: "2027-01-15" } as DashboardTodoItem;
    expect(applyDismissals(model({ todo: todo([moved]) }), stored).shown.studioItems).toHaveLength(1);
  });
});

describe("dismissal removes a reminder and nothing else", () => {
  it("the module is pure: no loader, no payment, message, charge or clock", () => {
    const src = readFileSync("lib/dashboard/needs-attention-visibility.ts", "utf8").replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/supabase|payment|stripe|charge|settle|message|sms|email|Date\.now|new Date|fetch\(/i);
    expect(src).not.toMatch(/^import .*from "@\/lib\/(supabase|billing|payments)/m);
  });
  it("applying dismissals does not mutate the input model", () => {
    const m = model({ intakesAwaitingReview: [intake("c1", "2026-10-30T10:00:00Z")], unpaid: [unpaid("a1", "c1", 5000)] });
    const before = JSON.stringify(m);
    applyDismissals(m, [{ itemKey: "unpaid:a1", instanceToken: unpaidToken(5000) }]);
    expect(JSON.stringify(m)).toBe(before);
  });
});
