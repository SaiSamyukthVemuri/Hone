import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { isStaffManagedClinic, loadStaffManagedClinic } from "@/lib/dashboard/staff-managed";
import { buildDashboardTodo, type BuildDashboardTodoInput } from "@/lib/dashboard/todo-model";
import type { PracticeDashboardMetrics } from "@/lib/dashboard/practice-metrics";

// HON-65: the staff-booked clinic slice. The posture comes ONLY from the two existing HON-47 settings; it is not a portal-off flag.

vi.mock("@/components/pending-link", () => ({
  PendingLink: ({ children }: { children: unknown }) => children,
}));

describe("isStaffManagedClinic (both existing HON-47 settings, default posture on any doubt)", () => {
  it.each([
    [{ client_cancellation_enabled: false, client_reschedule_enabled: false }, true],
    [{ client_cancellation_enabled: true, client_reschedule_enabled: true }, false],
    [{ client_cancellation_enabled: false, client_reschedule_enabled: true }, false],
    [{ client_cancellation_enabled: true, client_reschedule_enabled: false }, false],
    [{ client_cancellation_enabled: null, client_reschedule_enabled: null }, false],
    [{ client_cancellation_enabled: false }, false],
    [{}, false],
    [null, false],
    [undefined, false],
  ])("%j -> %s", (settings, expected) => {
    expect(isStaffManagedClinic(settings)).toBe(expected);
  });
});

// A tiny fake of the PostgREST builder over TWO studios; it answers only for the id the loader filtered on.
function fakeClient(rows: Record<string, unknown>, opts: { error?: boolean; throws?: boolean } = {}) {
  const asked: string[] = [];
  const client = {
    from: (table: string) => {
      expect(table).toBe("studios");
      return {
        select: (cols: string) => {
          expect(cols).toBe("client_cancellation_enabled, client_reschedule_enabled");
          return {
            eq: (col: string, id: string) => {
              expect(col).toBe("id");
              asked.push(id);
              return {
                maybeSingle: async () => {
                  if (opts.throws) throw new Error("boom");
                  return opts.error ? { data: null, error: { message: "x" } } : { data: rows[id] ?? null, error: null };
                },
              };
            },
          };
        },
      };
    },
  };
  return { client: client as never, asked };
}

describe("loadStaffManagedClinic", () => {
  const rows = {
    "studio-a": { client_cancellation_enabled: false, client_reschedule_enabled: false },
    "studio-b": { client_cancellation_enabled: true, client_reschedule_enabled: true },
  };
  it("reads only the caller's own studio: A is staff-managed, B is not, and neither read touches the other", async () => {
    const a = fakeClient(rows);
    expect(await loadStaffManagedClinic(a.client, "studio-a")).toBe(true);
    expect(a.asked).toEqual(["studio-a"]);
    const b = fakeClient(rows);
    expect(await loadStaffManagedClinic(b.client, "studio-b")).toBe(false);
    expect(b.asked).toEqual(["studio-b"]);
  });
  it("a studio whose row is not visible (another studio's id under RLS) is the default posture", async () => {
    const f = fakeClient({ "studio-a": rows["studio-a"] });
    expect(await loadStaffManagedClinic(f.client, "studio-b")).toBe(false);
  });
  it("a read error or a thrown exception is the default posture, never a throw", async () => {
    expect(await loadStaffManagedClinic(fakeClient(rows, { error: true }).client, "studio-a")).toBe(false);
    expect(await loadStaffManagedClinic(fakeClient(rows, { throws: true }).client, "studio-a")).toBe(false);
  });
});

const NO_METRICS = { reviewedSessions: 0, incompleteRecords: 0, missingProbeLots: 0, aftercareNotMarked: 0, recordsMissingDetails: 0 };
function todo(studio: Partial<BuildDashboardTodoInput["studio"]>) {
  return buildDashboardTodo({
    assistant: { items: [], hasItems: false, totalFound: 0 },
    attention: { totalClients: 0, clients: [], scanCapped: false },
    supplies: [],
    metrics: NO_METRICS,
    studio: { isOwner: true, intakesAwaitingReviewCount: 0, activeServicesCount: 3, paymentStatus: null, ...studio },
    todayLocal: "2026-10-20",
  } as BuildDashboardTodoInput);
}

