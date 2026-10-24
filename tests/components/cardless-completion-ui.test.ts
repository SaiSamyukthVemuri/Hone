import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

// HON-45 — TRUTHFUL CARDLESS COMPLETION, AS RENDERED OUTPUT.
//
// A client with no card on file has a completed, charted visit. What the
// payment card says about it must be true: nothing was charged, there is no
// charge path, and the visit stays OUTSTANDING until a real settlement records
// money received. Nothing on this path marks it paid or settled. These run the real components through
// react-dom/server, the idiom of tests/components/checkout-final-amount-ui.test.ts.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));

vi.mock("next/link", async () => {
  const react = await import("react");
  return {
    default: (props: { href: string; children?: ReactNode }) =>
      react.createElement("a", { href: props.href }, props.children),
  };
});

vi.mock("@/app/(app)/appointment-settlement-actions", () => ({
  recordAppointmentSettlementAction: async () => ({ ok: true }),
  waiveAppointmentFeeAction: async () => ({ ok: true }),
}));

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { SessionPaymentPrepareCard } =
  await import("@/components/session-payment-prepare-card");
const { NO_CARD_ON_FILE_REASON } =
  await import("@/lib/billing/session-payment-types");
const { COMPLETE_CONFIRM_MESSAGE } =
  await import("@/components/appointment/mark-complete-control");

const REFERENCE = {
  kind: "resolved" as const,
  amountCents: 12_000,
  source: "service_price" as const,
  serviceName: "Electrolysis 60 min",
  durationMinutes: 60,
  customPricingNote: null,
};

const noop = async () => ({ ok: false as const, error: "not called" });

function ineligible(blockingReasons: string[]) {
  return {
    eligible: false as const,
    blockingReasons,
    session: {
      id: "sess-1",
      modality: "electrolysis",
      startedAt: "2026-10-20T14:00:00.000Z",
      endedAt: null,
      pricePaidCents: null,
    },
    appointment: { id: "appt-1", status: "completed", startsAt: null },
    client: { id: "client-1", name: "Test Client" },
    card: null,
    cardAuthorization: null,
    existingAttempts: [],
  };
}

function render(opts: {
  reasons: string[];
  canRecordSettlement?: boolean;
  appointmentId?: string | null;
  settledMethod?: string | null;
  settledAmountCents?: number | null;
  quotedAmountCents?: number | null;
  amountResult?: unknown;
}): string {
  return renderToStaticMarkup(
    createElement(SessionPaymentPrepareCard, {
      sessionId: "sess-1",
      clientId: "client-1",
      eligibility: ineligible(opts.reasons),
      amountResult: ("amountResult" in opts ? opts.amountResult : REFERENCE) as never,
      appointmentId: "appointmentId" in opts ? opts.appointmentId : "appt-1",
      settledMethod: opts.settledMethod ?? null,
      settledAmountCents:
        "settledAmountCents" in opts
          ? opts.settledAmountCents
          : opts.settledMethod
            ? 12_000
            : null,
      settlementQuotedAmountCents:
        "quotedAmountCents" in opts ? opts.quotedAmountCents : 12_000,
      canRecordSettlement: opts.canRecordSettlement ?? true,
      isOwner: false,
      prepareAction: noop as never,
      executeAction: noop as never,
      sendReceiptAction: noop as never,
      refundAction: noop as never,
    } as never) as ReactNode,
  );
}

