import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const unavailableState = vi.hoisted(() => ({ check: null as unknown })); // null: the real loader runs; set only by the render tests below
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/queries", () => ({ requirePractitionerWithStudio: async () => ({ practitioner: { id: "p" }, studio: { id: "s", name: "Studio", timezone: "UTC" } }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: () => ({ select: () => ({ eq: () => ({}) }) }) }) }));
vi.mock("@/lib/notifications/owner-only-events", () => ({ scopeNotificationsToViewer: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }) }));
vi.mock("@/app/(app)/notifications/actions", () => ({ markAllReadFormAction: async () => {} }));
vi.mock("@/components/pending-button", () => ({ PendingButton: () => null }));
vi.mock("@/components/formatted-date-time", () => ({ FormattedDateTime: () => null }));
vi.mock("@/lib/notifications/disinfectant-alerts", async (orig) => ({ ...(await orig<object>()), checkOverdueDisinfectantAlerts: async (...a: Parameters<Awaited<ReturnType<typeof orig<typeof import("@/lib/notifications/disinfectant-alerts")>>>["checkOverdueDisinfectantAlerts"]>) => unavailableState.check ?? (await orig<typeof import("@/lib/notifications/disinfectant-alerts")>()).checkOverdueDisinfectantAlerts(...a) }));
import { checkOverdueDisinfectantAlerts, computeOverdueDisinfectantAlerts, loadOverdueDisinfectantAlerts } from "@/lib/notifications/disinfectant-alerts";
import { DUE_SOON_DAYS, disinfectantDueStatus } from "@/lib/record-keeping/disinfectant-status";
import { localDateString } from "@/lib/booking/tz";

// HON-12 (records lifecycle): deterministic clock boundaries for usable / due soon / due today / overdue / discarded. The existing suite checks one example
// per state; this file pins the EDGES, and the one place the clock enters (the studio-timezone "today" the callers hand to the pure helper). Synthetic data.

const rec = (due: string | null, discarded: string | null = null) => ({ date_discarded: discarded, discard_due_date: due });

describe("the day edges, around a fixed studio today", () => {
  const TODAY = "2026-03-10";
  it.each([
    ["2026-03-09", "overdue"], // yesterday
    ["2026-03-10", "due_today"],
    ["2026-03-11", "due_soon"], // tomorrow
    ["2026-03-17", "due_soon"], // exactly DUE_SOON_DAYS (7) away: still soon
    ["2026-03-18", "scheduled"], // 8 days away: not an alert
    ["2026-01-01", "overdue"],
    ["2027-03-10", "scheduled"],
  ])("a due date of %s is %s", (due, expected) => {
    expect(DUE_SOON_DAYS).toBe(7);
    expect(disinfectantDueStatus(rec(due), TODAY)).toBe(expected);
  });
  it("month, year and leap-day boundaries count whole days (no off-by-one across them)", () => {
    expect(disinfectantDueStatus(rec("2026-03-01"), "2026-02-28")).toBe("due_soon");
    expect(disinfectantDueStatus(rec("2028-02-29"), "2028-02-22")).toBe("due_soon"); // leap day, 7 days
    expect(disinfectantDueStatus(rec("2028-02-29"), "2028-02-21")).toBe("scheduled"); // 8 days
    expect(disinfectantDueStatus(rec("2027-01-02"), "2026-12-26")).toBe("due_soon"); // across the new year, 7 days
    expect(disinfectantDueStatus(rec("2026-12-31"), "2027-01-01")).toBe("overdue");
  });
  it("time passing is NOT a discard: only an explicit date_discarded makes it 'replaced', however old the due date", () => {
    expect(disinfectantDueStatus(rec("2000-01-01"), TODAY)).toBe("overdue");
    expect(disinfectantDueStatus(rec("2000-01-01", "2026-03-10"), TODAY)).toBe("replaced");
    // a blank or unparseable discard date is not a discard either
    expect(disinfectantDueStatus(rec("2026-03-09", ""), TODAY)).toBe("overdue");
  });
  it("a due date carrying a time part is judged by its day only", () => {
    expect(disinfectantDueStatus(rec("2026-03-10T23:59:59.000Z"), TODAY)).toBe("due_today");
    expect(disinfectantDueStatus(rec("2026-03-09T00:00:00.000Z"), TODAY)).toBe("overdue");
  });
});

