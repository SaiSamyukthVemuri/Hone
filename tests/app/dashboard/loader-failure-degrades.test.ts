import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/link", () => ({
  default: (p: { href: string; children?: unknown }) => createElement("a", { href: p.href }, p.children as never),
}));

// OPS #1308 (2): with a Before-Today style read failing, the WHOLE dashboard fell to the error boundary,
// because the Needs attention loaders were awaited bare. One failing loader must degrade to its own
// "unavailable" state. These render the real components with each loader rejecting in turn.

const { NeedsAttentionSection, NeedsAttentionCountPill, ClientsToReview } = await import(
  "@/app/(app)/dashboard/secondary-stack"
);

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
type Key = keyof typeof ok;

function props(failing?: Key) {
  const p: Record<string, unknown> = { isOwner: false, todayLocal: "2026-11-02" };
  for (const k of Object.keys(ok) as Key[]) {
    p[k] = k === failing ? Promise.reject(new Error("42501")) : ok[k]();
    (p[k] as Promise<unknown>).catch(() => undefined);
  }
  return p as never;
}

const section = async (failing?: Key) => renderToStaticMarkup((await NeedsAttentionSection(props(failing))) as never);
const inner = async (el: { props: unknown }) => {
  const child = (el.props as { children: { type: (p: unknown) => Promise<unknown>; props: unknown } }).children;
  return renderToStaticMarkup((await child.type(child.props)) as never);
};

const CASES: Array<{ loader: Key; named: string; clientAffecting: boolean }> = [
  { loader: "clientsNeedingAttention", named: "recent sessions", clientAffecting: true },
  { loader: "followUpAssistant", named: "missing records", clientAffecting: true },
  { loader: "procedureActions", named: "record details", clientAffecting: true },
  { loader: "expiringSupplies", named: "expiring supplies", clientAffecting: false },
];

describe("one failing Needs attention loader degrades to its own unavailable state", () => {
  it("control: nothing failing renders the all-clear and a real count", async () => {
    const out = await section();
    expect(out).toContain("Nothing needs attention right now");
    expect(out).not.toContain("Could not check");
    expect(await inner(ClientsToReview(props()) as never)).toMatch(/>0</);
  });

  it.each(CASES)("$loader rejecting: the panel renders, names $named, and is not the all-clear", async ({ loader, named }) => {
    const out = await section(loader);
    expect(out).toContain(`Could not check ${named}`);
    expect(out).toContain("may be incomplete");
    expect(out).not.toContain("Nothing needs attention right now");
    // only the failing check is named
    for (const other of CASES.filter((c) => c.loader !== loader)) expect(out).not.toContain(other.named);
  });

  it.each(CASES)("$loader rejecting: the strip and the header pill do not claim a count when the check feeds client cards", async ({ loader, clientAffecting }) => {
    const strip = await inner(ClientsToReview(props(loader)) as never);
    const pill = await inner(NeedsAttentionCountPill(props(loader)) as never);
    if (clientAffecting) {
      expect(strip).toContain("Unavailable");
      expect(pill).toContain("Unavailable");
    } else {
      // expiring supplies only adds a studio item: the client count is still a real number
      expect(strip).toMatch(/>0</);
      expect(pill).toContain("0 clients");
    }
  });

  it("several loaders failing at once are listed together in plain words", async () => {
    const p = props() as Record<string, unknown>;
    p.clientsNeedingAttention = Promise.reject(new Error("x"));
    p.followUpAssistant = Promise.reject(new Error("x"));
    (p.clientsNeedingAttention as Promise<unknown>).catch(() => undefined);
    (p.followUpAssistant as Promise<unknown>).catch(() => undefined);
    const out = renderToStaticMarkup((await NeedsAttentionSection(p as never)) as never);
    expect(out).toContain("Could not check recent sessions and missing records");
  });
});

describe("source pins", () => {
  const stack = readFileSync("app/(app)/dashboard/secondary-stack.tsx", "utf8");
  it("the owner's practice-metrics read (it reads session_blocks) degrades to a stated note, never the error boundary", () => {
    expect(stack).not.toMatch(/await practiceMetricsPromise;/);
    expect(stack).toMatch(/settleOrUnavailable\(practiceMetricsPromise, null\)/);
    expect(stack).toMatch(/\{isOwner && practiceMetricsRead\.unavailable && \(\s*<p data-testid="practice-snapshot-unavailable"/);
    // the existing no-snapshot branch (capacity link on its own) is kept
    expect(stack).toMatch(/\{isOwner && !practiceMetrics && capacityLink\}/);
  });
  it("no Needs attention loader promise is awaited bare any more", () => {
    for (const name of ["procedureActionsPromise", "clientsNeedingAttentionPromise", "followUpAssistantPromise", "expiringSuppliesPromise"]) {
      expect(stack).not.toMatch(new RegExp(`await ${name};`));
      expect(stack).toMatch(new RegExp(`settleOrUnavailable\\(\\s*${name}`));
    }
  });
});
