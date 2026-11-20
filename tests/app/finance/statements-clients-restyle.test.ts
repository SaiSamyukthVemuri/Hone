import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/financials/statements", useSearchParams: () => new URLSearchParams() }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: Record<string, unknown>) => createElement("a", { href: String(href), ...rest }, children as never),
  useLinkStatus: () => ({ pending: false }),
}));

import { ClientsView } from "@/app/(app)/financials/statements/clients-view";
import { formatStatementMoney } from "@/lib/finance/statement-money";

// The Clients tab, restyled to the approved layout: the same chrome as the Studio tab, a spacious grid, green client links, the visit count in words, and the
// amount with its payment status beneath. Presentation only: every figure and every status sentence is the directory's own. Synthetic records only.
const row = (over = {}) => ({ clientId: "c1", name: "Ada Lovelace", visitCount: 2, paidCents: 123456, awaitingCount: 0, unconfirmedFeeCount: 0, ...over });
const reconciliation = { clientsSpendCents: 0, offDocumentCollectedCents: 0, studioCollectedCents: 0, offDocumentWithMoney: 0, reconciled: true };
const dir = (rows = [row()]) => ({
  ok: true as const,
  value: { rows, totals: { clientCount: rows.length, visitCount: rows.reduce((n, x) => n + x.visitCount, 0), paidCents: rows.reduce((n, x) => n + x.paidCents, 0), awaitingCount: rows.reduce((n, x) => n + x.awaitingCount, 0) }, reconciliation },
});
const render = (rows = [row()]) =>
  renderToStaticMarkup(
    createElement(ClientsView as never, {
      month: "2026-11", monthLabel: "November 2026", maxMonth: "2026-11", timezone: "America/Toronto", notice: null, page: 1,
      format: (c: number) => formatStatementMoney(c, "cad"), directory: dir(rows), finder: { state: "ok", clients: [], lastVisits: null },
    }),
  );

describe("the Clients tab matches the Studio tab's chrome and the approved grid", () => {
  it("breadcrumb and the title 'Monthly statements', as on the Studio tab", () => {
    const out = render();
    expect(out).toMatch(/Business\s*\/\s*Statements/);
    expect(out).toMatch(/<h1[^>]*>Monthly statements<\/h1>/);
    expect(out).not.toMatch(/<h1[^>]*>Statements<\/h1>/);
  });
  it("the client is a green underlined link to their statement for the month; the visit count reads '2 visits' (singular for one)", () => {
    const out = render([row(), row({ clientId: "c2", name: "Grace Hopper", visitCount: 1 })]);
    const tag = out.match(/<a [^>]*><span[^>]*>Ada Lovelace<\/span>/)?.[0] ?? "";
    expect(tag).toContain('href="/financials/statements/c1?month=2026-11"');
    expect(tag).toContain("text-[#244e38]");
    expect(tag).toContain("underline");
    expect(out).toContain(">2 visits<");
    expect(out).toContain(">1 visit<");
  });
  it("the amount is grouped by thousands and carries its status BENEATH it in the same cell, in the directory's own words", () => {
    const out = render([row({ paidCents: 123456 }), row({ clientId: "c2", name: "Grace Hopper", paidCents: 5000, awaitingCount: 1 })]);
    expect(out).toMatch(/<span class="block font-medium text-fg">\$1,234\.56 CAD<\/span><span class="block text-xs text-\[#5d685f\]">All confirmed<\/span>/);
    expect(out).toMatch(/\$50\.00 CAD<\/span><span class="block text-xs text-\[#5d685f\]">1 visit awaiting payment confirmation<\/span>/);
    expect(out).not.toContain("Payment status"); // the column is gone; the words moved under the amount
  });
  it("still a real table with a header row and one row per client (assistive technology keeps its structure)", () => {
    const out = render([row(), row({ clientId: "c2", name: "Grace Hopper" })]);
    expect(out.match(/<tr /g)?.length).toBe(3);
    expect(out).toMatch(/<th scope="col"[^>]*>Client<\/th>/);
    expect(out).toMatch(/<th scope="row"/);
  });
  it("the page tints its content area #fafbf9 (source guard) and formats money with thousands separators", () => {
    const src = readFileSync("app/(app)/financials/statements/page.tsx", "utf8");
    expect(src).toContain('<div className="bg-[#fafbf9]">');
    expect(src).toContain("formatStatementMoney(c, currency)");
  });
});
