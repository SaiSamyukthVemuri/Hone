// PR #257: Quick Import V1, the PURE parse → normalize → group → plan →
// map pipeline for CSV/TSV client + treatment-history import. No I/O, no
// Supabase, no dates-from-now, no randomness: everything here is a
// deterministic data transform so the rules are unit-tested directly. The
// owner gate and the DB writes live in app/(app)/settings/import/actions.ts.
//
// Safety posture baked in here:
//   * imported rows are HISTORY, never live charting (the action writes only
//     imported_treatment_memories, never sessions/appointments).
//   * create-only: duplicate clients are SKIPPED, never overwritten/merged.
//   * never false-merge: rows are grouped only by a confident identity key;
//     same-name rows with conflicting contact/DOB stay separate.
//   * the raw pasted text is parsed transiently and never returned/stored.

import type { ImportSourceType } from "@/lib/types/database";

export const IMPORT_SOURCE_TYPES: readonly ImportSourceType[] = [
  "paper_card",
  "jane",
  "fresha",
  "spreadsheet",
  "other",
];

// Safety cap so a giant accidental paste can't create an unbounded import.
export const IMPORT_ROW_CAP = 2000;

// --- Canonical columns ------------------------------------------------------

export type CanonicalField =
  | "client_name"
  | "first_name"
  | "last_name"
  | "phone"
  | "email"
  | "date_of_birth"
  | "address"
  | "emergency_contact_name"
  | "emergency_contact_phone"
  | "allergies"
  | "pronouns"
  | "source_type"
  | "source_system"
  | "treatment_area"
  | "last_visit_date"
  | "occurred_on_text"
  | "modality"
  | "method_or_machine"
  | "probe_type"
  | "probe_size"
  | "probe_lot"
  | "tolerance"
  | "reaction"
  | "caution_note"
  | "next_visit_note"
  | "aftercare_marked"
  | "imported_note"
  | "general_notes";

// The visible, copyable template (one forgiving column set).
export const TEMPLATE_COLUMNS: readonly CanonicalField[] = [
  "client_name",
  "phone",
  "email",
  "date_of_birth",
  "address",
  "emergency_contact_name",
  "emergency_contact_phone",
  "source_type",
  "source_system",
  "treatment_area",
  "last_visit_date",
  "modality",
  "method_or_machine",
  "probe_type",
  "probe_size",
  "probe_lot",
  "tolerance",
  "reaction",
  "caution_note",
  "next_visit_note",
  "aftercare_marked",
  "imported_note",
  "general_notes",
];

// Header → canonical. Keys are normalized (lowercase, spaces/underscores/
// hyphens collapsed) so "Client Name", "client-name", "client_name" all map.
const ALIAS_ENTRIES: Record<string, CanonicalField> = {
  client_name: "client_name",
  name: "client_name",
  full_name: "client_name",
  fullname: "client_name",
  client: "client_name",
  first_name: "first_name",
  firstname: "first_name",
  given_name: "first_name",
  last_name: "last_name",
  lastname: "last_name",
  surname: "last_name",
  family_name: "last_name",
  phone: "phone",
  mobile: "phone",
  telephone: "phone",
  tel: "phone",
  cell: "phone",
  phone_number: "phone",
  email: "email",
  email_address: "email",
  date_of_birth: "date_of_birth",
  dob: "date_of_birth",
  birthday: "date_of_birth",
  birthdate: "date_of_birth",
  address: "address",
  emergency_contact_name: "emergency_contact_name",
  emergency_contact: "emergency_contact_name",
  emergency_contact_phone: "emergency_contact_phone",
  emergency_phone: "emergency_contact_phone",
  allergies: "allergies",
  allergy: "allergies",
  pronouns: "pronouns",
  source_type: "source_type",
  source: "source_type",
  source_system: "source_system",
  system: "source_system",
  treatment_area: "treatment_area",
  area: "treatment_area",
  area_treated: "treatment_area",
  treatment: "treatment_area",
  last_visit_date: "last_visit_date",
  last_treatment_date: "last_visit_date",
  visit_date: "last_visit_date",
  treatment_date: "last_visit_date",
  occurred_on_text: "occurred_on_text",
  date_text: "occurred_on_text",
  modality: "modality",
  method_or_machine: "method_or_machine",
  method: "method_or_machine",
  machine: "method_or_machine",
  probe_type: "probe_type",
  probe: "probe_type",
  probe_size: "probe_size",
  probe_lot: "probe_lot",
  lot: "probe_lot",
  batch: "probe_lot",
  lot_number: "probe_lot",
  tolerance: "tolerance",
  reaction: "reaction",
  reaction_notes: "reaction",
  caution_note: "caution_note",
  caution: "caution_note",
  next_visit_note: "next_visit_note",
  next_note: "next_visit_note",
  next_visit: "next_visit_note",
  aftercare_marked: "aftercare_marked",
  aftercare: "aftercare_marked",
  imported_note: "imported_note",
  history: "imported_note",
  notes: "general_notes",
  general_notes: "general_notes",
  note: "general_notes",
};

