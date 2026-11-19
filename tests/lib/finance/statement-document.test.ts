import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  FEE_NOT_RECORDED_COPY,
  NOT_COMPLETED_COPY,
  TOTAL_PAID_DEFINITION,
  UNKNOWN_REASONS,
  UNKNOWN_REASON_COPY,
  VISIT_FLAGS,
  VISIT_STATES,
  awaitingVisitLine,
  buildStatementDocument,
  classifyEligibility,
  type FeeItemInput,
  classifyVisit,
  formatLocalDate,
  isLocalDate,
  paidSummaryLine,
  resolveRecordedFee,
  selectVisits,
  type BuildDocumentInput,
  type DocumentVisitInput,
  type FeeCandidate,
} from "@/lib/finance/statement-document";
import { AMOUNT_KINDS, type StatementKind, type StatementMoneyLine } from "@/lib/finance/statement";

// Synthetic rows only. Amounts are chosen by each test; nothing here is a real price. The one pinned example is Sam's approved wording.
const ROOT = path.resolve(__dirname, "../../..");
const fmt = (c: number) => `$${(c / 100).toFixed(0)}`;

const line = (kind: StatementKind, cents: number | null, source: StatementMoneyLine["source"] = "card"): StatementMoneyLine => ({
  kind,
  cents: AMOUNT_KINDS.includes(kind) ? cents : null,
  source,
});
let n = 0;
const visit = (over: Partial<DocumentVisitInput> = {}): DocumentVisitInput => {
  n += 1;
  return {
    appointmentId: `appt-${n}`,
    clientId: "client-1",
    localDate: "2026-11-03",
    localTime: "10:00",
    startsAt: "2026-11-03T15:00:00Z",
    serviceName: "Service A",
    scheduledMinutes: 30,
    practitionerId: "prac-1",
    practitionerName: "Practitioner One",
    feeCandidates: [],
    lines: [],
    ...over,
  };
};
const quote = (cents: number | null): FeeCandidate => ({ source: "settlement_quote", cents });
const charged = (cents: number | null): FeeCandidate => ({ source: "card_attempt", cents });

const build = (visits: DocumentVisitInput[], over: Partial<BuildDocumentInput> = {}) =>
  buildStatementDocument({
    studioId: "studio-1",
    identity: { studioName: "Studio One", legalEntityName: null, address: null, contactEmail: null },
    client: { id: "client-1", name: "Client One" },
    scope: { kind: "full_history" },
    currency: "CAD",
    preparedOn: "2026-11-19",
    visits,
    ...over,
  });
const doc = (visits: DocumentVisitInput[], over: Partial<BuildDocumentInput> = {}) => {
  const r = build(visits, over);
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.document;
};

describe("the recorded fee comes only from stored records", () => {
  it("no record means NOT recorded (never a current price, never zero)", () => {
    expect(resolveRecordedFee([])).toEqual({ state: "not_recorded", ambiguous: false });
    expect(resolveRecordedFee([quote(null), charged(null)])).toEqual({ state: "not_recorded", ambiguous: false });
  });
  it("the settlement quote snapshot wins over a card amount", () => {
    expect(resolveRecordedFee([charged(7000), quote(6000)])).toEqual({ state: "recorded", cents: 6000, source: "settlement_quote" });
  });
  it("a card attempt's charged amount is recorded when there is no quote", () => {
    expect(resolveRecordedFee([charged(7000)])).toEqual({ state: "recorded", cents: 7000, source: "card_attempt" });
  });
  it("two attempts that agree are one fee; two that DISAGREE are ambiguous, not guessed", () => {
    expect(resolveRecordedFee([charged(7000), charged(7000)])).toMatchObject({ state: "recorded", cents: 7000 });
    expect(resolveRecordedFee([charged(7000), charged(5000)])).toEqual({ state: "not_recorded", ambiguous: true });
  });
  it("zero is a REAL recorded fee; a negative or fractional amount is not a fee", () => {
    expect(resolveRecordedFee([quote(0)])).toMatchObject({ state: "recorded", cents: 0 });
    expect(resolveRecordedFee([quote(-1), charged(12.5)])).toEqual({ state: "not_recorded", ambiguous: false });
  });
});

