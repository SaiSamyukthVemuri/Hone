import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { FIGURE_UNAVAILABLE_COPY, unavailableText, type ReadFailure } from "@/lib/business-analytics/figure";
import { overviewCsv, overviewCsvFileName } from "@/lib/business-analytics/overview-csv";
import { buildOverview, type OverviewInput, type OverviewView } from "@/lib/business-analytics/overview-model";
import { resolvePeriod } from "@/lib/business-analytics/period";
import { CSV_BOM } from "@/lib/finance/statement-csv";

// Same synthetic data as the screen tests: recognisable ids so a leak can be found by searching for them.
const appt = (id: string, status: string, startsAt: string, practitionerId: string | null, clientId = `client-${id}`) => ({ id, clientId, startsAt, status, practitionerId, serviceId: null, durationMinutes: 60 });
const appointments = [
  appt("done-quoted", "completed", "2026-11-05T15:00:00Z", "pr-1"),
  appt("done-over", "completed", "2026-11-06T15:00:00Z", "pr-1"),
  appt("done-noprice", "completed", "2026-11-07T15:00:00Z", "pr-2"),
  appt("noshow", "no_show", "2026-11-08T15:00:00Z", "pr-2"),
];
const card = (appointmentId: string, chargeReason: string, amountCents: number) => ({ appointmentId, chargeReason, status: "succeeded", amountCents, currency: "cad", refundStatus: null, refundAmountCents: null, providerRefundStatus: null, stripeRefundId: null, cumulativeFullRefundVerified: false, stripeLivemode: true });
const money = {
  cardRows: [card("done-noprice", "session_payment", 3000), card("noshow", "no_show_fee", 5000)],
  settlementRows: [
    { appointmentId: "done-quoted", method: "paid_cash", amountCents: 9000, currency: "cad", quotedAmountCents: 9000 },
    { appointmentId: "done-over", method: "paid_cash", amountCents: 9500, currency: "cad", quotedAmountCents: 9000 },
  ],
  legacyFeeRows: [],
};
const p = resolvePeriod({ kind: "custom", today: "2026-11-30", from: "2026-11-01", to: "2026-11-30" });
if (!p.ok) throw new Error(p.error);
const input = (over: Partial<OverviewInput> = {}): OverviewInput => ({
  timezone: "America/Toronto",
  currency: "cad",
  nowIso: "2026-11-30T20:00:00Z",
  period: p.period,
  filter: { kind: "all" },
  current: { ok: true, value: { appointments, money: { ok: true, value: money as never } } },
  comparison: { ok: false, reason: "read_failed" },
  history: { ok: true, value: { appointments: [appt("old", "completed", "2026-10-01T15:00:00Z", "pr-1", "client-done-quoted")] } },
  followThrough: { ok: true, value: { past: appointments, future: [] } },
  practitioners: [
    { id: "pr-1", displayName: "=HYPERLINK(1)", active: true },
    { id: "pr-2", displayName: "Grace Example", active: false },
  ],
  classesRead: ["recorded_at_visit"],
  ...over,
});
const csv = (view: OverviewView) => overviewCsv(view, { preparedOn: "2026-11-30" });
const healthy = () => buildOverview(input());

describe("the Overview CSV", () => {
  const text = csv(healthy());
  it("leads with a byte order mark and states the period, basis, currency and who sees it", () => {
    expect(text.startsWith(CSV_BOM)).toBe(true);
    expect(text).toContain("Collected (by visit date)");
    expect(text).toContain("CAD");
    expect(text).toContain("Only the studio owner is shown this page");
    expect(text).not.toMatch(/revenue|by payment date/i);
  });
  it("writes money as decimals with a currency column", () => {
    expect(text).toMatch(/Collected \(by visit date\),265\.00,CAD,/);
    expect(text).toMatch(/= Collected,265\.00,CAD,/);
  });
  it("a team member's name that starts like a formula is neutralised, and a former member is not named", () => {
    expect(text).toContain("'=HYPERLINK(1)");
    expect(text).not.toMatch(/(^|,|\n)=HYPERLINK/);
    expect(text).toContain("Former team member");
    expect(text).not.toContain("Grace");
  });
  it("holds no appointment id, client id or practitioner id", () => {
    for (const id of [...appointments.map((a) => a.id), ...appointments.map((a) => a.clientId), "pr-1", "pr-2"]) expect(text, id).not.toContain(id);
  });
  it("no next booking is a count, never a list of clients", () => {
    const row = text.split("\n").find((l) => l.startsWith("Clients,Clients with no next booking,")) ?? "";
    expect(row).toMatch(/^Clients,Clients with no next booking,\d+,,/);
    expect(text).not.toMatch(/client-[a-z]/);
  });
  it("the file name is the period's dates only, whatever the team-member filter", () => {
    expect(overviewCsvFileName(healthy().currentRange)).toBe("analytics-2026-11-01-to-2026-11-30.csv");
    const filtered = buildOverview(input({ filter: { kind: "one", practitionerId: "pr-1" } }));
    expect(overviewCsvFileName(filtered.currentRange)).not.toMatch(/pr-1/);
    expect(csv(filtered)).toContain("One team member (filtered)");
    expect(csv(filtered)).not.toContain("pr-1");
  });
});

describe("every unavailable figure is a row that says why, never an empty cell or a zero", () => {
  const KEYS = ["collected", "series", "byPractitioner", "serviceValue", "reconciliation", "completedVisits", "activeClients", "visitsPerClient", "averagePaid", "returning", "interval", "noNextBooking"] as const;
  const REASONS: ReadFailure[] = ["too_many_appointments", "read_failed", "currency_unknown", "not_reconciled", "no_evidence_read"];
  for (const key of KEYS) {
    for (const reason of REASONS) {
      it(`${key} (${reason})`, () => {
        const before = csv(healthy()).split("\n").length;
        const view = { ...healthy(), [key]: { available: false, reason } } as OverviewView;
        const text = csv(view);
        expect(text).toContain(unavailableText(reason).replace(/"/g, '""'));
        expect(text.split("\n").length).toBeLessThanOrEqual(before + 1);
        for (const line of text.split("\n").slice(1)) expect(line, line).not.toMatch(/,,,,$/); // no row of empty cells
      });
    }
  }
  it("the sentence is the screen's sentence", () => {
    expect(unavailableText("no_evidence_read")).toContain(FIGURE_UNAVAILABLE_COPY.no_evidence_read);
  });
});
