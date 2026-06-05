#!/usr/bin/env node
// PR #160. Pilot control sheet exporter.
//
// Reads pilot-control/*.yml, validates required fields, and emits:
//   * pilot-control/generated/<tab>.csv   (canonical CI-checked artifact)
//   * pilot-control/generated/dashboard.csv
//   * Hone_Pilot_Control_Sheet.xlsx  (optional; not checked in)
//
// Two modes:
//   * default:    `node scripts/export-pilot-control-sheet.mjs`
//                 writes the CSVs + the XLSX (XLSX only when --xlsx
//                 is also passed, or when run via `npm run pilot:export`).
//   * --check:    `node scripts/export-pilot-control-sheet.mjs --check`
//                 regenerates the CSVs to a temporary directory and
//                 diffs them against the checked-in copies. Exits 1
//                 when the YAML and the checked-in CSV disagree, when
//                 a required field is missing, or when the YAML is
//                 syntactically invalid.
//
// CI uses --check; humans run the default mode to refresh the
// canonical CSVs before committing.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { tmpdir } from "node:os";
import yaml from "js-yaml";
import JSZip from "jszip";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const PILOT_DIR = path.join(REPO_ROOT, "pilot-control");
const GENERATED_DIR = path.join(PILOT_DIR, "generated");
const XLSX_PATH = path.join(REPO_ROOT, "Hone_Pilot_Control_Sheet.xlsx");

const args = new Set(process.argv.slice(2));
const CHECK_MODE = args.has("--check");
const WRITE_XLSX = args.has("--xlsx") || (!CHECK_MODE && process.env.PILOT_WRITE_XLSX !== "0");

// ---------------------------------------------------------------------------
// Tracker definitions: source file, output csv name, ordered columns the CSV
// must carry, and which of those columns are required.
// ---------------------------------------------------------------------------
const TRACKERS = [
  {
    key: "chloe-testing-queue",
    title: "Chloe Testing Queue",
    columns: [
      "area",
      "pr",
      "priority",
      "owner",
      "status",
      "what_changed",
      "why_chloe_should_care",
      "test_steps",
      "expected_result",
      "chloe_notes",
      "last_tested",
    ],
    required: [
      "area",
      "pr",
      "priority",
      "owner",
      "status",
      "what_changed",
      "why_chloe_should_care",
      "test_steps",
      "expected_result",
    ],
  },
  {
    key: "product-feedback",
    title: "Product Feedback",
    columns: [
      "feedback",
      "source",
      "area",
      "pain_level",
      "suggested_fix",
      "decision",
      "status",
    ],
    required: [
      "feedback",
      "source",
      "area",
      "pain_level",
      "suggested_fix",
      "decision",
      "status",
    ],
  },
  {
    key: "launch-blockers",
    title: "Launch Blockers",
    columns: [
      "blocker",
      "why_it_matters",
      "owner",
      "needed_before_launch",
      "status",
      "next_action",
    ],
    required: [
      "blocker",
      "why_it_matters",
      "owner",
      "needed_before_launch",
      "status",
      "next_action",
    ],
  },
  {
    key: "pr-build-log",
    title: "PR / Build Log",
    columns: [
      "pr",
      "name",
      "what_changed",
      "risk_level",
      "merged",
      "needs_chloe_test",
      "smoke_result",
      "notes",
    ],
    required: [
      "pr",
      "name",
      "what_changed",
      "risk_level",
      "merged",
      "needs_chloe_test",
      "smoke_result",
      "notes",
    ],
  },
  {
    key: "future-ideas",
    title: "Future Ideas",
    columns: ["idea", "area", "why", "complexity"],
    required: ["idea", "area", "why", "complexity"],
  },
];

// ---------------------------------------------------------------------------
// CSV writer with deterministic line endings + RFC 4180 quoting.
// ---------------------------------------------------------------------------

