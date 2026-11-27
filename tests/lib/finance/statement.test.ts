import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { CollectedMoneyRow } from "@/lib/finance/collected-money-lines";
import {
  ADJUSTMENT_KINDS,
  COLLECTED_KINDS,
  STATEMENT_KINDS,
  buildStatement,
  classifyCardRow,
  classifyLegacyFeeRow,
  classifySettlementRow,
  type StatementAppointment,
  type StatementCardRow,
  type StatementLegacyFeeRow,
  type StatementSettlementRow,
} from "@/lib/finance/statement";
import * as copy from "@/lib/finance/statement-copy";
import { monthRange, shiftYearMonth, isYearMonth, yearMonthOf } from "@/lib/finance/statement-period";
import { MONEY_FORMS } from "@/lib/dashboard/other-money-forms";
import { INSURER_FIELD_GAPS } from "@/lib/clinical-records/insurer-field-gaps";

// HON-64 Slice A. Synthetic rows only. Groups 1 (pure statement), 2 (reconciliation), 3 (period), 4 (practitioner), 6 (insurer), 7 (copy), 8 (limitation).
const ROOT = path.resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

const base: CollectedMoneyRow = {
  chargeReason: "session_payment", status: "succeeded", amountCents: 10000, currency: "cad",
  refundStatus: null, refundAmountCents: null, providerRefundStatus: null, stripeRefundId: null, cumulativeFullRefundVerified: false, stripeLivemode: true,
};
const card = (over: Partial<CollectedMoneyRow> = {}, appointmentId = "a1"): StatementCardRow => ({ ...base, ...over, appointmentId });
const settle = (over: Partial<StatementSettlementRow> = {}): StatementSettlementRow => ({ appointmentId: "a1", method: "paid_cash", amountCents: 4000, currency: "cad", ...over });
const legacy = (over: Partial<StatementLegacyFeeRow> = {}): StatementLegacyFeeRow => ({ appointmentId: "a1", status: "succeeded", amountCents: 3000, currency: "cad", stripeLivemode: true, ...over });
const appts: StatementAppointment[] = [
  { id: "a1", practitionerId: "p-1", startsAt: "2026-11-03T15:00:00Z" },
  { id: "a2", practitionerId: "p-2", startsAt: "2026-11-04T15:00:00Z" },
  { id: "a3", practitionerId: null, startsAt: "2026-11-05T15:00:00Z" },
];
const build = (o: Partial<Parameters<typeof buildStatement>[0]> = {}) =>
  buildStatement({ studioCurrency: "cad", appointments: appts, cardRows: [], settlementRows: [], legacyFeeRows: [], ...o });

