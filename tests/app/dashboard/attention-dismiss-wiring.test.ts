import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const role = vi.hoisted(() => ({ value: "owner" }));
const rpc = vi.hoisted(() => vi.fn(async (..._a: unknown[]): Promise<{ data: unknown; error: unknown }> => ({ data: { ok: true, changed: true }, error: null })));
vi.mock("@/lib/supabase/queries", () => ({
  requirePractitionerWithStudio: vi.fn(async () => ({ practitioner: { role: role.value }, studio: { id: "studio-1" } })),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({ rpc })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), redirect: vi.fn() }));
vi.mock("next/link", () => ({ default: (p: { href: string; children?: unknown }) => createElement("a", { href: p.href }, p.children as never) }));

const { dismissAttentionAction, restoreAttentionAction } = await import("@/app/(app)/dashboard/actions");
const { NeedsAttentionPanel } = await import("@/app/(app)/dashboard/needs-attention-panel");
const { buildNeedsAttention } = await import("@/lib/dashboard/needs-attention-model");

beforeEach(() => {
  role.value = "owner";
  rpc.mockClear();
});

describe("dismiss and restore actions are owner-only on the server", () => {
  it("refuse a non-owner before the database is called", async () => {
    role.value = "practitioner";
    expect(await dismissAttentionAction("intake:c1:intake_review", "t1")).toEqual({ ok: false, code: "refused" });
    expect(await restoreAttentionAction("intake:c1:intake_review")).toEqual({ ok: false, code: "refused" });
    expect(rpc).not.toHaveBeenCalled();
  });
  it("refuse malformed keys and tokens without calling the database", async () => {
    for (const [k, t] of [["", "1"], ["a b", "1"], ["x:1", "a;b"], [1, "1"], ["x:1", undefined]]) {
      expect(await dismissAttentionAction(k, t)).toEqual({ ok: false, code: "invalid_item" });
    }
    expect(await restoreAttentionAction("bad key")).toEqual({ ok: false, code: "invalid_item" });
    expect(rpc).not.toHaveBeenCalled();
  });
  it("send exactly the studio, key and token to the owner-only commands, and nothing money-shaped", async () => {
    await dismissAttentionAction("unpaid:a1", "c5000");
    await restoreAttentionAction("unpaid:a1");
    expect(rpc).toHaveBeenNthCalledWith(1, "dismiss_attention_item", { p_studio: "studio-1", p_item_key: "unpaid:a1", p_instance_token: "c5000" });
    expect(rpc).toHaveBeenNthCalledWith(2, "restore_attention_item", { p_studio: "studio-1", p_item_key: "unpaid:a1" });
  });
  it("a database refusal or error is a plain code, never ok", async () => {
    rpc.mockResolvedValueOnce({ data: { ok: false, code: "refused" }, error: null });
    expect(await dismissAttentionAction("x:1", "1")).toEqual({ ok: false, code: "refused" });
    rpc.mockResolvedValueOnce({ data: null, error: { code: "42883" } });
    expect(await restoreAttentionAction("x:1")).toEqual({ ok: false, code: "unavailable" });
  });
});

describe("the panel", () => {
  const model = buildNeedsAttention({
    assistant: { items: [], hasItems: false, totalFound: 0, allItems: [], allTotal: 0 } as never,
    intakesAwaitingReview: [{ clientId: "c1", clientName: "Ada Client", submittedAt: "2026-10-30T10:00:00Z" } as never],
    todo: { items: [], moreCount: 0 } as never,
    unpaid: [
      { appointmentId: "a1", clientId: "c2", clientName: "Bo Client", endsAt: "2026-11-01T15:00:00Z", balance: { kind: "owed", outstandingCents: 5000, currency: "cad" } },
      { appointmentId: "a2", clientId: "c3", clientName: "Cy Client", endsAt: "2026-11-01T16:00:00Z", balance: { kind: "unavailable" } },
    ],
  });
  const render = (over: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(NeedsAttentionPanel, { needs: model, ...over } as never));
  it("owner: Dismiss on dismissable items; the unpaid amount is the authoritative figure; an unknown balance reads Amount unavailable and has no Dismiss", () => {
    const html = render({ isOwner: true });
    expect(html).toContain("Still owes $50.00 CAD");
    expect(html).toContain("Amount unavailable");
    expect(html.match(/data-testid="attention-dismiss"/g)).toHaveLength(2); // the intake and the known unpaid; not the unknown one
    expect(html).not.toMatch(/Still owes \$0\.00/);
  });
  it("non-owner: no Dismiss, no Dismissed view, even if rows were passed", () => {
    const html = render({ isOwner: false, dismissed: [{ itemKey: "k", instanceToken: "1", who: "X", label: "L", detail: null, kind: "studio", href: "/h", actionLabel: "Open" }] });
    expect(html).not.toContain("attention-dismiss");
    expect(html).not.toContain("attention-restore");
  });
  it("owner whose dismissals could not be read: every reminder shown, Dismiss withheld, and it says so", () => {
    const html = render({ isOwner: true, dismissalsUnavailable: true });
    expect(html).not.toContain('data-testid="attention-dismiss"');
    expect(html).toContain('data-testid="attention-dismissals-unavailable"');
  });
  it("owner: a Dismissed (N) control lists nothing until opened, and the count is NOT repeated in the panel", () => {
    const html = render({ isOwner: true, dismissed: [{ itemKey: "k", instanceToken: "1", who: "Payments", label: "Stripe not connected yet", detail: null, kind: "studio", href: "/settings/payments", actionLabel: "Open payments" }] });
    expect(html).toContain("Dismissed (1)");
    expect(html).not.toContain("Stripe not connected yet");
    expect(html).not.toContain('data-testid="needs-attention-count"');
  });
  it("an empty list with dismissed rows is still the all-clear, with the Dismissed control kept", () => {
    const empty = buildNeedsAttention({ assistant: { items: [], hasItems: false, totalFound: 0, allItems: [], allTotal: 0 } as never, intakesAwaitingReview: [], todo: { items: [], moreCount: 0 } as never });
    const html = renderToStaticMarkup(
      createElement(NeedsAttentionPanel, { needs: empty, isOwner: true, dismissed: [{ itemKey: "k", instanceToken: "1", who: "Payments", label: "x", detail: null, kind: "studio", href: "/h", actionLabel: "Open" }] } as never),
    );
    expect(html).toContain("Nothing needs attention right now");
    expect(html).toContain("Dismissed (1)");
  });
  it("owner: says what the unpaid check covers and offers the bounded All outstanding view; says when it is cut", () => {
    const html = render({ isOwner: true, unpaid: { windowDays: 90, notReturned: 3 }, unpaidHrefs: { all: "?period=day&unpaid=all", recent: "?period=day" } });
    expect(html).toContain("finished in the last 90 days");
    expect(html).toContain('data-testid="needs-attention-unpaid-capped"');
    expect(html).toContain('href="?period=day&amp;unpaid=all"');
    const all = render({ isOwner: true, unpaidAll: true, unpaid: { windowDays: null, notReturned: 0 }, unpaidHrefs: { all: "?unpaid=all", recent: "?" } });
    expect(all).toContain("all finished appointments with a balance");
    expect(all).not.toContain("needs-attention-unpaid-capped");
  });
  it("non-owner: no unpaid window note or toggle", () => {
    expect(render({ isOwner: false, unpaid: { windowDays: 90, notReturned: 0 } })).not.toContain("needs-attention-unpaid");
  });
});