function csvEscape(value) {
  // Always coerce to string. null / undefined render as empty.
  if (value === null || value === undefined) return "";
  let s;
  if (Array.isArray(value)) {
    // Multi-step lists serialize as newline-separated bullets so the
    // operator can read them inside one cell.
    s = value.map((step) => `- ${String(step)}`).join("\n");
  } else if (typeof value === "boolean") {
    s = value ? "true" : "false";
  } else {
    s = String(value);
  }
  // Trim trailing whitespace on each line so YAML block scalars do not
  // produce noisy diffs.
  s = s.replace(/[ \t]+\n/g, "\n").replace(/[ \t]+$/g, "");
  // RFC 4180: quote if the field contains comma, quote, or newline.
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowsToCsv(columns, rows) {
  const out = [];
  out.push(columns.join(","));
  for (const row of rows) {
    out.push(columns.map((c) => csvEscape(row[c])).join(","));
  }
  // LF line endings + trailing newline so the file is POSIX-clean.
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// YAML loading + validation.
// ---------------------------------------------------------------------------

function loadTrackerYaml(tracker) {
  const filePath = path.join(PILOT_DIR, `${tracker.key}.yml`);
  if (!existsSync(filePath)) {
    throw new ExporterError(
      `Tracker file is missing: ${path.relative(REPO_ROOT, filePath)}`,
    );
  }
  const text = readFileSync(filePath, "utf8");
  let parsed;
  try {
    parsed = yaml.load(text);
  } catch (err) {
    throw new ExporterError(
      `Failed to parse ${tracker.key}.yml: ${err.message}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new ExporterError(
      `${tracker.key}.yml must be a YAML sequence (top-level array of entries).`,
    );
  }
  // Validate every required field on every entry.
  parsed.forEach((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ExporterError(
        `${tracker.key}.yml entry #${index + 1} must be an object.`,
      );
    }
    for (const field of tracker.required) {
      const value = entry[field];
      const missing =
        value === undefined ||
        value === null ||
        (typeof value === "string" && value.trim() === "") ||
        (Array.isArray(value) && value.length === 0);
      if (missing) {
        throw new ExporterError(
          `${tracker.key}.yml entry #${index + 1} is missing required field: ${field}`,
        );
      }
    }
  });
  return parsed;
}

class ExporterError extends Error {
  constructor(message) {
    super(message);
    this.name = "ExporterError";
  }
}

// ---------------------------------------------------------------------------
// Dashboard summary: counts by status / pain_level / risk_level so the
// operator gets one quick read across every tracker.
// ---------------------------------------------------------------------------

function buildDashboardRows(loaded) {
  const rows = [];
  for (const tracker of TRACKERS) {
    const entries = loaded[tracker.key] ?? [];
    rows.push({
      tracker: tracker.title,
      metric: "total entries",
      value: entries.length,
    });
    if (tracker.key === "chloe-testing-queue") {
      const byStatus = countBy(entries, (e) => e.status);
      for (const [status, count] of byStatus) {
        rows.push({
          tracker: tracker.title,
          metric: `status: ${status}`,
          value: count,
        });
      }
      const byPriority = countBy(entries, (e) => e.priority);
      for (const [priority, count] of byPriority) {
        rows.push({
          tracker: tracker.title,
          metric: `priority: ${priority}`,
          value: count,
        });
      }
    }
    if (tracker.key === "product-feedback") {
      const byStatus = countBy(entries, (e) => e.status);
      for (const [status, count] of byStatus) {
        rows.push({
          tracker: tracker.title,
          metric: `status: ${status}`,
          value: count,
        });
      }
      const byPain = countBy(entries, (e) => e.pain_level);
      for (const [pain, count] of byPain) {
        rows.push({
          tracker: tracker.title,
          metric: `pain_level: ${pain}`,
          value: count,
        });
      }
    }
    if (tracker.key === "launch-blockers") {
      const byStatus = countBy(entries, (e) => e.status);
      for (const [status, count] of byStatus) {
        rows.push({
          tracker: tracker.title,
          metric: `status: ${status}`,
          value: count,
        });
      }
    }
    if (tracker.key === "pr-build-log") {
      const byRisk = countBy(entries, (e) => e.risk_level);
      for (const [risk, count] of byRisk) {
        rows.push({
          tracker: tracker.title,
          metric: `risk_level: ${risk}`,
          value: count,
        });
      }
      const bySmoke = countBy(entries, (e) => e.smoke_result);
      for (const [smoke, count] of bySmoke) {
        rows.push({
          tracker: tracker.title,
          metric: `smoke_result: ${smoke}`,
          value: count,
        });
      }
    }
  }
  return rows;
}

