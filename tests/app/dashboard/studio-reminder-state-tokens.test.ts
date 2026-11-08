import { describe, expect, it } from "vitest";
import { buildNeedsAttention } from "@/lib/dashboard/needs-attention-model";
import { applyDismissals, studioIdentity } from "@/lib/dashboard/needs-attention-visibility";
import { buildDashboardTodo, type BuildDashboardTodoInput, type DashboardTodoItem } from "@/lib/dashboard/todo-model";

// Privacy AO3 on #1356: a dismissed STUDIO-level reminder comes back when the state it reports changes. The dismissal token is derived
// from that state (which setup step is missing; how many intakes or records; the supply plus its expiry date), never the constant "1".
// Studio kinds that can be dismissed: payment_setup, no_services, intake_review (studio roll-up), records_details, supply_expiry.

const EMPTY_ASSISTANT = { items: [], hasItems: false, totalFound: 0, allItems: [], allTotal: 0 } as never;
const metrics = (recordsMissingDetails = 0) => ({ reviewedSessions: 40, incompleteRecords: 0, missingProbeLots: 0, aftercareNotMarked: 0, recordsMissingDetails });
const STUDIO = { isOwner: true, intakesAwaitingReviewCount: 0, activeServicesCount: 3, paymentStatus: { hasAccount: true, onboardingCompleted: true, payoutsEnabled: true } };

function todoItems(over: { studio?: Partial<typeof STUDIO>; paymentStatus?: Partial<typeof STUDIO.paymentStatus>; recordsMissingDetails?: number; supplies?: unknown[] } = {}): DashboardTodoItem[] {
  const studio = { ...STUDIO, ...over.studio, paymentStatus: { ...STUDIO.paymentStatus, ...over.paymentStatus } };
  const input = {
    assistant: EMPTY_ASSISTANT,
    attention: { totalClients: 0, clients: [], scanCapped: false },
    supplies: over.supplies ?? [],
    metrics: metrics(over.recordsMissingDetails),
    studio,
    todayLocal: "2026-11-04",
  } as unknown as BuildDashboardTodoInput;
  return buildDashboardTodo(input).items;
}
const find = (items: DashboardTodoItem[], kind: string) => items.find((i) => i.kind === kind);
const model = (items: DashboardTodoItem[]) => buildNeedsAttention({ assistant: EMPTY_ASSISTANT, intakesAwaitingReview: [], todo: { items, moreCount: 0 } as never } as never);
const shownKinds = (items: DashboardTodoItem[], stored: Array<{ itemKey: string; instanceToken: string }>) =>
  applyDismissals(model(items), stored).shown.studioItems.map((i) => i.kind);
/** Dismiss exactly what the owner would, from the item as it was shown. */
const dismissal = (item: DashboardTodoItem) => {
  const id = studioIdentity(item);
  expect(id, `${item.kind} must be dismissable`).not.toBeNull();
  return [{ itemKey: id!.itemKey, instanceToken: id!.instanceToken }];
};

describe("every dismissable studio reminder carries a state-derived token, never the constant", () => {
  it("no studio reminder's token is the constant 1", () => {
    const items = todoItems({
      studio: { intakesAwaitingReviewCount: 2, activeServicesCount: 0 },
      paymentStatus: { hasAccount: false },
      recordsMissingDetails: 3,
    });
    expect(items.filter((i) => i.subject.kind === "studio").map((i) => i.kind).sort()).toEqual(["intake_review", "no_services", "payment_setup", "records_details"]);
    for (const i of items.filter((x) => x.subject.kind === "studio")) {
      const id = studioIdentity(i);
      expect(id, i.kind).not.toBeNull();
      expect(id!.instanceToken, i.kind).not.toBe("1");
    }
  });
});

