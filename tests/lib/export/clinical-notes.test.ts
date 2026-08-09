import { describe, expect, it } from "vitest";
import {
  buildClinicalNoteExportRows,
  CLINICAL_NOTES_CSV_HEADERS,
  type ClinicalNoteExportSource,
} from "@/lib/export/clinical-notes";
import { rowsToCsv } from "@/lib/csv";

// `client_clinical_notes` (0126/0127) is the authoritative append-only store
// for the consultation and skin/hair-analysis narrative. It was visible and
// printable in the product but absent from the studio export — a records
// portability defect.
//
// These tests drive the REAL builder and the REAL rowsToCsv chokepoint, then
// parse the emitted CSV back with an independent RFC-4180 reader. A source
// grep could not prove that a note containing a comma, a quotation mark and a
// line break survives a round trip; this does.

// A deliberately independent RFC-4180 parser. Written here rather than reusing
// any project helper so the test cannot pass by sharing a bug with the writer.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let inQuotes = false;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const MAPS = {
  clientNameById: new Map([
    ["client-1", "Avery Stone"],
    ["client-2", "Blake Rivers"],
  ]),
  practitionerNameById: new Map([
    ["prac-1", "Dana Reyes"],
    ["prac-2", "Sam Ellis"],
  ]),
};

function note(over: Partial<ClinicalNoteExportSource> = {}): ClinicalNoteExportSource {
  return {
    id: "note-1",
    client_id: "client-1",
    practitioner_id: "prac-1",
    kind: "consultation",
    body: "Initial consultation. Discussed expectations.",
    areas: [],
    occurred_at: "2026-08-01T10:00:00.000Z",
    supersedes_note_id: null,
    created_at: "2026-08-01T10:05:00.000Z",
    ...over,
  };
}

/** Emit through the real writer and read back as a record per row. */
function roundTrip(
  notes: ReadonlyArray<ClinicalNoteExportSource>,
): Record<string, string>[] {
  const csv = rowsToCsv(
    CLINICAL_NOTES_CSV_HEADERS,
    buildClinicalNoteExportRows(notes, MAPS),
  );
  const [header, ...body] = parseCsv(csv);
  expect(header).toEqual([...CLINICAL_NOTES_CSV_HEADERS]);
  return body.map((cells) =>
    Object.fromEntries(header.map((h, i) => [h, cells[i]])),
  );
}

describe("clinical notes export — both kinds are present and distinct", () => {
  it("(1) a consultation note is exported", () => {
    const [row] = roundTrip([note({ kind: "consultation" })]);
    expect(row.kind).toBe("consultation");
    expect(row.body).toBe("Initial consultation. Discussed expectations.");
  });

  it("(2) a skin/hair analysis is exported", () => {
    const [row] = roundTrip([
      note({ id: "note-2", kind: "skin_hair_analysis", body: "Fitzpatrick III." }),
    ]);
    expect(row.kind).toBe("skin_hair_analysis");
    expect(row.body).toBe("Fitzpatrick III.");
  });

  it("(3) the two kinds stay distinct rows — neither absorbs the other", () => {
    const rows = roundTrip([
      note({ id: "a", kind: "consultation", body: "consult body" }),
      note({ id: "b", kind: "skin_hair_analysis", body: "analysis body" }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.kind).sort()).toEqual([
      "consultation",
      "skin_hair_analysis",
    ]);
    expect(rows.find((r) => r.id === "a")!.body).toBe("consult body");
    expect(rows.find((r) => r.id === "b")!.body).toBe("analysis body");
  });
});

describe("clinical notes export — history, not a snapshot", () => {
  it("(4) every revision is retained, not just the newest", () => {
    // Three generations of the same consultation. An export that kept only the
    // current one would silently discard clinical history the append-only
    // table deliberately preserves.
    const rows = roundTrip([
      note({ id: "v3", body: "third", supersedes_note_id: "v2" }),
      note({ id: "v2", body: "second", supersedes_note_id: "v1" }),
      note({ id: "v1", body: "first", supersedes_note_id: null }),
    ]);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.body)).toEqual(["third", "second", "first"]);
  });

  it("(5) supersession lineage survives, so the chain is reconstructable", () => {
    const rows = roundTrip([
      note({ id: "v3", supersedes_note_id: "v2" }),
      note({ id: "v2", supersedes_note_id: "v1" }),
      note({ id: "v1", supersedes_note_id: null }),
    ]);
    const bySupersedes = Object.fromEntries(
      rows.map((r) => [r.id, r.supersedes_note_id]),
    );
    expect(bySupersedes).toEqual({ v3: "v2", v2: "v1", v1: "" });
    // Walk the chain back to its root using only exported columns.
    let cur = "v3";
    const chain = [cur];
    while (bySupersedes[cur]) {
      cur = bySupersedes[cur];
      chain.push(cur);
    }
    expect(chain).toEqual(["v3", "v2", "v1"]);
  });

  it("occurred_at and created_at are BOTH exported — backdating stays visible", () => {
    const [row] = roundTrip([
      note({
        occurred_at: "2026-07-01T09:00:00.000Z",
        created_at: "2026-08-01T17:30:00.000Z",
      }),
    ]);
    expect(row.occurred_at).toBe("2026-07-01T09:00:00.000Z");
    expect(row.created_at).toBe("2026-08-01T17:30:00.000Z");
    expect(row.occurred_at).not.toBe(row.created_at);
  });
});

