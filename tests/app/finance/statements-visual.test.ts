import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: Record<string, unknown>) => createElement("a", { href: String(href), ...rest }, children as never),
  useLinkStatus: () => ({ pending: false }),
}));

import { ClientStatementView } from "@/app/(app)/financials/statements/client-statement-view";
import { StatementsTabs } from "@/app/(app)/financials/statements/statements-chrome";
import { buildStatementDocument } from "@/lib/finance/statement-document";
import { methodBreakdown } from "@/lib/finance/statement-methods";
import { VISIT_STATE_LABEL } from "@/lib/finance/statement-screen";

// The visual pass changes how the statement screens LOOK. These tests pin what must NOT change (every figure and sentence still reaches the page,
// unchanged) and what the new presentation adds (a prominent total, a payment-method breakdown that can never disagree with the total, readable
// badges, expandable details). Synthetic records only.
const ROOT = path.resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const fmt = (c: number) => "$" + (c / 100).toFixed(2);

const visit = (over = {}) => ({
  appointmentId: "a1", clientId: "c1", startsAt: "2026-11-03T15:00:00Z", localDate: "2026-11-03", localTime: "10:00", serviceName: "Service A", scheduledMinutes: 60,
  practitionerId: "p1", practitionerName: "Practitioner One", eligibility: "treatment", feeCandidates: [{ source: "settlement_quote", cents: 6000 }],
  lines: [{ kind: "collected_card_session", cents: 6000, source: "card" }], ...over,
});
const docFor = (visits: unknown[], extra: Record<string, unknown> = {}) => {
  const r = buildStatementDocument({
    studioId: "s1",
    identity: { studioName: "Studio One", legalEntityName: null, address: null, contactEmail: null },
    client: { id: "c1", name: "Ada Lovelace" },
    scope: { kind: "month", month: "2026-11" },
    currency: "cad",
    preparedOn: "2026-11-19",
    visits,
    ...extra,
  } as never);
  if (!r.ok) throw new Error(r.error);
  return r.document;
};
const props = (document: ReturnType<typeof docFor>, over = {}) => ({ document, month: "2026-11" as const, monthLabel: "November 2026", maxMonth: "2026-11" as const, view: "month" as const, notice: null, offDocumentWithMoney: 0, format: fmt, ...over });
const html = (d: ReturnType<typeof docFor>, over = {}) => renderToStaticMarkup(createElement(ClientStatementView, props(d, over) as never));

const split = visit({ appointmentId: "a9", localDate: "2026-11-05", lines: [{ kind: "collected_card_session", cents: 4000, source: "card" }, { kind: "collected_e_transfer", cents: 2000, source: "settlement" }] });

describe("the payment-method breakdown adds no rule: it regroups the lines and must equal the total", () => {
  it("groups collected lines by method, under the labels the screen already uses, summing to total paid", () => {
    const d = docFor([visit(), split]);
    const m = methodBreakdown(d)!;
    expect(m.map((x) => [x.kind, x.cents])).toEqual([["collected_card_session", 10000], ["collected_e_transfer", 2000]]);
    expect(m.reduce((n, x) => n + x.cents, 0)).toBe(d.totals.paidCents);
    expect(m[0].label).toBe("Card (Hone-verified): session payments");
  });
  it("includes collected money on a fee item (a no-show or cancellation fee), not only on visits", () => {
    const noShow = { appointmentId: "f1", clientId: "c1", localDate: "2026-11-06", startsAt: "2026-11-06T15:00:00Z", reason: "no_show_fee", feeCandidates: [{ source: "settlement_quote", cents: 2500 }], lines: [{ kind: "collected_card_fee", cents: 2500, source: "card" }] };
    const d = docFor([visit()], { feeItems: [noShow] });
    expect(d.totals.paidCents).toBe(8500); // the visit's $60.00 plus the fee's $25.00
    const m = methodBreakdown(d)!;
    expect(m.map((x) => [x.kind, x.cents])).toEqual([["collected_card_session", 6000], ["collected_card_fee", 2500]]);
    expect(m.reduce((n, x) => n + x.cents, 0)).toBe(d.totals.paidCents);
  });
  it("never counts a refunded line as money collected: a visit carrying a refunded line leaves the breakdown at the collected groups only", () => {
    const refunded = visit({ appointmentId: "a7", localDate: "2026-11-07", lines: [{ kind: "refunded_card_session", cents: 6000, source: "card" }] });
    const d = docFor([visit(), refunded]);
    expect(d.totals.paidCents).toBe(6000);
    expect(methodBreakdown(d)!.map((x) => [x.kind, x.cents])).toEqual([["collected_card_session", 6000]]);
  });
  it("is null when nothing was collected, and null whenever the groups do not add up to the total (never a figure beside a different total)", () => {
    expect(methodBreakdown(docFor([visit({ lines: [], feeCandidates: [] })]))).toBeNull();
    const d = docFor([visit()]);
    d.totals.paidCents += 1; // a document whose total the lines cannot explain
    expect(methodBreakdown(d)).toBeNull();
  });
  it("is a pure read of the document: no I/O, clock or request", () => {
    const src = read("lib/finance/statement-methods.ts").replace(/\/\/.*$/gm, "");
    expect([...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1]).sort()).toEqual(["@/lib/finance/statement", "@/lib/finance/statement-copy", "@/lib/finance/statement-document"]);
    expect(src).not.toMatch(/Date\.now|new Date|fetch\(|process\.env|supabase/);
  });
});

