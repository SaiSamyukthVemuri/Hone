import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The dismissals gate (HONE_DASHBOARD_DISMISSALS_ENABLED, default OFF). Migration 0298 is held, so the app must ship and work with the
// gate OFF: no Dismiss, no Dismissed view, no "could not read" note, none of the three database commands called. The one count in the
// heading and the unpaid reminders (authoritative amounts, 90 days / All outstanding) do not depend on it.

const rpc = vi.hoisted(() => vi.fn(async (..._a: unknown[]): Promise<{ data: unknown; error: unknown }> => ({ data: { ok: true, changed: true }, error: null })));
vi.mock("@/lib/supabase/queries", () => ({
  requirePractitionerWithStudio: vi.fn(async () => ({ practitioner: { role: "owner" }, studio: { id: "studio-1" } })),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({ rpc })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), redirect: vi.fn() }));
vi.mock("next/link", () => ({ default: (p: { href: string; children?: unknown }) => createElement("a", { href: p.href }, p.children as never) }));

const { dashboardDismissalsEnabled } = await import("@/lib/dashboard/dismissals-gate");
const { dismissAttentionAction, restoreAttentionAction } = await import("@/app/(app)/dashboard/actions");
const { NeedsAttentionPanel } = await import("@/app/(app)/dashboard/needs-attention-panel");
const { buildNeedsAttention } = await import("@/lib/dashboard/needs-attention-model");

const read = (p: string) => readFileSync(p, "utf8");

beforeEach(() => {
  vi.unstubAllEnvs();
  rpc.mockClear();
});

describe("the gate fails closed", () => {
  it("is ON only for exactly the string true", () => {
    expect(dashboardDismissalsEnabled()).toBe(false);
    for (const v of ["", " ", "TRUE", "True", "1", "yes", "on", " true", "true "]) {
      vi.stubEnv("HONE_DASHBOARD_DISMISSALS_ENABLED", v);
      expect(dashboardDismissalsEnabled(), JSON.stringify(v)).toBe(false);
    }
    vi.stubEnv("HONE_DASHBOARD_DISMISSALS_ENABLED", "true");
    expect(dashboardDismissalsEnabled()).toBe(true);
  });
});

describe("gate OFF: the actions do nothing", () => {
  it("an owner's dismiss and restore are refused as unavailable and call no command", async () => {
    expect(await dismissAttentionAction("intake:c1:intake_review", "t1")).toEqual({ ok: false, code: "unavailable" });
    expect(await restoreAttentionAction("intake:c1:intake_review")).toEqual({ ok: false, code: "unavailable" });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("gate OFF: the panel", () => {
  const model = buildNeedsAttention({
    assistant: { items: [], hasItems: false, totalFound: 0, allItems: [], allTotal: 0 } as never,
    intakesAwaitingReview: [{ clientId: "c1", clientName: "Ada Client", submittedAt: "2026-10-30T10:00:00Z" } as never],
    todo: { items: [], moreCount: 0 } as never,
    unpaid: [
      { appointmentId: "a1", clientId: "c2", clientName: "Bo Client", endsAt: "2026-11-01T15:00:00Z", balance: { kind: "owed", outstandingCents: 5000, currency: "cad" } },
      { appointmentId: "a2", clientId: "c3", clientName: "Cy Client", endsAt: "2026-11-01T16:00:00Z", balance: { kind: "unavailable" } },
    ],
    unavailableChecks: [],
  } as never);
  const render = (over: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(NeedsAttentionPanel, { needs: model, isOwner: true, ...over } as never));

  it("an owner sees no Dismiss, no Dismissed view and no note, by default and even if the read had failed", () => {
    for (const html of [render(), render({ dismissalsEnabled: false }), render({ dismissalsEnabled: false, dismissalsUnavailable: true })]) {
      expect(html).not.toContain("attention-dismiss");
      expect(html).not.toContain("attention-dismissed");
      expect(html).not.toContain("attention-restore");
      expect(html).not.toContain("attention-dismissals-unavailable");
      expect(html).not.toMatch(/could not read your dismissed/i);
    }
  });
  it("still shows every reminder, the authoritative amount, Amount unavailable and the window with its All outstanding link", () => {
    const html = render({ unpaid: { windowDays: 90, notReturned: 0 }, unpaidHrefs: { all: "?unpaid=all", recent: "?" } });
    expect(html).toContain("Ada Client");
    expect(html).toContain("still owed");
    expect(html).toContain("$50.00");
    expect(html).toContain("Amount unavailable");
    expect(html).toContain("needs-attention-unpaid-window");
    expect(html).toContain("Show all outstanding");
  });
  it("gate ON still works (the control case)", () => {
    const html = render({ dismissalsEnabled: true, dismissed: [{ itemKey: "k", instanceToken: "1", who: "Payments", label: "Stripe not connected yet", detail: null, kind: "studio", href: "/h", actionLabel: "Open" }] });
    expect(html).toContain("attention-dismiss");
    expect(html).toContain("attention-dismissed");
  });
});

describe("source pins: gate OFF never calls the three commands", () => {
  const actions = read("app/(app)/dashboard/actions.ts");
  const stack = read("app/(app)/dashboard/secondary-stack.tsx");

  it("each command name appears only in the actions file and the store, nowhere else in app/ or lib/", () => {
    const out = execFileSync("grep", ["-rlE", "dismiss_attention_item|restore_attention_item|list_dismissed_attention", "app", "lib"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .sort();
    expect(out).toEqual(["app/(app)/dashboard/actions.ts", "lib/dashboard/attention-dismissal-store.ts"]);
  });
  it("both actions check the gate before anything else, before any session lookup or client", () => {
    for (const name of ["dismissAttentionAction", "restoreAttentionAction"]) {
      const body = actions.slice(actions.indexOf(`export async function ${name}`));
      const gate = body.indexOf("dashboardDismissalsEnabled()");
      expect(gate, name).toBeGreaterThan(-1);
      expect(gate, name).toBeLessThan(body.indexOf("ownerStudioId()"));
      expect(gate, name).toBeLessThan(body.indexOf("createClient()"));
      expect(gate, name).toBeLessThan(body.indexOf(".rpc("));
    }
  });
  it("the resolver checks the gate before it reads the owner's dismissals, and it is the only caller of the store", () => {
    const gate = stack.indexOf("if (!dashboardDismissalsEnabled())");
    const call = stack.indexOf("await loadMyDismissals(");
    expect(gate).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(gate);
    expect(stack.split("loadMyDismissals(").length - 1).toBe(1);
    const callers = execFileSync("grep", ["-rl", "loadMyDismissals", "app", "lib"], { encoding: "utf8" }).split("\n").filter(Boolean).sort();
    expect(callers).toEqual(["app/(app)/dashboard/secondary-stack.tsx", "lib/dashboard/attention-dismissal-store.ts"]);
  });
  it("the panel only offers Dismiss, the Dismissed view and the note when the gate says so", () => {
    const panel = read("app/(app)/dashboard/needs-attention-panel.tsx");
    expect(panel).toMatch(/enabled: isOwner && dismissalsEnabled && !dismissalsUnavailable/);
    expect(panel).toMatch(/const dismissedView = isOwner && dismissalsEnabled \?/);
    expect(panel).toMatch(/const dismissalsNote = isOwner && dismissalsEnabled && dismissalsUnavailable \?/);
    expect(panel).toMatch(/dismissalsEnabled = false,/);
  });
});
