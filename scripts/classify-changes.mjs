#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Changed-path classifier for risk-based CI.
//
// Emits stable boolean outputs consumed by .github/workflows/ci.yml so a PR
// runs only the lanes its diff can actually affect. Pure and side-effect free
// so the classification is proved by unit tests instead of by pushing fake
// commits to trigger every lane.
//
// Usage:
//   node scripts/classify-changes.mjs --files-from <file>   # newline-separated paths
//   node scripts/classify-changes.mjs --files "a.ts,b.sql"
//   node scripts/classify-changes.mjs --github-output       # append to $GITHUB_OUTPUT
// ---------------------------------------------------------------------------

import { readFileSync, appendFileSync } from "node:fs";

/** Anything here genuinely affects every lane. Kept deliberately short. */
const FULL_MATRIX = [
  /^package\.json$/,
  /^package-lock\.json$/,
  /^tsconfig(\.[\w.-]+)?\.json$/,
  /^next\.config\.[cm]?[jt]s$/,
  /^middleware\.[cm]?[jt]s$/,
  /^vitest(\.[\w.-]+)?\.config\.[cm]?[jt]s$/,
  /^playwright(\.[\w.-]+)?\.config\.[cm]?[jt]s$/,
  /^lib\/supabase\//,
  /^lib\/env\//,
  /^e2e\/helpers\//,
  /^tests\/db\/helpers\//,
];

/** Docs and records that never change runtime behaviour. */
const DOCS = [
  /^docs\//,
  /^README\.md$/,
  /^CLAUDE\.md$/,
  /\.md$/,
  /^\.github\/(ISSUE_TEMPLATE|PULL_REQUEST_TEMPLATE)/,
];

const RULES = [
  { key: "database", patterns: [/^supabase\/migrations\//, /^supabase\/.*\.sql$/, /^tests\/db\//, /^tests\/migrations\//, /^scripts\/migration-state\.mjs$/, /^scripts\/check-migration-extension/, /^scripts\/check-fresh-managed/] },
  { key: "security", patterns: [/^tests\/security\//, /^lib\/security\//, /^lib\/observability\//, /^scripts\/check-.*gates/] },
  { key: "payment", patterns: [/payment/i, /stripe/i, /^lib\/billing\//, /^e2e-payment\//, /^playwright\.payment\.config/] },
  { key: "google_calendar", patterns: [/google[-_]?calendar/i, /^lib\/google-calendar\//, /^e2e-google\//, /^playwright\.google\.config/, /^app\/api\/cron\/calendar/] },
  { key: "mobile", patterns: [/^e2e-mobile\//, /^playwright\.mobile\.config/, /mobile/i, /responsive/i] },
  { key: "ci_workflows", patterns: [/^\.github\/workflows\//, /^scripts\/classify-changes\.mjs$/, /^scripts\/verify-prepush\.mjs$/, /^tests\/ci\//] },
  { key: "browser_core", patterns: [/^e2e\//, /^app\//, /^components\//, /^playwright\.config/] },
  { key: "application", patterns: [/^app\//, /^components\//, /^lib\//, /^hooks\//, /^types\//, /\.tsx?$/] },
];

const match = (file, patterns) => patterns.some((re) => re.test(file));

export function classify(files) {
  const list = (files ?? []).map((f) => f.trim()).filter(Boolean);

  const out = {
    docs_only: false,
    application: false,
    database: false,
    security: false,
    payment: false,
    google_calendar: false,
    browser_core: false,
    mobile: false,
    ci_workflows: false,
    full_matrix_required: false,
    changed_file_count: list.length,
  };

  if (list.length === 0) {
    // No detectable diff (e.g. a re-run). Be conservative: run everything.
    out.full_matrix_required = true;
    return out;
  }

  for (const rule of RULES) {
    if (list.some((f) => match(f, rule.patterns))) out[rule.key] = true;
  }

  // Docs-only when EVERY changed file is documentation.
  out.docs_only = list.every((f) => match(f, DOCS));
  if (out.docs_only) {
    for (const k of ["application", "database", "security", "payment", "google_calendar", "browser_core", "mobile", "ci_workflows"]) {
      out[k] = false;
    }
    return out;
  }

  // Shared infrastructure forces the full matrix. Docs, the ledger and
  // apply-record files are NEVER full-matrix triggers, which is why the
  // docs_only short-circuit above runs first.
  if (list.some((f) => match(f, FULL_MATRIX))) out.full_matrix_required = true;

  // Changing the CI system itself warrants the full matrix for that PR.
  if (out.ci_workflows) out.full_matrix_required = true;

  if (out.full_matrix_required) {
    for (const k of ["application", "database", "security", "payment", "google_calendar", "browser_core", "mobile"]) {
      out[k] = true;
    }
  }
  return out;
}

function parseArgs(argv) {
  const i = argv.indexOf("--files-from");
  if (i !== -1) return readFileSync(argv[i + 1], "utf8").split("\n");
  const j = argv.indexOf("--files");
  if (j !== -1) return argv[j + 1].split(",");
  return readFileSync(0, "utf8").split("\n");
}

if (process.argv[1] && process.argv[1].endsWith("classify-changes.mjs")) {
  const result = classify(parseArgs(process.argv));
  const lines = Object.entries(result).map(([k, v]) => `${k}=${v}`);
  if (process.argv.includes("--github-output") && process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, lines.join("\n") + "\n");
  }
  console.log(lines.join("\n"));
}