describe("the studio-timezone midnight edge, where the clock actually enters", () => {
  // The same instant is a different calendar day in different studios; the helper is only as right as the "today" its caller derives.
  const instant = new Date("2026-03-10T03:30:00.000Z"); // 22:30 on 9 March in Toronto (EST, UTC-5); 14:30 on 10 March in Sydney
  it("derives the studio's own day, not the server's", () => {
    expect(localDateString(instant, "America/Toronto")).toBe("2026-03-09");
    expect(localDateString(instant, "Australia/Sydney")).toBe("2026-03-10");
    expect(localDateString(instant, "UTC")).toBe("2026-03-10");
  });
  it("the same record is due_today for one studio and overdue for another at the same instant", () => {
    const record = rec("2026-03-09");
    expect(disinfectantDueStatus(record, localDateString(instant, "America/Toronto"))).toBe("due_today");
    expect(disinfectantDueStatus(record, localDateString(instant, "Australia/Sydney"))).toBe("overdue");
  });
  it("a daylight-saving change does not move the day edge (Toronto, 8 March 2026 spring-forward)", () => {
    const justBeforeMidnightEdt = new Date("2026-03-09T03:59:59.000Z"); // 23:59:59 on 8 March, EDT already (UTC-4)
    const justAfter = new Date("2026-03-09T04:00:00.000Z"); // 00:00:00 on 9 March
    expect(localDateString(justBeforeMidnightEdt, "America/Toronto")).toBe("2026-03-08");
    expect(localDateString(justAfter, "America/Toronto")).toBe("2026-03-09");
  });
});

describe("the notice is derived, deduplicated by record, and ordered deterministically", () => {
  const TODAY = "2026-03-10";
  const row = (id: string, due: string | null, discarded: string | null = null) => ({ id, disinfectant_name: "X", discard_due_date: due, date_discarded: discarded });
  it("computing the alerts is pure: one alert per overdue record keyed by its id, the same result every time (it does not prove the database never duplicates)", () => {
    const rows = [row("a", "2026-03-01"), row("b", "2026-03-09")];
    const once = computeOverdueDisinfectantAlerts(rows, TODAY);
    const twice = computeOverdueDisinfectantAlerts([...rows, ...rows].filter((r, i, all) => all.findIndex((x) => x.id === r.id) === i), TODAY);
    expect(once.map((a) => a.id)).toEqual(["disinfectant-overdue:a", "disinfectant-overdue:b"]);
    expect(twice).toEqual(once);
  });
  it("recording the replacement date makes the same record disappear from the notice, with no leftover entry", () => {
    const before = computeOverdueDisinfectantAlerts([row("a", "2026-03-01")], TODAY);
    const after = computeOverdueDisinfectantAlerts([row("a", "2026-03-01", "2026-03-10")], TODAY);
    expect(before.length).toBe(1);
    expect(after).toEqual([]);
  });
  it("moving the due date forward (a new replace-by date) also clears it; moving it into the past raises exactly one", () => {
    expect(computeOverdueDisinfectantAlerts([row("a", "2026-04-01")], TODAY)).toEqual([]);
    expect(computeOverdueDisinfectantAlerts([row("a", "2026-02-01")], TODAY).length).toBe(1);
  });
  it("most overdue first, ties by record id, and 'due today' or 'due soon' never raise a notice", () => {
    const out = computeOverdueDisinfectantAlerts([row("z", "2026-03-09"), row("m", "2026-03-01"), row("a", "2026-03-09"), row("d", "2026-03-10"), row("s", "2026-03-12")], TODAY);
    expect(out.map((a) => a.recordId)).toEqual(["m", "a", "z"]);
    expect(out[0].daysOverdueText).toBe("9 days overdue");
    expect(out[1].daysOverdueText).toBe("1 day overdue");
  });
  it("the notice carries no client or treatment data", () => {
    const [a] = computeOverdueDisinfectantAlerts([row("a", "2026-03-01")], TODAY);
    expect(Object.keys(a).sort()).toEqual(["actionLabel", "body", "contextLabel", "daysOverdue", "daysOverdueText", "dueDate", "href", "id", "recordId", "severity", "title"]);
  });
});