describe("To-do wording in both states", () => {
  it("default: unchanged client-booking wording", () => {
    const s = todo({ activeServicesCount: 0 }).items.find((i) => i.kind === "no_services")!;
    expect(s.detail).toBe("Clients can't book until at least one active service exists.");
    const p = todo({ paymentStatus: { hasAccount: false, onboardingCompleted: false, payoutsEnabled: false } }).items.find((i) => i.kind === "payment_setup")!;
    expect(p.detail).toContain("Public booking still works without it.");
  });
  it("staff-managed: no client-booking claims; reason, route and ownership gate unchanged", () => {
    const s = todo({ activeServicesCount: 0, staffManaged: true }).items.find((i) => i.kind === "no_services")!;
    expect(s.reason).toBe("No services yet");
    expect(s.action.href).toBe("/settings/services");
    expect(s.detail).toBe("Add at least one active service so appointments can be booked.");
    const p = todo({ staffManaged: true, paymentStatus: { hasAccount: false, onboardingCompleted: false, payoutsEnabled: false } }).items.find((i) => i.kind === "payment_setup")!;
    expect(p.reason).toBe("Stripe not connected yet");
    expect(p.detail).toBe("Connect when you're ready to accept payments.");
    expect(todo({ isOwner: false, activeServicesCount: 0, staffManaged: true }).items.some((i) => i.kind === "no_services")).toBe(false);
  });
});

const metrics: PracticeDashboardMetrics = {
  period: "week", periodLabel: "this week",
  appointments: { total: 4, completed: 1, upcoming: 2, cancelled: 1, noShows: 0, lateCancellations: 0 },
  actions: { reviewedSessions: 0, incompleteRecords: 0, missingProbeLots: 0, aftercareNotMarked: 0, recordsMissingDetails: 0 } as PracticeDashboardMetrics["actions"],
  chartedWithin24h: { completedCount: 0, chartedWithin24hCount: 0 },
  money: null,
};
async function render(staffManaged?: boolean) {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { PracticeSnapshot } = await import("@/app/(app)/dashboard/practice-snapshot");
  return renderToStaticMarkup(PracticeSnapshot({ metrics, selectedDay: "2026-10-20", todayLocal: "2026-10-20", staffManaged }) as never);
}

describe("Practice snapshot in both states", () => {
  it("default shows Late cancellations", async () => {
    expect(await render()).toContain("Late cancellations");
    expect(await render(false)).toContain("Late cancellations");
  });
  it("staff-managed hides ONLY Late cancellations; every other count is still shown", async () => {
    const html = await render(true);
    expect(html).not.toContain("Late cancellations");
    for (const label of ["Appointments this week", "Completed", "Upcoming", "Cancelled", "No-shows"]) expect(html).toContain(label);
  });
});

describe("wiring and boundaries (source guards)", () => {
  const page = readFileSync("app/(app)/dashboard/page.tsx", "utf8");
  const stack = readFileSync("app/(app)/dashboard/secondary-stack.tsx", "utf8");
  const mod = readFileSync("lib/dashboard/staff-managed.ts", "utf8");
  it("the page reads the posture for ITS studio only and the stack passes it to both consumers", () => {
    // WS-DB: the checked variant keeps "unknown" distinct; the copy posture still defaults to standard.
    expect(page).toMatch(/loadStaffManagedClinicChecked\(\s*supabase,\s*studio\.id,?\s*\)/);
    expect(page).toMatch(/v === STAFF_MANAGED_UNKNOWN \? false : v/);
    expect(stack).toMatch(/staffManaged,\n\s*\},/);
    expect(stack).toMatch(/<PracticeSnapshot[\s\S]*?staffManaged=\{staffManaged\}/);
  });
  it("no portal-off flag is invented: the module reads only the two HON-47 columns and no money field", () => {
    expect(mod).toMatch(/client_cancellation_enabled, client_reschedule_enabled/);
    expect(mod).not.toMatch(/portal_enabled|portal_off|online_booking|self_booking|price_cents|stripe/i);
  });
});

describe("WS-DB: an unreadable posture is stated, not silently defaulted", () => {
  it("the checked loader returns 'unknown' on a read error or a throw, and a boolean otherwise", async () => {
    const { loadStaffManagedClinicChecked, STAFF_MANAGED_UNKNOWN } = await import("@/lib/dashboard/staff-managed");
    const client = (result: unknown, throws = false) =>
      ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => { if (throws) throw new Error("x"); return result; } }) }) }) }) as never;
    expect(await loadStaffManagedClinicChecked(client({ data: null, error: { message: "x" } }), "s")).toBe(STAFF_MANAGED_UNKNOWN);
    expect(await loadStaffManagedClinicChecked(client(null, true), "s")).toBe(STAFF_MANAGED_UNKNOWN);
    expect(await loadStaffManagedClinicChecked(client({ data: { client_cancellation_enabled: false, client_reschedule_enabled: false }, error: null }), "s")).toBe(true);
    expect(await loadStaffManagedClinicChecked(client({ data: { client_cancellation_enabled: true, client_reschedule_enabled: false }, error: null }), "s")).toBe(false);
  });
});
