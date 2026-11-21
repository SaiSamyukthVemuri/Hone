import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { AssembleAppointment } from "@/lib/finance/statement-document-assemble";
import type { StatementCardRow } from "@/lib/finance/statement";
import { buildOverview, SUPPLIED_EVIDENCE_CLASSES, type OverviewInput, type WindowData } from "@/lib/business-analytics/overview-model";
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
const okMoney = (m: typeof money) => ({ ok: true as const, value: m });
const window = (over: { appointments?: AssembleAppointment[]; money?: typeof money } = {}) => ({ ok: true as const, value: { appointments: over.appointments ?? appointments, money: okMoney(over.money ?? money) } as WindowData });
const input = (over: Partial<OverviewInput> = {}): OverviewInput => ({
  timezone: "America/Toronto", currency: "cad", nowIso: NOW, period, filter: { kind: "all" },
  current: window(), comparison: window({ appointments: priorAppointments, money: priorMoney }),
  history: { ok: true, value: { appointments: [] } }, followThrough: { ok: true, value: { past: [], future: [] } },
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
  it("only a class that WAS read may show a zero: read with no rows is a known zero", () => {
    const none = window({ money: { cardRows: [], settlementRows: [], legacyFeeRows: [] } }).value;
    const read = must(buildOverview(input({ current: { ok: true, value: none }, classesRead: ["recorded_at_visit"] })).serviceValue);
    expect(read.classes.recorded_at_visit).toEqual({ read: true, visits: 0, cents: 0 });
  });
  it("a caller that lists a class the model cannot build candidates for still gets 'not available', never a false zero", () => {
    const sv = must(buildOverview(input({ classesRead: ["recorded_at_visit", "online_booking"] })).serviceValue);
    expect(sv.classes.online_booking).toEqual({ read: false });
    expect(sv.unreadClasses).toEqual(["online_booking"]);
  });
  it("no kind of price evidence read: no service value and no line to collected, and never a 0 for either", () => {
    // The settlement quotes are in the rows (two visits, 18,000 in all) but the class was not read.
    const v = buildOverview(input({ classesRead: [] }));
    expect(v.serviceValue).toEqual({ available: false, reason: "no_evidence_read" });
    expect(v.reconciliation).toEqual({ available: false, reason: "no_evidence_read" });
    expect(JSON.stringify([v.serviceValue, v.reconciliation])).not.toMatch(/Cents|"visits"|:0\b/);
    // collected money and every other figure stay
    expect(must(v.collected).headlineCents).toBe(30000);
    for (const f of [v.averagePaid, v.series, v.byPractitioner]) expect(f.available).toBe(true);
    expect(must(v.completedVisits).count).toBe(3);
  });
  it("a class listed as read that the model cannot supply is the same as none read", () => {
    const v = buildOverview(input({ classesRead: ["online_booking"] }));
    expect(v.serviceValue).toEqual({ available: false, reason: "no_evidence_read" });
    expect(v.reconciliation).toEqual({ available: false, reason: "no_evidence_read" });
  });
  it("one class read beside an unread one: service value shows, with the unread class as not read", () => {
    const v = buildOverview(input({ classesRead: ["recorded_at_visit", "online_booking"] }));
    expect(must(v.serviceValue).classes.online_booking).toEqual({ read: false });
    expect(must(v.reconciliation).serviceValueCents).toBe(18000);
  });
  it("the model's supplied classes are exactly the ones it has candidate code for", () => {
    expect([...SUPPLIED_EVIDENCE_CLASSES]).toEqual(["recorded_at_visit"]);
  });
});