describe("three states stay distinct: paid, unknown, confirmed unpaid", () => {
  it("collected money, nothing uncertain: paid", () => {
    const v = classifyVisit(visit({ feeCandidates: [quote(5000)], lines: [line("collected_card_session", 5000)] }));
    expect(v.state).toBe("paid");
    expect(v.reasons).toEqual([]);
  });
  it("no row at all: UNKNOWN (no_payment_record), with no owed amount", () => {
    const v = classifyVisit(visit({ feeCandidates: [quote(5000)] }));
    expect(v.state).toBe("unknown");
    expect(v.reasons).toEqual(["no_payment_record"]);
    expect(v.owedCents).toBeNull();
  });
  it("only excluded rows (failed or test-mode attempts) are the same as no row", () => {
    expect(classifyVisit(visit({ lines: [line("excluded", null)] })).reasons).toEqual(["no_payment_record"]);
  });
  it("an owner-attested 'still owes' with a RECORDED quote: confirmed unpaid, with the amount", () => {
    const v = classifyVisit(visit({ feeCandidates: [quote(5000)], lines: [line("still_owes_note", null, "settlement")] }));
    expect(v.state).toBe("confirmed_unpaid");
    expect(v.owedCents).toBe(5000);
  });
  it("'still owes' with NO recorded quote: confirmed unpaid, but the amount is not established", () => {
    const v = classifyVisit(visit({ lines: [line("still_owes_note", null, "settlement")] }));
    expect(v.state).toBe("confirmed_unpaid");
    expect(v.owedCents).toBeNull();
  });
  it("a card-recorded fee alone never makes a balance: still_owes needs the settlement QUOTE", () => {
    const v = classifyVisit(visit({ feeCandidates: [charged(5000)], lines: [line("still_owes_note", null, "settlement")] }));
    expect(v.state).toBe("confirmed_unpaid");
    expect(v.owedCents).toBeNull();
  });
  it("part paid with nothing attesting the rest: UNKNOWN (partial_payment_unverified), never an invented balance", () => {
    const v = classifyVisit(visit({ feeCandidates: [quote(5000)], lines: [line("collected_cash", 2000, "settlement")] }));
    expect(v.state).toBe("unknown");
    expect(v.reasons).toEqual(["partial_payment_unverified"]);
  });
  it("part paid and attested still owes, with a recorded quote: confirmed unpaid for the remainder", () => {
    const v = classifyVisit(visit({ feeCandidates: [quote(5000)], lines: [line("collected_card_session", 2000), line("still_owes_note", null, "settlement")] }));
    expect(v.state).toBe("confirmed_unpaid");
    expect(v.owedCents).toBe(3000);
  });
  it("payment plus a waiver that together cover the fee: paid", () => {
    const v = classifyVisit(visit({ feeCandidates: [quote(5000)], lines: [line("collected_cash", 3000, "settlement"), line("waived", 2000, "settlement")] }));
    expect(v.state).toBe("paid");
  });
  it("paid with NO recorded fee is still paid (the payment is the record), flagged fee_not_recorded", () => {
    const v = classifyVisit(visit({ lines: [line("collected_card_session", 4200)] }));
    expect(v.state).toBe("paid");
    expect(v.flags).toContain("fee_not_recorded");
  });
  it("an unresolved, other-currency or unreadable row makes the visit unknown even when money was also collected", () => {
    expect(classifyVisit(visit({ lines: [line("collected_cash", 100, "settlement"), line("unresolved", 900)] })).reasons).toEqual(["payment_unresolved"]);
    expect(classifyVisit(visit({ lines: [line("other_currency", null)] })).reasons).toEqual(["other_currency"]);
    expect(classifyVisit(visit({ lines: [line("unreadable", null, "settlement")] })).reasons).toEqual(["unreadable_record"]);
  });
  it("waived only, or fully refunded only: adjusted; a recorded zero fee with nothing paid: no_charge", () => {
    expect(classifyVisit(visit({ lines: [line("waived", 5000, "settlement")] })).state).toBe("adjusted");
    expect(classifyVisit(visit({ lines: [line("refunded_card_session", 5000)] })).state).toBe("adjusted");
    expect(classifyVisit(visit({ feeCandidates: [quote(0)] })).state).toBe("no_charge");
  });
  it("every state and reason the model can produce is in the closed set, each reason has fixed copy", () => {
    expect(VISIT_STATES).toEqual(["paid", "unknown", "confirmed_unpaid", "adjusted", "no_charge"]);
    for (const r of UNKNOWN_REASONS) expect(UNKNOWN_REASON_COPY[r].length).toBeGreaterThan(0);
    expect(Object.keys(UNKNOWN_REASON_COPY).sort()).toEqual([...UNKNOWN_REASONS].sort());
    expect(VISIT_FLAGS).toContain("fee_not_recorded");
  });
});

