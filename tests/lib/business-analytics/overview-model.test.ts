import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { AssembleAppointment } from "@/lib/finance/statement-document-assemble";
import type { StatementCardRow } from "@/lib/finance/statement";
import { buildOverview, type OverviewInput, type WindowData } from "@/lib/business-analytics/overview-model";
import { resolvePeriod } from "@/lib/business-analytics/period";
import { FORMER_TEAM_MEMBER_LABEL, UNATTRIBUTED_LABEL } from "@/lib/business-analytics/copy";

// Synthetic appointments and money. The real lib/finance code classifies the money; this file pins how the Overview model uses it.
const NOW = "2026-11-30T20:00:00Z";
const appt = (id: string, status: string, startsAt: string, practitionerId: string | null, clientId = `client-${id}`): AssembleAppointment => ({ id, clientId, startsAt, status, practitionerId, serviceId: null, durationMinutes: 60 });
const card = (appointmentId: string, amountCents: number, over: Partial<StatementCardRow> = {}): StatementCardRow => ({
  appointmentId, chargeReason: "session_payment", status: "succeeded", amountCents, currency: "cad", refundStatus: null, refundAmountCents: null,
  providerRefundStatus: null, stripeRefundId: null, cumulativeFullRefundVerified: false, stripeLivemode: true, ...over,
});
const cash = (appointmentId: string, amountCents: number, quoted: number | null, method = "paid_cash") => ({ appointmentId, method, amountCents, currency: "cad", quotedAmountCents: quoted });

const appointments: AssembleAppointment[] = [
  appt("done-quoted", "completed", "2026-11-05T15:00:00Z", "pr-1"), //   quote 9000, kept 9000
  appt("done-over", "completed", "2026-11-06T15:00:00Z", "pr-1"), //     quote 9000, kept 9500
  appt("done-noprice", "completed", "2026-11-07T15:00:00Z", "pr-2"), //  card 3000, no quote
  appt("noshow", "no_show", "2026-11-08T15:00:00Z", "pr-2"), //          fee 5000
  appt("unfinished", "confirmed", "2026-11-09T15:00:00Z", "pr-2"), //    cash 2000
  appt("later", "confirmed", "2026-11-30T21:00:00Z", null), //           e-transfer 1500, a booking still to come today
];
const money = {
  cardRows: [card("done-noprice", 3000), card("noshow", 5000, { chargeReason: "no_show_fee" })],
  settlementRows: [cash("done-quoted", 9000, 9000), cash("done-over", 9500, 9000), cash("unfinished", 2000, null), cash("later", 1500, null, "paid_e_transfer")],
  legacyFeeRows: [],
};
const period = (() => {
  const r = resolvePeriod({ kind: "custom", today: "2026-11-30", from: "2026-11-01", to: "2026-11-30" });
  if (!r.ok) throw new Error(r.error);
  return r.period;
})();
// The comparison window is the 30 days before: two completed visits there.
const priorAppointments: AssembleAppointment[] = [appt("old-1", "completed", "2026-10-10T15:00:00Z", "pr-1"), appt("old-2", "completed", "2026-10-12T15:00:00Z", "pr-1")];
const priorMoney = { cardRows: [], settlementRows: [cash("old-1", 6000, 6000), cash("old-2", 6000, 6000)], legacyFeeRows: [] };
const practitioners = [
  { id: "pr-1", displayName: "Ada Example", active: true },
  { id: "pr-2", displayName: "Grace Example", active: false },
];
const window = (over: Partial<WindowData> = {}) => ({ ok: true as const, value: { appointments, money, ...over } });
const input = (over: Partial<OverviewInput> = {}): OverviewInput => ({
  timezone: "America/Toronto", currency: "cad", nowIso: NOW, period, filter: { kind: "all" },
  current: window(), comparison: window({ appointments: priorAppointments, money: priorMoney }),
  practitioners, classesRead: ["recorded_at_visit"], ...over,
});
const must = <T,>(f: { available: true; value: T } | { available: false; reason: string }): T => {
  if (!f.available) throw new Error(`unavailable: ${f.reason}`);
  return f.value;
};

