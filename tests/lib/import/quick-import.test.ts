import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildImportPlan,
  canonicalForHeader,
  clientIdentityKey,
  detectDelimiter,
  groupRows,
  IMPORT_ROW_CAP,
  normalizeEmail,
  normalizePhone,
  parseBooleanLoose,
  parseDateLoose,
  parseDelimited,
  parseImportText,
  toClientInsertFields,
  toMemoryInsertFields,
  templateText,
  validSourceType,
  type ExistingClient,
} from "@/lib/import/quick-import";

// PR #257: Quick Import V1, pure pipeline tests. Heavy here because this is
// where parsing/normalization/grouping/dedup/mapping safety lives; the action
// + e2e prove the owner gate and the real writes.

describe("delimited parsing", () => {
  it("detects TSV (spreadsheet paste) vs CSV", () => {
    expect(detectDelimiter("a\tb\tc\n1\t2\t3")).toBe("\t");
    expect(detectDelimiter("a,b,c\n1,2,3")).toBe(",");
  });

  it("parses the template CSV header + row", () => {
    const grid = parseDelimited(templateText());
    expect(grid[0][0]).toBe("client_name");
    expect(grid[1][0]).toBe("Maya Rodriguez");
  });

  it("parses TSV pasted from a spreadsheet", () => {
    const grid = parseDelimited("client_name\temail\nMaya R\tmaya@x.com");
    expect(grid).toEqual([
      ["client_name", "email"],
      ["Maya R", "maya@x.com"],
    ]);
  });

  it("handles quoted commas and quoted line breaks", () => {
    const grid = parseDelimited(
      'client_name,address\n"Maya, R","1 King St\nSuite 2"',
    );
    expect(grid[1]).toEqual(["Maya, R", "1 King St\nSuite 2"]);
  });

  it("handles escaped quotes and skips blank rows", () => {
    const grid = parseDelimited('client_name\n"Maya ""M"" R"\n\n   \nJordan');
    expect(grid).toEqual([["client_name"], ['Maya "M" R'], ["Jordan"]]);
  });
});

describe("header aliases + unknown columns", () => {
  it("maps common aliases case-insensitively", () => {
    expect(canonicalForHeader("Full Name")).toBe("client_name");
    expect(canonicalForHeader("mobile")).toBe("phone");
    expect(canonicalForHeader("DOB")).toBe("date_of_birth");
    expect(canonicalForHeader("Area Treated")).toBe("treatment_area");
    expect(canonicalForHeader("last treatment date")).toBe("last_visit_date");
    expect(canonicalForHeader("lot")).toBe("probe_lot");
    expect(canonicalForHeader("batch")).toBe("probe_lot");
    expect(canonicalForHeader("notes")).toBe("general_notes");
    expect(canonicalForHeader("history")).toBe("imported_note");
  });

  it("ignores unknown columns safely (reported, not imported)", () => {
    const r = parseImportText("client_name,favourite_colour\nMaya,Blue");
    expect(r.ignoredColumns).toContain("favourite_colour");
    expect(r.rows[0].fields).toEqual({ client_name: "Maya" });
  });

  it("caps the import row count", () => {
    const lines = ["client_name"];
    for (let i = 0; i < IMPORT_ROW_CAP + 50; i++) lines.push(`Client ${i}`);
    const r = parseImportText(lines.join("\n"));
    expect(r.capped).toBe(true);
    expect(r.rows.length).toBe(IMPORT_ROW_CAP);
    expect(r.totalDataRows).toBe(IMPORT_ROW_CAP + 50);
  });
});

describe("value normalization", () => {
  it("normalizes email + phone for matching", () => {
    expect(normalizeEmail("  Maya@Example.COM ")).toBe("maya@example.com");
    expect(normalizePhone("(555) 010-0199")).toBe("5550100199");
  });

  it("parses unambiguous dates and leaves ambiguous ones null", () => {
    expect(parseDateLoose("2024-11-02")).toBe("2024-11-02");
    expect(parseDateLoose("25/12/2024")).toBe("2024-12-25"); // day>12 => D/M/Y
    expect(parseDateLoose("12/25/2024")).toBe("2024-12-25"); // day>12 => M/D/Y
    expect(parseDateLoose("03/04/2024")).toBeNull(); // ambiguous
    expect(parseDateLoose("last spring")).toBeNull();
  });

  it("parses aftercare booleans confidently, else null", () => {
    expect(parseBooleanLoose("yes")).toBe(true);
    expect(parseBooleanLoose("x")).toBe(true);
    expect(parseBooleanLoose("no")).toBe(false);
    expect(parseBooleanLoose("maybe")).toBeNull();
    expect(parseBooleanLoose("")).toBeNull();
  });

  it("coerces unknown source_type to 'other'", () => {
    expect(validSourceType("Jane")).toBe("jane");
    expect(validSourceType("paper card")).toBe("paper_card");
    expect(validSourceType("magic")).toBe("other");
  });
});

