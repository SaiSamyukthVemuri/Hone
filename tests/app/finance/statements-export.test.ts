import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { NextRequest } from "next/server";

// The statement CSV route, the shared owner loader and the print view. Synthetic records only; the read layer and identity are mocked, so this
// proves the HANDLER's decisions (who, which client, which selection, what headers, what is never read) rather than the database.
const h = vi.hoisted(() => ({
  who: vi.fn(),
  jurisdiction: vi.fn(),
  read: vi.fn(),
}));
vi.mock("@/lib/supabase/queries", () => ({ getCurrentPractitionerWithStudio: h.who, requirePractitionerWithStudio: h.who }));
vi.mock("@/lib/billing/payment-jurisdiction-server", () => ({ getStudioPaymentJurisdiction: h.jurisdiction }));
vi.mock("@/lib/finance/client-statement-read", () => ({ loadClientStatementRead: h.read }));

import * as csvModule from "@/lib/finance/statement-csv";
import { IdentityRefusalError } from "@/lib/supabase/identity-refusal";
import { GET } from "@/app/(app)/financials/statements/[clientId]/export.csv/route";
import { loadOwnerClientStatement } from "@/lib/finance/owner-client-statement";
import { StatementPrintView, PRINT_CSS } from "@/app/(app)/financials/statements/statement-print-view";
import { buildStatementDocument } from "@/lib/finance/statement-document";
import { statementExportHref, statementPrintHref } from "@/lib/finance/statement-screen";

const ROOT = path.resolve(__dirname, "../../..");
const src = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const CLIENT = "11111111-1111-4111-8111-111111111111";
const studio = { id: "22222222-2222-4222-8222-222222222222", name: "Studio One", timezone: "America/Toronto" };
const owner = { practitioner: { id: "p1", role: "owner" }, studio };
const staff = { practitioner: { id: "p2", role: "practitioner" }, studio };

const visit = (over = {}) => ({
  appointmentId: "a1", clientId: CLIENT, startsAt: "2026-11-03T15:00:00Z", localDate: "2026-11-03", localTime: "10:00", serviceName: "Service A", scheduledMinutes: 60,
  practitionerId: "p1", practitionerName: "Practitioner One", eligibility: "treatment", feeCandidates: [{ source: "settlement_quote", cents: 6000 }],
  lines: [{ kind: "collected_card_session", cents: 6000, source: "card" }], ...over,
});
const granted = (over = {}) => ({ access: "granted", ok: true, client: { id: CLIENT, name: "Ada Lovelace" }, studioCurrency: "cad", visits: [visit()], feeItems: [], offDocumentWithMoney: 0, ...over });

const call = (qs = "", id = CLIENT) => GET(new NextRequest(`http://localhost/financials/statements/${id}/export.csv${qs}`), { params: Promise.resolve({ clientId: id }) });

beforeEach(() => {
  h.who.mockReset().mockResolvedValue(owner);
  h.jurisdiction.mockReset().mockResolvedValue({ ok: true, jurisdiction: { currency: "cad" } });
  h.read.mockReset().mockResolvedValue(granted());
});

