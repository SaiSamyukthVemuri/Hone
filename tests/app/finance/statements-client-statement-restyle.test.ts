import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/financials/statements/c1", useSearchParams: () => new URLSearchParams() }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: Record<string, unknown>) => createElement("a", { href: String(href), ...rest }, children as never),
  useLinkStatus: () => ({ pending: false }),
}));

import { ClientStatementView } from "@/app/(app)/financials/statements/client-statement-view";
import { StatementPrintView } from "@/app/(app)/financials/statements/statement-print-view";
import { StatementsTabs } from "@/app/(app)/financials/statements/statements-chrome";
import { buildStatementDocument } from "@/lib/finance/statement-document";
import { formatClock12h, formatStatementMoney, splitCurrency } from "@/lib/finance/statement-money";

// One client's statement, restyled to the approved layout. Presentation only: the document, its totals, the CSV and the print page are unchanged; the screen
// shows the same visits latest first, with short method words, CAD once, 12-hour times and a primary Print action. Synthetic records only.
const fmt = (c: number) => formatStatementMoney(c, "cad");
const visit = (id: string, day: string, time: string, over = {}) => ({
  appointmentId: id, clientId: "c1", startsAt: `${day}T${time}:00Z`, localDate: day, localTime: time, serviceName: "Service A", scheduledMinutes: 60,
  practitionerId: "p1", practitionerName: "Practitioner One", eligibility: "treatment", feeCandidates: [{ source: "settlement_quote", cents: 6000 }],
  lines: [{ kind: "collected_card_session", cents: 6000, source: "card" }], ...over,
});
const docFor = (visits: unknown[]) => {
  const r = buildStatementDocument({
    studioId: "s1", identity: { studioName: "Studio One", legalEntityName: null, address: null, contactEmail: null }, client: { id: "c1", name: "Ada Lovelace" },
    scope: { kind: "month", month: "2026-11" }, currency: "cad", preparedOn: "2026-11-19", visits,
  } as never);
  if (!r.ok) throw new Error(r.error);
  return r.document;
};
const props = (d: ReturnType<typeof docFor>, over = {}) => ({ document: d, month: "2026-11" as const, monthLabel: "November 2026", maxMonth: "2026-11" as const, view: "month" as const, notice: null, offDocumentWithMoney: 0, format: fmt, ...over });
const html = (d: ReturnType<typeof docFor>, over = {}) => renderToStaticMarkup(createElement(ClientStatementView, props(d, over) as never));
const three = () => docFor([visit("a1", "2026-11-03", "09:00"), visit("a2", "2026-11-10", "13:30"), visit("a3", "2026-11-17", "11:00", { lines: [{ kind: "collected_e_transfer", cents: 6000, source: "settlement" }] })]);

describe("helpers", () => {
  it("formatClock12h: midnight, noon, morning, afternoon; anything else unchanged", () => {
    expect(formatClock12h("00:05")).toBe("12:05 AM");
    expect(formatClock12h("09:00")).toBe("9:00 AM");
    expect(formatClock12h("12:00")).toBe("12:00 PM");
    expect(formatClock12h("13:30")).toBe("1:30 PM");
    expect(formatClock12h("23:59")).toBe("11:59 PM");
    for (const x of ["", "9", "24:00", "not a time", "09:0"]) expect(formatClock12h(x)).toBe(x);
  });
  it("splitCurrency: the figure and its trailing label; text without a label whole", () => {
    expect(splitCurrency("$1,234.00 CAD")).toEqual({ amount: "$1,234.00", unit: "CAD" });
    expect(splitCurrency("$60.00")).toEqual({ amount: "$60.00", unit: null });
    expect(splitCurrency("Fee not recorded")).toEqual({ amount: "Fee not recorded", unit: null });
  });
});

describe("chrome and actions", () => {
  it("breadcrumb, the title 'Client statement', the tabs and Find a client beside them; Print is the primary action, Export CSV the plain one", () => {
    const tabs = renderToStaticMarkup(createElement(StatementsTabs, { active: "clients", month: "2026-11" }));
    const out = html(three(), { tabs: createElement("div", { dangerouslySetInnerHTML: { __html: tabs } }), finder: { state: "ok", clients: [{ id: "c1", displayName: "Ada Lovelace", archived: false }], lastVisits: null } });
    expect(out).toMatch(/Business\s*\/\s*Statements/);
    expect(out).toMatch(/<h1[^>]*>Client statement<\/h1>/);
    expect(out).toMatch(/<h2 id="stmt-find" class="sr-only">Find a client<\/h2>/);
    expect(out).toContain('aria-current="page"');
    const print = out.match(/<a [^>]*><span[^>]*>Print \/ Save as PDF<\/span>/)?.[0] ?? "";
    expect(print).toContain("bg-[#1f3d2e]");
    const csv = out.match(/<a [^>]*>Export CSV<\/a>/)?.[0] ?? "";
    expect(csv).not.toContain("bg-[#1f3d2e]");
    expect(csv).toContain("href=");
  });
  it("without tabs or a finder the old Back to Clients link stays", () => {
    expect(html(three())).toContain("Back to Clients (November 2026)");
  });
});