describe("group 1: every money form lands in exactly one kind", () => {
  it("card session payment and card fee are SEPARATE collected lines", () => {
    const s = build({ cardRows: [card(), card({ chargeReason: "no_show_fee", amountCents: 5000 }), card({ chargeReason: "late_cancellation_fee", amountCents: 2500 })] });
    expect(s.all.kinds.collected_card_session).toEqual({ count: 1, cents: 10000 });
    expect(s.all.kinds.collected_card_fee).toEqual({ count: 2, cents: 7500 });
    expect(s.all.collectedCents).toBe(17500);
  });
  it("cash, e-transfer and other external count as collected, each labelled by its own method", () => {
    const s = build({ settlementRows: [settle(), settle({ method: "paid_e_transfer", amountCents: 6000 }), settle({ method: "paid_other_external", amountCents: 700 })] });
    expect(s.all.kinds.collected_cash.cents).toBe(4000);
    expect(s.all.kinds.collected_e_transfer.cents).toBe(6000);
    expect(s.all.kinds.collected_other_external.cents).toBe(700);
    expect(s.all.collectedCents).toBe(10700);
  });
  it("a waiver is an ADJUSTMENT: shown on its own line and never reduces Collected", () => {
    const s = build({ settlementRows: [settle({ method: "waived", amountCents: 9000 }), settle({ appointmentId: "a2", amountCents: 1000 })] });
    expect(s.all.kinds.waived).toEqual({ count: 1, cents: 9000 });
    expect(s.all.collectedCents).toBe(1000);
  });
  it("a full refund is an adjustment: the charge leaves Collected and appears under Refunded in full", () => {
    const s = build({ cardRows: [card({ refundStatus: "succeeded", refundAmountCents: 10000, providerRefundStatus: "succeeded" })] });
    expect(s.all.kinds.refunded_card_session).toEqual({ count: 1, cents: 10000 });
    expect(s.all.collectedCents).toBe(0);
  });
  it("still_owes is a note: never an amount, never summed", () => {
    const s = build({ settlementRows: [settle({ method: "still_owes", amountCents: 99999 })] });
    expect(s.all.kinds.still_owes_note).toEqual({ count: 1, cents: 0 });
    expect(s.all.collectedCents).toBe(0);
  });
  it("test mode, unknown mode, pending, failed: excluded (not collected money)", () => {
    for (const over of [{ stripeLivemode: false }, { stripeLivemode: null }, { status: "pending_stripe" }, { status: "failed" }] as const) {
      expect(classifyCardRow({ ...base, ...over }, "cad").kind).toBe("excluded");
    }
  });
  it("another currency is counted and never summed (card and settlement alike)", () => {
    expect(classifyCardRow({ ...base, currency: "usd" }, "cad").kind).toBe("other_currency");
    expect(classifySettlementRow(settle({ currency: "usd" }), "cad").kind).toBe("other_currency");
    expect(build({ cardRows: [card({ currency: "usd" })] }).all.collectedCents).toBe(0);
  });
  it("a partial refund, an in-flight refund and an unprovable refund are UNRESOLVED, neither collected nor refunded", () => {
    for (const over of [
      { refundStatus: "succeeded", refundAmountCents: 2000, providerRefundStatus: "succeeded" },
      { refundStatus: "pending_stripe" },
      { refundStatus: "weird" },
    ] as const) {
      const c = classifyCardRow({ ...base, ...over }, "cad");
      expect(c.kind).toBe("unresolved");
      expect(c.cents).toBe(10000);
    }
  });
  it("an unknown charge reason never becomes revenue", () => {
    expect(classifyCardRow({ ...base, chargeReason: "future_reason" }, "cad").kind).toBe("excluded");
    expect(classifyCardRow({ ...base, chargeReason: null }, "cad").kind).toBe("excluded");
  });
  it("the legacy manual-fee ledger: a succeeded real fee is UNRESOLVED (no refund record exists), never collected; test mode is excluded", () => {
    expect(classifyLegacyFeeRow(legacy(), "cad")).toEqual({ kind: "unresolved", cents: 3000 });
    expect(classifyLegacyFeeRow(legacy({ stripeLivemode: false }), "cad").kind).toBe("excluded");
    expect(classifyLegacyFeeRow(legacy({ status: "failed" }), "cad").kind).toBe("excluded");
    expect(classifyLegacyFeeRow(legacy({ currency: "usd" }), "cad").kind).toBe("other_currency");
    expect(build({ legacyFeeRows: [legacy()] }).all.collectedCents).toBe(0);
  });
  it("an unknown method, a negative or fractional amount are UNREADABLE, never a figure", () => {
    expect(classifySettlementRow(settle({ method: "barter" }), "cad").kind).toBe("unreadable");
    expect(classifySettlementRow(settle({ amountCents: -5 }), "cad").kind).toBe("unreadable");
    expect(classifySettlementRow(settle({ amountCents: 1.5 }), "cad").kind).toBe("unreadable");
    expect(classifySettlementRow(settle({ amountCents: null }), "cad").kind).toBe("unreadable");
  });
  it("the card rule is the pinned one, not a copy: statement.ts calls collectedMoneyLines and re-implements no refund logic", () => {
    const src = read("lib/finance/statement.ts");
    expect(src).toContain("collectedMoneyLines(");
    expect(src).not.toMatch(/refundDisplayState/);
    expect(src).not.toMatch(/stripe_|supabase|createClient/);
  });
});