function countBy(entries, fn) {
  const counts = new Map();
  for (const entry of entries) {
    const key = String(fn(entry) ?? "(unset)");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  // Stable order: by key alphabetic.
  return [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

// ---------------------------------------------------------------------------
// XLSX writer. Minimal OOXML / SpreadsheetML, no styles, no formulas,
// shared strings. Deterministic ordering so the binary is byte-stable
// when the YAML is unchanged.
// ---------------------------------------------------------------------------

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function colLetter(index) {
  // 1-based: A, B, ..., Z, AA, AB, ...
  let n = index;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function buildSheetXml(rows, sharedStringIndex) {
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  lines.push(
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
  );
  lines.push("<sheetData>");
  rows.forEach((row, rowIdx) => {
    const r = rowIdx + 1;
    lines.push(`<row r="${r}">`);
    row.forEach((cell, colIdx) => {
      const ref = `${colLetter(colIdx + 1)}${r}`;
      if (cell === "" || cell === null || cell === undefined) {
        return;
      }
      if (typeof cell === "number" && Number.isFinite(cell)) {
        lines.push(`<c r="${ref}"><v>${cell}</v></c>`);
        return;
      }
      const s = String(cell);
      const idx = sharedStringIndex.add(s);
      lines.push(`<c r="${ref}" t="s"><v>${idx}</v></c>`);
    });
    lines.push("</row>");
  });
  lines.push("</sheetData>");
  lines.push("</worksheet>");
  return lines.join("\n");
}

class SharedStrings {
  constructor() {
    this.list = [];
    this.index = new Map();
  }
  add(s) {
    if (this.index.has(s)) return this.index.get(s);
    const i = this.list.length;
    this.list.push(s);
    this.index.set(s, i);
    return i;
  }
  toXml() {
    const lines = [];
    lines.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
    lines.push(
      `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${this.list.length}" uniqueCount="${this.list.length}">`,
    );
    for (const s of this.list) {
      lines.push(`<si><t xml:space="preserve">${xmlEscape(s)}</t></si>`);
    }
    lines.push("</sst>");
    return lines.join("\n");
  }
}

async function writeXlsx(sheets, outputPath) {
  // Deterministic mtime so the zip hash is stable across runs.
  const FIXED_DATE = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
  const shared = new SharedStrings();
  const sheetXmls = sheets.map((s) => buildSheetXml(s.rows, shared));

  const zip = new JSZip();

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    sheets
      .map(
        (_, i) =>
          `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
      )
      .join("") +
    '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
    "</Types>";

  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    "</Relationships>";

  const workbookRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join("") +
    `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>` +
    "</Relationships>";

  const workbookXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    "<sheets>" +
    sheets
      .map(
        (s, i) =>
          `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
      )
      .join("") +
    "</sheets>" +
    "</workbook>";

  zip.file("[Content_Types].xml", contentTypes, { date: FIXED_DATE });
  zip.file("_rels/.rels", rootRels, { date: FIXED_DATE });
  zip.file("xl/workbook.xml", workbookXml, { date: FIXED_DATE });
  zip.file("xl/_rels/workbook.xml.rels", workbookRels, { date: FIXED_DATE });
  zip.file("xl/sharedStrings.xml", shared.toXml(), { date: FIXED_DATE });
  sheets.forEach((_, i) => {
    zip.file(`xl/worksheets/sheet${i + 1}.xml`, sheetXmls[i], {
      date: FIXED_DATE,
    });
  });

  const buf = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    streamFiles: true,
  });
  writeFileSync(outputPath, buf);
}

// ---------------------------------------------------------------------------
// Main: load, validate, write.
// ---------------------------------------------------------------------------

function loadAll() {
  const loaded = {};
  for (const tracker of TRACKERS) {
    loaded[tracker.key] = loadTrackerYaml(tracker);
  }
  return loaded;
}

function buildSheets(loaded) {
  const sheets = [];
  // Dashboard sheet first.
  const dashboardRows = buildDashboardRows(loaded);
  sheets.push({
    name: "Dashboard",
    csvKey: "dashboard",
    columns: ["tracker", "metric", "value"],
    rows: [["tracker", "metric", "value"], ...dashboardRows.map((r) => [r.tracker, r.metric, r.value])],
    dataRows: dashboardRows,
  });
  for (const tracker of TRACKERS) {
    const entries = loaded[tracker.key] ?? [];
    const headerRow = tracker.columns;
    const dataRows = entries.map((entry) =>
      tracker.columns.map((col) => coerceForCell(entry[col])),
    );
    sheets.push({
      name: tracker.title,
      csvKey: tracker.key,
      columns: tracker.columns,
      rows: [headerRow, ...dataRows],
      dataRows: entries,
    });
  }
  return sheets;
}

function coerceForCell(value) {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) {
    return value.map((step) => `- ${String(step)}`).join("\n");
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value).replace(/[ \t]+\n/g, "\n").replace(/[ \t]+$/g, "");
}

function writeCsvsTo(outDir, loaded) {
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  // Dashboard csv.
  const dashboardRows = buildDashboardRows(loaded);
  writeFileSync(
    path.join(outDir, "dashboard.csv"),
    rowsToCsv(["tracker", "metric", "value"], dashboardRows),
  );
  for (const tracker of TRACKERS) {
    const entries = loaded[tracker.key] ?? [];
    writeFileSync(
      path.join(outDir, `${tracker.key}.csv`),
      rowsToCsv(tracker.columns, entries),
    );
  }
}

function listCsvsIn(dir) {
  if (!existsSync(dir)) return new Map();
  const out = new Map();
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (!statSync(full).isFile()) continue;
    if (!entry.endsWith(".csv")) continue;
    out.set(entry, readFileSync(full, "utf8"));
  }
  return out;
}