describe("no balance while anything is unknown", () => {
  it("established (zero) when every visit is paid", () => {
    const d = doc([visit({ feeCandidates: [quote(5000)], lines: [line("collected_card_session", 5000)] })]);
    expect(d.balanceDue).toEqual({ kind: "established", cents: 0 });
  });
  it("NOT established while one visit is unknown, even with a confirmed unpaid one beside it", () => {
    const d = doc([
      visit({ feeCandidates: [quote(5000)], lines: [line("still_owes_note", null, "settlement")] }),
      visit({ feeCandidates: [quote(6000)] }),
    ]);
    expect(d.balanceDue).toEqual({ kind: "not_established", because: "unknown_visits" });
  });
  it("established as the sum of confirmed unpaid amounts when nothing is unknown", () => {
    const d = doc([
      visit({ feeCandidates: [quote(5000)], lines: [line("still_owes_note", null, "settlement")] }),
      visit({ feeCandidates: [quote(2500)], lines: [line("still_owes_note", null, "settlement")] }),
    ]);
    expect(d.balanceDue).toEqual({ kind: "established", cents: 7500 });
  });
  it("not established when an attested owed amount cannot be established", () => {
    const d = doc([visit({ feeCandidates: [charged(5000)], lines: [line("still_owes_note", null, "settlement")] })]);
    expect(d.balanceDue).toEqual({ kind: "not_established", because: "owed_amount_not_established" });
    // with no recorded fee at all, D1 speaks first: no balance because the fee is not recorded
    expect(doc([visit({ lines: [line("still_owes_note", null, "settlement")] })]).balanceDue).toEqual({ kind: "not_established", because: "fee_not_recorded" });
  });
});

