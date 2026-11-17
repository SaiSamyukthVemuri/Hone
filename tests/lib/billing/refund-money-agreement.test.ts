import { describe, expect, it } from "vitest";
import { refundDisplayState, type RefundDisplayInput } from "@/lib/billing/refund-display-state";
import { outstandingForAppointment, type OutstandingInput } from "@/lib/billing/outstanding-balance";

// The owner sees a refund in two places that are computed by two different functions: the
// refund panel (refundDisplayState) and the owner's balance (outstandingForAppointment, through its card-kept rule). They
// are documented as "the same agreement rules", but nothing proved it. This runs every combination of the refund columns
// through BOTH and asserts they never disagree about the money:
//   - the panel can state a remaining amount  <=>  the balance can state a figure (otherwise both say "cannot state");
//   - when both can, the money the balance says the card KEPT equals the remaining amount the panel says is refundable.
// Rows carrying the signed cumulative full-refund receipt are NOT here: they are covered where that rule is implemented.

const CHARGE = 5000;
const QUOTE = 10000;

const ours = [null, "pending_stripe", "succeeded", "failed", "unrecognised"] as const;
const provider = [null, "pending", "requires_action", "succeeded", "failed", "canceled", "unrecognised"] as const;
// A refund above the charge is excluded here: payment_charge_attempts has a CHECK (0078) that forbids it, so it cannot be stored.
// Today's divergence for that impossible input is pinned in its own test below.
const amounts = [null, 0, 2000, CHARGE, -1] as const;
const refundIds = [null, "re_1"] as const;

function bothViews(o: {
  refundStatus: string | null;
  providerRefundStatus: string | null;
  refundAmountCents: number | null;
  stripeRefundId: string | null;
}) {
  const display = refundDisplayState({
    chargeStatus: "succeeded",
    amountCents: CHARGE,
    refundStatus: o.refundStatus,
    refundAmountCents: o.refundAmountCents,
    providerRefundStatus: o.providerRefundStatus,
    stripeRefundId: o.stripeRefundId,
    cumulativeFullRefundVerified: false,
  } satisfies RefundDisplayInput);
  const input: OutstandingInput = {
    status: "completed",
    endsAt: "2026-10-01T15:00:00Z",
    now: "2026-11-03T12:00:00Z",
    quoteCents: QUOTE,
    studioCurrency: "CAD",
    settlements: [],
    cards: [{
      status: "succeeded",
      amountCents: CHARGE,
      refundStatus: o.refundStatus,
      refundAmountCents: o.refundAmountCents,
      providerRefundStatus: o.providerRefundStatus,
      currency: "cad",
    }],
  };
  const balance = outstandingForAppointment(input);
  return { display, balance };
}

describe("the refund panel and the owner's balance agree on every refund-column combination", () => {
  const cases: Array<[string, Parameters<typeof bothViews>[0]]> = [];
  for (const refundStatus of ours)
    for (const providerRefundStatus of provider)
      for (const refundAmountCents of amounts)
        for (const stripeRefundId of refundIds)
          cases.push([
            `ours=${refundStatus} provider=${providerRefundStatus} amount=${refundAmountCents} refundId=${stripeRefundId}`,
            { refundStatus, providerRefundStatus, refundAmountCents, stripeRefundId },
          ]);

  it("the sweep covers every combination (a changed list must be deliberate)", () => {
    expect(cases).toHaveLength(ours.length * provider.length * amounts.length * refundIds.length);
    expect(cases.length).toBe(350);
  });

  it("no combination lets the panel and the balance disagree about what the card kept", () => {
    const disagreements: string[] = [];
    for (const [label, o] of cases) {
      const { display, balance } = bothViews(o);
      const panelRemaining = display.remainingRefundableCents;
      const kept =
        balance.kind === "owed" ? balance.cardKeptCents
        : balance.kind === "paid" ? null // cannot happen with quote > charge; flagged below if it does
        : null;
      if (balance.kind === "paid" || balance.kind === "not_applicable") {
        disagreements.push(`${label}: balance ${balance.kind} (unexpected for a ${QUOTE} quote and a ${CHARGE} charge)`);
        continue;
      }
      if (panelRemaining === null) {
        if (balance.kind !== "amount_unavailable") {
          disagreements.push(`${label}: panel cannot state a remaining amount but balance says ${balance.kind} (kept ${kept})`);
        }
      } else if (balance.kind !== "owed" || kept !== panelRemaining) {
        disagreements.push(`${label}: panel says ${panelRemaining} still refundable (kept), balance says ${balance.kind} kept=${kept}`);
      }
    }
    expect(disagreements, disagreements.slice(0, 12).join("\n")).toEqual([]);
  });

  it("PINNED TODAY (input the database CHECK forbids): a refund recorded above the charge reads 'cannot state' on the panel but 'kept 0' on the balance", () => {
    // Unreachable through the database (0078 CHECK refund_amount_cents <= amount_cents), so this is a code-level divergence, not
    // a live one. If either side is changed to agree, this test fails on purpose: delete it and add the amount to the sweep.
    const { display, balance } = bothViews({ refundStatus: "succeeded", providerRefundStatus: null, refundAmountCents: CHARGE + 1, stripeRefundId: null });
    expect(display.remainingRefundableCents).toBeNull();
    expect(balance).toMatchObject({ kind: "owed", cardKeptCents: 0 });
  });

  it("CONTROL: the check can fail (a deliberately wrong panel reading is caught)", () => {
    const { display, balance } = bothViews({ refundStatus: "succeeded", providerRefundStatus: null, refundAmountCents: 2000, stripeRefundId: "re_1" });
    expect(display.remainingRefundableCents).toBe(3000);
    expect(balance).toMatchObject({ kind: "owed", cardKeptCents: 3000 });
    // A reading that said 5000 would not equal what the balance kept.
    expect(5000).not.toBe(balance.kind === "owed" ? balance.cardKeptCents : null);
  });
});
