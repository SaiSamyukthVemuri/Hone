import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { buildStatement, type StatementCardRow } from "@/lib/finance/statement";
import { STATEMENT_NO_TOTAL, STATEMENT_UNNAMED_PRACTITIONER } from "@/lib/finance/statement-copy";

vi.mock("server-only", () => ({}));

// HON-64 Slice A review findings, pinned by rendering the real view with synthetic data.
const row = (over: Partial<StatementCardRow>): StatementCardRow => ({
  appointmentId: "a1",
  chargeReason: "session_payment",
  status: "succeeded",
  amountCents: 12345,
  currency: "cad",
  refundStatus: null,
  refundAmountCents: null,
  providerRefundStatus: null,
  stripeRefundId: null,
  cumulativeFullRefundVerified: false,
  stripeLivemode: true,
  ...over,
});
const fmt = (c: number) => `$${Math.trunc(c / 100)}.${String(c % 100).padStart(2, "0")} CAD`;

async function render(opts: { names?: Record<string, string>; startsAt?: string }) {
  const { StatementView } = await import("@/app/(app)/financials/statement/statement-view");
  const statement = buildStatement({
    studioCurrency: "cad",
    appointments: [
      { id: "a1", practitionerId: "p-1", startsAt: opts.startsAt ?? "2026-12-01T03:30:00Z" },
      { id: "a2", practitionerId: "p-2", startsAt: "2026-11-10T15:00:00Z" },
    ],
    cardRows: [
      row({}),
      row({ appointmentId: "a2", refundStatus: "pending_stripe", amountCents: 77700 }),
      row({ appointmentId: "a2", currency: "usd", amountCents: 88800 }),
      row({ appointmentId: "a2", status: "failed", amountCents: 66600 }),
    ],
    settlementRows: [
      { appointmentId: "a1", method: "paid_cash", amountCents: 5000, currency: "cad" },
      { appointmentId: "a1", method: "mystery", amountCents: 44400, currency: "cad" },
    ],
    legacyFeeRows: [{ appointmentId: "a1", status: "succeeded", amountCents: 99900, currency: "cad", stripeLivemode: true }],
  });
  return renderToStaticMarkup(
    StatementView({
      view: {
        access: "granted",
        ok: true,
        month: "2026-11",
        label: "November 2026",
        timezone: "America/Toronto",
        startLocal: "2026-11-01",
        endLocalExclusive: "2026-12-01",
        statement,
        visitInfo: { a1: { clientName: "Synthetic Client", serviceName: "Service" }, a2: { clientName: "Other Client", serviceName: null } },
        practitionerNames: opts.names ?? { "p-1": "Pat Synthetic", "p-2": "Sam Example" },
      },
      currency: "cad",
      format: fmt,
    }),
  );
}

describe("review finding: practitioner subtotals are named, never an array index", () => {
  it("shows each practitioner's display name and never 'Practitioner 1'", async () => {
    const html = await render({});
    expect(html).toContain("Pat Synthetic");
    expect(html).toContain("Sam Example");
    expect(html).not.toMatch(/Practitioner \d/);
  });
  it("a name that could not be read gets the explained fallback, and the id is never printed", async () => {
    const html = await render({ names: {} });
    expect(html).toContain(STATEMENT_UNNAMED_PRACTITIONER);
    expect(html).not.toContain("p-1");
    expect(html).not.toContain("p-2");
  });
});

describe("review findings: counted-but-not-totalled lines never print an amount (and never $0.00)", () => {
  it("unresolved, other-currency, excluded, unreadable and legacy-fee rows show 'no amount', never a figure", async () => {
    const html = await render({});
    for (const cents of [77700, 88800, 66600, 44400, 99900]) expect(html).not.toContain(fmt(cents));
    expect(STATEMENT_NO_TOTAL).toBe("no amount");
    expect(html).toContain("no amount");
    // collected still prints
    expect(html).toContain(fmt(12345));
    expect(html).toContain(fmt(5000));
  });
  it("the four non-amount lines of the 'Not totalled' section never carry a currency amount", async () => {
    const html = await render({});
    const section = html.slice(html.indexOf("Not totalled"), html.indexOf("Not totalled") + 2500);
    expect(section).not.toMatch(/\$\d+\.\d\d/);
    expect(section).not.toContain("$0.00");
  });
  it("the model carries no cents for any non-amount kind, so no caller can format one", () => {
    const s = buildStatement({
      studioCurrency: "cad",
      appointments: [{ id: "a1", practitionerId: "p", startsAt: "2026-11-02T12:00:00Z" }],
      cardRows: [row({ refundStatus: "pending_stripe" }), row({ currency: "usd" }), row({ status: "failed" })],
      settlementRows: [
        { appointmentId: "a1", method: "still_owes", amountCents: 5000, currency: "cad" },
        { appointmentId: "a1", method: "nope", amountCents: 5000, currency: "cad" },
      ],
      legacyFeeRows: [{ appointmentId: "a1", status: "succeeded", amountCents: 3000, currency: "cad", stripeLivemode: true }],
    });
    for (const k of ["unresolved", "other_currency", "excluded", "unreadable", "still_owes_note"] as const) {
      expect(s.all.kinds[k].cents, k).toBe(0);
      expect(s.all.kinds[k].count, k).toBeGreaterThan(0);
    }
    const amountKinds = ["collected_card_session", "collected_card_fee", "collected_cash", "collected_e_transfer", "collected_other_external", "refunded_card_session", "refunded_card_fee", "waived"];
    for (const v of s.visits) for (const l of v.lines) if (!amountKinds.includes(l.kind)) expect(l.cents).toBeNull();
  });
});

describe("review finding: visit dates are in the studio's timezone", () => {
  it("23:30 Toronto on 30 Nov (03:30 UTC on 1 Dec) is shown as 2026-11-30, not the UTC date", async () => {
    const html = await render({ startsAt: "2026-12-01T03:30:00Z" });
    expect(html).toContain("2026-11-30:");
    expect(html).not.toContain("2026-12-01:");
  });
  it("the view never slices an ISO string for a date", () => {
    const src = readFileSync("app/(app)/financials/statement/statement-view.tsx", "utf8");
    expect(src).not.toMatch(/startsAt\.slice|\.slice\(0, 10\)/);
  });
});

describe("review findings: wording", () => {
  it("reconciliation says rows PLACED, and the copy says Unresolved is never added to Collected and a full refund is already absent from it", async () => {
    const html = await render({});
    expect(html).toMatch(/money rows? placed, each in exactly one line above/);
    expect(html).not.toMatch(/money rows? read/);
    expect(html).toContain("never added to Collected");
    expect(html).toContain("A fully refunded charge is already absent from Collected");
    expect(html).not.toMatch(/not subtracted from Collected|never added to any total/i);
  });
});