describe("the approved missing-payment example is representable exactly", () => {
  // Sam's wording, with synthetic ids: five visits, 57000 in recorded fees, 51000 confirmed, one visit on 19 Nov with a recorded 6000 fee and no payment row.
  const four = [10000, 20000, 11000, 10000].map((c, i) =>
    visit({ localDate: `2026-11-0${i + 1}`, startsAt: `2026-11-0${i + 1}T15:00:00Z`, feeCandidates: [quote(c)], lines: [line("collected_card_session", c)] }),
  );
  const unpaid = visit({ localDate: "2026-11-19", startsAt: "2026-11-19T15:00:00Z", feeCandidates: [quote(6000)] });
  const d = doc([...four, unpaid], { scope: { kind: "month", month: "2026-11" } });
  it("$510 paid · 1 visit awaiting payment confirmation", () => {
    expect(d.totals.paidCents).toBe(51000);
    expect(d.totals.recordedFeeCents).toBe(57000);
    expect(d.totals.visitCount).toBe(5);
    expect(paidSummaryLine(d, fmt)).toBe("$510 paid · 1 visit awaiting payment confirmation");
  });
  it("Nov 19, 2026 · $60 fee · No payment recorded, and NO aggregate balance", () => {
    expect(d.awaiting).toHaveLength(1);
    const v = d.visits.find((x) => x.localDate === "2026-11-19")!;
    expect(awaitingVisitLine(v, fmt)).toBe("Nov 19, 2026 · $60 fee · No payment recorded");
    expect(d.balanceDue.kind).toBe("not_established");
  });
  it("with NO recorded fee source the same visit says 'Fee not recorded', never a price", () => {
    const d2 = doc([visit({ localDate: "2026-11-19", startsAt: "2026-11-19T15:00:00Z" })]);
    expect(awaitingVisitLine(d2.visits[0], fmt)).toBe(`Nov 19, 2026 · ${FEE_NOT_RECORDED_COPY} · No payment recorded`);
    expect(d2.totals.feeTotalComplete).toBe(false);
  });
  it("several uncertain visits list each date and reason", () => {
    const d3 = doc([
      visit({ localDate: "2026-11-05", startsAt: "2026-11-05T15:00:00Z" }),
      visit({ localDate: "2026-11-06", startsAt: "2026-11-06T15:00:00Z", lines: [line("unresolved", 800)] }),
    ]);
    expect(d3.awaiting.map((a) => [a.localDate, a.reasons])).toEqual([
      ["2026-11-05", ["no_payment_record"]],
      ["2026-11-06", ["payment_unresolved"]],
    ]);
    expect(paidSummaryLine(d3, fmt)).toBe("$0 paid · 2 visits awaiting payment confirmation");
  });
});

describe("total paid has one definition, and refunds and waivers are never netted or counted twice", () => {
  const d = doc([
    visit({ feeCandidates: [quote(5000)], lines: [line("collected_card_session", 5000)] }),
    visit({ feeCandidates: [quote(4000)], lines: [line("refunded_card_session", 4000)] }),
    visit({ feeCandidates: [quote(3000)], lines: [line("waived", 3000, "settlement")] }),
  ]);
  it("paid = collected and kept only; refunded and waived are their own totals; original paid = paid + refunded", () => {
    expect(d.totals.paidCents).toBe(5000);
    expect(d.totals.refundedCents).toBe(4000);
    expect(d.totals.waivedCents).toBe(3000);
    expect(d.totals.originalPaidCents).toBe(9000);
    expect(TOTAL_PAID_DEFINITION).toMatch(/collected and kept/);
  });
  it("rows that carry no amount are never summed anywhere", () => {
    const e = doc([visit({ lines: [line("unresolved", 9900), line("other_currency", 9900), line("unreadable", 9900, "settlement"), line("excluded", 9900)] })]);
    expect(e.totals.paidCents + e.totals.refundedCents + e.totals.waivedCents).toBe(0);
    for (const l of e.visits[0].lines) expect(l.cents).toBeNull();
  });
  it("each visit's lines stay together (a split payment is one visit)", () => {
    const e = doc([visit({ feeCandidates: [quote(5000)], lines: [line("collected_card_session", 3000), line("collected_cash", 2000, "settlement")] })]);
    expect(e.visits).toHaveLength(1);
    expect(e.visits[0].paidCents).toBe(5000);
    expect(e.visits[0].state).toBe("paid");
  });
  it("the recorded fee total is flagged incomplete whenever any visit has no recorded fee", () => {
    const e = doc([visit({ feeCandidates: [quote(5000)], lines: [line("collected_cash", 5000, "settlement")] }), visit({ lines: [line("collected_cash", 700, "settlement")] })]);
    expect(e.totals.recordedFeeCents).toBe(5000);
    expect(e.totals.feeTotalComplete).toBe(false);
  });
});