/** Visible text only, so assertions read what a practitioner reads. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

describe("HON-45: a completed visit for a client with no card on file", () => {
  it("says nothing was charged, calmly, instead of an amber fault", () => {
    const html = render({ reasons: [NO_CARD_ON_FILE_REASON] });
    expect(html).toContain('data-testid="session-payment-no-card"');
    expect(text(html)).toContain("No card on file · Nothing has been charged.");
    expect(text(html)).toContain(
      "Completing and charting this visit does not take a payment.",
    );
    expect(text(html)).not.toContain(
      "Session payment cannot be prepared right now.",
    );
    // The notice is neutral: amber is the fault colour.
    const notice = html.match(
      /<div[^>]*data-testid="session-payment-no-card"[^>]*>/,
    )![0];
    expect(notice).not.toMatch(/amber/);
  });

  it("offers no charge path at all", () => {
    const html = render({ reasons: [NO_CARD_ON_FILE_REASON] });
    expect(html).not.toMatch(/name="final_amount_dollars"/);
    expect(text(html)).not.toMatch(/Run charge|Prepare session payment/);
    expect(text(html)).not.toMatch(/saved card will be charged/);
  });

  it("claims no payment anywhere on the card", () => {
    const visible = text(render({ reasons: [NO_CARD_ON_FILE_REASON] }));
    // The only "paid" words allowed are the settlement BUTTON labels, which
    // are choices, not claims, plus the existing header and the new notice,
    // which are negations. Strip those and nothing may say paid/charged.
    const withoutChoices = visible
      .replace(/Paid cash|Paid by e-transfer|Paid another way/g, "")
      .replace(/The client is not charged until you run the charge\./g, "")
      .replace(/Choose a paid method only once[^.]*\./g, "")
      .replace(/Nothing has been charged\./g, "")
      .replace(/until it is paid\./g, "");
    expect(withoutChoices).not.toMatch(/\b(paid|charged)\b/i);
  });

  it("keeps the visit OUTSTANDING with its balance, without recording anything", () => {
    const html = render({ reasons: [NO_CARD_ON_FILE_REASON] });
    expect(html).toContain('data-testid="session-payment-outstanding"');
    expect(text(html)).toContain(
      "Balance outstanding: $120.00. No payment has been received.",
    );
    expect(text(html)).toContain(
      "It stays outstanding until payment is actually received. Record it below only then.",
    );
    // The settlement controls are still a choice, not a pre-made record.
    expect(html).toContain("appointment-settlement-controls");
    expect(html).not.toContain("appointment-settlement-recorded");
  });

  it("never steers an insurance claim to a paid or client-debt record", () => {
    const visible = text(render({ reasons: [NO_CARD_ON_FILE_REASON] }));
    expect(visible).toContain(
      "Choose a paid method only once the money has actually been received. An insurance claim that has been sent is not a payment: leave the visit outstanding until it is paid.",
    );
    expect(visible).not.toMatch(
      /insurance[^.]*(Paid another way|Client still owes)/,
    );
  });

  it("an unknown price is still outstanding, with no invented figure", () => {
    const html = render({
      reasons: [NO_CARD_ON_FILE_REASON],
      quotedAmountCents: null,
    });
    expect(text(html)).toContain(
      "Balance outstanding. No payment has been received.",
    );
    expect(text(html)).not.toMatch(/\$0\.00/);
  });

  it("a recorded 'still owes' is still outstanding", () => {
    const html = render({
      reasons: [NO_CARD_ON_FILE_REASON],
      settledMethod: "still_owes",
    });
    expect(html).toContain("session-payment-outstanding");
  });

  it("only a REAL recorded settlement ends 'outstanding'", () => {
    for (const m of [
      "paid_cash",
      "paid_e_transfer",
      "paid_other_external",
      "waived",
    ]) {
      const html = render({
        reasons: [NO_CARD_ON_FILE_REASON],
        settledMethod: m,
      });
      expect(html).not.toContain("session-payment-outstanding");
      // The recorded fact is shown as the studio's record, never as Hone's.
      expect(html).toContain("appointment-settlement-recorded");
      expect(text(html)).toContain(
        "Recorded by the studio, not verified by Hone.",
      );
    }
  });

  it("does not point at a settlement control that is not there", () => {
    const html = render({
      reasons: [NO_CARD_ON_FILE_REASON],
      canRecordSettlement: false,
    });
    expect(html).not.toContain("appointment-settlement-controls");
    expect(text(html)).toContain(
      "It stays outstanding until payment is actually received.",
    );
    expect(text(html)).not.toContain("Record it below only then.");
  });

  it("keeps the amber list when anything else is also wrong", () => {
    const html = render({
      reasons: [NO_CARD_ON_FILE_REASON, "Session has not started yet."],
    });
    expect(html).not.toContain("session-payment-no-card");
    expect(text(html)).toContain(
      "Session payment cannot be prepared right now.",
    );
    expect(text(html)).toContain(NO_CARD_ON_FILE_REASON);
  });

  it("never presents a failed card read as 'no card'", () => {
    const html = render({
      reasons: [
        "Payment eligibility could not be verified. Refresh and try again.",
      ],
    });
    expect(html).not.toContain("session-payment-no-card");
    expect(text(html)).not.toContain("No card on file");
  });
});

// Codex P2 4365600228 / 4365600234 on #1072.
const FREE = {
  kind: "free" as const,
  serviceName: "Free consultation",
  durationMinutes: 30,
};

describe("HON-45: the outstanding notice names the right balance, or none", () => {
  it("an authoritatively free visit with no settlement is not presented as debt", () => {
    const html = render({ reasons: [NO_CARD_ON_FILE_REASON], amountResult: FREE, quotedAmountCents: 0 });
    expect(html).toContain("session-payment-no-card");
    expect(html).not.toContain("session-payment-outstanding");
    // The settlement controls' general rule ("leave the visit outstanding
    // until it is paid") may still render; no BALANCE claim may.
    expect(text(html)).not.toMatch(/Balance outstanding|It stays outstanding/);
    expect(text(html)).toContain("Free consultation is free · No payment required.");
    expect(text(html)).toContain("Nothing has been charged.");
  });

  it("a $0 appointment quote alone (pricing context unavailable) is not debt either", () => {
    const html = render({ reasons: [NO_CARD_ON_FILE_REASON], amountResult: null, quotedAmountCents: 0 });
    expect(html).not.toContain("session-payment-outstanding");
  });

  it("a recorded still-owes shows the RECORDED debt, not the quote", () => {
    const html = render({
      reasons: [NO_CARD_ON_FILE_REASON],
      settledMethod: "still_owes",
      settledAmountCents: 8_000,
      quotedAmountCents: 12_000,
    });
    expect(text(html)).toContain("Balance outstanding: $80.00. No payment has been received.");
    expect(text(html)).not.toContain("$120.00");
  });

  it("a recorded still-owes on a free visit is a real record and is still shown", () => {
    const html = render({
      reasons: [NO_CARD_ON_FILE_REASON],
      amountResult: FREE,
      quotedAmountCents: 0,
      settledMethod: "still_owes",
      settledAmountCents: 5_000,
    });
    expect(text(html)).toContain("Balance outstanding: $50.00. No payment has been received.");
  });

  it("an unsettled priced visit still shows the quote (control)", () => {
    const html = render({ reasons: [NO_CARD_ON_FILE_REASON] });
    expect(text(html)).toContain("Balance outstanding: $120.00. No payment has been received.");
  });
});

describe("HON-45: the completion confirmation", () => {
  it("says no payment is taken and does not promise a charge", () => {
    expect(COMPLETE_CONFIRM_MESSAGE).toContain("No payment is taken.");
    expect(COMPLETE_CONFIRM_MESSAGE).not.toMatch(
      /allows the session to be charged/,
    );
  });
});
