import { describe, expect, it } from "vitest";

import type { CollectedSplit } from "@/lib/business-analytics/money-metrics";
import { serviceValueToCollected, type CompletedVisitMoney } from "@/lib/business-analytics/reconciliation-line";

// Synthetic figures. The line is an exact identity: no remainder line.
const v = (appointmentId: string, priceCents: number | null, collectedCents: number, collectedRows = 1): CompletedVisitMoney => ({ appointmentId, priceCents, collectedCents, collectedRows });
const split = (visits: number, fees: number, unc: number, other: number): CollectedSplit => ({
  completedVisitsCents: visits, feesCents: fees, uncompletedPaymentsCents: unc, otherBookingsCents: other,
  onDocumentCents: visits + fees + unc, totalCents: visits + fees + unc + other,
});

describe("service value to collected", () => {
  const visits = [
    v("paid", 10000, 10000), //            kept = price
    v("over", 10000, 10500, 2), //         above by 500, two sources: possible double recording
    v("short", 10000, 4000), //            below by 6000
    v("unpaid", 8000, 0), //               below by 8000
    v("noprice", null, 3000), //           money on a visit with no price evidence
  ];
  const s = split(27500, 8000, 2000, 1500);
  const r = serviceValueToCollected(visits, s);
  it("every line, and the lines add up to the collected total", () => {
    if (!r.ok) throw new Error(r.reason);
    expect(r.line).toMatchObject({
      serviceValueCents: 38000, collectedAbovePriceCents: 500, collectedBelowPriceCents: 14000, collectedOnNoEvidenceCents: 3000,
      feesCents: 8000, uncompletedPaymentsCents: 2000, otherBookingsCents: 1500, collectedCents: 39000,
    });
    const l = r.line;
    expect(l.serviceValueCents + l.collectedAbovePriceCents - l.collectedBelowPriceCents + l.collectedOnNoEvidenceCents + l.feesCents + l.uncompletedPaymentsCents + l.otherBookingsCents).toBe(s.totalCents);
  });
  it("possible double recording is a note, not a line: visits above price with two or more sources", () => {
    if (!r.ok) throw new Error(r.reason);
    expect(r.line.possibleDoubleRecording).toEqual({ visits: 1, aboveCents: 500 });
  });
  it("a repeated visit counts once", () => {
    expect(serviceValueToCollected([...visits, v("paid", 10000, 10000)], s).ok).toBe(true);
  });
  it("no visits at all still reconciles to fees and other money", () => {
    const only = split(0, 100, 0, 50);
    const rr = serviceValueToCollected([], only);
    expect(rr.ok && rr.line.collectedCents).toBe(150);
  });
  it("refuses when the completed visits' money differs from the split, instead of absorbing it", () => {
    expect(serviceValueToCollected(visits, split(27501, 8000, 2000, 1500))).toEqual({ ok: false, reason: "completed_money_differs_from_split" });
  });
  it("refuses a total that does not add up", () => {
    expect(serviceValueToCollected(visits, { ...s, totalCents: s.totalCents + 1 })).toEqual({ ok: false, reason: "identity_failed" });
  });
  it("refuses an unreadable amount", () => {
    expect(serviceValueToCollected([v("x", 100, Number.NaN)], s)).toEqual({ ok: false, reason: "unreadable_amount" });
    expect(serviceValueToCollected([v("x", -1, 0)], s)).toEqual({ ok: false, reason: "unreadable_amount" });
  });
});