export function normalizeHeader(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s\-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

export function canonicalForHeader(raw: string): CanonicalField | null {
  return ALIAS_ENTRIES[normalizeHeader(raw)] ?? null;
}

// --- Delimited parsing (small local RFC4180-ish parser; no dependency) ------

// Auto-detect tab vs comma from the first non-empty line (Google Sheets /
// Excel paste is tab-delimited; CSV exports are comma-delimited).
export function detectDelimiter(text: string): "\t" | "," {
  const firstLine = text.split(/\r\n|\r|\n/).find((l) => l.trim().length > 0);
  if (!firstLine) return ",";
  const tabs = (firstLine.match(/\t/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  return tabs > 0 && tabs >= commas ? "\t" : ",";
}

// Parse delimited text into rows of cells. Handles quoted fields with embedded
// delimiters, embedded newlines, and "" escaped quotes. Blank lines (outside
// quotes) are dropped.
export function parseDelimited(text: string, delimiter?: string): string[][] {
  const delim = delimiter ?? detectDelimiter(text);
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    // Drop fully-empty rows (every cell blank after trim).
    if (row.some((c) => c.trim().length > 0)) rows.push(row);
    row = [];
  };

  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === delim) {
      pushField();
      i += 1;
      continue;
    }
    if (ch === "\r") {
      if (text[i + 1] === "\n") i += 1;
      pushRow();
      i += 1;
      continue;
    }
    if (ch === "\n") {
      pushRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  // Trailing field/row (no final newline).
  if (field.length > 0 || row.length > 0) pushRow();
  return rows;
}

// --- Value normalization ----------------------------------------------------

export function normalizeEmail(raw: string | undefined | null): string {
  return (raw ?? "").trim().toLowerCase();
}

// Digits only, for MATCHING (we keep the raw phone for storage). Strips a
// leading country-code differences only loosely: exact-match dedupe within a
// studio is the goal, not canonical E.164.
export function normalizePhone(raw: string | undefined | null): string {
  return (raw ?? "").replace(/\D+/g, "");
}

export function normalizeName(raw: string | undefined | null): string {
  return (raw ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

// Parse a loose date into a clean YYYY-MM-DD when confidently parseable, else
// null. Recognizes ISO (YYYY-MM-DD), and unambiguous D/M/Y or M/D/Y only when
// a component is > 12 (otherwise ambiguous → leave null, keep the text).
export function parseDateLoose(raw: string | undefined | null): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    return toIso(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  }
  const dmy = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})$/);
  if (dmy) {
    const a = Number(dmy[1]);
    const b = Number(dmy[2]);
    let year = Number(dmy[3]);
    if (year < 100) year += year < 50 ? 2000 : 1900;
    // Disambiguate: if first > 12 it must be a day (D/M/Y); if second > 12 it
    // must be a day (M/D/Y). If both <= 12 it's ambiguous → don't guess.
    if (a > 12 && b <= 12) return toIso(year, b, a); // D/M/Y
    if (b > 12 && a <= 12) return toIso(year, a, b); // M/D/Y
    return null; // ambiguous (or invalid) → preserve as text only
  }
  return null;
}