describe("a dismissed setup reminder returns when the missing step changes", () => {
  const at = (paymentStatus: Record<string, boolean>) => find(todoItems({ paymentStatus }), "payment_setup")!;
  const noAccount = at({ hasAccount: false });
  const unfinished = at({ onboardingCompleted: false });
  const payouts = at({ payoutsEnabled: false });
  it("the three steps carry three different tokens", () => {
    const tokens = [noAccount, unfinished, payouts].map((i) => studioIdentity(i)!.instanceToken);
    expect(new Set(tokens).size).toBe(3);
  });
  it("dismissed at 'not connected': hidden while it is still that, shown again at 'setup not finished' and again at 'payouts'", () => {
    const stored = dismissal(noAccount);
    expect(shownKinds([noAccount], stored)).toEqual([]);
    expect(shownKinds([unfinished], stored)).toEqual(["payment_setup"]);
    expect(shownKinds([payouts], stored)).toEqual(["payment_setup"]);
  });
  it("dismissed at 'payouts needs attention' (a restricted account), then the account is connected afresh: the earlier step shows again", () => {
    expect(shownKinds([noAccount], dismissal(payouts))).toEqual(["payment_setup"]);
  });
});

describe("other studio reminders return when their state changes", () => {
  it("no services: hidden while none, and a different reminder shows when it is a different state", () => {
    const none = find(todoItems({ studio: { activeServicesCount: 0 } }), "no_services")!;
    expect(shownKinds([none], dismissal(none))).toEqual([]);
    expect(shownKinds([{ ...none, state: "other" } as DashboardTodoItem], dismissal(none))).toEqual(["no_services"]);
  });
  it("intakes awaiting review: a different count is a new reminder", () => {
    const two = find(todoItems({ studio: { intakesAwaitingReviewCount: 2 } }), "intake_review")!;
    const five = find(todoItems({ studio: { intakesAwaitingReviewCount: 5 } }), "intake_review")!;
    // (The model replaces this roll-up with one entry per client when it has them; the identity is what a dismissal of it would store.)
    expect(studioIdentity(two)!.instanceToken).not.toBe(studioIdentity(five)!.instanceToken);
    expect(studioIdentity(two)!.instanceToken).toBe(studioIdentity(find(todoItems({ studio: { intakesAwaitingReviewCount: 2 } }), "intake_review")!)!.instanceToken);
  });
  it("records missing details: a different count is a new reminder", () => {
    const three = find(todoItems({ recordsMissingDetails: 3 }), "records_details")!;
    const four = find(todoItems({ recordsMissingDetails: 4 }), "records_details")!;
    expect(shownKinds([three], dismissal(three))).toEqual([]);
    expect(shownKinds([four], dismissal(three))).toEqual(["records_details"]);
  });
  it("a supply reminder is the item plus its expiry date: a new expiry, or another supply, shows again", () => {
    const supply = (id: string, expiry: string) => ({ id: `supply_expiry:${id}`, kind: "supply_expiry", subject: { kind: "supply", id, label: "Gel" }, reason: "Expires soon", detail: null, action: { href: "/x", label: "Open" }, priority: 5, occurredAt: expiry, tone: "normal" }) as unknown as DashboardTodoItem;
    // supply items are not "studio" subjects in the builder, so exercise the identity directly as the panel and model do.
    const a = supply("s1", "2026-12-01");
    const stored = dismissal(a);
    expect(studioIdentity(a)!.instanceToken).toBe("2026-12-01");
    expect(studioIdentity(supply("s1", "2027-01-15"))!.instanceToken).not.toBe(stored[0].instanceToken);
    expect(studioIdentity(supply("s2", "2026-12-01"))!.itemKey).not.toBe(stored[0].itemKey);
  });
});

describe("a studio reminder that reports no state is not dismissable (never hidden on a guess)", () => {
  it("identity is null, and a stored dismissal with any token never hides it", () => {
    const noState = { ...find(todoItems({ paymentStatus: { hasAccount: false } }), "payment_setup")!, state: undefined } as DashboardTodoItem;
    expect(studioIdentity(noState)).toBeNull();
    expect(shownKinds([noState], [{ itemKey: noState.id, instanceToken: "1" }])).toEqual(["payment_setup"]);
    const blank = { ...noState, state: "  " } as DashboardTodoItem;
    expect(studioIdentity(blank)).toBeNull();
  });
});