describe("row validation", () => {
  it("treats a row with no usable name as an error (not importable)", () => {
    const r = parseImportText("client_name,email\n,nobody@x.com\nMaya,maya@x.com");
    const { groups, errorRows } = groupRows(r.rows);
    expect(errorRows).toHaveLength(1);
    expect(groups).toHaveLength(1);
  });

  it("builds a full name from first_name/last_name when client_name is absent", () => {
    const r = parseImportText("first_name,last_name\nMaya,Rodriguez");
    const { groups } = groupRows(r.rows);
    expect(groups[0].fullName).toBe("Maya Rodriguez");
  });
});

describe("within-file grouping", () => {
  it("groups multiple treatment-area rows for the same client into ONE client", () => {
    const text =
      "client_name,email,treatment_area\n" +
      "Maya R,maya@x.com,Upper lip\n" +
      "Maya R,maya@x.com,Chin\n" +
      "Maya R,maya@x.com,Neck";
    const r = parseImportText(text);
    const { groups } = groupRows(r.rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].rows).toHaveLength(3);
    expect(groups[0].treatmentAreas.sort()).toEqual(["Chin", "Neck", "Upper lip"]);
  });

  it("groups paper-card rows by name when there is no conflicting contact info", () => {
    const text =
      "client_name,treatment_area\nJordan L,Upper lip\nJordan L,Chin";
    const { groups } = groupRows(parseImportText(text).rows);
    expect(groups).toHaveLength(1);
  });

  it("does NOT group same-name rows with conflicting email (no false merge)", () => {
    const text =
      "client_name,email\nAlex P,alex1@x.com\nAlex P,alex2@x.com";
    const { groups } = groupRows(parseImportText(text).rows);
    expect(groups).toHaveLength(2);
  });

  it("does NOT group same-name rows with conflicting DOB", () => {
    const text =
      "client_name,date_of_birth\nAlex P,1990-01-01\nAlex P,1991-02-02";
    const { groups } = groupRows(parseImportText(text).rows);
    expect(groups).toHaveLength(2);
  });
});

describe("existing-client duplicate detection (create-only, never overwrite)", () => {
  const existing: ExistingClient[] = [
    { id: "c-email", name: "Maya R", email: "maya@x.com", phone: null, date_of_birth: null },
    { id: "c-phone", name: "Jordan L", email: null, phone: "555-0100", date_of_birth: null },
    { id: "c-namedob", name: "Alex P", email: null, phone: null, date_of_birth: "1990-01-01" },
    { id: "c-nameonly", name: "Sam T", email: null, phone: null, date_of_birth: null },
  ];

  function planFor(text: string) {
    return buildImportPlan(parseImportText(text), existing);
  }

  it("skips a confident email duplicate by default", () => {
    const plan = planFor("client_name,email\nMaya R,MAYA@x.com");
    expect(plan.groups[0].action).toBe("skip_duplicate");
    expect(plan.groups[0].duplicateOf?.id).toBe("c-email");
    expect(plan.duplicateGroups).toBe(1);
  });

  it("skips a confident phone duplicate by default", () => {
    const plan = planFor("client_name,phone\nJordan L,(555) 010-0\n");
    // phone normalizes to 5550100: matches c-phone 555-0100
    expect(plan.groups[0].action).toBe("skip_duplicate");
    expect(plan.groups[0].duplicateOf?.reason).toMatch(/phone/i);
  });

  it("skips a confident name+DOB duplicate by default", () => {
    const plan = planFor("client_name,date_of_birth\nAlex P,1990-01-01");
    expect(plan.groups[0].action).toBe("skip_duplicate");
    expect(plan.groups[0].duplicateOf?.reason).toMatch(/date of birth/i);
  });

  it("WARNS (does not skip, does not merge) on a name-only match", () => {
    const plan = planFor("client_name,treatment_area\nSam T,Chin");
    expect(plan.groups[0].action).toBe("warning");
    expect(plan.groups[0].duplicateOf?.id).toBe("c-nameonly");
    expect(plan.groups[0].warnings.join(" ")).toMatch(/possible existing client/i);
  });

  it("creates a brand-new client when there is no match", () => {
    const plan = planFor("client_name,email\nNew Person,new@x.com");
    expect(plan.groups[0].action).toBe("create");
    expect(plan.groups[0].duplicateOf).toBeNull();
  });
});