describe("scope: month, full history, inclusive range, chosen visits", () => {
  const nov30 = visit({ localDate: "2026-11-30", startsAt: "2026-11-30T20:00:00Z" });
  const dec01 = visit({ localDate: "2026-12-01", startsAt: "2026-12-01T15:00:00Z" });
  const oct31 = visit({ localDate: "2026-10-31", startsAt: "2026-10-31T15:00:00Z" });
  const all = [dec01, oct31, nov30];
  it("a month holds only that studio-local month, in date order", () => {
    expect(doc(all, { scope: { kind: "month", month: "2026-11" } }).visits.map((v) => v.localDate)).toEqual(["2026-11-30"]);
  });
  it("full history holds everything exactly once, in date order, even if the same visit was passed twice", () => {
    expect(doc([...all, nov30], { scope: { kind: "full_history" } }).visits.map((v) => v.localDate)).toEqual(["2026-10-31", "2026-11-30", "2026-12-01"]);
  });
  it("a custom range is inclusive at BOTH ends", () => {
    const r = doc(all, { scope: { kind: "range", startLocal: "2026-10-31", endLocalInclusive: "2026-11-30" } });
    expect(r.visits.map((v) => v.localDate)).toEqual(["2026-10-31", "2026-11-30"]);
    expect(doc(all, { scope: { kind: "range", startLocal: "2026-11-30", endLocalInclusive: "2026-11-30" } }).visits).toHaveLength(1);
  });
  it("chosen visits may be nonconsecutive and across months, counted once", () => {
    const r = doc(all, { scope: { kind: "visits", appointmentIds: [dec01.appointmentId, oct31.appointmentId, dec01.appointmentId] } });
    expect(r.visits.map((v) => v.localDate)).toEqual(["2026-10-31", "2026-12-01"]);
  });
  it("a month with no visit is a valid EMPTY document with no balance claim of its own", () => {
    const r = doc(all, { scope: { kind: "month", month: "2026-09" } });
    expect(r.visits).toEqual([]);
    expect(r.totals.visitCount).toBe(0);
  });
  it("rejects a reversed range, an empty selection, an unknown id, a malformed month or date, and a visit of another client", () => {
    expect(build(all, { scope: { kind: "range", startLocal: "2026-11-30", endLocalInclusive: "2026-11-01" } })).toEqual({ ok: false, error: "reversed_range" });
    expect(build(all, { scope: { kind: "visits", appointmentIds: [] } })).toEqual({ ok: false, error: "empty_selection" });
    expect(build(all, { scope: { kind: "visits", appointmentIds: ["not-mine"] } })).toEqual({ ok: false, error: "unknown_visit" });
    expect(build(all, { scope: { kind: "month", month: "2026-13" } })).toEqual({ ok: false, error: "invalid_scope" });
    expect(build(all, { scope: { kind: "range", startLocal: "2026-02-30", endLocalInclusive: "2026-03-01" } })).toEqual({ ok: false, error: "invalid_date" });
    expect(build([...all, visit({ clientId: "client-2" })])).toEqual({ ok: false, error: "foreign_visit" });
    expect(build(all, { preparedOn: "19 Nov" })).toEqual({ ok: false, error: "invalid_date" });
    expect(build(all, { currency: " " })).toEqual({ ok: false, error: "invalid_currency" });
  });
  it("selectVisits never reaches outside the list it is given: an id of another client's visit is unknown", () => {
    const other = visit({ clientId: "client-2" });
    expect(selectVisits("client-1", all, { kind: "visits", appointmentIds: [other.appointmentId] })).toEqual({ ok: false, error: "unknown_visit" });
  });
});

