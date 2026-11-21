import { describe, expect, it } from "vitest";

import { EVIDENCE_LABELS, MISSING_PRICE_EVIDENCE_LABEL, SERVICE_VALUE_LABEL, COLLECTED_LABEL, noNextBookingNote, beyondUsualNote, SERVICE_VALUE_DEFINITION, COLLECTED_DEFINITION, NEVER_SUMMED_NOTE } from "@/lib/business-analytics/copy";
import { PRICE_EVIDENCE_CLASSES, resolveVisitPrice, serviceValue, type PriceCandidate } from "@/lib/business-analytics/service-value";

// Synthetic prices only. Service value is subtotals per evidence class plus a count of visits with no evidence.
const rec = (cents: number | null): PriceCandidate => ({ evidence: "recorded_at_visit", cents });
const onl = (cents: number | null): PriceCandidate => ({ evidence: "online_booking", cents });

describe("resolving one visit by the evidence it has", () => {
  it("the price recorded with the visit is its own class", () => {
    expect(resolveVisitPrice([rec(9000)])).toEqual({ state: "evidence", evidence: "recorded_at_visit", cents: 9000 });
  });
  it("the online-booking price is its own class, never merged into the first", () => {
    expect(resolveVisitPrice([onl(8000)])).toEqual({ state: "evidence", evidence: "online_booking", cents: 8000 });
  });
  it("a visit with both is counted once, in the stronger class; the other amount is not added", () => {
    expect(resolveVisitPrice([onl(8000), rec(9000)])).toEqual({ state: "evidence", evidence: "recorded_at_visit", cents: 9000 });
  });
  it("the precedence is a parameter", () => {
    expect(resolveVisitPrice([onl(8000), rec(9000)], ["online_booking", "recorded_at_visit"])).toEqual({ state: "evidence", evidence: "online_booking", cents: 8000 });
  });
  it("the same amount twice in one class is one price; two different amounts are ambiguous and missing, not guessed", () => {
    expect(resolveVisitPrice([rec(9000), rec(9000)])).toEqual({ state: "evidence", evidence: "recorded_at_visit", cents: 9000 });
    expect(resolveVisitPrice([rec(9000), rec(9500)])).toEqual({ state: "missing", reason: "ambiguous" });
  });
  it("zero is a real recorded price (a free visit)", () => {
    expect(resolveVisitPrice([rec(0)])).toEqual({ state: "evidence", evidence: "recorded_at_visit", cents: 0 });
  });
  it("no evidence, or only an unreadable amount, is missing with its reason", () => {
    expect(resolveVisitPrice([])).toEqual({ state: "missing", reason: "no_evidence" });
    expect(resolveVisitPrice([rec(null), rec(-5), rec(1.5)])).toEqual({ state: "missing", reason: "unreadable" });
  });
  it("an unreadable amount does not hide a readable one of another class", () => {
    expect(resolveVisitPrice([rec(null), onl(8000)])).toEqual({ state: "evidence", evidence: "online_booking", cents: 8000 });
  });
  it("only the two evidence classes exist: there is no card or fee class to pass in", () => {
    expect([...PRICE_EVIDENCE_CLASSES]).toEqual(["recorded_at_visit", "online_booking"]);
  });
});

describe("service value: subtotals per class plus the count with no evidence", () => {
  const visits = [
    { appointmentId: "a", candidates: [rec(9000)] },
    { appointmentId: "b", candidates: [rec(6000)] },
    { appointmentId: "c", candidates: [onl(8000)] },
    { appointmentId: "d", candidates: [] },
    { appointmentId: "e", candidates: [rec(1), rec(2)] },
  ];
  const v = serviceValue(visits);
  it("each class has its own subtotal and visit count", () => {
    expect(v.subtotals.recorded_at_visit).toEqual({ visits: 2, cents: 15000 });
    expect(v.subtotals.online_booking).toEqual({ visits: 1, cents: 8000 });
  });
  it("visits without evidence are counted, by reason, and are in no subtotal", () => {
    expect(v.missingVisits).toBe(2);
    expect(v.missingByReason).toEqual({ no_evidence: 1, ambiguous: 1, unreadable: 0 });
    expect(v.completedVisits).toBe(5);
    expect(v.withEvidenceVisits + v.missingVisits).toBe(v.completedVisits);
  });
  it("the combined figure is only the reliable subtotals, and always has the missing count beside it", () => {
    expect(v.withEvidenceCents).toBe(23000);
  });
  it("a repeated appointment id counts once", () => {
    expect(serviceValue([...visits, { appointmentId: "a", candidates: [rec(9000)] }]).completedVisits).toBe(5);
  });
  it("nothing at all is zero visits and zero cents with an empty class, not an unknown", () => {
    expect(serviceValue([])).toMatchObject({ completedVisits: 0, missingVisits: 0, withEvidenceCents: 0 });
  });
  it("is the same whatever order the visits arrive in", () => {
    expect(serviceValue([...visits].reverse())).toEqual(v);
  });
});

describe("fixed labels and definitions", () => {
  it("the two money labels are exactly these", () => {
    expect(COLLECTED_LABEL).toBe("Collected (by visit date)");
    expect(SERVICE_VALUE_LABEL).toBe("Completed service value (by visit date)");
    expect(EVIDENCE_LABELS).toEqual({ recorded_at_visit: "Price when the visit was recorded", online_booking: "Price shown at online booking" });
    expect(MISSING_PRICE_EVIDENCE_LABEL).toBe("Completed visits with no price evidence");
  });
  it("the service-value definition says the settlement price is the price at recording, never today's list, and that card and fees are not prices", () => {
    expect(SERVICE_VALUE_DEFINITION).toContain("never today's price list");
    expect(SERVICE_VALUE_DEFINITION).toContain("may not be the price on the day of the visit");
    expect(SERVICE_VALUE_DEFINITION).toContain("A card payment or a fee is money, not a price");
    expect(SERVICE_VALUE_DEFINITION).toContain("A discount that was never recorded cannot be shown");
    expect(NEVER_SUMMED_NOTE).toContain("not added together");
  });
  it("neither figure is called revenue, sales or by payment date", () => {
    for (const t of [SERVICE_VALUE_LABEL, SERVICE_VALUE_DEFINITION, COLLECTED_LABEL, COLLECTED_DEFINITION, NEVER_SUMMED_NOTE]) expect(t).not.toMatch(/revenue|sales|by payment date/i);
  });
  it("the look-back and factor sentences follow their parameters", () => {
    expect(noNextBookingNote(12)).toContain("last 12 months");
    expect(noNextBookingNote(6)).toContain("last 6 months");
    expect(noNextBookingNote(1)).toContain("last 1 month ");
    expect(noNextBookingNote(6)).not.toContain("12");
    expect(beyondUsualNote(2)).toContain("2 times");
    expect(beyondUsualNote(1.5)).toContain("1.5 times");
    expect(noNextBookingNote(12)).toContain("any practitioner");
  });
});
