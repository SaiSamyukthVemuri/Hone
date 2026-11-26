import { describe, expect, it, vi } from "vitest";
import { immediateVisitPlans, planTargetOnPage } from "@/lib/dashboard/immediate-visit-plans";
import type { AppointmentPrepLoad } from "@/lib/sessions/last-treatment-loader";

const target = { id: "b", client_id: "client", starts_at: "2026-11-24T15:00:00Z", service: { modality: "electrolysis" }, status: "confirmed" };
const plan = { sessionId: "source-session", startedAt: "2026-11-05T09:59:59.000000Z", text: "Ask about the last visit." };
const visit = (id: string, starts_at: string, modality = "electrolysis", sessions: { id: string }[] = []) =>
  ({ id, starts_at, service: { modality }, sessions });
const current = visit(target.id, target.starts_at);
const later = visit("future", "2026-12-14T09:00:00Z");
const source = visit("first", "2026-11-05T10:00:00Z", "electrolysis", [{ id: plan.sessionId }]);
const second = visit("second", "2026-11-11T13:45:00Z");

const isImmediatePlanTarget = (...args: Parameters<typeof planTargetOnPage>) => planTargetOnPage(...args) === "target";

describe("a plan is only for the first eligible treatment appointment", () => {
  it("does not consume a plan on the same source appointment, even when treatment started early", () => {
    expect(isImmediatePlanTarget(target, plan, [source, current, later])).toBe(true);
  });
  it("an intervening treatment consumes the note even when it has no linked chart", () => {
    expect(isImmediatePlanTarget(target, plan, [source, second, current])).toBe(false);
  });
  it("ignores consultations, future bookings and a previous appointment before the source", () => {
    expect(isImmediatePlanTarget(target, plan, [visit("old", "2026-09-30T13:45:00Z"), source,
      visit("consult", second.starts_at, "consultation"), current, later])).toBe(true);
  });
  it("a capped or missing target cannot receive a note, nor can a different session's simultaneous treatment", () => {
    expect(isImmediatePlanTarget(target, plan, [source])).toBe(false);
    expect(isImmediatePlanTarget(target, plan, [source, visit("a", current.starts_at), current])).toBe(false);
  });
  it("uses the instant at database precision when two visits differ by one microsecond", () => {
    const closeTarget = { ...target, starts_at: "2026-11-24T15:00:00.000002Z" };
    const earlier = visit("z", "2026-11-24T10:00:00.000001-05:00");
    expect(isImmediatePlanTarget(closeTarget, plan, [earlier, visit(closeTarget.id, closeTarget.starts_at)])).toBe(false);
  });

  const load = (latest = plan.sessionId): AppointmentPrepLoad => ({
    treatment: null, unavailable: false, narrative: { plan, legacySessionNotes: null, latestVisit: { id: latest, at: plan.startedAt } },
  });
  function stub(visits: typeof current[], error = false) {
    const client = {
      from: vi.fn(() => client), select: vi.fn(() => client), eq: vi.fn(() => client), in: vi.fn(() => client),
      gte: vi.fn(() => client), lte: vi.fn(() => client), order: vi.fn(() => client),
      range: vi.fn(async (start: number, end: number) => ({ data: [{ id: target.client_id, visits: visits.slice(start, end + 1) }], error })),
    };
    return client;
  }
  it("does not backfill a note from an older session, and a cancelled, missed or consultation target receives nothing", async () => {
    const client = stub([current]);
    const api = client as unknown as Parameters<typeof immediateVisitPlans>[0];
    expect(await immediateVisitPlans(api, "studio", [target], new Map([[target.id, load("newer-blank")]]))).toEqual(new Map());
    for (const row of [{ ...target, status: "no_show" }, { ...target, status: "cancelled" }, { ...target, service: { modality: "consultation" } }]) {
      expect(await immediateVisitPlans(api, "studio", [row], new Map([[target.id, load()]]))).toEqual(new Map());
    }
    expect(client.from).not.toHaveBeenCalled();
  });
  it("removes the reminder from the completed visit and never carries it to the following one", async () => {
    const client = stub([source, current, later]);
    const result = await immediateVisitPlans(client as unknown as Parameters<typeof immediateVisitPlans>[0], "studio",
      [{ ...target, status: "completed" }, { ...target, ...later }], new Map([[target.id, load()], [later.id, load()]]));
    expect(result.size).toBe(0);
  });
  it("checks only the studio's confirmed/completed appointments and attributes one note across multiple rows", async () => {
    const client = stub([source, current, later]);
    const result = await immediateVisitPlans(client as unknown as Parameters<typeof immediateVisitPlans>[0], "studio",
      [target, { ...target, ...later }], new Map([[target.id, load()], [later.id, load()]]));
    expect(result).toEqual(new Map([[target.id, plan.text]]));
    expect(client.from).toHaveBeenCalledTimes(1);
    expect(client.eq).toHaveBeenCalledWith("studio_id", "studio");
    expect(client.in).toHaveBeenCalledWith("visits.status", ["confirmed", "completed"]);
  });
  it("finds a valid target beyond the first batch without allowing an intervening treatment to slip through", async () => {
    const consults = Array.from({ length: 50 }, (_, n) => visit(`consult-${n}`, second.starts_at, "consultation"));
    for (const [visits, expected] of [[consults, true], [[...consults, second], false]] as const) {
      const client = stub([source, ...visits, current]);
      const result = await immediateVisitPlans(client as unknown as Parameters<typeof immediateVisitPlans>[0], "studio",
        [target], new Map([[target.id, load()]]));
      expect(result.has(target.id)).toBe(expected);
      expect(client.range).toHaveBeenCalledTimes(2);
    }
  });
  it("a failed read does not attribute a note", async () => {
    const client = stub([current], true);
    expect(await immediateVisitPlans(client as unknown as Parameters<typeof immediateVisitPlans>[0], "studio",
      [target], new Map([[target.id, load()]]))).toEqual(new Map());
  });
});
