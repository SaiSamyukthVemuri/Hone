import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CSV_BOM, STATEMENT_CSV_COLUMNS, statementCsvLine, STATEMENT_NOT_AN_INVOICE, decimalAmount, scopeLabel, statementCsv, statementCsvFileName, statementCsvLines } from "@/lib/finance/statement-csv";
import { buildStatementDocument, type BuildDocumentInput, type DocumentVisitInput } from "@/lib/finance/statement-document";

// Synthetic records only.
const ROOT = path.resolve(__dirname, "../../..");
let n = 0;
const visit = (over: Partial<DocumentVisitInput> = {}): DocumentVisitInput => {
  n += 1;
  return {
    appointmentId: `appt-SECRET-${n}`,
    clientId: "client-SECRET-1",
    startsAt: "2026-11-03T15:00:00Z",
    localDate: "2026-11-03",
    localTime: "10:00",
    serviceName: "Service A",
    scheduledMinutes: 60,
    practitionerId: `prac-SECRET-${n}`,
    practitionerName: "Practitioner One",
    eligibility: "treatment",
    feeCandidates: [{ source: "settlement_quote", cents: 6000 }],
    lines: [{ kind: "collected_card_session", cents: 6000, source: "card" }],
    ...over,
  } as DocumentVisitInput;
};
const doc = (visits: DocumentVisitInput[], over: Partial<BuildDocumentInput> = {}) => {
  const r = buildStatementDocument({
    studioId: "studio-SECRET-1",
    identity: { studioName: "Studio One", legalEntityName: null, address: null, contactEmail: null },
    client: { id: "client-SECRET-1", name: "Ada Lovelace" },
    scope: { kind: "month", month: "2026-11" },
    currency: "cad",
    preparedOn: "2026-11-19",
    visits,
    ...over,
  } as BuildDocumentInput);
  if (!r.ok) throw new Error(r.error);
  return r.document;
};
const parse = (csv: string) => csv.replace(CSV_BOM, "").trimEnd().split("\n");

describe("the header block", () => {
  const lines = statementCsvLines(doc([visit()]));
  it("states what the file is NOT, who it is for, the selected client, the selection, the prepared date and the currency", () => {
    expect(lines.slice(0, 7)).toEqual([
      [STATEMENT_NOT_AN_INVOICE],
      ["Prepared by Hone for Studio One"],
      ["Studio", "Studio One"],
      ["Client", "Ada Lovelace"],
      ["Selection", "November 2026"],
      ["Prepared", "2026-11-19"],
      ["Currency", "CAD"],
    ]);
    expect(STATEMENT_NOT_AN_INVOICE).toBe("Statement — not an invoice");
  });
  it("carries the client's name in the header ONLY, never per row", () => {
    const body = lines.slice(9).flat().join("|");
    expect(body).not.toContain("Ada Lovelace");
  });
  it("names the selection: a month, the full history, a range, chosen visits", () => {
    expect(scopeLabel({ kind: "month", month: "2026-11" })).toBe("November 2026");
    expect(scopeLabel({ kind: "full_history" })).toBe("Full history");
    expect(scopeLabel({ kind: "range", startLocal: "2026-10-01", endLocalInclusive: "2026-10-31" })).toBe("2026-10-01 to 2026-10-31");
    expect(scopeLabel({ kind: "visits", appointmentIds: ["a"] })).toBe("1 chosen visit");
    expect(scopeLabel({ kind: "visits", appointmentIds: ["a", "b"] })).toBe("2 chosen visits");
  });
});