describe("a failed read is 'unavailable', never 'nothing overdue'", () => {
  const supa = (result: { data: unknown; error: unknown } | "throw") => {
    const b: Record<string, unknown> = {};
    for (const m of ["from", "select", "eq", "is", "not", "order"]) b[m] = () => b;
    b.limit = async () => {
      if (result === "throw") throw new Error("socket");
      return result;
    };
    return b as never;
  };
  it("a read error is unavailable", async () => {
    expect(await checkOverdueDisinfectantAlerts(supa({ data: null, error: { code: "57014" } }), "studio", "2026-03-10")).toEqual({ status: "unavailable" });
  });
  it("a thrown read is unavailable", async () => {
    expect(await checkOverdueDisinfectantAlerts(supa("throw"), "studio", "2026-03-10")).toEqual({ status: "unavailable" });
  });
  it("an empty successful read is ok with no alerts (distinct from unavailable)", async () => {
    expect(await checkOverdueDisinfectantAlerts(supa({ data: [], error: null }), "studio", "2026-03-10")).toEqual({ status: "ok", alerts: [] });
  });
  it("a successful read returns the overdue alerts", async () => {
    const r = await checkOverdueDisinfectantAlerts(supa({ data: [{ id: "a", disinfectant_name: "X", discard_due_date: "2026-03-01", date_discarded: null }], error: null }), "studio", "2026-03-10");
    expect(r.status === "ok" && r.alerts.map((a) => a.recordId)).toEqual(["a"]);
  });
  it("the count-only wrapper (header badge) still degrades to [] and never throws", async () => {
    expect(await loadOverdueDisinfectantAlerts(supa("throw"), "studio", "2026-03-10")).toEqual([]);
  });
  it("the Notification Centre uses the checking loader and says it could not check", () => {
    const page = readFileSync("app/(app)/notifications/page.tsx", "utf8");
    expect(page).toContain("checkOverdueDisinfectantAlerts(");
    expect(page).not.toMatch(/\bloadOverdueDisinfectantAlerts\(/);
    expect(page).toContain("Couldn&apos;t check disinfectant dates. Reload to try again.");
    expect(page).toMatch(/disinfectantUnavailable\s*&&/);
  });
});

describe("a failed check leaves a trace without raw error text", () => {
  afterEach(() => vi.restoreAllMocks());
  const failing = (mode: "error" | "throw") => {
    const b: Record<string, unknown> = {};
    for (const m of ["from", "select", "eq", "is", "not", "order"]) b[m] = () => b;
    b.limit = async () => {
      if (mode === "throw") throw new Error("secret detail host=db.internal");
      return { data: null, error: { code: "57014", message: "secret detail host=db.internal" } };
    };
    return b as never;
  };
  it("logs one fixed event with a classified code, for a read error and for a throw", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { checkOverdueDisinfectantAlerts: real } = await vi.importActual<typeof import("@/lib/notifications/disinfectant-alerts")>("@/lib/notifications/disinfectant-alerts");
    await real(failing("error"), "studio", "2026-03-10");
    await real(failing("throw"), "studio", "2026-03-10");
    const lines = warn.mock.calls.map((c) => JSON.stringify(c));
    expect(lines.length).toBe(2);
    for (const l of lines) {
      expect(l).toContain("disinfectant_check_unavailable");
      expect(l).not.toMatch(/secret|db\.internal/);
    }
    expect(lines[0]).toContain("57014");
  });
});

describe("the Notification Centre, rendered, when the check is unavailable", () => {
  it("shows the notice and not the empty state", async () => {
    unavailableState.check = { status: "unavailable" };
    const { default: Page } = await import("@/app/(app)/notifications/page");
    const html = renderToStaticMarkup(await Page());
    expect(html).toContain("disinfectant-check-unavailable");
    expect(html).toContain("check disinfectant dates");
    expect(html).not.toContain("No notifications yet");
    unavailableState.check = null;
  });
  it("a successful empty check shows no notice and the normal empty state", async () => {
    unavailableState.check = { status: "ok", alerts: [] };
    const { default: Page } = await import("@/app/(app)/notifications/page");
    const html = renderToStaticMarkup(await Page());
    expect(html).not.toContain("disinfectant-check-unavailable");
    expect(html).toContain("No notifications yet");
    unavailableState.check = null;
  });
});
