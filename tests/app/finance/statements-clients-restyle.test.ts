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
  it("breadcrumb and the title 'Clients this month' (the Studio tab keeps 'Monthly statements')", () => {
    const out = render();
    expect(out).toMatch(/Business\s*\/\s*Statements/);
    expect(out).toMatch(/<h1[^>]*>Clients this month<\/h1>/);
    expect(out).not.toMatch(/<h1[^>]*>Monthly statements<\/h1>/);
  });
  it("the client is an underlined charcoal link to their statement for the month; the visit count reads '2 visits' (singular for one)", () => {
    const out = render([row(), row({ clientId: "c2", name: "Grace Hopper", visitCount: 1 })]);
    const tag = out.match(/<a [^>]*><span[^>]*>Ada Lovelace<\/span>/)?.[0] ?? "";
    expect(tag).toContain('href="/financials/statements/c1?month=2026-11"');
    expect(tag).toContain("text-fg");
    expect(tag).toContain("underline");
    expect(out).toContain(">2 visits<");
    expect(out).toContain(">1 visit<");
  });
  it("the amount is grouped by thousands and carries its status BENEATH it in the same cell, in the directory's own words", () => {
    const out = render([row({ paidCents: 123456 }), row({ clientId: "c2", name: "Grace Hopper", paidCents: 5000, awaitingCount: 1 })]);
    expect(out).toMatch(/<span class="block font-medium text-fg">\$1,234\.56<\/span><span class="block text-xs text-fg-muted">All confirmed<\/span>/);
    expect(out).toMatch(/\$50\.00<\/span><span class="block text-xs text-fg-muted">1 visit awaiting payment confirmation<\/span>/);
    expect(out).not.toContain("Payment status"); // the column is gone; the words moved under the amount
    const list = out.slice(out.indexOf("<tbody"), out.indexOf("</table>"));
    expect(list).not.toContain("CAD"); // no currency suffix on a row, as on the Studio tab (CAD stays in the footnote totals line)
  });
  it("the reference draws no column heads: they are visually hidden (sr-only) but stay for assistive technology; one row per client", () => {
    const out = render([row(), row({ clientId: "c2", name: "Grace Hopper" })]);
    expect(out.match(/<tr[ >]/g)?.length).toBe(3);
    expect(out).toMatch(/<thead class="sr-only">/);
    expect(out).toMatch(/<th scope="col"[^>]*>Client<\/th>/);
    expect(out).toMatch(/<th scope="row"/);
  });
  it("the page keeps its content area on the white ground, no tint (source guard) and formats money with thousands separators", () => {
    const src = readFileSync("app/(app)/financials/statements/page.tsx", "utf8");
    expect(src).toContain('<div className="bg-surface min-[1140px]:-mx-[45px]">'); // the same breakout width as the Studio tab
    expect(src).toContain("formatStatementMoney(c, currency)");
  });
});

