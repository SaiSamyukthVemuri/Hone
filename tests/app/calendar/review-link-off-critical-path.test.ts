import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

// Insurance V-1b option A. The review-link check is slow in exactly the state it hides the link (a large, clean solo studio), so the Calendar
// must START it with its other loads and wait for it only where the toolbar is drawn. This runs the REAL page with the check held open:
// the week/month loaders must already have run while the check is still pending, and the finished page must carry the check's answer.
// Synthetic ids only; the queries are faked.

const state = vi.hoisted(() => ({
  role: "owner" as "owner" | "practitioner",
  order: [] as string[],
  release: null as null | ((v: boolean | Error) => void),
  checkCalls: 0,
}));

vi.mock("@/lib/appointments/review-link", () => ({
  shouldShowReviewLink: () => {
    state.checkCalls++;
    state.order.push("check:start");
    return new Promise<boolean>((resolve, reject) => {
      state.release = (v) => (v instanceof Error ? reject(v) : resolve(v));
    });
  },
}));
vi.mock("@/lib/supabase/queries", () => ({
  requirePractitionerWithStudio: async () => ({
    practitioner: { id: "p-owner", role: state.role, display_name: "Owner" },
    studio: { id: "studio-1", timezone: "America/Toronto", practitioner_capacity_enabled: false },
  }),
  getClientsForStudio: async () => [],
  getPractitionersForStudio: async () => [],
}));
vi.mock("@/lib/booking/queries", () => ({
  getActiveServices: async () => [],
  getAppointmentsForRange: async () => (state.order.push("load:appointments"), []),
  getAvailabilityDefaults: async () => [],
  getBlockouts: async () => [],
  getOverridesForRange: async () => [],
  getRecurringBreakOccurrencesForRange: async () => [],
  getTimedBlocksForRange: async () => [],
}));

const { default: CalendarPage } = await import("@/app/(app)/calendar/page");

type Props = Record<string, unknown>;
function elements(node: ReactNode, out: ReactElement<Props>[] = []): ReactElement<Props>[] {
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (Array.isArray(node)) { node.forEach((n) => elements(n, out)); return out; }
  if (isValidElement(node)) {
    out.push(node as ReactElement<Props>);
    elements((node.props as { children?: ReactNode }).children, out);
  }
  return out;
}
const hrefOf = (tree: unknown) => elements(tree as ReactNode).find((e) => "reviewAssignmentsHref" in e.props)?.props.reviewAssignmentsHref;
const tick = () => new Promise((r) => setTimeout(r, 25));

beforeEach(() => { state.role = "owner"; state.order = []; state.release = null; state.checkCalls = 0; });

const views: Array<[string, Record<string, string>]> = [
  ["week", { week: "2026-10-18" }],
  ["month", { view: "month", month: "2026-10-01" }],
];

describe("V-1b A: the review-link check is off the Calendar's critical path", () => {
  it.each(views)("%s view: the loads run while the check is still pending, and the page waits for it only to draw the toolbar", async (_v, search) => {
    let done = false;
    const page = CalendarPage({ searchParams: Promise.resolve(search) }).then((t) => ((done = true), t));
    await tick();
    expect(state.order[0]).toBe("check:start"); // started first, before any load
    expect(state.order).toContain("load:appointments"); // the loads did not wait for it
    expect(done).toBe(false); // the toolbar still needs its answer
    state.release!(true);
    expect(hrefOf(await page)).toBe("/calendar/check-practitioner");
  });

  it.each(views)("%s view: a hidden answer gives no link; a thrown check fails toward SHOWING", async (_v, search) => {
    const hidden = CalendarPage({ searchParams: Promise.resolve(search) });
    await tick();
    state.release!(false);
    expect(hrefOf(await hidden)).toBeUndefined();

    state.order = [];
    const failed = CalendarPage({ searchParams: Promise.resolve(search) });
    await tick();
    state.release!(new Error("read failed"));
    expect(hrefOf(await failed)).toBe("/calendar/check-practitioner");
  });

  it.each(views)("%s view: a non-owner never runs the check and never waits", async (_v, search) => {
    state.role = "practitioner";
    const tree = await CalendarPage({ searchParams: Promise.resolve(search) });
    expect(state.checkCalls).toBe(0);
    expect(hrefOf(tree)).toBeUndefined();
  });
});
