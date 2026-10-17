import { describe, expect, it } from "vitest";

import {
  DELIVERY_STATE_MEANING,
  EMAIL_STALENESS,
  emailDeliveryView,
  type EmailDeliveryRow,
  type EmailLedgerStatus,
} from "@/lib/delivery/status";

// ===========================================================================
// DELIVERY-EVENTS-01 — the delivery vocabulary is truthful.
//
// Pinned here: accepted is never shown as delivered, delivered never claims
// the inbox or a read, unknown and stale are never success, and every ledger
// status maps to exactly one display state.
// ===========================================================================

const NOW = new Date("2026-10-11T18:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

function row(status: EmailLedgerStatus, over: Partial<EmailDeliveryRow> = {}): EmailDeliveryRow {
  return {
    status,
    claimedAt: ago(60_000),
    settledAt: ago(59_000),
    providerStatusAt: ago(30_000),
    complainedAt: null,
    ...over,
  };
}

describe("email ledger status -> display state", () => {
  it.each<[EmailLedgerStatus, string, boolean, boolean]>([
    // status,            state,               final, attention
    ["claimed", "queued", false, false],
    ["skipped", "not_sent", true, false],
    ["refused", "failed", true, true],
    ["unknown", "unknown", false, true],
    ["accepted", "provider_accepted", false, false],
    ["sent", "provider_accepted", false, false],
    ["delivery_delayed", "delayed", false, false],
    ["delivered", "delivered", true, false],
    ["bounced", "bounced", true, true],
    ["failed", "failed", true, true],
    ["suppressed", "suppressed", true, true],
  ])("%s is shown as %s", (status, state, final, attention) => {
    expect(emailDeliveryView(row(status), NOW)).toEqual({ state, final, attention, complained: false });
  });

  it("never shows a provider's acceptance as delivery", () => {
    for (const status of ["accepted", "sent", "delivery_delayed"] as const) {
      expect(emailDeliveryView(row(status), NOW).state).not.toBe("delivered");
    }
  });

  it("turns silence into unknown or stale, never into success", () => {
    const unsettled = row("claimed", { claimedAt: ago(EMAIL_STALENESS.unsettledClaimMs + 1), settledAt: null, providerStatusAt: null });
    expect(emailDeliveryView(unsettled, NOW)).toMatchObject({ state: "unknown", attention: true });

    const quietAccepted = row("accepted", { providerStatusAt: null, settledAt: ago(EMAIL_STALENESS.noReportMs + 1) });
    expect(emailDeliveryView(quietAccepted, NOW)).toMatchObject({ state: "stale", attention: true, final: false });

    const quietSent = row("sent", { providerStatusAt: ago(EMAIL_STALENESS.noReportMs + 1) });
    expect(emailDeliveryView(quietSent, NOW).state).toBe("stale");

    const longDelay = row("delivery_delayed", { providerStatusAt: ago(EMAIL_STALENESS.delayedMs + 1) });
    expect(emailDeliveryView(longDelay, NOW).state).toBe("stale");
  });

  it("does not call a fresh attempt stale, right up to each threshold", () => {
    expect(emailDeliveryView(row("claimed", { claimedAt: ago(EMAIL_STALENESS.unsettledClaimMs) }), NOW).state).toBe("queued");
    expect(emailDeliveryView(row("sent", { providerStatusAt: ago(EMAIL_STALENESS.noReportMs) }), NOW).state).toBe(
      "provider_accepted",
    );
    expect(emailDeliveryView(row("delivery_delayed", { providerStatusAt: ago(EMAIL_STALENESS.delayedMs) }), NOW).state).toBe(
      "delayed",
    );
  });

  it("keeps a complaint visible beside the delivery it implies", () => {
    expect(emailDeliveryView(row("delivered", { complainedAt: ago(1_000) }), NOW)).toEqual({
      state: "delivered",
      final: true,
      attention: false,
      complained: true,
    });
  });
});

describe("the meaning of each state", () => {
  it("never says delivered means read, opened or in the inbox", () => {
    const delivered = DELIVERY_STATE_MEANING.delivered.toLowerCase();
    expect(delivered).toContain("does not mean");
    expect(delivered).toMatch(/seen or read/);
  });

  it("says plainly that accepted, unknown and stale are not delivery", () => {
    expect(DELIVERY_STATE_MEANING.provider_accepted).toMatch(/No delivery has been reported/);
    expect(DELIVERY_STATE_MEANING.unknown).toMatch(/may or may not have been sent/);
    expect(DELIVERY_STATE_MEANING.stale).toMatch(/not as delivered/);
  });
});