function toIso(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

const TRUE_WORDS = new Set(["true", "yes", "y", "1", "marked", "done", "x"]);
const FALSE_WORDS = new Set(["false", "no", "n", "0", "unmarked", ""]);

// aftercare_marked: only a confident yes/no maps to a boolean; anything else
// is null (unknown), never a false default.
export function parseBooleanLoose(
  raw: string | undefined | null,
): boolean | null {
  const s = (raw ?? "").trim().toLowerCase();
  if (TRUE_WORDS.has(s)) return true;
  if (s.length === 0) return null;
  if (FALSE_WORDS.has(s)) return false;
  return null;
}

export function validSourceType(raw: string | undefined | null): ImportSourceType {
  const s = (raw ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (IMPORT_SOURCE_TYPES as string[]).includes(s)
    ? (s as ImportSourceType)
    : "other";
}

// --- Parse import text into canonical rows -----------------------------------

export type ParsedRow = {
  rowNumber: number; // 1-based source row number (excluding the header)
  fields: Partial<Record<CanonicalField, string>>;
};

export type ParseResult = {
  headers: { raw: string; canonical: CanonicalField | null }[];
  detectedFields: CanonicalField[];
  ignoredColumns: string[];
  rows: ParsedRow[];
  totalDataRows: number;
  capped: boolean;
};

export function parseImportText(text: string): ParseResult {
  const grid = parseDelimited(text);
  if (grid.length === 0) {
    return {
      headers: [],
      detectedFields: [],
      ignoredColumns: [],
      rows: [],
      totalDataRows: 0,
      capped: false,
    };
  }
  const headerCells = grid[0];
  const headers = headerCells.map((raw) => ({
    raw: raw.trim(),
    canonical: canonicalForHeader(raw),
  }));
  const detectedFields = Array.from(
    new Set(
      headers
        .map((h) => h.canonical)
        .filter((c): c is CanonicalField => c !== null),
    ),
  );
  const ignoredColumns = headers
    .filter((h) => h.canonical === null && h.raw.length > 0)
    .map((h) => h.raw);

  const dataRows = grid.slice(1);
  const totalDataRows = dataRows.length;
  const capped = totalDataRows > IMPORT_ROW_CAP;
  const limited = capped ? dataRows.slice(0, IMPORT_ROW_CAP) : dataRows;

  const rows: ParsedRow[] = limited.map((cells, idx) => {
    const fields: Partial<Record<CanonicalField, string>> = {};
    headers.forEach((h, col) => {
      if (!h.canonical) return;
      const value = (cells[col] ?? "").trim();
      if (value.length === 0) return;
      // First non-empty wins if a canonical field appears twice.
      if (fields[h.canonical] === undefined) fields[h.canonical] = value;
    });
    return { rowNumber: idx + 1, fields };
  });

  return {
    headers,
    detectedFields,
    ignoredColumns,
    rows,
    totalDataRows,
    capped,
  };
}

// --- Row identity + grouping -------------------------------------------------

export function rowFullName(fields: Partial<Record<CanonicalField, string>>): string {
  const direct = (fields.client_name ?? "").trim();
  if (direct) return direct;
  const first = (fields.first_name ?? "").trim();
  const last = (fields.last_name ?? "").trim();
  return [first, last].filter(Boolean).join(" ").trim();
}

// A source row carries treatment memory only if at least one history field is
// present (otherwise it's a client-only row → no imported_treatment_memory).
const MEMORY_FIELDS: CanonicalField[] = [
  "treatment_area",
  "last_visit_date",
  "occurred_on_text",
  "modality",
  "method_or_machine",
  "probe_type",
  "probe_size",
  "probe_lot",
  "tolerance",
  "reaction",
  "caution_note",
  "next_visit_note",
  "aftercare_marked",
  "imported_note",
];

export function rowHasMemory(fields: Partial<Record<CanonicalField, string>>): boolean {
  return MEMORY_FIELDS.some((f) => (fields[f] ?? "").trim().length > 0);
}

// Single source of truth for the client identity key, used BOTH to group source
// rows AND (in the import action) to match a bulk-inserted client row back to
// its group. Inputs must be pre-normalized so grouping and matching can never
// diverge. Priority: email > phone > name+DOB > name.
export function clientIdentityKey(parts: {
  email: string;
  phone: string;
  name: string;
  dateOfBirth: string | null;
}): string {
  if (parts.email) return `email:${parts.email}`;
  if (parts.phone) return `phone:${parts.phone}`;
  if (parts.dateOfBirth) return `namedob:${parts.name}|${parts.dateOfBirth}`;
  return `name:${parts.name}`;
}

function identityKey(fields: Partial<Record<CanonicalField, string>>): string {
  return clientIdentityKey({
    email: normalizeEmail(fields.email),
    phone: normalizePhone(fields.phone),
    name: normalizeName(rowFullName(fields)),
    dateOfBirth: parseDateLoose(fields.date_of_birth),
  });
}

export type ClientGroup = {
  key: string;
  fullName: string;
  normalizedName: string;
  email: string; // normalized; "" if none
  phone: string; // normalized; "" if none
  dateOfBirth: string | null; // YYYY-MM-DD
  // First non-empty raw values across the group's rows, for client creation.
  clientFields: Partial<Record<CanonicalField, string>>;
  rows: ParsedRow[];
  treatmentAreas: string[];
  warnings: string[];
};

// Group valid (named) rows by confident identity. Rows with no usable name are
// returned separately as errors. Same-name rows with conflicting email/phone/
// DOB naturally fall into DIFFERENT keys, so they are NEVER auto-merged.
export function groupRows(rows: ParsedRow[]): {
  groups: ClientGroup[];
  errorRows: ParsedRow[];
} {
  const errorRows: ParsedRow[] = [];
  const byKey = new Map<string, ParsedRow[]>();
  for (const row of rows) {
    if (!rowFullName(row.fields)) {
      errorRows.push(row);
      continue;
    }
    const key = identityKey(row.fields);
    const list = byKey.get(key);
    if (list) list.push(row);
    else byKey.set(key, [row]);
  }

  const groups: ClientGroup[] = [];
  for (const [key, groupRowsList] of byKey) {
    const clientFields: Partial<Record<CanonicalField, string>> = {};
    for (const row of groupRowsList) {
      for (const [k, v] of Object.entries(row.fields)) {
        const cf = k as CanonicalField;
        if (clientFields[cf] === undefined && (v ?? "").trim().length > 0) {
          clientFields[cf] = v;
        }
      }
    }
    const fullName = rowFullName(clientFields);
    const treatmentAreas = Array.from(
      new Set(
        groupRowsList
          .map((r) => (r.fields.treatment_area ?? "").trim())
          .filter((a) => a.length > 0),
      ),
    );
    const warnings: string[] = [];
    // Within a confident-identity group, note (do not block) inconsistent
    // secondary contact details so the operator can review.
    const dobs = new Set(
      groupRowsList
        .map((r) => parseDateLoose(r.fields.date_of_birth))
        .filter((d): d is string => d !== null),
    );
    if (dobs.size > 1) {
      warnings.push("Rows for this client have different dates of birth.");
    }
    // A shared email/phone with DIFFERENT names may be two people on one
    // contact detail (e.g. a shared landline). Flag for review, never block.
    const names = new Set(
      groupRowsList
        .map((r) => normalizeName(rowFullName(r.fields)))
        .filter((nm) => nm.length > 0),
    );
    if (names.size > 1) {
      warnings.push(
        "Different names share this contact detail. Review before importing.",
      );
    }

    groups.push({
      key,
      fullName,
      normalizedName: normalizeName(fullName),
      email: normalizeEmail(clientFields.email),
      phone: normalizePhone(clientFields.phone),
      dateOfBirth: parseDateLoose(clientFields.date_of_birth),
      clientFields,
      rows: groupRowsList,
      treatmentAreas,
      warnings,
    });
  }
  return { groups, errorRows };
}

// --- Existing-client duplicate detection + plan ------------------------------

export type ExistingClient = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  date_of_birth: string | null;
};

export type GroupAction = "create" | "skip_duplicate" | "warning";

export type PlannedGroup = {
  key: string;
  fullName: string;
  action: GroupAction;
  // Why it matched an existing client (for confident skip / weak warning).
  duplicateOf: { id: string; reason: string } | null;
  warnings: string[];
  treatmentAreas: string[];
  memoryRowCount: number;
  group: ClientGroup;
};

export type ImportPlan = {
  totalSourceRows: number;
  groupedClients: number;
  readyGroups: number;
  warningGroups: number;
  duplicateGroups: number;
  errorRows: number;
  memoriesToCreate: number;
  detectedFields: CanonicalField[];
  ignoredColumns: string[];
  treatmentAreas: string[];
  capped: boolean;
  totalDataRows: number;
  groups: PlannedGroup[];
  errors: { rowNumber: number }[];
};

function matchExisting(
  group: ClientGroup,
  existing: ExistingClient[],
): { id: string; reason: string; confident: boolean } | null {
  // Confident: email, phone, or name+DOB.
  for (const c of existing) {
    if (group.email && normalizeEmail(c.email) === group.email) {
      return { id: c.id, reason: "Same email", confident: true };
    }
  }
  for (const c of existing) {
    if (group.phone && normalizePhone(c.phone) === group.phone) {
      return { id: c.id, reason: "Same phone", confident: true };
    }
  }
  for (const c of existing) {
    if (
      group.dateOfBirth &&
      normalizeName(c.name) === group.normalizedName &&
      c.date_of_birth === group.dateOfBirth
    ) {
      return { id: c.id, reason: "Same name and date of birth", confident: true };
    }
  }
  // Weak: name only.
  for (const c of existing) {
    if (group.normalizedName && normalizeName(c.name) === group.normalizedName) {
      return { id: c.id, reason: "Same name", confident: false };
    }
  }
  return null;
}

export function buildImportPlan(
  parsed: ParseResult,
  existing: ExistingClient[],
): ImportPlan {
  const { groups, errorRows } = groupRows(parsed.rows);

  const planned: PlannedGroup[] = groups.map((group) => {
    const memoryRowCount = group.rows.filter((r) => rowHasMemory(r.fields)).length;
    const match = matchExisting(group, existing);
    let action: GroupAction = "create";
    let duplicateOf: { id: string; reason: string } | null = null;
    const warnings = [...group.warnings];
    if (match) {
      duplicateOf = { id: match.id, reason: match.reason };
      if (match.confident) {
        action = "skip_duplicate";
      } else {
        action = "warning";
        warnings.push(`Possible existing client (${match.reason.toLowerCase()}).`);
      }
    } else if (warnings.length > 0) {
      action = "warning";
    }
    return {
      key: group.key,
      fullName: group.fullName,
      action,
      duplicateOf,
      warnings,
      treatmentAreas: group.treatmentAreas,
      memoryRowCount,
      group,
    };
  });

  const treatmentAreas = Array.from(
    new Set(planned.flatMap((p) => p.treatmentAreas)),
  );
  const memoriesToCreate = planned
    .filter((p) => p.action !== "skip_duplicate")
    .reduce((sum, p) => sum + p.memoryRowCount, 0);

  return {
    totalSourceRows: parsed.rows.length,
    groupedClients: planned.length,
    readyGroups: planned.filter((p) => p.action === "create").length,
    warningGroups: planned.filter((p) => p.action === "warning").length,
    duplicateGroups: planned.filter((p) => p.action === "skip_duplicate").length,
    errorRows: errorRows.length,
    memoriesToCreate,
    detectedFields: parsed.detectedFields,
    ignoredColumns: parsed.ignoredColumns,
    treatmentAreas,
    capped: parsed.capped,
    totalDataRows: parsed.totalDataRows,
    groups: planned,
    errors: errorRows.map((r) => ({ rowNumber: r.rowNumber })),
  };
}

// --- Insert-shape mapping (ids injected by the action) ----------------------

export type ClientInsertFields = {
  name: string;
  email: string | null;
  phone: string | null;
  date_of_birth: string | null;
  address: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  allergies: string | null;
  pronouns: string | null;
  notes: string | null;
};

function orNull(v: string | undefined): string | null {
  const t = (v ?? "").trim();
  return t.length > 0 ? t : null;
}

// Map a group to the safe client-insert fields. date_of_birth is the cleanly
// parsed value (null if it could not be parsed. We never store a bad date).
export function toClientInsertFields(group: ClientGroup): ClientInsertFields {
  const f = group.clientFields;
  return {
    name: group.fullName,
    email: orNull(f.email),
    phone: orNull(f.phone),
    date_of_birth: group.dateOfBirth,
    address: orNull(f.address),
    emergency_contact_name: orNull(f.emergency_contact_name),
    emergency_contact_phone: orNull(f.emergency_contact_phone),
    allergies: orNull(f.allergies),
    pronouns: orNull(f.pronouns),
    // general_notes is the client-level note; imported_note maps to the
    // memory row, so the two are not duplicated.
    notes: orNull(f.general_notes),
  };
}

export type MemoryInsertFields = {
  source_type: ImportSourceType;
  source_system: string | null;
  source_row_number: number;
  occurred_on: string | null;
  occurred_on_text: string | null;
  treatment_area_text: string | null;
  modality: string | null;
  method_or_machine: string | null;
  probe_type: string | null;
  probe_size: string | null;
  probe_lot: string | null;
  tolerance_text: string | null;
  reaction_text: string | null;
  caution_note: string | null;
  next_visit_note: string | null;
  aftercare_marked: boolean | null;
  imported_note: string | null;
};

// Map a single source row to imported_treatment_memories fields. Returns null
// when the row carries no treatment history (client-only row → no memory).
// occurred_on is parsed; if it can't be parsed the original text is preserved
// in occurred_on_text (warning, never fatal).
export function toMemoryInsertFields(
  row: ParsedRow,
  batchSourceType: ImportSourceType,
): MemoryInsertFields | null {
  if (!rowHasMemory(row.fields)) return null;
  const f = row.fields;
  const parsedDate = parseDateLoose(f.last_visit_date);
  const occurredOnText =
    orNull(f.occurred_on_text) ??
    // If the visit date couldn't be parsed, keep the raw text so it's not lost.
    (f.last_visit_date && parsedDate === null ? f.last_visit_date.trim() : null);
  return {
    source_type: f.source_type ? validSourceType(f.source_type) : batchSourceType,
    source_system: orNull(f.source_system),
    source_row_number: row.rowNumber,
    occurred_on: parsedDate,
    occurred_on_text: occurredOnText,
    treatment_area_text: orNull(f.treatment_area),
    modality: orNull(f.modality),
    method_or_machine: orNull(f.method_or_machine),
    probe_type: orNull(f.probe_type),
    probe_size: orNull(f.probe_size),
    probe_lot: orNull(f.probe_lot),
    tolerance_text: orNull(f.tolerance),
    reaction_text: orNull(f.reaction),
    caution_note: orNull(f.caution_note),
    next_visit_note: orNull(f.next_visit_note),
    aftercare_marked: parseBooleanLoose(f.aftercare_marked),
    imported_note: orNull(f.imported_note),
  };
}

// The copyable template line (header row) + one example data row.
export function templateText(): string {
  const header = TEMPLATE_COLUMNS.join(",");
  const example = [
    "Maya Rodriguez", // client_name
    "555-0100", // phone
    "maya@example.com", // email
    "1990-04-12", // date_of_birth
    "1 King St", // address
    "Sam Rivera", // emergency_contact_name
    "555-0199", // emergency_contact_phone
    "paper_card", // source_type
    "", // source_system
    "Upper lip", // treatment_area
    "2024-11-02", // last_visit_date
    "Electrolysis", // modality
    "Sterex", // method_or_machine
    "F3", // probe_type
    "0.003", // probe_size
    "L-204", // probe_lot
    "4/5", // tolerance
    "Mild redness", // reaction
    "Lower energy next time", // caution_note
    "Chin next visit", // next_visit_note
    "yes", // aftercare_marked
    "Moved from paper cards", // imported_note
    "Prefers afternoons", // general_notes
  ].join(",");
  return `${header}\n${example}`;
}