describe("D4: eligibility, fee line items, total spend, Not completed", () => {
  const NOW = "2026-11-19T12:00:00Z";
  const el = (status: string, startsAt: string, hasFeeRecord = false) => classifyEligibility({ status, startsAt, hasFeeRecord }, NOW);
  it("completed is a treatment; fee-bearing cancel/no-show is a fee line item; fee-free ones and the future are off; a past confirmed booking is Not completed", () => {
    expect(el("completed", "2026-11-01T10:00:00Z")).toBe("treatment");
    expect(el("cancelled", "2026-11-01T10:00:00Z", true)).toBe("fee_only");
    expect(el("no_show", "2026-11-01T10:00:00Z", true)).toBe("fee_only");
    expect(el("cancelled", "2026-11-01T10:00:00Z", false)).toBe("off_document");
    expect(el("no_show", "2026-11-01T10:00:00Z", false)).toBe("off_document");
    expect(el("confirmed", "2026-12-01T10:00:00Z")).toBe("off_document");
    expect(el("confirmed", "2026-11-01T10:00:00Z")).toBe("not_completed");
    expect(el("mystery", "2026-11-01T10:00:00Z", true)).toBe("off_document");
  });
  const fee = (over: Partial<FeeItemInput> = {}): FeeItemInput => {
    n += 1;
    return { appointmentId: `fee-${n}`, clientId: "client-1", localDate: "2026-11-10", startsAt: "2026-11-10T15:00:00Z", reason: "no_show_fee", feeCandidates: [charged(3000)], lines: [], ...over };
  };
  it("a fee counts toward total spend ONLY when its payment is confirmed; an unconfirmed fee adds nothing and blocks the balance", () => {
    const d = doc([visit({ feeCandidates: [quote(5000)], lines: [line("collected_card_session", 5000)] })], {
      feeItems: [fee({ lines: [line("collected_card_fee", 3000)] }), fee({ localDate: "2026-11-11", startsAt: "2026-11-11T15:00:00Z", lines: [line("unresolved", 3000)] })],
    });
    expect(d.feeItems.map((f) => f.state)).toEqual(["paid", "unconfirmed"]);
    expect(d.totals.paidCents).toBe(8000);
    expect(d.totals.feePaidCents).toBe(3000);
    expect(d.totals.treatmentPaidCents).toBe(5000);
    expect(d.totals.visitCount).toBe(1);
    expect(d.balanceDue).toEqual({ kind: "not_established", because: "unconfirmed_fee" });
  });
  it("fee items are separate line items: never in the visit list, count or states", () => {
    const d = doc([], { feeItems: [fee({ lines: [line("collected_card_fee", 3000)] })] });
    expect(d.visits).toEqual([]);
    expect(d.totals.visitCount).toBe(0);
    expect(d.feeItems).toHaveLength(1);
  });
  it("fee items follow the month and range scope, are absent from a chosen-visits scope, and a fee of another client is refused", () => {
    const v = visit();
    const f = fee({ localDate: "2026-10-05", startsAt: "2026-10-05T15:00:00Z", lines: [line("collected_card_fee", 3000)] });
    expect(doc([v], { feeItems: [f], scope: { kind: "month", month: "2026-11" } }).feeItems).toEqual([]);
    expect(doc([v], { feeItems: [f], scope: { kind: "month", month: "2026-10" } }).feeItems).toHaveLength(1);
    expect(doc([v], { feeItems: [f], scope: { kind: "visits", appointmentIds: [v.appointmentId] } }).feeItems).toEqual([]);
    expect(build([v], { feeItems: [fee({ clientId: "client-2" })] })).toEqual({ ok: false, error: "foreign_visit" });
  });
  it("a missing fee keeps the visit visible, labelled, and no balance is established for the period (D1)", () => {
    const d = doc([visit({ lines: [line("collected_card_session", 4200)] })]);
    expect(d.visits).toHaveLength(1);
    expect(d.visits[0].fee).toEqual({ state: "not_recorded", ambiguous: false });
    expect(FEE_NOT_RECORDED_COPY).toBe("Fee not recorded");
    expect(d.balanceDue).toEqual({ kind: "not_established", because: "fee_not_recorded" });
  });
  describe("Not completed appears ONLY in the full-history view", () => {
    const nc = visit({ eligibility: "not_completed", localDate: "2026-11-02", startsAt: "2026-11-02T15:00:00Z" });
    const tr = visit({ localDate: "2026-11-03", startsAt: "2026-11-03T15:00:00Z", feeCandidates: [quote(5000)], lines: [line("collected_cash", 5000, "settlement")] });
    it("listed in full history, with no amount, outside every count and total", () => {
      const d = doc([nc, tr], { scope: { kind: "full_history" } });
      expect(d.notCompleted.map((r) => r.appointmentId)).toEqual([nc.appointmentId]);
      expect(d.visits.map((x) => x.appointmentId)).toEqual([tr.appointmentId]);
      expect(d.totals.visitCount).toBe(1);
      expect(d.awaiting).toEqual([]);
      expect(d.totals.paidCents).toBe(5000);
      expect(d.balanceDue).toEqual({ kind: "established", cents: 0 });
      expect(Object.keys(d.notCompleted[0])).not.toEqual(expect.arrayContaining(["fee", "paidCents"]));
    });
    it("never in a month view, a range, or a chosen-visits selection (which refuses its id as unknown)", () => {
      for (const scope of [{ kind: "month", month: "2026-11" }, { kind: "range", startLocal: "2026-11-01", endLocalInclusive: "2026-11-30" }] as const) {
        expect(doc([nc, tr], { scope }).notCompleted).toEqual([]);
        expect(doc([nc, tr], { scope }).visits).toHaveLength(1);
      }
      expect(build([nc, tr], { scope: { kind: "visits", appointmentIds: [nc.appointmentId] } })).toEqual({ ok: false, error: "unknown_visit" });
    });
    it("copy is exactly 'Not completed'", () => expect(NOT_COMPLETED_COPY).toBe("Not completed"));
  });
});