async function main() {
  let loaded;
  try {
    loaded = loadAll();
  } catch (err) {
    if (err instanceof ExporterError) {
      console.error(`pilot-control: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  if (CHECK_MODE) {
    // Regenerate CSVs to a temp directory, diff against the checked-in
    // copies. Anything that differs (or is missing on disk) is a
    // failure.
    const tmp = mkSyncSafeTmpDir();
    try {
      writeCsvsTo(tmp, loaded);
      const expected = listCsvsIn(tmp);
      const actual = listCsvsIn(GENERATED_DIR);
      const offenders = [];
      for (const [name, expectedText] of expected) {
        const actualText = actual.get(name);
        if (actualText === undefined) {
          offenders.push(`missing: pilot-control/generated/${name}`);
          continue;
        }
        if (actualText !== expectedText) {
          offenders.push(`stale:   pilot-control/generated/${name}`);
        }
      }
      for (const name of actual.keys()) {
        if (!expected.has(name)) {
          offenders.push(`orphan:  pilot-control/generated/${name}`);
        }
      }
      if (offenders.length > 0) {
        console.error("pilot-control: generated CSVs are out of sync with YAML.");
        for (const line of offenders) console.error(`  ${line}`);
        console.error(
          "  Run `npm run pilot:export` and commit pilot-control/generated/.",
        );
        process.exit(1);
      }
      console.log(
        `pilot-control: CHECK ok. ${TRACKERS.length} trackers + dashboard up to date.`,
      );
      return;
    } finally {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }

  // Default (export) mode.
  writeCsvsTo(GENERATED_DIR, loaded);
  console.log(
    `pilot-control: wrote ${TRACKERS.length + 1} CSV file(s) under pilot-control/generated/.`,
  );
  if (WRITE_XLSX) {
    const sheets = buildSheets(loaded);
    await writeXlsx(sheets, XLSX_PATH);
    console.log(
      `pilot-control: wrote ${path.relative(REPO_ROOT, XLSX_PATH)} (${sheets.length} tabs).`,
    );
  }
}

function mkSyncSafeTmpDir() {
  let d = path.join(
    tmpdir(),
    `pilot-control-check-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
  );
  mkdirSync(d, { recursive: true });
  return d;
}

await main();