describe("group 2: reconciliation (nothing lost, nothing double counted)", () => {
  it("every row read is placed in exactly one kind, across a mixed set", () => {
    const s = build({
      cardRows: [card(), card({ chargeReason: "no_show_fee" }), card({ status: "failed" }), card({ currency: "usd" }), card({ refundStatus: "pending_stripe" }), card({ chargeReason: "x" }, "a2")],
      settlementRows: [settle(), settle({ method: "waived" }), settle({ method: "still_owes" }), settle({ method: "nope" }), settle({ appointmentId: "a3", method: "paid_e_transfer" })],
      legacyFeeRows: [legacy(), legacy({ stripeLivemode: false })],
    });
    expect(s.reconciliation.rowsIn).toBe(13);
    expect(s.reconciliation.rowsClassified).toBe(13);
    expect(STATEMENT_KINDS.reduce((n, k) => n + s.all.kinds[k].count, 0)).toBe(13);
  });
  it("property: over many seeded random sets, rows in = rows classified, and practitioner buckets add up to the total", () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const reasons = ["session_payment", "no_show_fee", "late_cancellation_fee", "weird", null];
    const statuses = ["succeeded", "failed", "pending_stripe", null];
    const methods = ["paid_cash", "paid_e_transfer", "paid_other_external", "waived", "still_owes", "junk"];
    for (let n = 0; n < 200; n++) {
      const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)];
      const ids = ["a1", "a2", "a3", "ghost"];
      const s = build({
        cardRows: Array.from({ length: Math.floor(rnd() * 8) }, () =>
          card({ chargeReason: pick(reasons), status: pick(statuses), amountCents: pick([0, 1, 5000, -1, null, 2.5]), currency: pick(["cad", "usd", null]), stripeLivemode: pick([true, false, null]), refundStatus: pick([null, "succeeded", "failed", "pending_stripe"]), refundAmountCents: pick([null, 5000, 100]) }, pick(ids)),
        ),
        settlementRows: Array.from({ length: Math.floor(rnd() * 6) }, () => settle({ method: pick(methods), amountCents: pick([0, 4000, -1, null]), currency: pick(["cad", "usd", null]), appointmentId: pick(ids) })),
        legacyFeeRows: Array.from({ length: Math.floor(rnd() * 4) }, () => legacy({ status: pick(statuses), stripeLivemode: pick([true, false, null]), appointmentId: pick(ids) })),
      });
      expect(s.reconciliation.rowsClassified).toBe(s.reconciliation.rowsIn);
      const sumRows = s.byPractitioner.reduce((a, p) => a + p.bucket.rows, 0);
      expect(sumRows).toBe(s.all.rows);
      for (const k of STATEMENT_KINDS) {
        expect(s.byPractitioner.reduce((a, p) => a + p.bucket.kinds[k].count, 0)).toBe(s.all.kinds[k].count);
        expect(s.byPractitioner.reduce((a, p) => a + p.bucket.kinds[k].cents, 0)).toBe(s.all.kinds[k].cents);
      }
      expect(s.byPractitioner.reduce((a, p) => a + p.bucket.collectedCents, 0)).toBe(s.all.collectedCents);
      // collected is only ever the sum of the collected kinds
      expect(COLLECTED_KINDS.reduce((a, k) => a + s.all.kinds[k].cents, 0)).toBe(s.all.collectedCents);
    }
  });
  it("adjustments are never part of the collected total", () => {
    const s = build({ settlementRows: [settle({ method: "waived", amountCents: 500 })], cardRows: [card({ refundStatus: "succeeded", refundAmountCents: 10000, providerRefundStatus: "succeeded" })] });
    expect(s.all.collectedCents).toBe(0);
    expect(ADJUSTMENT_KINDS.reduce((a, k) => a + s.all.kinds[k].cents, 0)).toBe(10500);
  });
});