describe("Find a client on the Studio tab", () => {
  const studioView = async (finder: unknown) => {
    const { StatementView } = await import("@/app/(app)/financials/statement/statement-view");
    const { buildStatement } = await import("@/lib/finance/statement");
    const statement = buildStatement({ studioCurrency: "cad", appointments: [], cardRows: [], settlementRows: [], legacyFeeRows: [] });
    return renderToStaticMarkup(createElement(StatementView as never, {
      view: { access: "granted", ok: true, month: "2026-11", label: "November 2026", timezone: "America/Toronto", startLocal: "2026-11-01", endLocalExclusive: "2026-12-01", statement, visitInfo: {}, practitionerNames: {}, settlementQuotes: {}, noPaymentVisits: [] },
      currency: "cad", format: (c: number) => formatStatementMoney(c, "cad"), maxMonth: "2026-11", tabs: createElement("nav", null, "TABS-STUB"), finder,
    }));
  };
  it("with finder data the box sits beside the tabs under the same 'Find a client' heading as on the Clients tab", async () => {
    const out = await studioView({ state: "ok", clients: [{ id: "c1", displayName: "Ada Lovelace", archived: false }], lastVisits: null });
    expect(out).toContain("TABS-STUB");
    expect(out).toMatch(/<h2 id="stmt-find" class="sr-only">Find a client<\/h2>/);
    expect(out).toMatch(/<input[^>]*role="combobox"|placeholder="Find a client/);
    expect(out.indexOf("TABS-STUB")).toBeLessThan(out.indexOf("stmt-find"));
  });
  it("too many clients, or an unavailable list, say so in the existing words instead of a box; no finder prop draws nothing", async () => {
    expect(await studioView({ state: "too_many" })).toContain("more clients than Find a client can search");
    expect(await studioView({ state: "unavailable" })).toMatch(/could not be read/);
    expect(await studioView(undefined)).not.toContain("stmt-find");
  });
  it("the Studio page loads the finder only after the owner gate (source guard)", () => {
    const src = readFileSync("app/(app)/financials/statement/page.tsx", "utf8");
    expect(src.indexOf('practitioner.role !== "owner"')).toBeLessThan(src.indexOf("await loadFinderState("));
    expect(src).toContain("finder={finder}");
  });
  it("the Studio view tells the finder it has no month counts, so a result states none (source guard)", () => {
    const src = readFileSync("app/(app)/financials/statement/statement-view.tsx", "utf8");
    expect(src).toMatch(/<ClientFinder[^>]*monthVisits=\{null\}[^>]*showMonthCount=\{false\}/);
  });
});

describe("each client row has a real document action", () => {
  it("'Statement' opens that client's statement for the month (where Print and Export already work), styled as the reference's row button; there is no Invoice wording", () => {
    const out = render([row(), row({ clientId: "c2", name: "Grace Hopper" })]);
    for (const [id, name] of [["c1", "Ada Lovelace"], ["c2", "Grace Hopper"]]) {
      const tag = out.match(new RegExp(`<a [^>]*aria-label="Statement for ${name}"[^>]*>`))?.[0] ?? "";
      expect(tag, name).toContain(`href="/financials/statements/${id}?month=2026-11"`);
      expect(tag).toContain("border-line-strong");
    }
    expect(out.match(/>Statement<\/span>/g)?.length).toBe(2);
    expect(out).not.toMatch(/Invoice/);
  });
});

describe("the shared finder loader keeps its size cap and its states", () => {
  const load = async (clients: { id: string; name: string; preferredName: string | null; archived: boolean }[], over: Record<string, unknown> = {}) => {
    vi.resetModules();
    const lastVisits = vi.fn(async () => ({ access: "granted", ok: true, lastVisit: {} }));
    vi.doMock("@/lib/finance/statement-directory-read", () => ({
      LAST_VISIT_MAX_CLIENTS: 40,
      loadFinderClients: vi.fn(async () => ({ access: "granted", ok: true, clients })),
      loadLastVisitDates: lastVisits,
      ...over,
    }));
    const { loadFinderState } = await import("@/app/(app)/financials/statements/finder-data");
    const { FINDER_CLIENT_CAP } = await import("@/lib/finance/statement-screen");
    return { state: await loadFinderState({ role: "owner" } as never, { id: "s1", timezone: "America/Toronto" } as never), cap: FINDER_CLIENT_CAP, lastVisits };
  };
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, name: `Client ${i}`, preferredName: null, archived: false }));
  it("exactly the cap is searchable; one more is 'too_many' and carries NO client", async () => {
    const { cap } = await load([]);
    const atCap = await load(many(cap));
    expect(atCap.state.state).toBe("ok");
    const over = await load(many(cap + 1));
    expect(over.state).toEqual({ state: "too_many" });
  });
  it("a refused or failed client read is 'unavailable', never an empty finder", async () => {
    const refused = await load([], { loadFinderClients: vi.fn(async () => ({ access: "refused" })) });
    expect(refused.state).toEqual({ state: "unavailable" });
    const failed = await load([], { loadFinderClients: vi.fn(async () => ({ access: "granted", ok: false, reason: "read_failed" })) });
    expect(failed.state).toEqual({ state: "unavailable" });
  });
  it("above the cap no last-visit lookup is made at all", async () => {
    const { cap } = await load([]);
    const over = await load(many(cap + 1));
    expect(over.lastVisits).not.toHaveBeenCalled();
  });
});

describe("the Clients tab header and footnote follow the reference without dropping the explanation", () => {
  it("the header is the month then 'N clients with visits'; no tinted summary strip above the table", () => {
    const out = render([row(), row({ clientId: "c2", name: "Grace Hopper" })]);
    expect(out).toMatch(/<h2 id="stmt-clients"[^>]*>November 2026<\/h2><p[^>]*>2 clients with visits<\/p>/);
    expect(out.indexOf("2 clients with visits")).toBeLessThan(out.indexOf("<table"));
    expect(out).not.toMatch(/aria-live="polite"[^>]*>[^<]*13 clients/);
  });
  it("the counting explanation, the timezone and the month's totals (with the awaiting count) are a footnote BELOW the list", () => {
    const out = render([row({ awaitingCount: 1 })]);
    const foot = out.slice(out.indexOf("</table>"));
    expect(foot).toContain("1 client · 2 visits");
    expect(foot).toMatch(/awaiting payment confirmation/);
    expect(foot).toContain("The counts and totals for the month cover every client, not only this page.");
    expect(foot).toContain("America/Toronto");
    expect(out.slice(0, out.indexOf("<table"))).not.toContain("America/Toronto");
  });
  it("the Studio tab's finder results state no visit count at all (never 'unavailable', never zero)", async () => {
    const { finderOptionLine } = await import("@/lib/finance/statement-screen");
    expect(finderOptionLine({ monthLabel: "November 2026", monthVisitCount: null, sameNameAsAnother: false, lastVisit: undefined, lastVisitsLoaded: false, showMonthCount: false })).toBe("");
    expect(finderOptionLine({ monthLabel: "November 2026", monthVisitCount: null, sameNameAsAnother: true, lastVisit: undefined, lastVisitsLoaded: false, showMonthCount: false })).toBe("Same name as another client");
    // unchanged where counts are loaded: an unreadable month still says so on the Clients tab
    expect(finderOptionLine({ monthLabel: "November 2026", monthVisitCount: null, sameNameAsAnother: false, lastVisit: undefined, lastVisitsLoaded: false })).toBe("Visit count for November 2026 unavailable");
  });
});