describe("money is decimal with a separate currency column", () => {
  it("formats cents as decimals and a missing amount as blank, never zero", () => {
    expect(decimalAmount(6000)).toBe("60.00");
    expect(decimalAmount(5)).toBe("0.05");
    expect(decimalAmount(0)).toBe("0.00");
    expect(decimalAmount(123456)).toBe("1234.56");
    expect(decimalAmount(null)).toBe("");
  });
  it("the columns are named without _cents and end with currency; every data row carries the currency", () => {
    expect([...STATEMENT_CSV_COLUMNS]).toEqual(["row_type", "date", "time", "service", "practitioner", "fee_state", "fee", "state", "reasons", "paid", "refunded", "waived", "owed", "currency"]);
    const rows = statementCsvLines(doc([visit()]));
    const header = rows[8];
    expect(header).toEqual([...STATEMENT_CSV_COLUMNS]);
    const row = rows[9];
    expect(row.length).toBe(header.length);
    expect(row[header.indexOf("paid")]).toBe("60.00");
    expect(row[header.indexOf("fee")]).toBe("60.00");
    expect(row[header.indexOf("currency")]).toBe("CAD");
    expect(parse(statementCsv(doc([visit()])))[9]).toBe("visit,2026-11-03,10:00,Service A,Practitioner One,recorded,60.00,paid,,60.00,0.00,0.00,,CAD");
  });
  it("a visit with no fee record has a blank fee, not 0.00", () => {
    const rows = statementCsvLines(doc([visit({ feeCandidates: [], lines: [] })]));
    expect(rows[9][rows[8].indexOf("fee")]).toBe("");
    expect(rows[9][rows[8].indexOf("fee_state")]).toBe("not_recorded");
  });
});

