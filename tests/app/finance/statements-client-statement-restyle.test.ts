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
const docFor = (visits: unknown[], scope: unknown = { kind: "month", month: "2026-11" }) => {
  const r = buildStatementDocument({
    studioId: "s1", identity: { studioName: "Studio One", legalEntityName: null, address: null, contactEmail: null }, client: { id: "c1", name: "Ada Lovelace" },
    scope, currency: "cad", preparedOn: "2026-11-19", visits,
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
    expect(print).toContain("bg-accent"); // the app's solid action
    const csv = out.match(/<a [^>]*>Export CSV<\/a>/)?.[0] ?? "";
    expect(csv).not.toContain("bg-accent");
    expect(csv).toContain("href=");
  });
  it("without tabs or a finder the old Back to Clients link stays", () => {
    expect(html(three())).toContain("Back to Clients (November 2026)");
  });
});

describe("the visits and the card", () => {
  it("rows are LATEST FIRST on screen, the date over a 12-hour time", () => {
    const out = html(three());
    const order = [...out.matchAll(/<time dateTime="\d{4}-\d\d-(\d\d)">[^<]*<\/time><span[^>]*>(\d+:\d{2} [AP]M)</g)].map((m) => `${Number(m[1])} ${m[2]}`);
    expect(order).toEqual(["17 11:00 AM", "10 1:30 PM", "3 9:00 AM"]);
    expect(out).not.toMatch(/>09:00<|>13:30<|>11:00</);
    expect(out).toContain(">Nov 17<"); // within one month the year is left off
  });
  it("the card: the client's name, '<month> · Collected', the total with CAD once beside it, '3 visits · <studio>'; short method words, the bar ABOVE them, no currency suffix", () => {
    const out = html(three(), { studioName: "Studio One" });
    const card = out.slice(out.indexOf('aria-labelledby="cs-summary"'), out.indexOf("</section>", out.indexOf('aria-labelledby="cs-summary"')));
    expect(card).toMatch(/<p class="font-semibold text-fg">Ada Lovelace<\/p><p[^>]*>November 2026 · Collected<\/p>/);
    expect(card).toMatch(/<small[^>]*>CAD<\/small>/);
    expect(card).toContain("3 visits · Studio One");
    expect(card).toMatch(/<span>Card<\/span><span[^>]*>\$120\.00<\/span>/);
    expect(card).toMatch(/<span>E-transfer<\/span><span[^>]*>\$60\.00<\/span>/);
    expect(card.indexOf("h-[7px]")).toBeLessThan(card.indexOf("<span>Card</span>"));
    expect(card).toContain("Collected by method");
    expect(out).not.toContain("How it was paid");
    expect(card).toMatch(/<p class="sr-only">\$180\.00 CAD paid<\/p>|<p class="sr-only">[^<]*paid<\/p>/); // the verified sentence is kept for screen readers
  });
  it("without a studio name the line is only the visit count", () => {
    expect(html(three())).toMatch(/>3 visits<\/p>/);
  });
  it("the collected column carries no currency suffix; the Full payment breakdown keeps the full wording, the balance sentence and the total-spend note", () => {
    const out = html(three());
    const rows = out.slice(out.indexOf('aria-labelledby="cs-visits"'));
    const collected = [...rows.matchAll(/<span class="text-right font-medium tabular-nums[^"]*">([^<]*)<\/span>/g)].map((m) => m[1]);
    expect(collected).toEqual(["$60.00", "$60.00", "$60.00"]);
    const breakdown = out.slice(out.indexOf("Full payment breakdown"), out.indexOf('aria-labelledby="cs-visits"'));
    expect(breakdown).toContain("Card (Hone-verified): session payments");
    expect(breakdown).toMatch(/Balance due/);
    expect(breakdown).toContain("Total spend is money recorded as collected and kept");
    // none of those sit in the card itself any more
    const card = out.slice(out.indexOf('aria-labelledby="cs-summary"'), out.indexOf("Full payment breakdown"));
    expect(card).not.toContain("Total spend is money recorded");
  });
  it("the display order changes NO figure: the total, the visit count and the sentence are identical for any order of the same visits", () => {
    const a = three();
    const b = docFor([...[visit("a3", "2026-11-17", "11:00", { lines: [{ kind: "collected_e_transfer", cents: 6000, source: "settlement" }] }), visit("a2", "2026-11-10", "13:30"), visit("a1", "2026-11-03", "09:00")]]);
    expect(b.totals).toEqual(a.totals);
    expect(html(b)).toBe(html(a));
  });
});

describe("the toolbar and the visits header", () => {
  it("the period toggle reads 'Full history | One month', in that order", () => {
    const out = html(three());
    const nav = out.slice(out.indexOf('aria-label="Statement period"'), out.indexOf("</nav>", out.indexOf('aria-label="Statement period"')));
    expect(nav.indexOf("Full history")).toBeGreaterThan(-1);
    expect(nav.indexOf("Full history")).toBeLessThan(nav.indexOf("One month"));
    expect(nav).toMatch(/aria-current="page"[^>]*>[^]{0,240}?One month/);
  });
  it("'Client visits' with '<scope> · Latest first' has Export CSV and the primary Print beside it (not on the toggle row); no Create invoice", () => {
    const out = html(three());
    const section = out.slice(out.indexOf('aria-labelledby="cs-visits"'));
    const header = section.slice(0, section.indexOf("<div class=\"overflow-hidden"));
    expect(header).toMatch(/>Client visits<\/h2><p[^>]*>November 2026 · Latest first<\/p>/);
    expect(header).toContain("Export CSV");
    expect(header).toMatch(/bg-accent[^>]*><span[^>]*>Print \/ Save as PDF</);
    expect(out.slice(0, out.indexOf('aria-labelledby="cs-visits"'))).not.toContain("Export CSV");
    expect(out).not.toMatch(/Create invoice|Invoice/);
  });
  it("in the full history the header says 'Full history · Latest first' and each date carries its year", () => {
    const hist = docFor([visit("a1", "2026-11-03", "09:00")], { kind: "full_history" });
    const out = html(hist, { view: "history" });
    expect(out).toMatch(/Full history · Latest first/);
    expect(out).toMatch(/>Nov 3, 2026</);
  });
  it("Export CSV is a plain link and Print is the primary link, both to the unchanged routes", () => {
    const out = html(three());
    expect(out).toContain('href="/financials/statements/c1/export.csv?month=2026-11"');
    expect(out).toContain('href="/financials/statements/c1/print?month=2026-11"');
  });
});

describe("a visit row's expander keeps the fee, its basis, and every detail", () => {
  it("Duration, Practitioner, Fee with its basis ('Agreed fee' / 'Charged') and Payment are inside the row's own expander, not in the grid", () => {
    const out = html(three());
    const row = out.slice(out.indexOf('<details class="group'));
    const grid = row.slice(0, row.indexOf("</summary>"));
    const expander = row.slice(row.indexOf("</summary>"), row.indexOf("</details>"));
    expect(grid).not.toMatch(/Agreed fee|Charged|Practitioner One/);
    expect(expander).toMatch(/<dt[^>]*>Duration<\/dt><dd>60 min<\/dd>/);
    expect(expander).toMatch(/Practitioner One/);
    expect(expander).toMatch(/<dt[^>]*>Fee<\/dt><dd>\$60\.00 CAD · (Agreed fee|Charged)/);
    expect(expander).toMatch(/Payment/);
  });
  it("a visit with no collected money shows a dash read aloud as 'No amount', never a $0.00", () => {
    const unpaid = docFor([visit("a9", "2026-11-19", "09:00", { lines: [] })]);
    const out = html(unpaid);
    expect(out).toMatch(/<span aria-hidden="true">—<\/span><span class="sr-only">No amount<\/span>/);
    expect(out.slice(out.indexOf('aria-labelledby="cs-visits"'))).not.toMatch(/>\$0\.00</);
  });
});

describe("the print page and the CSV keep the document's own order and 24-hour times", () => {
  it("DELIBERATE CHANGE: the print page now lists visits LATEST FIRST with 12-hour times (it was oldest first, 24-hour); the document's own order is untouched", () => {
    const doc = three();
    const before = doc.visits.map((v) => v.appointmentId);
    const out = renderToStaticMarkup(createElement(StatementPrintView as never, { document: doc, offDocumentWithMoney: 0, backHref: "/x", format: fmt }));
    const rows = [...out.matchAll(/<td class="py-1 pr-3"><span class="block">Nov (\d+), 2026<\/span><span class="block text-fg-muted">(\d+:\d{2} [AP]M)<\/span>/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(rows).toEqual(["17 11:00 AM", "10 1:30 PM", "3 9:00 AM"]);
    expect(doc.visits.map((v) => v.appointmentId)).toEqual(before);
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
  it("the client statement page hands the view the studio's name (source guard)", () => {
    const src = readFileSync("app/(app)/financials/statements/[clientId]/page.tsx", "utf8");
    expect(src).toContain("studioName={studio.name}");
  });
  it("the client statement page loads the finder after its owner gate, like the Studio page", () => {
    const src = readFileSync("app/(app)/financials/statements/[clientId]/page.tsx", "utf8").replace(/\/\/.*$/gm, "");
    const gate = src.indexOf('practitioner.role !== "owner"');
    const call = src.indexOf("await loadFinderState(");
    expect(gate).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(gate);
    // The statement itself is read only after the gate too. The page times the read, so the call is `await loadOwnerClientStatement(` or the same inside `timed("...", () => ...)`; either form is accepted, and the call must be awaited.
    const load = /await (?:timed\("[a-z.-]+", \(\) => )?loadOwnerClientStatement\(/.exec(src);
    expect(load, "the statement read is awaited, directly or inside timed()").not.toBeNull();
    expect((load as RegExpExecArray).index).toBeGreaterThan(gate);
    expect(src.match(/loadOwnerClientStatement\(/g), "exactly one call of the statement read").toHaveLength(1);
  });
});

describe("the print paper follows the approved hierarchy and keeps what must stay", () => {
  const paper = (d = three(), over = {}) => renderToStaticMarkup(createElement(StatementPrintView as never, { document: d, offDocumentWithMoney: 0, backHref: "/x", format: fmt, timezone: "America/Toronto", currency: "cad", monthLabel: "November 2026", ...over }));
  it("title 'Client statement', then the client, the month, 'N visits · Toronto time · CAD', and 'Collected $X, Refunded and Net' with the currency only in the header line", () => {
    const out = paper();
    expect(out).toMatch(/<h1[^>]*>Client statement<\/h1><h2[^>]*>Ada Lovelace<\/h2><p[^>]*>November 2026<\/p><p[^>]*>3 visits · Toronto time · CAD<\/p>/);
    expect(out).toMatch(/Collected \$180\.00</);
    const table = out.slice(out.indexOf("<table"), out.indexOf("</table>"));
    expect(table).not.toContain("CAD");
  });
  it("KEEPS the 'Statement — not an invoice' line, the prepared-by line and the prepared date, inside the statement's own header", () => {
    const out = paper();
    expect(out).toMatch(/<header data-statement-header[^>]*>[\s\S]*Statement — not an invoice[\s\S]*Ada Lovelace[\s\S]*Prepared by Hone for Studio One[\s\S]*Prepared Nov 19, 2026[\s\S]*<\/header>/);
  });
  it("four columns: Date & time (two lines), Visit (service · minutes, then the practitioner), Payment details, Paid", () => {
    const out = paper();
    const heads = [...out.matchAll(/<th scope="col"[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
    expect(heads).toEqual(["Date &amp; time", "Visit", "Payment details", "Paid"]);
    expect(out).toContain("Service A · 60 min");
    expect(out).toContain("Practitioner One");
    expect(out).toMatch(/Card · Collected · \$60\.00/);
    expect(out).toMatch(/E-transfer · Collected · \$60\.00/);
  });
  it("a visit with no payment says so, a dash is its Paid cell, and its status word is kept; a still-owing note keeps its full wording", () => {
    const d = docFor([visit("a1", "2026-11-03", "09:00", { lines: [] }), visit("a2", "2026-11-04", "09:00", { lines: [{ kind: "still_owes_note", cents: null, source: "settlement" }] })]);
    const out = paper(d);
    expect(out).toContain("No payment recorded");
    expect(out).toContain("Marked still owing (a note, not an amount)");
    expect(out).toMatch(/<td class="py-1 text-right tabular-nums">—<\/td>/);
    expect(out).toMatch(/Not paid|Payment not confirmed/);
  });
  it("keeps the verified paid sentence, the balance rule and the awaiting line, so no status is lost from the paper", () => {
    const d = docFor([visit("a1", "2026-11-03", "09:00"), visit("a2", "2026-11-19", "09:00", { lines: [] })]);
    const out = paper(d);
    expect(out).toMatch(/\$60\.00 CAD paid · 1 visit awaiting payment confirmation|\$60\.00 paid · 1 visit awaiting payment confirmation/);
    expect(out).toMatch(/Balance due is not shown yet/);
    expect(out).not.toMatch(/Balance due \$/);
    expect(out).toMatch(/Nov 19, 2026 · \$60\.00( CAD)? agreed fee · No payment recorded/);
  });
  it("G1: the paper's Paid cell is EXACTLY the money collected on that visit: one line, split lines summed, and refunded, waived, still-owing and unresolved lines never added", () => {
    const d = docFor([
      visit("a1", "2026-11-03", "09:00", { lines: [{ kind: "collected_card_session", cents: 6000, source: "card" }] }),
      visit("a2", "2026-11-04", "09:00", { lines: [{ kind: "collected_card_session", cents: 4000, source: "card" }, { kind: "collected_cash", cents: 2500, source: "settlement" }, { kind: "refunded_card_session", cents: 1000, source: "card" }, { kind: "waived", cents: 700, source: "settlement" }] }),
    ]);
    const out = paper(d);
    const cells = [...out.matchAll(/<td class="py-1 text-right tabular-nums">([^<]*)<\/td>/g)].map((m) => m[1]);
    // latest first: the split visit (4000 + 2500 = 6500) then the single one (6000)
    expect(cells).toEqual(["$65.00", "$60.00"]);
  });
  it("G2: a line that is not collected money (pending, failed or test mode) is never printed on the paper, in its words or its amount", () => {
    const d = docFor([visit("a1", "2026-11-03", "09:00", { lines: [{ kind: "collected_card_session", cents: 6000, source: "card" }, { kind: "excluded", cents: 9900, source: "card" }] })]);
    const out = paper(d);
    expect(out).not.toContain("Not collected money");
    expect(out).not.toContain("$99.00");
    expect(out).toMatch(/Card · Collected · \$60\.00/);
  });
  it("without a timezone or currency the header line states only what it knows (never a guessed zone)", () => {
    const out = paper(three(), { timezone: null, currency: null });
    expect(out).toMatch(/<p[^>]*>3 visits<\/p>/);
    expect(out).not.toMatch(/time ·|· CAD/);
  });
  it("the print page route hands the paper the studio timezone and currency (source guard)", () => {
    const src = readFileSync("app/(app)/financials/statements/[clientId]/print/page.tsx", "utf8");
    expect(src).toContain("timezone={studio.timezone}");
    expect(src).toContain("currency={result.currency}");
  });
  it("the CSV is untouched: its route and builder are not part of this change (source guard on the fixed header and the document order)", () => {
    const csv = readFileSync("lib/finance/statement-csv.ts", "utf8");
    expect(csv).not.toMatch(/latestFirst|formatClock12h/);
  });
});


// Sam's acceptance (HON-123 / HON-122): the $225 split ($100 card, $50 cash, $75 transfer, then a $40 partial card refund) reads Collected $225.00, Refunded $40.00, Net $185.00
// on the statement and its print paper, with the same labels checkout and the visit page use.
describe("Collected / Refunded / Net on the statement and its print paper", () => {
  const split = () => docFor([visit("s1", "2026-11-17", "11:00", {
    feeCandidates: [{ source: "settlement_quote", cents: 22500 }],
    lines: [
      { kind: "collected_card_session", cents: 10000, source: "card" }, { kind: "collected_cash", cents: 5000, source: "settlement" },
      { kind: "collected_e_transfer", cents: 7500, source: "settlement" }, { kind: "refunded_partial", cents: 4000, source: "ledger" },
    ],
  })]);
  const printed = (d: ReturnType<typeof docFor>) => renderToStaticMarkup(createElement(StatementPrintView as never, { document: d, offDocumentWithMoney: 0, backHref: "/x", format: fmt, timezone: "America/Toronto", currency: "cad", monthLabel: "November 2026" } as never));
  it("the screen: Collected $225.00 large, then Refunded $40.00 and Net $185.00, never 'Total paid'", () => {
    const out = html(split());
    expect(out).toMatch(/November 2026 · Collected</);
    expect(out).toMatch(/data-testid="statement-money-refunded">\$40\.00</);
    expect(out).toMatch(/data-testid="statement-money-net">\$185\.00</);
    expect(out).toMatch(/>\$225\.00</);
    expect(out).not.toContain("Total paid");
  });
  it("the print paper says the same three figures", () => {
    const out = printed(split());
    expect(out).toContain("Collected $225.00");
    expect(out).toContain("Refunded $40.00 · Net $185.00");
  });
  it("a legacy fully refunded card payment: Collected is what was received, Net is zero", () => {
    const out = html(docFor([visit("l1", "2026-11-17", "11:00", { lines: [{ kind: "refunded_card_session", cents: 6000, source: "card" }] })]));
    expect(out).toMatch(/data-testid="statement-money-refunded">\$60\.00</);
    expect(out).toMatch(/data-testid="statement-money-net">\$0\.00</);
    expect(out).toMatch(/>\$60\.00</);
  });
});