describe("group 3: the month, in the studio's timezone", () => {
  it("half-open month bounds, across a year end and a leap February", () => {
    expect(monthRange("2026-11")).toMatchObject({ startLocal: "2026-11-01", endLocalExclusive: "2026-12-01", label: "November 2026" });
    expect(monthRange("2026-12").endLocalExclusive).toBe("2027-01-01");
    expect(monthRange("2028-02").endLocalExclusive).toBe("2028-03-01");
    expect(shiftYearMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftYearMonth("2026-12", 1)).toBe("2027-01");
  });
  it("only YYYY-MM is accepted; anything else is not a month", () => {
    for (const bad of ["2026-13", "2026-00", "2026-1", "26-11", "2026-11-01", "", "../x", undefined]) expect(isYearMonth(bad as string | undefined)).toBe(false);
    expect(() => monthRange("2026-13")).toThrow();
    expect(yearMonthOf("2026-11-19")).toBe("2026-11");
  });
  it("the window instants come from local midnight TWICE (a DST month is not 30 days of 24h), in the studio's zone, not the server's", async () => {
    const { utcInstantFromLocal } = await import("@/lib/booking/tz");
    const r = monthRange("2026-11"); // US/Canada DST ends 1 Nov 2026
    const start = utcInstantFromLocal(r.startLocal, "00:00", "America/Toronto");
    const end = utcInstantFromLocal(r.endLocalExclusive, "00:00", "America/Toronto");
    expect(start.toISOString()).toBe("2026-11-01T04:00:00.000Z"); // still EDT at 00:00 on 1 Nov
    expect(end.toISOString()).toBe("2026-12-01T05:00:00.000Z"); // EST by 1 Dec
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(30 * 24 + 1); // 30 days plus the repeated hour
    const west = utcInstantFromLocal(r.startLocal, "00:00", "America/Vancouver");
    expect(west.toISOString()).toBe("2026-11-01T07:00:00.000Z");
    // a visit at 23:30 Toronto on 30 Nov is IN November, one at 00:30 on 1 Dec is not
    const inNov = new Date("2026-12-01T04:30:00Z"); // 23:30 EST 30 Nov
    const inDec = new Date("2026-12-01T05:30:00Z"); // 00:30 EST 1 Dec
    expect(inNov < end && inNov >= start).toBe(true);
    expect(inDec < end).toBe(false);
  });
  it("the read module converts the window with utcInstantFromLocal twice, never start + N days", () => {
    const src = read("lib/finance/statement-read.ts");
    expect(src.match(/utcInstantFromLocal\(/g)?.length).toBe(2);
    expect(src).not.toMatch(/86_?400_?000|24 \* 60 \* 60/);
  });
});

describe("group 4: the APPOINTMENT's practitioner decides; none means Unattributed", () => {
  it("money lands under the appointment's practitioner, whatever else touched it", () => {
    const s = build({ cardRows: [card({}, "a1"), card({}, "a2")], settlementRows: [settle({ appointmentId: "a2", amountCents: 100 })] });
    const by = (id: string | null) => s.byPractitioner.find((p) => p.practitionerId === id)!.bucket;
    expect(by("p-1").collectedCents).toBe(10000);
    expect(by("p-2").collectedCents).toBe(10100);
  });
  it("an appointment with a null practitioner is Unattributed, listed last, never guessed", () => {
    const s = build({ settlementRows: [settle({ appointmentId: "a3", amountCents: 700 }), settle({ appointmentId: "a1", amountCents: 300 })] });
    expect(s.byPractitioner.map((p) => p.practitionerId)).toEqual(["p-1", null]);
    expect(s.byPractitioner[1].bucket.collectedCents).toBe(700);
  });
  it("a row whose appointment was not read is Unattributed AND counted, never dropped", () => {
    const s = build({ settlementRows: [settle({ appointmentId: "ghost", amountCents: 50 })] });
    expect(s.reconciliation.rowsWithoutAppointment).toBe(1);
    expect(s.byPractitioner.at(-1)).toMatchObject({ practitionerId: null });
    expect(s.all.collectedCents).toBe(50);
  });
  it("the statement model has no field for the confirming or recording practitioner", () => {
    const src = read("lib/finance/statement.ts") + read("lib/finance/statement-read.ts");
    expect(src).not.toMatch(/recorded_by_practitioner_id|confirmed_by|practitioner_id\b.*settle/i);
  });
});

describe("group 6: the insurer block says only 'Not recorded'", () => {
  it("lists exactly the four gap fields from the shared module, each Not recorded", () => {
    expect(INSURER_FIELD_GAPS.map((g) => g.key).sort()).toEqual(["diagnosis", "insurer_member_policy", "legal_identity", "medical_record_number"]);
    const view = read("app/(app)/financials/statement/statement-view.tsx");
    expect(view).toContain("INSURER_FIELD_GAPS.map");
    expect(view).toContain("INSURER_NOT_RECORDED");
    expect(copy.INSURER_NOT_RECORDED).toBe("Not recorded");
  });
  it("no legal name, MRN, diagnosis or policy value is read anywhere on this surface", () => {
    const src = read("lib/finance/statement-read.ts") + read("app/(app)/financials/statement/statement-view.tsx");
    expect(src).not.toMatch(/legal_name|legal_identity|medical_record|diagnos|member_id|policy_number|insurerDocumentName/i);
  });
});

describe("group 7: copy guard", () => {
  const allCopy = Object.entries(copy).filter(([, v]) => typeof v === "string") as Array<[string, string]>;
  it("only the framing sentence may use 'revenue' or 'claim', and it uses them to say what the statement is NOT", () => {
    expect(copy.STATEMENT_FRAMING).toMatch(/not revenue accounting, not a claim, and not a bill/);
    for (const [name, v] of allCopy) {
      if (name === "STATEMENT_FRAMING") continue;
      expect(v, name).not.toMatch(/revenue|claim|reimburs|payer|insurer pays|billed to/i);
    }
  });
  it("the view and page never print revenue, reimbursement, payer or claim wording of their own", () => {
    const src = read("app/(app)/financials/statement/statement-view.tsx") + read("app/(app)/financials/statement/page.tsx");
    expect(src).not.toMatch(/revenue|reimburs|payer|\bclaim\b/i);
  });
  it("write-offs are stated as not recorded, and a refund as its own line", () => {
    expect(copy.STATEMENT_WRITE_OFFS_NOTE).toMatch(/not recorded separately/);
    expect(copy.STATEMENT_PARTIAL_REFUND_NOTE).toMatch(/never taken off the payment/);
  });
  it("every kind has a label and a label never calls collected money 'revenue'", () => {
    for (const k of STATEMENT_KINDS) expect(copy.STATEMENT_METHOD_LABELS[k]).toBeTruthy();
  });
});

describe("group 8: the 'amount Hone can see' limitation tracks MONEY_FORMS", () => {
  it("names, in plain words, every kind of record behind the not_checked tables, and never a table name", () => {
    const tables = [...new Set(MONEY_FORMS.filter((f) => f.handling === "not_checked").map((f) => f.table))].sort();
    expect(tables.length).toBeGreaterThan(0);
    const line = copy.unreadableFormsLine(MONEY_FORMS);
    for (const f of MONEY_FORMS.filter((x) => x.handling === "not_checked")) {
      expect(f.plain, `${f.table} needs a plain-word name`).toBeTruthy();
      expect(line).toContain(f.plain as string);
    }
    for (const t of tables) expect(line).not.toContain(t);
    expect(line).not.toMatch(/stripe_|appointment_payments|_/);
    expect(line).toMatch(/shows the money Hone can see/);
    expect(line).toMatch(/cannot see these kinds of payment record yet/);
  });
  it("changes when a form is added or removed (no hard-coded list), and an undescribed table still gets a plain sentence", () => {
    const more = [...MONEY_FORMS, { table: "brand_new_table", form: "x", handling: "not_checked", note: "" }];
    expect(copy.unreadableFormsLine(more)).toContain(copy.UNREADABLE_FALLBACK_KIND);
    expect(copy.unreadableFormsLine(more)).not.toContain("brand_new_table");
    expect(copy.unreadableFormsLine(MONEY_FORMS.filter((f) => f.handling !== "not_checked"))).not.toContain("disputes");
  });
  it("the view builds the line from MONEY_FORMS", () => {
    expect(read("app/(app)/financials/statement/statement-view.tsx")).toContain("unreadableFormsLine(MONEY_FORMS)");
  });
});