describe("a money read that fails or hits its cap hides only the money figures", () => {
  const MONEY = ["collected", "averagePaid", "series", "byPractitioner", "serviceValue", "reconciliation"] as const;
  for (const [what, reason] of [["fails", "read_failed"], ["hits its row cap", "read_failed"]] as const) {
    it(`appointments read, money ${what}: visit figures show, every money figure says why`, () => {
      const v = buildOverview(input({ current: { ok: true, value: { appointments, money: { ok: false, reason } } } }));
      for (const k of MONEY) expect(v[k], k).toEqual({ available: false, reason });
      expect(must(v.completedVisits).count).toBe(3);
      expect(must(v.activeClients).count).toBe(3);
      expect(v.visitsPerClient.available).toBe(true);
    });
  }
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

// ---------------------------------------------------------------------------
// History figures: returning versus first-time, visit interval, and no next booking
// ---------------------------------------------------------------------------
describe("history figures", () => {
  // The period is November 2026. Before it: ada saw us on 10 Sep and 10 Oct; bea once, on 1 Oct. In it: ada, bea and cy (new) are seen.
  const hist = (id: string, clientId: string, startsAt: string, status = "completed", practitionerId: string | null = "pr-1"): AssembleAppointment => ({ id, clientId, startsAt, status, practitionerId, serviceId: null, durationMinutes: 60 });
  const prior = [hist("h1", "ada", "2026-09-10T15:00:00Z"), hist("h2", "ada", "2026-10-10T15:00:00Z"), hist("h3", "bea", "2026-10-01T15:00:00Z", "completed", "pr-2"), hist("h4", "dan", "2026-10-02T15:00:00Z", "cancelled")];
  const inWindow = [hist("w1", "ada", "2026-11-05T15:00:00Z"), hist("w2", "bea", "2026-11-06T15:00:00Z", "completed", "pr-2"), hist("w3", "cy", "2026-11-07T15:00:00Z")];
  const base = (over: Partial<OverviewInput> = {}) => input({
    current: window({ appointments: inWindow, money: { cardRows: [], settlementRows: [], legacyFeeRows: [] } }),
    history: { ok: true, value: { appointments: prior } },
    ...over,
  });

  it("returning versus first-time: had a completed visit before the period began; a cancelled one does not count", () => {
    const r = must(buildOverview(base()).returning);
    expect(r).toMatchObject({ activeClients: 3, returning: 2, firstTime: 1 });
    expect(r.returningPercent).toEqual({ known: true, value: (100 * 2) / 3 });
  });
  it("the practitioner filter decides who counts as seen; history is the whole studio's", () => {
    // pr-2 saw only bea in November; bea had a visit before (with pr-2). ada's earlier visits with pr-1 do not matter here.
    const r = must(buildOverview(base({ filter: { kind: "one", practitionerId: "pr-2" } })).returning);
    expect(r).toMatchObject({ activeClients: 1, returning: 1, firstTime: 0 });
    // a client first seen by pr-2 who was previously seen only by pr-1 is RETURNING to the studio
    const moved = [hist("m1", "ada", "2026-10-10T15:00:00Z", "completed", "pr-1")];
    const r2 = must(buildOverview(base({ filter: { kind: "one", practitionerId: "pr-2" }, history: { ok: true, value: { appointments: moved } }, current: window({ appointments: [hist("m2", "ada", "2026-11-05T15:00:00Z", "completed", "pr-2")], money: { cardRows: [], settlementRows: [], legacyFeeRows: [] } }) })).returning);
    expect(r2).toMatchObject({ activeClients: 1, returning: 1 });
  });
  it("nobody seen: the percentage is not available, not 0", () => {
    const r = must(buildOverview(base({ current: window({ appointments: [], money: { cardRows: [], settlementRows: [], legacyFeeRows: [] } }) })).returning);
    expect(r.activeClients).toBe(0);
    expect(r.returningPercent.known).toBe(false);
  });
  it("visit interval pools RETURNING clients only: a client not seen in the period, or first seen in it, is not in the pool", () => {
    // fay (1 Jun, 1 Jul) was not seen in November; cy is new in November. Neither is returning, so neither shapes the interval.
    const extra = [...prior, hist("e1", "fay", "2026-06-01T15:00:00Z"), hist("e2", "fay", "2026-07-01T15:00:00Z")];
    const i = must(buildOverview(base({ history: { ok: true, value: { appointments: extra } } })).interval);
    expect(i.pooledAverageDays).toEqual({ known: true, value: (30 + 26 + 36) / 3 }); // ada 30, 26; bea 36
    expect(i).toMatchObject({ clientsWithInterval: 2, clientsWithoutInterval: 0 });
  });
  it("with a team-member filter, both who is seen AND the visits used for the gaps are that team member's", () => {
    // pr-2 saw only bea in November. bea's visits: 1 Oct (pr-2), 6 Nov (pr-2): one gap of 36. ada's visits with pr-1 are neither seen nor used.
    const f = must(buildOverview(base({ filter: { kind: "one", practitionerId: "pr-2" } })).interval);
    expect(f.pooledAverageDays).toEqual({ known: true, value: 36 });
    // a returning client seen by pr-2 whose EARLIER visit was with pr-1: that visit is not pr-2's, so there is no gap to pool (counted as without, never 0)
    const moved = [hist("m1", "ada", "2026-10-10T15:00:00Z", "completed", "pr-1")];
    const g = must(buildOverview(base({ filter: { kind: "one", practitionerId: "pr-2" }, history: { ok: true, value: { appointments: moved } }, current: window({ appointments: [hist("m2", "ada", "2026-11-05T15:00:00Z", "completed", "pr-2")], money: { cardRows: [], settlementRows: [], legacyFeeRows: [] } }) })).interval);
    expect(g.pooledAverageDays.known).toBe(false);
    expect(g).toMatchObject({ clientsWithInterval: 0, clientsWithoutInterval: 1 });
  });
  it("a client with one visit date is left out and counted, never averaged in as a zero gap", () => {
    const one = must(buildOverview(base({ history: { ok: true, value: { appointments: [hist("s1", "ada", "2026-10-10T15:00:00Z"), hist("s2", "bea", "2026-10-01T15:00:00Z", "completed", "pr-2")] } } })).interval);
    expect(one).toMatchObject({ clientsWithInterval: 2, clientsWithoutInterval: 0 }); // ada 10 Oct to 5 Nov = 26, bea 1 Oct to 6 Nov = 36
    expect(one.pooledAverageDays).toEqual({ known: true, value: 31 });
    const solo = must(buildOverview(base({ current: window({ appointments: [hist("t1", "ada", "2026-11-05T15:00:00Z")], money: { cardRows: [], settlementRows: [], legacyFeeRows: [] } }), history: { ok: true, value: { appointments: [] } } })).interval);
    expect(solo.pooledAverageDays.known).toBe(false); // ada has one visit and is first-time: no gap, not 0
    expect(solo.clientsWithoutInterval + solo.clientsWithInterval).toBe(0);
  });
  it("visit interval is pooled over the returning clients, through the period's last day only", () => {
    // ada: 10 Sep, 10 Oct, 5 Nov → gaps 30, 26. bea: 1 Oct, 6 Nov → gap 36. cy is first-time: not in the pool.
    const i = must(buildOverview(base()).interval);
    expect(i.pooledAverageDays).toEqual({ known: true, value: (30 + 26 + 36) / 3 });
    expect(i).toMatchObject({ clientsWithInterval: 2, clientsWithoutInterval: 0 });
  });
  it("a visit after the period never shapes its interval", () => {
    const later = [...prior, hist("z", "ada", "2026-12-20T15:00:00Z")];
    expect(must(buildOverview(base({ history: { ok: true, value: { appointments: later } } })).interval).pooledAverageDays).toEqual({ known: true, value: (30 + 26 + 36) / 3 });
  });
  it("history that could not be read makes only returning and interval unavailable", () => {
    const v = buildOverview(base({ history: { ok: false, reason: "too_many_appointments" } }));
    expect(v.returning).toEqual({ available: false, reason: "too_many_appointments" });
    expect(v.interval).toEqual({ available: false, reason: "too_many_appointments" });
    expect(must(v.completedVisits).count).toBe(3);
    expect(v.collected.available).toBe(true);
  });

  const NOW_MS = Date.parse(NOW);
  const future = (id: string, clientId: string, status = "confirmed", dayOffset = 3) => hist(id, clientId, new Date(NOW_MS + dayOffset * 86_400_000).toISOString(), status);
  const follow = (past: AssembleAppointment[], fut: AssembleAppointment[]) => ({ ok: true as const, value: { past, future: fut } });
  const seenRecently = [hist("l1", "ada", "2026-11-20T15:00:00Z"), hist("l2", "bea", "2026-08-01T15:00:00Z", "completed", "pr-2"), hist("l3", "cy", "2025-01-01T15:00:00Z")];
  it("no next booking: any client with a completed visit, nothing still to come with anyone; a count only, however long ago they were seen", () => {
    const v = buildOverview(base({ followThrough: follow(seenRecently, [future("f1", "ada")]) }));
    expect(must(v.noNextBooking)).toEqual({ count: 2 }); // bea and cy (seen in 2025: no look-back), ada has a booking
    expect(JSON.stringify(v.noNextBooking)).not.toMatch(/ada|bea|cy/);
  });
  it("only a confirmed booking still to come counts: a cancelled or past one does not", () => {
    expect(must(buildOverview(base({ followThrough: follow(seenRecently, [future("f1", "ada", "cancelled"), future("f2", "bea", "confirmed", -1)]) })).noNextBooking).count).toBe(3);
  });
  it("completed, no-show and cancelled rows dated in the future are not bookings: only a confirmed one counts", () => {
    const wrong = ["completed", "no_show", "cancelled", "pending"].map((st, i) => future(`g${i}`, "ada", st));
    expect(must(buildOverview(base({ followThrough: follow(seenRecently, wrong) })).noNextBooking).count).toBe(3); // ada, bea and cy are all still without one
    expect(must(buildOverview(base({ followThrough: follow(seenRecently, [...wrong, future("g9", "ada", "confirmed")]) })).noNextBooking).count).toBe(2);
  });
  it("the practitioner filter narrows who was seen, never the future-booking test", () => {
    const v = buildOverview(base({ filter: { kind: "one", practitionerId: "pr-2" }, followThrough: follow(seenRecently, [future("f1", "bea", "confirmed")].map((a) => ({ ...a, practitionerId: "pr-1" }))) }));
    expect(must(v.noNextBooking).count).toBe(0); // bea was seen by pr-2 and has a booking with pr-1: still booked
  });
  it("a client last seen years ago is counted: there is no look-back (the reference's scope), and a cancelled-only client is not a client with a visit", () => {
    const old = [hist("o1", "dee", "2019-03-01T15:00:00Z"), hist("o2", "eli", "2026-10-01T15:00:00Z", "cancelled")];
    expect(must(buildOverview(base({ followThrough: follow(old, []) })).noNextBooking)).toEqual({ count: 1 });
  });
  it("a follow-through read that failed makes only that figure unavailable", () => {
    const v = buildOverview(base({ followThrough: { ok: false, reason: "too_many_appointments" } }));
    expect(v.noNextBooking).toEqual({ available: false, reason: "too_many_appointments" });
    expect(v.returning.available).toBe(true);
  });
  it("the current window failing makes the history figures unavailable with its reason", () => {
    const v = buildOverview(base({ current: { ok: false, reason: "read_failed" } }));
    for (const f of [v.returning, v.interval, v.noNextBooking]) expect(f).toEqual({ available: false, reason: "read_failed" });
  });
});

describe("the figures the layout draws", () => {
  it("the comparison period's collected is carried so the difference can be said in words, and is null when the comparison could not be read", () => {
    expect(must(buildOverview(input()).collected).previousCents).toBe(12000);
    const noComparison = buildOverview(input({ comparison: { ok: false, reason: "read_failed" } }));
    expect(must(noComparison.collected).previousCents).toBeNull();
    expect(must(noComparison.collected).change).toEqual({ kind: "unavailable" });
  });
  it("the previous period's series is the comparison window's own points, one per day; unreadable comparison is unavailable with its reason, never an empty line", () => {
    const v = buildOverview(input());
    const prev = must(v.previousSeries);
    expect(prev.unit).toBe("day");
    expect(prev.points).toHaveLength(30);
    expect(prev.points.reduce((n, p) => n + p.collectedCents, 0)).toBe(12000);
    const failed = buildOverview(input({ comparison: { ok: false, reason: "read_failed" } }));
    expect(failed.previousSeries).toEqual({ available: false, reason: "read_failed" });
  });
  it("average paid has a change only when both averages are known; otherwise it is unavailable, never 0%", () => {
    const v = buildOverview(input());
    const cur = must(v.averagePaid).averageCents;
    expect(cur.known).toBe(true);
    expect(v.averagePaidChange.kind).toBe("percent");
    expect(buildOverview(input({ comparison: { ok: false, reason: "read_failed" } })).averagePaidChange).toEqual({ kind: "unavailable" });
    const noPaidBefore = buildOverview(input({ comparison: window({ appointments: priorAppointments, money: { cardRows: [], settlementRows: [], legacyFeeRows: [] } }) }));
    expect(noPaidBefore.averagePaidChange).toEqual({ kind: "unavailable" });
  });
  it("visit frequency buckets the active clients into 1, 2 and 3+ visits, and the buckets add up to the active clients", () => {
    const rows: AssembleAppointment[] = [
      appt("a1", "completed", "2026-11-02T15:00:00Z", "pr-1", "client-a"),
      appt("a2", "completed", "2026-11-09T15:00:00Z", "pr-1", "client-a"),
      appt("b1", "completed", "2026-11-03T15:00:00Z", "pr-1", "client-b"),
      appt("b2", "completed", "2026-11-10T15:00:00Z", "pr-1", "client-b"),
      appt("b3", "completed", "2026-11-17T15:00:00Z", "pr-1", "client-b"),
      appt("b4", "completed", "2026-11-24T15:00:00Z", "pr-1", "client-b"),
      appt("c1", "completed", "2026-11-04T15:00:00Z", "pr-1", "client-c"),
      appt("d1", "cancelled", "2026-11-05T15:00:00Z", "pr-1", "client-d"),
    ];
    const v = buildOverview(input({ current: window({ appointments: rows, money: { cardRows: [], settlementRows: [], legacyFeeRows: [] } }) }));
    const f = must(v.visitFrequency);
    expect(f).toEqual({ one: 1, two: 1, threePlus: 1 });
    expect(f.one + f.two + f.threePlus).toBe(must(v.activeClients).count);
  });
  it("visit frequency follows the team-member filter, and its buckets still add up", () => {
    const rows: AssembleAppointment[] = [
      appt("a1", "completed", "2026-11-02T15:00:00Z", "pr-1", "client-a"),
      appt("a2", "completed", "2026-11-09T15:00:00Z", "pr-2", "client-a"),
      appt("c1", "completed", "2026-11-04T15:00:00Z", "pr-2", "client-c"),
    ];
    const v = buildOverview(input({ filter: { kind: "one", practitionerId: "pr-1" }, current: window({ appointments: rows, money: { cardRows: [], settlementRows: [], legacyFeeRows: [] } }) }));
    const f = must(v.visitFrequency);
    expect(f).toEqual({ one: 1, two: 0, threePlus: 0 });
    expect(f.one + f.two + f.threePlus).toBe(must(v.activeClients).count);
  });
  it("a failed current read makes the new figures unavailable too, with the same reason", () => {
    const v = buildOverview(input({ current: { ok: false, reason: "read_failed" } }));
    for (const f of [v.previousSeries, v.visitFrequency]) expect(f).toEqual({ available: false, reason: "read_failed" });
  });
});

describe("beyond their usual visit interval", () => {
  const past: AssembleAppointment[] = [
    appt("x1", "completed", "2026-08-01T15:00:00Z", "pr-1", "client-x"), appt("x2", "completed", "2026-08-11T15:00:00Z", "pr-1", "client-x"), // gap 10, last 111 days ago: beyond
    appt("y1", "completed", "2026-10-01T15:00:00Z", "pr-1", "client-y"), appt("y2", "completed", "2026-10-31T15:00:00Z", "pr-1", "client-y"), // gap 30, last 30 days ago: within 45
    appt("z1", "completed", "2026-06-01T15:00:00Z", "pr-1", "client-z"), appt("z2", "completed", "2026-06-11T15:00:00Z", "pr-1", "client-z"), // beyond, but has a booking to come
    appt("w1", "completed", "2026-05-01T15:00:00Z", "pr-1", "client-w"), // one visit date: not enough history
    appt("q1", "completed", "2026-03-01T15:00:00Z", "pr-2", "client-q"), appt("q2", "completed", "2026-03-11T15:00:00Z", "pr-2", "client-q"), // beyond, seen by pr-2 only
    appt("m1", "completed", "2026-01-01T15:00:00Z", "pr-2", "client-m"), appt("m2", "completed", "2026-01-11T15:00:00Z", "pr-2", "client-m"), appt("m3", "completed", "2026-02-01T15:00:00Z", "pr-1", "client-m"), // pr-2 saw them twice, pr-1 once: their gaps are across BOTH
    appt("c1", "cancelled", "2026-02-01T15:00:00Z", "pr-1", "client-c"), appt("c2", "cancelled", "2026-02-11T15:00:00Z", "pr-1", "client-c"), // never completed: not counted
  ];
  const future: AssembleAppointment[] = [appt("fz", "confirmed", "2026-12-15T15:00:00Z", "pr-2", "client-z"), appt("fp", "pending", "2026-12-16T15:00:00Z", "pr-1", "client-x")];
  const ft = (o: Partial<OverviewInput> = {}) => buildOverview(input({ followThrough: { ok: true, value: { past, future } }, ...o }));
  it("counts the clients past 1.5 times their own average gap, with no confirmed booking to come; a one-visit client is counted apart, never flagged", () => {
    expect(must(ft().beyondUsual)).toEqual({ count: 3, notEnoughHistory: 1 }); // x, q and m beyond; w short; y within; z has a booking; c never completed
  });
  it("a pending booking does not count as a booking to come; a confirmed one with ANY practitioner does", () => {
    const v = ft({ followThrough: { ok: true, value: { past, future: [appt("fz", "confirmed", "2026-12-15T15:00:00Z", "pr-2", "client-z"), appt("fx", "confirmed", "2026-12-16T15:00:00Z", "pr-2", "client-x")] } } });
    expect(must(v.beyondUsual).count).toBe(2); // x now has a confirmed booking with pr-2; q and m are beyond
  });
  it("the team-member filter narrows who is counted (the clients that member saw), not the history or the future test", () => {
    expect(must(ft({ filter: { kind: "one", practitionerId: "pr-1" } }).beyondUsual)).toEqual({ count: 2, notEnoughHistory: 1 }); // x, and m: their gaps use pr-2's visits too, not only pr-1's single visit
    expect(must(ft({ filter: { kind: "one", practitionerId: "pr-2" } }).beyondUsual)).toEqual({ count: 2, notEnoughHistory: 0 }); // q and m
  });
  it("the boundary is strict: exactly 1.5 times the average gap is not beyond, one day more is", () => {
    const run = (last: string, first: string) => must(ft({ followThrough: { ok: true, value: { past: [appt("e1", "completed", `${first}T15:00:00Z`, "pr-1", "client-e"), appt("e2", "completed", `${last}T15:00:00Z`, "pr-1", "client-e")], future: [] } } }).beyondUsual).count;
    expect(run("2026-11-15", "2026-11-05")).toBe(0); // gap 10, last visit 15 days before 30 Nov: exactly 1.5 x
    expect(run("2026-11-14", "2026-11-04")).toBe(1); // gap 10, last visit 16 days before
  });
  it("when the follow-through read failed the figure is unavailable with its reason, never 0", () => {
    const v = buildOverview(input({ followThrough: { ok: false, reason: "read_failed" } }));
    expect(v.beyondUsual).toEqual({ available: false, reason: "read_failed" });
    expect(must(buildOverview(input({ followThrough: { ok: true, value: { past: [], future: [] } } })).beyondUsual)).toEqual({ count: 0, notEnoughHistory: 0 });
  });
});

describe("the collected difference, visit frequency buckets and one bucket unit for both series", () => {
  const empty = { cardRows: [], settlementRows: [], legacyFeeRows: [] };
  it("the model says which way collected moved and by how much, so the screen subtracts nothing", () => {
    // now = 265.00 (the fixture); the comparison collected is set by the prior money
    const up = must(buildOverview(input()).collected); // previous 120.00
    expect(up.difference).toEqual({ direction: "more", cents: up.headlineCents - 12000 });
    const down = must(buildOverview(input({ comparison: window({ appointments: priorAppointments, money: { cardRows: [], settlementRows: [cash("old-1", 40000, 40000)], legacyFeeRows: [] } }) })).collected);
    expect(down.difference).toEqual({ direction: "less", cents: 40000 - down.headlineCents });
    expect(down.difference!.cents).toBeGreaterThan(0); // the amount is never negative; the direction carries the sign
    const same = must(buildOverview(input({ comparison: window({ appointments: priorAppointments, money: { cardRows: [], settlementRows: [cash("old-1", must(buildOverview(input()).collected).headlineCents, 1)], legacyFeeRows: [] } }) })).collected);
    expect(same.difference).toEqual({ direction: "same", cents: 0 });
    expect(must(buildOverview(input({ comparison: { ok: false, reason: "read_failed" } })).collected).difference).toBeNull();
  });
  it("three-visit and four-visit clients land in the 3+ bucket, and the buckets add up to the active clients", () => {
    const rows: AssembleAppointment[] = [];
    for (const [c, n] of [["c1", 1], ["c2", 2], ["c3", 3], ["c4", 4]] as const) for (let i = 0; i < n; i++) rows.push(appt(`${c}-${i}`, "completed", `2026-11-0${i + 2}T15:00:00Z`, "pr-1", `client-${c}`));
    const v = buildOverview(input({ current: window({ appointments: rows, money: empty }) }));
    const f = must(v.visitFrequency);
    expect(f).toEqual({ one: 1, two: 1, threePlus: 2 });
    expect(f.one + f.two + f.threePlus).toBe(must(v.activeClients).count);
  });
  it("both series use the CURRENT period's unit, so a 63-day year to date and its 62-day comparison are both monthly", () => {
    const r = resolvePeriod({ kind: "year_to_date", today: "2028-03-03" });
    if (!r.ok) throw new Error(r.error);
    expect(r.period.current.days).toBe(63);
    expect(r.period.comparison.days).toBe(62);
    const v = buildOverview(input({ period: r.period, nowIso: "2028-03-03T18:00:00Z", current: window({ appointments: [], money: empty }), comparison: window({ appointments: [], money: empty }) }));
    const cur = must(v.series);
    const prev = must(v.previousSeries);
    expect(cur.unit).toBe("month");
    expect(prev.unit).toBe("month");
    expect(prev.points.map((p) => p.key)).toEqual(["2027-01", "2027-02", "2027-03"]);
    expect(cur.points.map((p) => p.key)).toEqual(["2028-01", "2028-02", "2028-03"]);
  });
  it("a short current period keeps daily buckets for a longer comparison", () => {
    const r = resolvePeriod({ kind: "custom", today: "2028-03-03", from: "2028-03-01", to: "2028-03-03" });
    if (!r.ok) throw new Error(r.error);
    const v = buildOverview(input({ period: r.period, nowIso: "2028-03-03T18:00:00Z", current: window({ appointments: [], money: empty }), comparison: window({ appointments: [], money: empty }) }));
    expect(must(v.series).unit).toBe("day");
    expect(must(v.previousSeries).unit).toBe("day");
  });
  it("the scope of beyond-usual under a filter is documented on the type (every client that team member has ever seen)", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("lib/business-analytics/overview-model.ts", "utf8")).toContain("has EVER seen, not only those seen in the period");
  });
});