describe("spreadsheet formulas never run from a name or a title", () => {
  const evil = ['=HYPERLINK("http://x","y")', "+1+1", "-2", "@SUM(A1)", "\tcmd", "\rcmd"];
  it.each(evil)("a client name, studio name and service title beginning %j is neutralised", (e) => {
    const d = doc([visit({ serviceName: e })], { client: { id: "client-SECRET-1", name: e }, identity: { studioName: e, legalEntityName: null, address: null, contactEmail: null } });
    const csv = statementCsv(d);
    // every field that came from a person starts with an apostrophe, so no cell begins with a formula trigger
    for (const line of csv.replace(CSV_BOM, "").split("\n")) for (const cell of line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) expect(cell.replace(/^"/, "")).not.toMatch(/^[=+\-@\t\r]/);
    expect(csv).toContain("'");
  });
  it("commas, quotes and line breaks are quoted per RFC 4180 (the model already folds a name's own line breaks to spaces)", () => {
    const d = doc([visit({ serviceName: "Line one\nLine two" })], { client: { id: "client-SECRET-1", name: 'Lovelace, "Ada"' } });
    const csv = statementCsv(d);
    expect(csv).toContain('Client,"Lovelace, ""Ada"""');
    expect(csv).toContain('"Line one\nLine two"');
  });
});

describe("a negative amount stays a number (so the file sums to the screen), every text cell stays neutralised", () => {
  const money = new Set([1]);
  it("a pure signed decimal in a MONEY column is written plainly; the same text elsewhere is neutralised", () => {
    expect(statementCsvLine(["x", "-60.00"], money)).toBe("x,-60.00");
    expect(statementCsvLine(["x", "60.00"], money)).toBe("x,60.00");
    expect(statementCsvLine(["-60.00", "x"], money)).toBe("'-60.00,x"); // a text column is never exempt
  });
  it("a money cell that is not exactly a signed two-place decimal is still neutralised", () => {
    for (const v of ["-1+1", "=1", "+1.00", "-60", "-60.0", "-60.000", "1e3", "-60.00 ", "=1+1.00", "@SUM(1)", "-.50"]) {
      const out = statementCsvLine(["x", v], money).split(",").slice(1).join(",");
      expect(out.startsWith("'") || !/^[=+\-@\t\r]/.test(out), v).toBe(true);
    }
    expect(statementCsvLine(["x", "-1+1"], money)).toBe("x,'-1+1");
    expect(statementCsvLine(["x", "=1"], money)).toBe("x,'=1");
  });
  it("a refund of -60.00 in a real document is emitted unprefixed, and the parsed file sums to the document's own totals", () => {
    const d = doc([visit(), visit({ localDate: "2026-11-04" })]);
    d.visits[1].refundedCents = -6000;
    const csv = parse(statementCsv(d));
    const head = csv[8].split(",");
    const rows = csv.slice(9).map((l) => l.split(","));
    expect(rows[1][head.indexOf("refunded")]).toBe("-60.00");
    expect(csv.join("\n")).not.toContain("'-60.00");
    const sum = (col: string) => rows.reduce((n, r) => n + Math.round(parseFloat(r[head.indexOf(col)] || "0") * 100), 0);
    expect(sum("paid")).toBe(d.visits.reduce((n, v) => n + v.paidCents, 0));
    expect(sum("refunded")).toBe(d.visits.reduce((n, v) => n + v.refundedCents, 0));
    expect(sum("paid")).toBe(d.totals.paidCents);
  });
  it("names, reasons and service titles that look like numbers or formulas are still neutralised in the real file", () => {
    const d = doc([visit({ serviceName: "-60.00" })], { client: { id: "client-SECRET-1", name: "=1" } });
    const csv = statementCsv(d);
    expect(csv).toContain("Client,'=1");
    expect(csv).toContain(",'-60.00,"); // the service column
  });
});

describe("what the file never carries", () => {
  it("no internal id of a client, studio, appointment or practitioner leaves the file", () => {
    const csv = statementCsv(doc([visit(), visit({ eligibility: "not_completed", feeCandidates: [], lines: [] })], { scope: { kind: "full_history" } }));
    expect(csv).not.toMatch(/SECRET|appt-|prac-|client-S|studio-S/);
  });
  it("Not completed rows appear in the full-history file only, with no amounts", () => {
    const nc = visit({ eligibility: "not_completed", feeCandidates: [], lines: [], localDate: "2026-11-02" });
    const history = parse(statementCsv(doc([visit(), nc], { scope: { kind: "full_history" } })));
    expect(history.some((l) => l.startsWith("not_completed,2026-11-02"))).toBe(true);
    const month = parse(statementCsv(doc([visit(), nc])));
    expect(month.some((l) => l.startsWith("not_completed"))).toBe(false);
    const ncRow = statementCsvLines(doc([nc], { scope: { kind: "full_history" } })).find((r) => r[0] === "not_completed")!;
    const h = [...STATEMENT_CSV_COLUMNS];
    for (const c of ["fee", "paid", "refunded", "waived", "owed"]) expect(ncRow[h.indexOf(c)]).toBe("");
  });
  it("split payments, an unpaid visit and its reasons are each one row", () => {
    const split = visit({ lines: [{ kind: "collected_card_session", cents: 4000, source: "card" }, { kind: "collected_cash", cents: 2000, source: "settlement" }] });
    const unpaid = visit({ lines: [], localDate: "2026-11-07" });
    const rows = statementCsvLines(doc([split, unpaid])).slice(9);
    expect(rows).toHaveLength(2);
    expect(rows[0][[...STATEMENT_CSV_COLUMNS].indexOf("paid")]).toBe("60.00");
    expect(rows[1][[...STATEMENT_CSV_COLUMNS].indexOf("state")]).toBe("unknown");
    // the reasons are the screen's plain words, never the model's enum names
    const reasons = rows[1][[...STATEMENT_CSV_COLUMNS].indexOf("reasons")];
    expect(reasons).toBe("No payment recorded");
    expect(reasons).not.toMatch(/_/);
  });
});

describe("the file name and encoding", () => {
  it("the name is the month or full-history only", () => {
    expect(statementCsvFileName({ kind: "month", month: "2026-11" })).toBe("statement-2026-11.csv");
    expect(statementCsvFileName({ kind: "full_history" })).toBe("statement-full-history.csv");
    expect(statementCsvFileName({ kind: "visits", appointmentIds: ["x"] })).toBe("statement-chosen-visits.csv");
  });
  it("starts with a UTF-8 byte order mark so a spreadsheet reads accented names, and ends with a newline", () => {
    const csv = statementCsv(doc([visit()], { client: { id: "client-SECRET-1", name: "Zoë Núñez" } }));
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv.endsWith("\n")).toBe(true);
    expect(csv).toContain("Zoë Núñez");
  });
});

describe("source guard: the serializer is pure", () => {
  it("imports only the CSV helper, the document model and the period helper; no I/O, clock or request", () => {
    const src = readFileSync(path.join(ROOT, "lib/finance/statement-csv.ts"), "utf8").replace(/\/\/.*$/gm, "");
    const imports = [...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1]).sort();
    expect(imports).toEqual(["@/lib/csv", "@/lib/finance/statement-document", "@/lib/finance/statement-period"]);
    expect(src).not.toMatch(/Date\.now|new Date|fetch\(|process\.env|supabase|cookies\(|headers\(/);
  });
});
