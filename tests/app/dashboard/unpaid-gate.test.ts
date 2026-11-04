import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

// HON-65: the Needs attention unpaid reminders (#1356) are behind HONE_DASHBOARD_UNPAID_ENABLED, default OFF. With it OFF the unpaid
// loader is never called, the panel has no unpaid item, no window note, no "Show all outstanding" link and no "Could not check unpaid
// balances" entry, `?unpaid=all` changes nothing, and the heading count excludes unpaid. With it ON, behaviour is #1356's, unchanged.
// These render the REAL section and heading count (as loader-failure-degrades does), with only the data loaders faked.

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(app)/dashboard/attention-actions", () => ({ dismissAttentionAction: vi.fn(), restoreAttentionAction: vi.fn() }));
vi.mock("@/lib/dashboard/attention-dismissal-store", () => ({ loadMyDismissals: vi.fn(async () => ({ ok: true, rows: [] })) }));
vi.mock("next/link", () => ({
  default: (p: { href: string; children?: unknown }) => createElement("a", { href: p.href }, p.children as never),
}));

const ITEMS = [
  { appointmentId: "a1", clientId: "c2", clientName: "Bo Client", endsAt: "2026-11-01T15:00:00Z", balance: { kind: "owed", outstandingCents: 5000, currency: "cad" } },
  { appointmentId: "a2", clientId: "c3", clientName: "Cy Client", endsAt: "2026-11-01T16:00:00Z", balance: { kind: "unavailable" } },
];
const loader = vi.hoisted(() => vi.fn());
vi.mock("@/lib/dashboard/unpaid-attention", () => ({ loadUnpaidAttention: loader, UNPAID_DEFAULT_WINDOW_DAYS: 90 }));

const { dashboardUnpaidEnabled } = await import("@/lib/dashboard/unpaid-gate");
const { NeedsAttentionSection, NeedsAttentionHeadingCount } = await import("@/app/(app)/dashboard/secondary-stack");

const ok = {
  attentionSources: () => Promise.resolve([[], 1, null, []]) as never,
  staffManaged: () => Promise.resolve(false),
  procedureActions: () =>
    Promise.resolve({ reviewedSessions: 0, incompleteRecords: 0, missingProbeLots: 0, aftercareNotMarked: 0, recordsMissingDetails: 0, detailGaps: [] }) as never,
  upcomingVisitClients: () => Promise.resolve(new Set<string>()) as never,
  clientsNeedingAttention: () => Promise.resolve({ totalClients: 0, clients: [], scanCapped: false }) as never,
  followUpAssistant: () => Promise.resolve({ items: [], hasItems: false, totalFound: 0 }) as never,
  expiringSupplies: () => Promise.resolve([]) as never,
};

// A fresh props object per render: the resolver memoises on the attentionSources promise.
function props(over: Record<string, unknown> = {}) {
  const p: Record<string, unknown> = {
    isOwner: true,
    todayLocal: "2026-11-02",
    studioId: "studio-1",
    studioTimezone: "America/Toronto",
    unpaidAll: false,
    unpaidHrefs: { all: "?unpaid=all", recent: "?" },
    ...over,
  };
  for (const k of Object.keys(ok) as Array<keyof typeof ok>) p[k] = ok[k]();
  return p as never;
}
const section = async (over?: Record<string, unknown>) => renderToStaticMarkup((await NeedsAttentionSection(props(over))) as never);
const count = async (over?: Record<string, unknown>) => {
  const el = NeedsAttentionHeadingCount(props(over)) as unknown as { props: { children: { type: (p: unknown) => Promise<unknown>; props: unknown } } };
  const child = el.props.children;
  return renderToStaticMarkup((await child.type(child.props)) as never);
};

const UNPAID_MARKERS = ["attention-unpaid-amount", "needs-attention-unpaid-window", "needs-attention-unpaid-toggle", "Show all outstanding", "Show last 90 days only", "still owed", "Amount unavailable", "Bo Client", "Cy Client", "unpaid balances", 'data-attention-issue="unpaid"'];