describe("the CSV route", () => {
  it("a non-owner is refused with NOTHING read", async () => {
    h.who.mockResolvedValue(staff);
    const r = await call("?month=2026-11");
    expect(r.status).toBe(403);
    expect(h.jurisdiction).not.toHaveBeenCalled();
    expect(h.read).not.toHaveBeenCalled();
  });
  it("a caller who is refused (signed out, no studio, a studio to choose) is a 403; a FAILED read (database outage) is a 503, not a 403", async () => {
    h.who.mockRejectedValue(new IdentityRefusalError("no-active-practitioner", "none"));
    expect((await call()).status).toBe(403);
    h.who.mockRejectedValue(Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/login;307;" }));
    expect((await call()).status).toBe(403);
    h.who.mockRejectedValue(new Error("connection terminated"));
    const r = await call();
    expect(r.status).toBe(503);
    expect(r.headers.get("cache-control")).toBe("no-store, private");
    expect(h.read).not.toHaveBeenCalled();
  });
  it("a file that cannot be built is a 503, never an unexplained 500", async () => {
    const spy = vi.spyOn(csvModule, "statementCsv").mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const r = await call("?month=2026-11");
    expect(r.status).toBe(503);
    expect(await r.text()).not.toMatch(/boom|Ada/);
    spy.mockRestore();
  });
  it("the file carries the screen's totals, balance and the off-document notice", async () => {
    h.read.mockResolvedValue(granted({ offDocumentWithMoney: 2 }));
    const body = await (await call("?month=2026-11")).text();
    expect(body).toContain("Paid,60.00");
    expect(body).toContain("Visits,1");
    expect(body).toMatch(/Balance,/);
    expect(body).toContain("Note,2 upcoming bookings have payments recorded.");
  });
  it("a client id that is not an id is the same 404 as an unknown client, with nothing read", async () => {
    expect((await call("", "not-a-uuid")).status).toBe(404);
    expect(h.read).not.toHaveBeenCalled();
  });
  it("another studio's client (or none) is a 404, a failed read is a 503, and neither yields a file", async () => {
    h.read.mockResolvedValue({ access: "granted", ok: false, reason: "client_not_found" });
    const nf = await call("?month=2026-11");
    expect(nf.status).toBe(404);
    expect(await nf.text()).not.toMatch(/Ada|Studio One/);
    h.read.mockResolvedValue({ access: "granted", ok: false, reason: "too_many_appointments" });
    expect((await call("?month=2026-11")).status).toBe(503);
    h.read.mockResolvedValue({ access: "refused" });
    expect((await call("?month=2026-11")).status).toBe(503);
  });
  it("a month or view that is present but invalid is a 400 (never silently today's month), with nothing read", async () => {
    for (const qs of ["?month=2026-13", "?month=banana", "?month=2999-01", "?month=2026-11&month=2026-10", "?month=2026-11&view=everything", "?view=a&view=history"]) {
      expect((await call(qs)).status, qs).toBe(400);
    }
    expect(h.read).not.toHaveBeenCalled();
  });
  it("an owner gets the file: text/csv, an attachment named by the month only, never cached, nosniff", async () => {
    const r = await call("?month=2026-11");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(r.headers.get("content-disposition")).toBe('attachment; filename="statement-2026-11.csv"');
    expect(r.headers.get("cache-control")).toBe("no-store, private");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    const bytes = new Uint8Array(await r.clone().arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // the UTF-8 byte order mark (text() would strip it)
    const body = await r.text();
    expect(body.startsWith("Statement — not an invoice\n")).toBe(true);
    expect(body).toContain("Client,Ada Lovelace");
    expect(body).toContain("Selection,November 2026");
    expect(r.headers.get("content-disposition")).not.toMatch(/Ada|Lovelace|Studio|[0-9a-f]{8}-/);
  });
  it("the full history is named full-history and carries Not completed rows; the month does not", async () => {
    h.read.mockResolvedValue(granted({ visits: [visit(), visit({ appointmentId: "a2", eligibility: "not_completed", feeCandidates: [], lines: [], localDate: "2026-11-02" })] }));
    const hist = await call("?month=2026-11&view=history");
    expect(hist.headers.get("content-disposition")).toBe('attachment; filename="statement-full-history.csv"');
    expect(await hist.text()).toContain("Not completed,2026-11-02");
    expect(await (await call("?month=2026-11")).text()).not.toContain("Not completed,");
  });
  it("the file is built from the SAME loader the screen uses, for the client named in the URL only", async () => {
    await call("?month=2026-11");
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.read.mock.calls[0][3]).toBe(CLIENT);
  });
});

describe("the shared owner loader", () => {
  const base = { studio, clientId: CLIENT, monthParam: "2026-11", viewParam: undefined, now: new Date("2026-11-19T18:00:00Z") };
  it("refuses a non-owner before the jurisdiction or the statement is read", async () => {
    const r = await loadOwnerClientStatement({ ...base, practitioner: staff.practitioner } as never);
    expect(r).toMatchObject({ ok: false, refusal: "not_owner" });
    expect(h.jurisdiction).not.toHaveBeenCalled();
    expect(h.read).not.toHaveBeenCalled();
  });
  it("without strict, an invalid month falls back to the current month and says so (the screen's behaviour)", async () => {
    const r = await loadOwnerClientStatement({ ...base, monthParam: "banana", practitioner: owner.practitioner } as never);
    expect(r.ok && r.fellBack && r.month).toBe("2026-11");
  });
  it("is the only place the owner gate precedes every read (source guard)", () => {
    const code = src("lib/finance/owner-client-statement.ts").replace(/\/\/.*$/gm, "");
    const gate = code.indexOf('practitioner.role !== "owner"');
    expect(gate).toBeGreaterThan(-1);
    for (const reader of ["getStudioPaymentJurisdiction(", "loadClientStatementRead("]) expect(code.indexOf(reader)).toBeGreaterThan(gate);
  });
});

const printDoc = (visits: unknown[] = [visit()], scope: unknown = { kind: "month", month: "2026-11" }) => {
  const r = buildStatementDocument({
    studioId: studio.id,
    identity: { studioName: "Studio One", legalEntityName: null, address: null, contactEmail: null },
    client: { id: CLIENT, name: "Ada Lovelace" },
    scope,
    currency: "cad",
    preparedOn: "2026-11-19",
    visits,
  } as never);
  if (!r.ok) throw new Error(r.error);
  return r.document;
};
const fmt = (c: number) => `$${(c / 100).toFixed(2)}`;
const html = (document: ReturnType<typeof printDoc>, off = 0) => renderToStaticMarkup(createElement(StatementPrintView, { document, offDocumentWithMoney: off, backHref: "/back", format: fmt }));

describe("the print view", () => {
  it("carries the fixed not-an-invoice label, the attribution, the client, the selection and the prepared date", () => {
    const out = html(printDoc());
    expect(out).toContain("Statement — not an invoice");
    expect(out).toContain("Prepared by Hone for Studio One");
    expect(out).toContain("Ada Lovelace");
    expect(out).toContain("November 2026");
    expect(out).toMatch(/Prepared Nov 19, 2026/);
  });
  it("says what the screen says: paid summary, the balance omitted with its hint, the awaiting line and the off-document notice", () => {
    const unpaid = visit({ appointmentId: "a2", localDate: "2026-11-07", lines: [] });
    const out = html(printDoc([visit(), unpaid]), 2);
    expect(out).toMatch(/\$60\.00 paid · 1 visit awaiting payment confirmation/);
    expect(out).toMatch(/Balance due is not shown yet/);
    expect(out).toMatch(/Nov 7, 2026 · \$60\.00 agreed fee · No payment recorded/);
    expect(out).toMatch(/2 upcoming bookings have payments recorded/);
    expect(out).not.toMatch(/Balance due \$/);
  });
  it("is one plain table of visits (split payments in one row), Not completed only in the history", () => {
    const split = visit({ lines: [{ kind: "collected_card_session", cents: 4000, source: "card" }, { kind: "collected_cash", cents: 2000, source: "settlement" }] });
    const nc = visit({ appointmentId: "a3", eligibility: "not_completed", feeCandidates: [], lines: [] });
    expect(html(printDoc([split])).match(/<tr /g)?.length).toBe(2);
    expect(html(printDoc([split, nc], { kind: "full_history" }))).toMatch(/never marked completed/);
    expect(html(printDoc([split, nc]))).not.toMatch(/never marked completed/);
  });
  it("hides the app's chrome and its own controls when printed, and shows no internal id or contact detail", () => {
    const out = html(printDoc());
    expect(PRINT_CSS).toMatch(/@media print[\s\S]*header:not\(\[data-statement-header\]\), footer, nav, \[data-print-hide\] \{ display: none !important; \}/);
    // the statement's own header (client name, attribution, selection, prepared date, label) is NOT matched by the hiding rule
    expect(out).toMatch(/<header data-statement-header[^>]*>[\s\S]*Statement — not an invoice[\s\S]*Ada Lovelace[\s\S]*Prepared by Hone for Studio One[\s\S]*<\/header>/);
    expect(PRINT_CSS.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/(^|[\s,{])header\s*[,{]/m); // no bare `header` selector
    expect(out).toContain("data-print-hide");
    expect(out).toContain("Print / Save as PDF");
    const visible = out.replace(/<style>[\s\S]*?<\/style>/, "").replace(/<[^>]*>/g, " ");
    expect(visible).not.toMatch(/a1\b|11111111|@|\+\d{6,}/);
  });
});

describe("links and the client profile", () => {
  it("the export and print hrefs name only the client id, the month and the view", () => {
    expect(statementExportHref(CLIENT, "2026-11", "month")).toBe(`/financials/statements/${CLIENT}/export.csv?month=2026-11`);
    expect(statementExportHref(CLIENT, "2026-11", "history")).toBe(`/financials/statements/${CLIENT}/export.csv?month=2026-11&view=history`);
    expect(statementPrintHref(CLIENT, "2026-11", "month")).toBe(`/financials/statements/${CLIENT}/print?month=2026-11`);
  });
  it("the statement screen offers Export CSV and Print / Save as PDF, and still no Invoice control", () => {
    const view = src("app/(app)/financials/statements/client-statement-view.tsx");
    expect(view).toMatch(/Export CSV/);
    expect(view).toMatch(/Print \/ Save as PDF/);
    expect(view).not.toMatch(/Invoice/);
  });
  it("View statement appears on the client profile for the owner only, and goes to this client's full history", () => {
    const page = src("app/(app)/clients/[id]/page.tsx");
    const at = page.indexOf("View statement");
    expect(at).toBeGreaterThan(-1);
    expect(page.slice(Math.max(0, at - 420), at)).toMatch(/\{isOwner && \(/);
    expect(page.slice(Math.max(0, at - 420), at)).toContain("/financials/statements/${encodeURIComponent(client.id)}?view=history");
    expect(page.match(/View statement/g)?.length).toBe(1);
  });
  it("the new route and page are not given a Cache-Control that allows storing, set no cookies and call nothing external", () => {
    const route = src("app/(app)/financials/statements/[clientId]/export.csv/route.ts").replace(/\/\/.*$/gm, "");
    expect(route).toContain('"Cache-Control": "no-store, private"');
    expect(route).not.toMatch(/Access-Control|set-cookie|cookies\(|fetch\(|console\.|\.insert\(|\.update\(|\.upsert\(|\.delete\(|\.rpc\(/i);
    const print = src("app/(app)/financials/statements/[clientId]/print/page.tsx");
    expect(print).toMatch(/export const dynamic = "force-dynamic"/);
    expect(print.indexOf('practitioner.role !== "owner"')).toBeLessThan(print.indexOf("loadOwnerClientStatement("));
  });
});

describe("print: what a visit's amount is called leaves the app too", () => {
  const card = visit({ appointmentId: "a2", localDate: "2026-11-04", feeCandidates: [{ source: "card_attempt", cents: 7000 }] });
  it("DELIBERATE CHANGE (the paper now follows the approved layout): the print table's last column is 'Paid', the money COLLECTED, so a fee's basis is no longer printed per visit; no amount is ever called 'Agreed fee' unless the awaiting line says so, and a card amount is never 'Agreed fee'", () => {
    const out = html(printDoc([visit(), card]));
    expect(out).toMatch(/>Paid<\/th>/);
    expect(out).not.toMatch(/>Amount<\/th>|>Fee<\/th>/);
    expect(out).not.toMatch(/\$70\.00[^<]{0,12}Agreed fee/);
    expect(out).not.toContain("· Charged"); // the basis wording stays on the screen's expander and in the CSV below
  });
  it("the CSV an owner downloads says the same, row by row", async () => {
    h.read.mockResolvedValue(granted({ visits: [visit(), card] }));
    const text = await (await call()).text();
    expect(text).toMatch(/Agreed fee,60\.00/);
    expect(text).toMatch(/Charged,70\.00/);
    expect(text).not.toMatch(/Fee recorded/);
  });
});