describe("clinical notes export — safe serialization of free text", () => {
  it("(6) commas, quotes and newlines round-trip byte-exactly", () => {
    const nasty =
      'Client said "it stings, a lot".\nPlan: reduce intensity, re-assess.\r\nNotes: 3,000 hairs; "sensitive" zones.';
    const [row] = roundTrip([note({ body: nasty })]);
    expect(row.body).toBe(nasty);
  });

  it("a formula-triggering note body is neutralized but still readable", () => {
    // OWASP CSV injection: the value must not execute in a spreadsheet, and
    // lib/csv.ts guards it with a leading apostrophe. The content itself is
    // preserved — nothing is dropped.
    const evil = '=HYPERLINK("http://evil","click")';
    const csv = rowsToCsv(
      CLINICAL_NOTES_CSV_HEADERS,
      buildClinicalNoteExportRows([note({ body: evil })], MAPS),
    );
    // Asserted on the PARSED cell, not the raw text: the cell also contains
    // commas and quotes, so RFC-4180 wraps it and doubles the inner quotes —
    // a raw substring match would be testing the quoting, not the guard.
    const [, first] = parseCsv(csv);
    const bodyIdx = CLINICAL_NOTES_CSV_HEADERS.indexOf("body");
    expect(first[bodyIdx]).toBe(`'${evil}`);
    expect(first[bodyIdx]).not.toBe(evil);
    expect(first[bodyIdx].startsWith("'=")).toBe(true);
  });

  it("areas serialize losslessly and never leak into the next column", () => {
    const [row] = roundTrip([
      note({ areas: ["upper_lip", "chin"], body: "body, with comma" }),
    ]);
    expect(JSON.parse(row.areas)).toEqual(["upper_lip", "chin"]);
    expect(row.body).toBe("body, with comma");
    expect(row.occurred_at).toBe("2026-08-01T10:00:00.000Z");
  });

  it("a multi-line body does not break the row count", () => {
    const rows = roundTrip([
      note({ id: "a", body: "line one\nline two\nline three" }),
      note({ id: "b", body: "plain" }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0].body.split("\n")).toHaveLength(3);
  });
});

describe("clinical notes export — attribution and honesty", () => {
  it("author and client are resolved to readable names beside their IDs", () => {
    const [row] = roundTrip([
      note({ client_id: "client-2", practitioner_id: "prac-2" }),
    ]);
    expect(row.client_id).toBe("client-2");
    expect(row.client_name).toBe("Blake Rivers");
    expect(row.practitioner_id).toBe("prac-2");
    expect(row.practitioner_display_name).toBe("Sam Ellis");
  });

  it("an unresolvable author keeps the ID and blanks the name — never drops the row", () => {
    const rows = roundTrip([note({ practitioner_id: "prac-gone" })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].practitioner_id).toBe("prac-gone");
    expect(rows[0].practitioner_display_name).toBe("");
  });

  it("(9) no rows in means a header-only file — never a fake empty row", () => {
    const csv = rowsToCsv(CLINICAL_NOTES_CSV_HEADERS, buildClinicalNoteExportRows([], MAPS));
    expect(csv).toBe(`${CLINICAL_NOTES_CSV_HEADERS.join(",")}\n`);
    expect(parseCsv(csv)).toHaveLength(1);
  });

  it("(8) the builder filters NOTHING — the table has no soft-delete to honour", () => {
    // sessions.csv filters `deleted_at is null`; client_clinical_notes has no
    // such column (0126 is append-only), so exporting every row IS the existing
    // policy applied honestly rather than a widening of it.
    const input = [
      note({ id: "a" }),
      note({ id: "b", kind: "skin_hair_analysis" }),
      note({ id: "c", supersedes_note_id: "a" }),
    ];
    const out = buildClinicalNoteExportRows(input, MAPS);
    expect(out).toHaveLength(input.length);
    expect(out.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("row order is preserved exactly as queried", () => {
    const rows = roundTrip([
      note({ id: "x", occurred_at: "2026-08-03T00:00:00.000Z" }),
      note({ id: "y", occurred_at: "2026-08-02T00:00:00.000Z" }),
      note({ id: "z", occurred_at: "2026-08-01T00:00:00.000Z" }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(["x", "y", "z"]);
  });
});