beforeEach(() => {
  vi.unstubAllEnvs();
  loader.mockReset();
  loader.mockResolvedValue({ ok: true, items: ITEMS, windowDays: 90, notReturned: 0 });
});

describe("the unpaid gate fails closed", () => {
  it("is ON only for exactly the string true", () => {
    expect(dashboardUnpaidEnabled()).toBe(false);
    for (const v of ["", " ", "TRUE", "True", "1", "yes", "on", " true", "true ", "false"]) {
      vi.stubEnv("HONE_DASHBOARD_UNPAID_ENABLED", v);
      expect(dashboardUnpaidEnabled(), JSON.stringify(v)).toBe(false);
    }
    vi.stubEnv("HONE_DASHBOARD_UNPAID_ENABLED", "true");
    expect(dashboardUnpaidEnabled()).toBe(true);
  });
});

describe("gate OFF: nothing unpaid, and the loader is never called", () => {
  it("an owner's panel has no unpaid item, note, link or unavailable entry, also with ?unpaid=all", async () => {
    for (const over of [{}, { unpaidAll: true }]) {
      const html = await section(over);
      for (const m of UNPAID_MARKERS) expect(html, `${JSON.stringify(over)} ${m}`).not.toContain(m);
      expect(html).toContain("Nothing needs attention right now");
    }
    expect(loader).not.toHaveBeenCalled();
  });
  it("a failing unpaid read cannot surface either: the loader is not reached", async () => {
    loader.mockRejectedValue(new Error("42501"));
    const html = await section();
    expect(html).not.toContain("Could not check");
    expect(html).not.toContain("unpaid balances");
    expect(loader).not.toHaveBeenCalled();
  });
  it("the heading count excludes unpaid", async () => {
    expect(await count()).toContain("0 clients, 0 items");
    expect(loader).not.toHaveBeenCalled();
  });
});

describe("gate ON: #1356 behaviour unchanged (the control case)", () => {
  beforeEach(() => vi.stubEnv("HONE_DASHBOARD_UNPAID_ENABLED", "true"));

  it("an owner sees the unpaid items, the authoritative amount, Amount unavailable, the window note and the link", async () => {
    const html = await section();
    expect(html).toContain("Bo Client");
    expect(html).toContain("still owed");
    expect(html).toContain("$50.00");
    expect(html).toContain("Amount unavailable");
    expect(html).toContain("needs-attention-unpaid-window");
    expect(html).toContain("Show all outstanding");
    expect(loader).toHaveBeenCalledWith(expect.objectContaining({ studioId: "studio-1", viewerIsOwner: true, windowDays: 90 }));
  });
  it("?unpaid=all asks for every finished appointment", async () => {
    await section({ unpaidAll: true });
    expect(loader).toHaveBeenCalledWith(expect.objectContaining({ windowDays: null }));
  });
  it("a failing unpaid read is named as unavailable", async () => {
    loader.mockRejectedValue(new Error("42501"));
    const html = await section();
    expect(html).toContain("Could not check unpaid balances");
  });
  it("the heading count includes unpaid", async () => {
    expect(await count()).toContain("2 clients, 2 items");
  });
  it("a non-owner still never queries unpaid", async () => {
    const html = await section({ isOwner: false });
    expect(html).not.toContain("Bo Client");
    expect(loader).not.toHaveBeenCalled();
  });
});

describe("source pins", () => {
  const stack = readFileSync("app/(app)/dashboard/secondary-stack.tsx", "utf8");
  it("the resolver calls the loader only behind the owner check AND the unpaid gate, exactly once", () => {
    expect(stack).toMatch(/const unpaidRead = props\.isOwner && dashboardUnpaidEnabled\(\)\s*\?\s*await loadUnpaidAttention\(/);
    expect(stack.split("loadUnpaidAttention(").length - 1).toBe(1);
  });
  it("secondary-stack is the only app caller of the unpaid loader", () => {
    const callers = execFileSync("grep", ["-rl", "loadUnpaidAttention", "app", "lib"], { encoding: "utf8" }).split("\n").filter(Boolean).sort();
    expect(callers).toEqual(["app/(app)/dashboard/secondary-stack.tsx", "lib/dashboard/unpaid-attention.ts"]);
  });
});