describe("the visits and the card", () => {
  it("rows are LATEST FIRST on screen (table and phone list), times in 12-hour form", () => {
    const out = html(three());
    const order = [...out.matchAll(/Nov(?:ember)? (\d+), 2026, (\d+:\d{2} [AP]M)/g)].map((m) => `${m[1]} ${m[2]}`);
    const table = order.slice(0, 3);
    expect(table).toEqual(["17 11:00 AM", "10 1:30 PM", "3 9:00 AM"]);
    expect(out).not.toMatch(/, 09:00|, 13:30|, 11:00</);
  });
  it("the card shows the total with CAD once beside it, short method words, the bar ABOVE the list, no currency suffix on the lines or the fees", () => {
    const out = html(three());
    const card = out.slice(out.indexOf('aria-labelledby="cs-summary"'), out.indexOf("</section>", out.indexOf('aria-labelledby="cs-summary"')));
    expect(card).toMatch(/<small[^>]*>CAD<\/small>/);
    expect(card).toMatch(/<span>Card<\/span><span[^>]*>\$120\.00<\/span>/);
    expect(card).toMatch(/<span>E-transfer<\/span><span[^>]*>\$60\.00<\/span>/);
    expect(card.indexOf("h-[7px]")).toBeLessThan(card.indexOf("<span>Card</span>"));
    const fees = [...out.matchAll(/<td class="whitespace-nowrap px-3 py-3 text-right[^"]*">([^<]*)</g)].map((m) => m[1]);
    expect(fees).toEqual(["$60.00", "$60.00", "$60.00"]); // the fee column carries no currency suffix (the Details disclosure keeps full amounts)
    expect(out).toContain("CAD paid"); // the verified sentence keeps its currency
  });
  it("the display order changes NO figure: the total, the visit count and the sentence are identical for any order of the same visits", () => {
    const a = three();
    const b = docFor([...[visit("a3", "2026-11-17", "11:00", { lines: [{ kind: "collected_e_transfer", cents: 6000, source: "settlement" }] }), visit("a2", "2026-11-10", "13:30"), visit("a1", "2026-11-03", "09:00")]]);
    expect(b.totals).toEqual(a.totals);
    expect(html(b)).toBe(html(a));
  });
});

describe("the print page and the CSV keep the document's own order and 24-hour times", () => {
  it("the print page lists visits in the document order with the stored time, unchanged", () => {
    const doc = three();
    const out = renderToStaticMarkup(createElement(StatementPrintView as never, { document: doc, offDocumentWithMoney: 0, backHref: "/x", format: fmt }));
    const times = [...out.matchAll(/Nov(?:ember)? (\d+), 2026, (\d{2}:\d{2})</g)].map((m) => `${m[1]} ${m[2]}`);
    expect(times).toEqual(doc.visits.map((v) => `${Number(v.localDate.slice(8))} ${v.localTime}`));
  });
});

describe("the display order is a COPY, and the page loads the finder only after the owner gate", () => {
  it("rendering leaves the document's own visits array in its original order and identity", () => {
    const doc = three();
    const before = doc.visits.map((v) => v.appointmentId);
    const ref = doc.visits;
    html(doc);
    expect(doc.visits).toBe(ref);
    expect(doc.visits.map((v) => v.appointmentId)).toEqual(before);
    expect(before).not.toEqual([...before].reverse()); // the order is a real one, so an in-place sort would be noticed
  });
  it("the client statement page loads the finder after its owner gate, like the Studio page", () => {
    const src = readFileSync("app/(app)/financials/statements/[clientId]/page.tsx", "utf8").replace(/\/\/.*$/gm, "");
    const gate = src.indexOf('practitioner.role !== "owner"');
    const call = src.indexOf("await loadFinderState(");
    expect(gate).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(gate);
    expect(src.indexOf("await loadOwnerClientStatement(")).toBeGreaterThan(gate);
  });
});
