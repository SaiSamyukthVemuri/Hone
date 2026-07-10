import { describe, expect, it } from "vitest";
import { csvCell, rowsToCsv } from "@/lib/csv";

// C13: CSV formula-injection hardening. csvCell must neutralize spreadsheet
// formulas (leading = + - @ TAB CR) so an exported free-text value like
// =HYPERLINK(...) renders as text and never executes, while preserving normal
// text, numbers, and RFC-4180 quoting.
//
// Neutralization = prefix a single quote ('). RFC-4180 quoting (wrapping in
// double quotes) is applied AFTER, and ONLY when the value contains a comma,
// double-quote, CR, or LF — so a formula without those chars gets the ' prefix
// but no surrounding quotes.

describe("csvCell — formula-injection neutralization", () => {
  it("neutralizes =HYPERLINK(...) and RFC-quotes it (has quotes + comma)", () => {
    const out = csvCell('=HYPERLINK("x","y")');
    // '  prefix, wrapped in quotes, embedded quotes doubled.
    expect(out).toBe(`"'=HYPERLINK(""x"",""y"")"`);
  });

  it("neutralizes +SUM(A1:A9) (no comma/quote/newline → prefix only, no wrap)", () => {
    expect(csvCell("+SUM(A1:A9)")).toBe("'+SUM(A1:A9)");
  });

  it("neutralizes -1+2", () => {
    expect(csvCell("-1+2")).toBe("'-1+2");
  });

  it("neutralizes @cmd", () => {
    expect(csvCell("@cmd")).toBe("'@cmd");
  });

  it("neutralizes a TAB-prefixed formula (tab is not an RFC quote trigger)", () => {
    expect(csvCell("\t=1+1")).toBe("'\t=1+1");
  });

  it("neutralizes a CR-prefixed value (CR also forces RFC quoting)", () => {
    expect(csvCell("\r=1+1")).toBe(`"'\r=1+1"`);
  });
});

describe("csvCell — ordinary values are preserved", () => {
  it("leaves ordinary text unchanged", () => {
    expect(csvCell("Chin")).toBe("Chin");
    expect(csvCell("John Doe")).toBe("John Doe");
  });

  it("preserves numbers, including negatives (numeric origin, not neutralized to text)", () => {
    expect(csvCell(42)).toBe("42");
    expect(csvCell(-50)).toBe("-50");
    expect(csvCell(0)).toBe("0");
    expect(csvCell(3.14)).toBe("3.14");
  });

  it("preserves booleans and blanks", () => {
    expect(csvCell(true)).toBe("true");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("preserves Unicode", () => {
    expect(csvCell("café · 日本語 · émoji 🎉")).toBe("café · 日本語 · émoji 🎉");
  });

  it("does not double-mutate an already-safe value (leading apostrophe is not a trigger)", () => {
    expect(csvCell("'already")).toBe("'already");
  });

  it("a mid-string formula char is not neutralized (only leading matters)", () => {
    expect(csvCell("1=2")).toBe("1=2");
    expect(csvCell("a+b")).toBe("a+b");
  });
});

describe("csvCell — RFC-4180 quoting still correct", () => {
  it("quotes commas", () => {
    expect(csvCell("Chin, Jawline")).toBe(`"Chin, Jawline"`);
  });

  it("quotes and doubles embedded quotes", () => {
    expect(csvCell('she said "ok"')).toBe(`"she said ""ok"""`);
  });

  it("quotes newlines", () => {
    expect(csvCell("line1\nline2")).toBe(`"line1\nline2"`);
  });

  it("JSON-encodes arrays/objects (start with [ or { — not a trigger)", () => {
    expect(csvCell(["Chin", "Jaw"])).toBe(`"[""Chin"",""Jaw""]"`);
  });
});

describe("rowsToCsv — end to end", () => {
  it("builds header + rows, neutralizing a malicious cell without breaking columns", () => {
    const csv = rowsToCsv(
      ["name", "note", "minutes"],
      [
        { name: "Ann", note: "ok", minutes: 30 },
        { name: "Eve", note: "=1,2", minutes: -5 },
      ],
    );
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe("name,note,minutes");
    expect(lines[1]).toBe("Ann,ok,30");
    // Malicious note neutralized (' prefix + RFC-quoted for the comma);
    // minutes stays a real negative number.
    expect(lines[2]).toBe(`Eve,"'=1,2",-5`);
    expect(csv.endsWith("\n")).toBe(true);
  });

  it("headers are never treated as formulas (no ordinary header triggers)", () => {
    expect(rowsToCsv(["id", "email"], [])).toBe("id,email\n");
  });
});