describe("the Overview model", () => {
  const v = buildOverview(input());
  it("collected is the all-money total with its four lines, and every money figure is available", () => {
    const c = must(v.collected);
    expect(c.headlineCents).toBe(9000 + 9500 + 3000 + 5000 + 2000 + 1500);
    expect(c.split).toMatchObject({ completedVisitsCents: 21500, feesCents: 5000, uncompletedPaymentsCents: 2000, otherBookingsCents: 1500, totalCents: 30000 });
    for (const f of [v.averagePaid, v.series, v.byPractitioner, v.serviceValue, v.reconciliation]) expect(f.available).toBe(true);
  });
  it("visits and clients count completed visits only, not bookings still to come", () => {
    expect(must(v.completedVisits).count).toBe(3);
    expect(must(v.activeClients)).toMatchObject({ count: 3, withoutClient: 0 });
    expect(must(v.visitsPerClient)).toEqual({ known: true, value: 1 });
  });
  it("the series adds up to collected and the chart has every day", () => {
    const s = must(v.series);
    expect(s.unit).toBe("day");
    expect(s.points).toHaveLength(30);
    expect(s.points.reduce((n, p) => n + p.collectedCents, 0)).toBe(30000);
    expect(s.points.reduce((n, p) => n + p.completedVisits, 0)).toBe(3);
  });
  it("the line from service value to collected holds exactly", () => {
    const l = must(v.reconciliation);
    expect(l).toMatchObject({ serviceValueCents: 18000, collectedAbovePriceCents: 500, collectedBelowPriceCents: 0, collectedOnNoEvidenceCents: 3000, feesCents: 5000, uncompletedPaymentsCents: 2000, otherBookingsCents: 1500, collectedCents: 30000 });
  });
  it("service value is per evidence class, with the visits that have no evidence counted beside it", () => {
    const sv = must(v.serviceValue);
    expect(sv.classes.recorded_at_visit).toEqual({ read: true, visits: 2, cents: 18000 });
    expect(sv.missingVisits).toBe(1);
    expect(sv.completedVisits).toBe(3);
    expect(sv.withEvidenceVisits + sv.missingVisits).toBe(sv.completedVisits);
  });
  it("change against the comparison period", () => {
    expect(must(v.collected).change).toEqual({ kind: "percent", percent: ((30000 - 12000) / 12000) * 100 });
    expect(must(v.completedVisits).change).toEqual({ kind: "percent", percent: ((3 - 2) / 2) * 100 });
  });
});

describe("a price class that could not be read is never a zero and never 'none'", () => {
  it("the unread online-booking class is not available, with no count and no amount", () => {
    const sv = must(buildOverview(input()).serviceValue);
    expect(sv.classes.online_booking).toEqual({ read: false });
    expect(sv.unreadClasses).toEqual(["online_booking"]);
    expect(JSON.stringify(sv.classes.online_booking)).not.toMatch(/visits|cents|0/);
  });
  it("only a class that WAS read may show a zero: read with no rows is a known zero, unread is not", () => {
    const none = { ...window().value, money: { cardRows: [], settlementRows: [], legacyFeeRows: [] } };
    const both = must(buildOverview(input({ current: { ok: true, value: none }, classesRead: ["recorded_at_visit", "online_booking"] })).serviceValue);
    expect(both.classes.online_booking).toEqual({ read: true, visits: 0, cents: 0 });
    const onlyOne = must(buildOverview(input({ current: { ok: true, value: none }, classesRead: ["recorded_at_visit"] })).serviceValue);
    expect(onlyOne.classes.online_booking).toEqual({ read: false });
    expect(onlyOne.classes.recorded_at_visit).toEqual({ read: true, visits: 0, cents: 0 });
  });
  it("whatever rows another class has, an unread class is not filled in from them", () => {
    const sv = must(buildOverview(input({ classesRead: [] })).serviceValue);
    expect(sv.classes).toEqual({ recorded_at_visit: { read: false }, online_booking: { read: false } });
    expect(sv.unreadClasses).toHaveLength(2);
  });
});

