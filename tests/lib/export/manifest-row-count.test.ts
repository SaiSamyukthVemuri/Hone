import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { rowsToCsv } from "@/lib/csv";

// Manifest row counts must be LOGICAL RECORDS, not physical lines.
//
// THE DEFECT THIS REPLACES. The first version of the manifest counted rows by
// splitting the serialized CSV on "\n". That is wrong for this codebase
// specifically: `csvCell` emits RFC-4180 quoted fields that PRESERVE embedded
// CR/LF, so one multiline clinical note, session note or free-text comment is a
// SINGLE record spanning several physical lines. Every file containing a
// multiline note was over-reported — in the one artifact whose whole job is to
// tell the owner how much data they actually have.
//
// THE FIX. The export now records `rows.length` from the exact collection handed
// to `rowsToCsv` (see `countedCsv` in the export action), so the count is exact
// by construction and needs no parser in production.
//
// WHAT THESE TESTS DO. They prove the serialized file AGREES with that number:
// a correct RFC-4180 reader over the real `rowsToCsv` output must find exactly
// `rows.length` records, for every nasty value the product can store. The
// parser lives here, in the test — production does not need one.

const REPO = path.resolve(__dirname, "../../..");

/** Minimal RFC-4180 record counter: quote-aware, CRLF-aware. Test-only. */
function countCsvRecords(text: string): number {
  let records = 0;
  let inQuotes = false;
  let sawContent = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        // Doubled quote is an escaped literal, not the end of the field.
        if (text[i + 1] === '"') i++;
        else inQuotes = false;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      sawContent = true;
      continue;
    }
    if (ch === "\r" && text[i + 1] === "\n") {
      records++;
      sawContent = false;
      i++;
      continue;
    }
    if (ch === "\n") {
      records++;
      sawContent = false;
      continue;
    }
    sawContent = true;
  }
  if (sawContent) records++; // final record with no trailing newline
  return records;
}

/** Records excluding the header — what the manifest reports. */
function countDataRecords(csv: string): number {
  return Math.max(0, countCsvRecords(csv) - 1);
}

const HEADERS = ["id", "body"] as const;
const csvFor = (rows: Array<Record<string, unknown>>) =>
  rowsToCsv(HEADERS as unknown as string[], rows);

describe("one logical record always counts as one", () => {
  const cases: Array<{ name: string; body: string }> = [
    { name: "plain row", body: "nothing special" },
    { name: "comma", body: "chin, upper lip, and jawline" },
    { name: "embedded double quote", body: 'client said "it stings"' },
    { name: "embedded LF", body: "line one\nline two" },
    { name: "embedded CRLF", body: "line one\r\nline two" },
    { name: "bare CR", body: "line one\rline two" },
    {
      name: "multiline clinical-note body",
      // The realistic shape: a consultation note typed with paragraph breaks,
      // a comma, and a quoted phrase. Persisted notes are CRLF, not LF.
      body:
        'Consultation 2026-05-02\r\n\r\nGoals: full clearance, chin + neck.\r\n' +
        'Client reports "burning" after the last session, so dropped intensity.\r\n' +
        "Plan: 2-week cadence, reassess in 6 visits.",
    },
  ];

  for (const c of cases) {
    it(`${c.name}: 1 row in, 1 record out`, () => {
      const rows = [{ id: "a", body: c.body }];
      expect(countDataRecords(csvFor(rows))).toBe(rows.length);
    });
  }

  it("all of them together: 7 rows in, 7 records out", () => {
    const rows = cases.map((c, i) => ({ id: `id-${i}`, body: c.body }));
    expect(countDataRecords(csvFor(rows))).toBe(rows.length);
  });

  it("NEGATIVE CONTROL: naive newline splitting over-reports the same file", () => {
    // Exactly what the replaced implementation did. If this ever stops
    // over-counting, the fixture no longer reproduces the defect and the tests
    // above prove nothing.
    const rows = cases.map((c, i) => ({ id: `id-${i}`, body: c.body }));
    const csv = csvFor(rows);
    const naive = Math.max(0, csv.split("\n").filter((l) => l.length > 0).length - 1);
    expect(naive).toBeGreaterThan(rows.length);
    expect(countDataRecords(csv)).toBe(rows.length);
  });

  it("an empty table is zero data records, not minus one", () => {
    expect(countDataRecords(csvFor([]))).toBe(0);
  });
});

describe("the export derives manifest counts from rows, never from bytes", () => {
  const ACTIONS = readFileSync(
    path.join(REPO, "app/(app)/settings/data/actions.ts"),
    "utf8",
  );

  it("counts come from the row collection handed to rowsToCsv", () => {
    expect(ACTIONS).toMatch(/manifestCounts\[name\] = rows\.length;/);
  });

  it("every CSV written goes through the counting wrapper", () => {
    // A file written with a bare rowsToCsv would be missing from the manifest.
    const zipCsvWrites = ACTIONS.match(/zip\.file\(\n\s+[^\n]+,\n\s+countedCsv\(/g) ?? [];
    expect(zipCsvWrites.length).toBe(14);
    // No CSV may bypass it.
    expect(ACTIONS).not.toMatch(/zip\.file\(\n\s+[^\n]+,\n\s+rowsToCsv\(/);
  });

  it("and the export refuses if a CSV was written without a recorded count", () => {
    expect(ACTIONS).toMatch(/was written without a recorded/);
  });

  it("the byte-splitting counter is gone from the shared helper", () => {
    const PAGINATE = readFileSync(
      path.join(REPO, "lib/export/paginate.ts"),
      "utf8",
    );
    expect(PAGINATE).not.toMatch(/csvDataRowCount/);
    expect(PAGINATE).not.toMatch(/split\("\\n"\)/);
  });
});
