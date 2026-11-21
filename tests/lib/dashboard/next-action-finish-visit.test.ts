import { describe, expect, it } from "vitest";
import { resolveNextAction } from "@/lib/dashboard/next-action";
import { resolveDayNextAction } from "@/lib/dashboard/day-next-action";

// HON-45: charting no longer completes an appointment, so a past CONFIRMED appointment that has a chart is still OPEN. The
// dashboard must say so (otherwise it stays confirmed forever), and the pointer must never complete, send or charge.
const base = { clientId: "c1", appointmentId: "a1", hasHistory: true, sessionId: "s1", hasChartedArea: true } as const;

describe("a charted but unfinished visit is surfaced", () => {
  it("past + confirmed + charted: Finish visit, chip Not finished, pointing at the session page", () => {
    const out = resolveNextAction({ ...base, status: "confirmed", hasEnded: true });
    expect(out).toEqual({ label: "Finish visit", href: "/clients/c1/sessions/s1", chip: "Not finished" });
  });

  it("past + confirmed + chart started but empty: still Finish visit (it is open either way)", () => {
    const out = resolveNextAction({ ...base, status: "confirmed", hasEnded: true, hasChartedArea: false });
    expect(out.label).toBe("Finish visit");
  });

  it("the pointer is a session-page link only: never a payment, charge or completion route", () => {
    const out = resolveNextAction({ ...base, status: "confirmed", hasEnded: true });
    expect(out.href).not.toMatch(/pay|charge|complete|api/i);
  });

  it("not yet ended: charting in progress is unchanged", () => {
    expect(resolveNextAction({ ...base, status: "confirmed", hasEnded: false }).label).toBe("View session");
    expect(resolveNextAction({ ...base, status: "confirmed", hasChartedArea: false, hasEnded: false }).label).toBe("Continue charting");
  });

  it("hasEnded omitted: exactly the previous behaviour for every existing caller", () => {
    expect(resolveNextAction({ ...base, status: "confirmed" }).label).toBe("View session");
  });

  it("completed, cancelled and no-show are never 'not finished'", () => {
    for (const status of ["completed", "cancelled", "no_show"]) {
      expect(resolveNextAction({ ...base, status, hasEnded: true }).chip, status).not.toBe("Not finished");
    }
  });

  it("the Day wrapper delegates it unchanged on Today and off Today (a linked session decides before history)", () => {
    for (const history of [{ asked: true, hasHistory: true }, { asked: false }] as const) {
      const out = resolveDayNextAction({ ...base, status: "confirmed", hasEnded: true, history });
      expect(out.label, JSON.stringify(history)).toBe("Finish visit");
    }
  });
});