describe("identity and words", () => {
  it("carries only the identity it is given and the exact attribution", () => {
    const d = doc([], { identity: { studioName: "Second Studio", legalEntityName: "Second Studio Inc.", address: null, contactEmail: "hello@example.test" } });
    expect(d.attribution).toBe("Prepared by Hone for Second Studio");
    expect(d.identity.address).toBeNull();
    expect(d.identity.phone).toBeUndefined();
  });
  it("dates read the same on every machine, and an impossible date is refused", () => {
    expect(formatLocalDate("2026-11-19")).toBe("Nov 19, 2026");
    expect(formatLocalDate("2026-01-05")).toBe("Jan 5, 2026");
    expect(isLocalDate("2026-02-29")).toBe(false);
    expect(isLocalDate("2028-02-29")).toBe(true);
  });
  it("a visit with no practitioner or service is flagged, never guessed", () => {
    const v = classifyVisit(visit({ practitionerId: null, practitionerName: null, serviceName: null }));
    expect(v.flags).toEqual(expect.arrayContaining(["practitioner_unattributed", "service_not_recorded", "fee_not_recorded"]));
  });
});

describe("source guard: the model is pure and can never write, charge or message", () => {
  const src = readFileSync(path.join(ROOT, "lib/finance/statement-document.ts"), "utf8");
  const imports = [...src.matchAll(/^import .* from "([^"]+)";/gm)].map((m) => m[1]);
  it("imports only the pure statement classifier", () => {
    expect(imports).toEqual(["@/lib/finance/statement"]);
  });
  it("has no server-only, client, Stripe, mail, SMS, fetch, clock or random", () => {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const bad of [/server-only/, /supabase/i, /stripe/i, /resend|nodemailer|sendgrid|twilio/i, /\bfetch\(/, /new Date\(\)/, /Date\.now/, /Math\.random/, /process\.env/]) {
      expect(code).not.toMatch(bad);
    }
  });
  it("has no write verbs", () => {
    expect(src).not.toMatch(/\.(insert|update|upsert|delete|rpc)\(/);
  });
});
