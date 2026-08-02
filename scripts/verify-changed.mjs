#!/usr/bin/env node
// ---------------------------------------------------------------------------
// `npm run verify:changed` — run the focused local checks this diff warrants.
//
// Consumes the SAME classifier and browser-group selector as CI (via
// scripts/ci-plan.mjs), so local scope and CI scope cannot drift apart. There
// is deliberately no second path map.
//
// It never silently launches the whole matrix: expensive lanes are printed as
// suggestions with the exact command, and only cheap, safe checks auto-run.
//
//   npm run verify:changed            # run the focused checks
//   npm run verify:changed -- --plan  # dry run: print, execute nothing
// ---------------------------------------------------------------------------

import { execSync } from "node:child_process";
import { buildPlan, changedFiles } from "./ci-plan.mjs";

const PLAN_ONLY = process.argv.includes("--plan");

const GREEN = "[32m";
const YELLOW = "[33m";
const RED = "[31m";
const DIM = "[2m";
const RESET = "[0m";

const files = changedFiles();
const plan = buildPlan(files);
const c = plan.classification;

/** Cheap and safe to run automatically. */
const auto = [];
/** Expensive or environment-dependent: printed, never auto-run. */
const suggested = [];

const addAuto = (label, cmd, why) => auto.push({ label, cmd, why });
const addSuggested = (label, cmd, why) => suggested.push({ label, cmd, why });

if (c.docs_only) {
  addAuto("documentation consistency", "npx vitest run tests/docs/", "docs-only diff");
  addAuto("migration state derives", "node scripts/migration-state.mjs", "docs may quote migration state");
} else {
  if (c.database) {
    addAuto("migration source contracts", "npx vitest run tests/migrations/", "migration paths changed");
    addAuto("migration state derives", "node scripts/migration-state.mjs", "migration paths changed");
    addSuggested(
      "focused DB integration (needs one fresh pinned reset)",
      "npx --yes supabase@2.102.0 db reset --local && npm run test:db",
      "database change — one fresh reset per migration head",
    );
  }
  if (c.security) {
    addAuto("security guards", "npx vitest run tests/security/", "security paths changed");
  }
  if (c.ci_workflows) {
    addAuto("CI classifier + workflow config", "npx vitest run tests/ci/", "CI configuration changed");
  }
  if (c.application || c.payment || c.google_calendar) {
    addAuto("typecheck", "npx tsc --noEmit", "TypeScript changed");
  }
  if (c.payment) {
    addAuto("payment unit + safety gates", "npx vitest run tests/app/ --silent=false -t payment || npm run check:stripe-gates", "payment paths changed");
    addSuggested("payment browser E2E", "npm run test:e2e:payment", "payment paths changed");
  }
  if (c.google_calendar) {
    addSuggested("Google browser E2E (fake Google)", "npm run test:e2e:google", "Google Calendar paths changed");
  }
  if (c.mobile) {
    addSuggested("mobile completion E2E", "npm run test:e2e:mobile", "mobile/responsive paths changed");
  }
  if (plan.browser.groups.length > 0) {
    if (plan.browser.extended) {
      addSuggested(
        "EXTENDED browser suite (all specs — CI shards this in two)",
        "npm run test:e2e",
        plan.browser.reason,
      );
    } else {
      const specs = (plan.browser.specs ?? []).map((s) => `e2e/${s}`).join(" ");
      addSuggested(
        `targeted browser group(s): ${plan.browser.groups.join(", ")} (${plan.browser.spec_count} specs)`,
        `npx playwright test ${specs}`,
        plan.browser.reason,
      );
    }
  }
  if (c.full_matrix_required) {
    addSuggested(
      "FULL local matrix — usually unnecessary; prefer the nightly workflow",
      "npm run ci",
      "shared infrastructure or CI configuration changed",
    );
  }
}

console.log(`\nverify:changed — ${files.length} changed file(s)`);
console.log(`${DIM}scope comes from the same classifier CI uses (npm run ci:plan)${RESET}\n`);

if (auto.length === 0 && suggested.length === 0) {
  console.log("nothing to verify for this diff.");
  process.exit(0);
}

console.log("Automatic (cheap, safe):");
for (const a of auto) console.log(`  ${a.label.padEnd(46)} ${DIM}${a.why}${RESET}`);
if (suggested.length) {
  console.log("\nSuggested (expensive — run deliberately):");
  for (const s of suggested) {
    console.log(`  ${YELLOW}${s.label}${RESET}`);
    console.log(`    ${DIM}${s.why}${RESET}`);
    console.log(`    $ ${s.cmd}`);
  }
}

if (PLAN_ONLY) {
  console.log(`\n${DIM}--plan: nothing executed.${RESET}`);
  process.exit(0);
}

console.log("");
let failed = 0;
for (const a of auto) {
  process.stdout.write(`→ ${a.label} ... `);
  try {
    execSync(a.cmd, { stdio: "pipe", encoding: "utf8" });
    console.log(`${GREEN}ok${RESET}`);
  } catch (err) {
    failed += 1;
    console.log(`${RED}FAILED${RESET}`);
    const out = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim().split("\n").slice(-15);
    for (const l of out) console.log(`    ${l}`);
  }
}

if (failed) {
  console.log(`\n${RED}${failed} automatic check(s) failed.${RESET}`);
  process.exit(1);
}
console.log(`\n${GREEN}automatic checks passed.${RESET}`);
if (suggested.length) {
  console.log(`${DIM}${suggested.length} expensive check(s) suggested above were NOT run.${RESET}`);
}