describe("the practitioner filter", () => {
  it("one practitioner: the figures are that practitioner's, reconciled against the statement's own bucket", () => {
    const f = buildOverview(input({ filter: { kind: "one", practitionerId: "pr-1" } }));
    expect(must(f.collected).headlineCents).toBe(18500);
    expect(must(f.completedVisits).count).toBe(2);
    expect(must(f.series).points.reduce((n, p) => n + p.collectedCents, 0)).toBe(18500);
    expect(f.filterKind).toBe("one");
  });
  it("unattributed: the booking with no practitioner", () => {
    expect(must(buildOverview(input({ filter: { kind: "unattributed" } })).collected).headlineCents).toBe(1500);
  });
  it("by-practitioner always shows the whole studio, whichever filter is on", () => {
    const rows = must(buildOverview(input({ filter: { kind: "one", practitionerId: "pr-1" } })).byPractitioner);
    expect(rows.reduce((n, r) => n + r.collectedCents, 0)).toBe(30000);
  });
});

describe("people labels: former, unnamed and unattributed", () => {
  const rows = must(buildOverview(input()).byPractitioner);
  it("keys are opaque indexes, never an id or a name", () => {
    expect(rows.map((r) => r.key)).toEqual(["p0", "p1", "p2"]);
  });
  it("an active practitioner shows their display name; a deactivated one is a former team member with no name; no practitioner is unattributed", () => {
    expect(rows.map((r) => r.label)).toEqual(["Ada Example", FORMER_TEAM_MEMBER_LABEL, UNATTRIBUTED_LABEL]);
    expect(JSON.stringify(rows)).not.toContain("Grace");
  });
  it("one removed from the list altogether is also a former team member", () => {
    const r = must(buildOverview(input({ practitioners: [] })).byPractitioner);
    expect(r.map((x) => x.label)).toEqual([FORMER_TEAM_MEMBER_LABEL, FORMER_TEAM_MEMBER_LABEL, UNATTRIBUTED_LABEL]);
  });
});

describe("the view holds aggregates only", () => {
  it("no appointment id, client id or practitioner id appears anywhere in what is sent to the browser", () => {
    const json = JSON.stringify(buildOverview(input({ filter: { kind: "one", practitionerId: "pr-1" } })));
    for (const id of [...appointments.map((a) => a.id), ...appointments.map((a) => a.clientId), "pr-1", "pr-2"]) expect(json, id).not.toContain(id);
  });
});

describe("failures make only the figures that needed them unavailable", () => {
  it("the current window failing: every figure carries the reason, none is zero", () => {
    const v = buildOverview(input({ current: { ok: false, reason: "too_many_appointments" } }));
    for (const f of [v.collected, v.completedVisits, v.activeClients, v.visitsPerClient, v.averagePaid, v.series, v.byPractitioner, v.serviceValue, v.reconciliation]) {
      expect(f).toEqual({ available: false, reason: "too_many_appointments" });
    }
  });
  it("the comparison failing: only the change figures are unavailable", () => {
    const v = buildOverview(input({ comparison: { ok: false, reason: "too_many_appointments" } }));
    expect(must(v.collected).change).toEqual({ kind: "unavailable" });
    expect(must(v.completedVisits).change).toEqual({ kind: "unavailable" });
    expect(must(v.collected).headlineCents).toBe(30000);
  });
  it("no payment currency: money says so and visit figures still show", () => {
    const v = buildOverview(input({ currency: null }));
    for (const f of [v.collected, v.averagePaid, v.series, v.byPractitioner, v.serviceValue, v.reconciliation]) expect(f).toEqual({ available: false, reason: "currency_unknown" });
    expect(must(v.completedVisits).count).toBe(3);
  });
  it("money that does not add up to the statement shows no money figure at all, and visits still show", () => {
    const orphan = { ...money, cardRows: [...money.cardRows, card("not-in-this-window", 4000)] };
    const v = buildOverview(input({ current: window({ money: orphan }) }));
    for (const f of [v.collected, v.averagePaid, v.series, v.serviceValue, v.reconciliation]) expect(f).toEqual({ available: false, reason: "not_reconciled" });
    expect(must(v.completedVisits).count).toBe(3);
  });
});

describe("what may be claimed about Statements", () => {
  it("a whole calendar month may say it matches that Statements month; a month to date may not", () => {
    expect(buildOverview(input()).statementsClaim).toEqual({ kind: "one_whole_month", month: "2026-11" });
    const mtd = resolvePeriod({ kind: "month_to_date", today: "2026-11-19" });
    if (!mtd.ok) throw new Error(mtd.error);
    expect(buildOverview(input({ period: mtd.period })).statementsClaim.kind).toBe("same_rules_same_dates");
  });
});
