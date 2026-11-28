import { describe, expect, it } from "vitest";
import { createCheckoutFeeDraft, splitBillFeeFields } from "@/components/checkout-fee-fields";

// The quick checkout sends the REVIEWED fee with "Split this payment" (Codex P2): $100 adjusted to $80 must become an $80 bill, never a $100 one.
describe("splitBillFeeFields", () => {
  const draft = (over: Partial<ReturnType<typeof createCheckoutFeeDraft>> = {}) => ({ ...createCheckoutFeeDraft(10000), ...over });
  it("adjusts $100 to $80 with a reason: sends 80.00 and the reason", () => {
    expect(splitBillFeeFields(draft({ finalFee: "80.00", reason: "  Loyalty discount " }), 10000))
      .toEqual({ ok: true, fields: { reference_fee_cents: "10000", final_amount_dollars: "80.00", adjustment_reason: "Loyalty discount" } });
  });
  it("a waived fee ($0) with a reason is carried too", () => {
    expect(splitBillFeeFields(draft({ finalFee: "0", reason: "Comp" }), 10000))
      .toEqual({ ok: true, fields: { reference_fee_cents: "10000", final_amount_dollars: "0.00", adjustment_reason: "Comp" } });
  });
  it("an unchanged fee still sends the fee the owner SAW, so the server can refuse a price that moved (Codex P2)", () => {
    expect(splitBillFeeFields(draft(), 10000)).toEqual({ ok: true, fields: { reference_fee_cents: "10000" } });
    expect(splitBillFeeFields(undefined, 10000)).toEqual({ ok: true, fields: { reference_fee_cents: "10000" } });
  });
  it("a changed fee with no reason is refused, never recorded blind", () => {
    expect(splitBillFeeFields(draft({ finalFee: "80.00", reason: "  " }), 10000)).toMatchObject({ ok: false });
  });
  it("an unreadable fee is refused", () => {
    expect(splitBillFeeFields(draft({ finalFee: "abc" }), 10000)).toMatchObject({ ok: false });
  });
  it("a draft made against a different booked fee is refused (the price changed while checkout was open)", () => {
    expect(splitBillFeeFields(draft({ finalFee: "80.00", reason: "x" }), 12000)).toMatchObject({ ok: false });
  });
});