describe("imported_treatment_memories mapping", () => {
  it("maps treatment-memory fields into the insert shape", () => {
    const r = parseImportText(
      "client_name,treatment_area,modality,probe_lot,tolerance,reaction,caution_note,next_visit_note,aftercare_marked,last_visit_date\n" +
        "Maya R,Upper lip,Electrolysis,L-204,4/5,Mild redness,Lower energy,Chin next,yes,2024-11-02",
    );
    const mem = toMemoryInsertFields(r.rows[0], "paper_card");
    expect(mem).not.toBeNull();
    expect(mem!.treatment_area_text).toBe("Upper lip");
    expect(mem!.modality).toBe("Electrolysis");
    expect(mem!.probe_lot).toBe("L-204");
    expect(mem!.tolerance_text).toBe("4/5");
    expect(mem!.reaction_text).toBe("Mild redness");
    expect(mem!.aftercare_marked).toBe(true);
    expect(mem!.occurred_on).toBe("2024-11-02");
    expect(mem!.source_row_number).toBe(1);
    expect(mem!.source_type).toBe("paper_card");
  });

  it("preserves an unparseable visit date as occurred_on_text (warning, not fatal)", () => {
    const r = parseImportText("client_name,treatment_area,last_visit_date\nMaya R,Chin,last spring");
    const mem = toMemoryInsertFields(r.rows[0], "other");
    expect(mem!.occurred_on).toBeNull();
    expect(mem!.occurred_on_text).toBe("last spring");
  });

  it("returns null for a client-only row (no memory created)", () => {
    const r = parseImportText("client_name,email\nMaya R,maya@x.com");
    expect(toMemoryInsertFields(r.rows[0], "other")).toBeNull();
  });

  it("maps client fields to safe columns (general_notes -> notes; no normalized_email)", () => {
    const { groups } = groupRows(
      parseImportText(
        "client_name,email,phone,general_notes\nMaya R,maya@x.com,555,Prefers PM",
      ).rows,
    );
    const c = toClientInsertFields(groups[0]);
    expect(c).toMatchObject({
      name: "Maya R",
      email: "maya@x.com",
      phone: "555",
      notes: "Prefers PM",
    });
    expect(Object.keys(c)).not.toContain("normalized_email");
    expect(Object.keys(c)).not.toContain("id");
  });
});

describe("client identity key is the single source of truth for matching", () => {
  it("prioritizes email > phone > name+DOB > name", () => {
    expect(
      clientIdentityKey({ email: "a@x.com", phone: "555", name: "maya", dateOfBirth: "1990-01-01" }),
    ).toBe("email:a@x.com");
    expect(
      clientIdentityKey({ email: "", phone: "555", name: "maya", dateOfBirth: "1990-01-01" }),
    ).toBe("phone:555");
    expect(
      clientIdentityKey({ email: "", phone: "", name: "maya", dateOfBirth: "1990-01-01" }),
    ).toBe("namedob:maya|1990-01-01");
    expect(
      clientIdentityKey({ email: "", phone: "", name: "maya", dateOfBirth: null }),
    ).toBe("name:maya");
  });

  it("recomputing the key from a group's stored identity matches its group key (the confirm-match invariant)", () => {
    const text =
      "client_name,email,phone,date_of_birth,treatment_area\n" +
      "Maya R,maya@x.com,555-0100,1990-04-12,Upper lip\n" +
      "Jordan L,,555-0200,,Chin\n" +
      "Alex P,,,1985-02-02,Neck\n" +
      "Sam T,,,,Lip";
    const { groups } = groupRows(parseImportText(text).rows);
    for (const g of groups) {
      const recomputed = clientIdentityKey({
        email: g.email,
        phone: g.phone,
        name: g.normalizedName,
        dateOfBirth: g.dateOfBirth,
      });
      expect(recomputed).toBe(g.key);
    }
  });

  it("warns when different names share one contact detail (shared-landline guard)", () => {
    const { groups } = groupRows(
      parseImportText("client_name,phone\nCat A,555-1234\nDog B,(555) 1234").rows,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].warnings.join(" ")).toMatch(/different names share/i);
  });
});

describe("safe wording in the pure module", () => {
  it("uses no clinical-advice or false-assurance wording", () => {
    const SRC = readFileSync(
      path.resolve(__dirname, "../../..", "lib/import/quick-import.ts"),
      "utf8",
    );
    const code = SRC.split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n");
    expect(code).not.toMatch(/\brecommended\b/i);
    expect(code).not.toMatch(/\bdiagnosis\b/i);
    expect(code).not.toMatch(/should treat/i);
    expect(code).not.toMatch(/\bverified\b/i);
    expect(code).not.toMatch(/complete compliance/i);
  });
});
