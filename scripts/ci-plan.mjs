#!/usr/bin/env node
// ---------------------------------------------------------------------------
// `npm run ci:plan`, what CI will do for the current diff, and why.
//
// This is the single source Claude (or anyone) should consult before deciding
// local test scope. It shares the classifier and the browser-group selector
// with CI, so local expectations and CI behaviour cannot drift apart.
//
//   npm run ci:plan                  # diff vs the merge base with the base branch
//   npm run ci:plan -- --files a,b   # hypothetical diff
//   npm run ci:plan -- --json
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";
import { classify } from "./classify-changes.mjs";
import { selectBrowserGroups, specsForGroups, BROWSER_GROUPS, EXTENDED } from "./browser-groups.mjs";

const BASE_BRANCH = process.env.HONE_BASE_BRANCH ?? "claude/build-hone-saas-hOex7";

export function changedFiles() {
  const explicit = process.argv.indexOf("--files");
  if (explicit !== -1) return process.argv[explicit + 1].split(",");
  try {
    const base = execFileSync("git", ["merge-base", "HEAD", `origin/${BASE_BRANCH}`], {
      encoding: "utf8",
    }).trim();
    const committed = execFileSync("git", ["diff", "--name-only", base, "HEAD"], { encoding: "utf8" });
    const working = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map((l) => l.slice(3).trim());
    return [...new Set([...committed.split("\n"), ...working])].filter(Boolean);
  } catch {
    return [];
  }
}

export function buildPlan(files) {
  const c = classify(files);
  const b = selectBrowserGroups(files);

  const lanes = [];
  const add = (lane, run, why) => lanes.push({ lane, run, why });

  add("changed-path detection", true, "always: classifies the diff");
  add(
    "typecheck / lint / build / test / safety gates",
    !c.docs_only,
    c.docs_only ? "skipped: docs-only diff" : "code or config changed",
  );
  add(
    "db integration (local supabase)",
    c.database || c.security || c.full_matrix_required,
    c.database ? "database/migration paths changed" : c.security ? "security paths changed" : c.full_matrix_required ? "full matrix required" : "skipped: no database or security paths",
  );
  add(
    "browser e2e (local stack)",
    b.groups.length > 0,
    b.reason,
  );
  add(
    "payment browser e2e (fake stripe)",
    c.payment || c.full_matrix_required,
    c.payment ? "payment paths changed" : c.full_matrix_required ? "full matrix required" : "skipped: no payment paths",
  );
  add(
    "google browser e2e (fake google)",
    c.google_calendar || c.full_matrix_required,
    c.google_calendar ? "Google Calendar paths changed" : c.full_matrix_required ? "full matrix required" : "skipped: no Google paths",
  );
  add(
    "mobile completion e2e (chromium iphone-profile)",
    c.mobile || c.full_matrix_required,
    c.mobile ? "mobile/responsive paths changed" : c.full_matrix_required ? "full matrix required" : "skipped: no mobile paths",
  );

  const specs = specsForGroups(b.groups);
  return {
    changed_file_count: files.length,
    classification: c,
    browser: {
      extended: b.extended,
      groups: b.groups,
      reason: b.reason,
      spec_count: b.extended ? "all" : (specs?.length ?? 0),
      specs: b.extended ? null : specs,
      sharded: b.extended,
    },
    full_matrix_required: c.full_matrix_required,
    lanes,
  };
}

if (process.argv[1] && process.argv[1].endsWith("ci-plan.mjs")) {
  const files = changedFiles();
  const plan = buildPlan(files);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    console.log(`\nCI PLAN, ${plan.changed_file_count} changed file(s)\n`);
    console.log("Risk classification:");
    for (const [k, v] of Object.entries(plan.classification)) {
      if (typeof v === "boolean" && v) console.log(`  • ${k}`);
    }
    if (plan.full_matrix_required) console.log("  ⚠ FULL MATRIX REQUIRED");
    console.log("\nLanes:");
    for (const l of plan.lanes) {
      console.log(`  ${l.run ? "RUN " : "skip"}  ${l.lane.padEnd(48)} ${l.why}`);
    }
    console.log("\nBrowser coverage:");
    if (plan.browser.groups.length === 0) {
      console.log(`  none, ${plan.browser.reason}`);
    } else if (plan.browser.extended) {
      console.log(`  EXTENDED (all specs, 2 shards), ${plan.browser.reason}`);
    } else {
      console.log(`  groups: ${plan.browser.groups.join(", ")}`);
      console.log(`  specs:  ${plan.browser.spec_count}`);
      console.log(`  reason: ${plan.browser.reason}`);
    }
    console.log("");
  }
}