describe("the client statement, restyled", () => {
  it("shows a prominent total, the VERIFIED sentence unchanged, the visit count and how it was paid", () => {
    const out = html(docFor([visit(), split]));
    expect(out).toMatch(/aria-hidden="true"[^>]*>\$120\.00<\/p>/);
    expect(out).toMatch(/\$120\.00 paid<\/p>/);
    expect(out).toMatch(/2 visits/);
    expect(out).toMatch(/How it was paid/);
    expect(out).toMatch(/Card \(Hone-verified\): session payments<\/span><span[^>]*>\$100\.00/);
    expect(out).toMatch(/E-transfer \(recorded by the owner\)<\/span><span[^>]*>\$20\.00/);
  });
  it("omits the breakdown entirely when no method can be shown, and never invents a balance", () => {
    const out = html(docFor([visit({ lines: [] })]));
    expect(out).not.toMatch(/How it was paid/);
    expect(out).toMatch(/Balance due is not shown yet/);
    expect(out).not.toMatch(/Balance due \$/);
  });
  it("each visit carries a readable status badge whose words are the unchanged state labels, and a Details disclosure with the rest", () => {
    const unpaid = visit({ appointmentId: "a2", localDate: "2026-11-19", lines: [] });
    const out = html(docFor([visit(), unpaid]));
    expect(out).toContain(VISIT_STATE_LABEL.paid);
    expect(out).toContain(VISIT_STATE_LABEL.unknown);
    expect(out).toMatch(/<details/);
    expect(out).toMatch(/Duration/);
    expect(out).toMatch(/Practitioner One/);
    expect(out).toMatch(/No payment recorded/);
    expect(out).toMatch(/normal-case[^"]*"[^>]*>Paid</);
    // the shared pill sets small capitals; the override must be !important or the browser still shows "PAID" (found in the browser run, not by markup alone)
    expect(out).toMatch(/!normal-case !tracking-normal !text-xs/);
  });
  it("the wide table and the stacked phone list EACH carry the badge, the unchanged label and the details (neither is a copy of the other's text)", () => {
    const out = html(docFor([visit()]));
    const table = out.slice(out.indexOf("<table"), out.indexOf("</table>"));
    const list = out.slice(out.indexOf("</table>"));
    for (const part of [table, list]) {
      expect(part).toMatch(/normal-case[^"]*"[^>]*>Paid</);
      expect(part).toMatch(/<details/);
      expect(part).toMatch(/Practitioner One/);
    }
  });
  it("the summary card, the Clients totals line and the Studio collected total share ONE muted-sage tone (not the full success surface)", () => {
    const out = html(docFor([visit()]));
    // oklab, not oklch: the neutral has an explicit hue of 0, so an oklch mix drags the green toward orange (a peach card, seen in the browser, not in markup)
    expect(out).toMatch(/bg-\[color-mix\(in_oklab,var\(--color-success-surface\)_35%,var\(--color-line\)\)\]/);
    for (const f of ["client-statement-view.tsx", "clients-view.tsx", "../statement/statement-view.tsx"]) {
      expect(read("app/(app)/financials/statements/" + f), f).not.toMatch(/bg-success-surface\/\d+/);
      expect(read("app/(app)/financials/statements/" + f), f).toMatch(/SUMMARY_TONE/);
    }
  });
  it("fees are right-aligned numbers in a bordered table with one header row plus one row per visit", () => {
    const out = html(docFor([visit(), visit({ appointmentId: "a2", localDate: "2026-11-04" })]));
    expect(out.match(/<tr /g)?.length).toBe(3);
    expect(out).toMatch(/text-right[^"]*tabular-nums[^"]*"[^>]*>\$60\.00</);
    expect(out).toMatch(/rounded-xl border border-line/);
  });
  it("the month and full-history controls keep their links and aria-current", () => {
    const out = html(docFor([visit()]));
    expect(out).toMatch(/aria-current="page"[^>]*>[^]{0,240}?November 2026</);
    expect(out).toContain('href="/financials/statements/c1?month=2026-11&amp;view=history"');
    const tabs = renderToStaticMarkup(createElement(StatementsTabs, { active: "clients", month: "2026-11" }));
    expect(tabs).toMatch(/aria-current="page"[^>]*>[^]{0,240}?Clients</);
  });
  it("still shows the off-document notice and the total-paid definition", () => {
    const out = html(docFor([visit()]), { offDocumentWithMoney: 2 });
    expect(out).toMatch(/2 upcoming bookings have payments recorded/);
    expect(out).toMatch(/Total spend is money recorded as collected and kept/);
  });
});

describe("presentation only: the views reach no loader, client, write, Stripe or mail layer", () => {
  it.each(["client-statement-view.tsx", "clients-view.tsx", "statements-chrome.tsx", "client-finder.tsx"])("%s", (f) => {
    const src = read("app/(app)/financials/statements/" + f).replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/supabase|loadClientStatementRead|loadOwnerClientStatement|stripe|resend|twilio|\.insert\(|\.update\(|\.rpc\(|fetch\(|console\./i);
  });
});
