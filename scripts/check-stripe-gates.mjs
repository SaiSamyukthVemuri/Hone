#!/usr/bin/env node
/*
 * Stripe / payment safety grep gates (PR #154).
 *
 * Scans only RUNTIME source paths for payment-call patterns the
 * codebase has agreed must remain absent (or pinned to exactly one
 * allowed location). Reports PASS / FAIL per rule and exits non-zero
 * on any failure.
 *
 * Why a dedicated script (not `grep -R`):
 *   * docs/, tests/, supabase/migrations/, scripts/, .github/, and
 *     this file itself all legitimately reference the forbidden
 *     strings (assertion text, runbook copy, decision-log entries,
 *     the script's own rule list). A naive grep would flag every
 *     one of those and the gate would never pass.
 *   * The rule is "no new money-moving CALL SITE in runtime code",
 *     not "no string anywhere in the repo." This script enforces
 *     the call-site shape precisely.
 *
 * Adding new rules / allowlist entries:
 *   * Edit RULES below. Each entry defines: a pattern (RegExp) and
 *     an optional ALLOWLIST array of "relative/path/to/file.ts"
 *     paths where occurrences are permitted (with a rationale
 *     comment).
 *   * Any new occurrence outside the allowlist is a hard fail.
 *   * Allowlist files are matched exactly against the relative
 *     path (POSIX separators).
 */

import { readdirSync, readFileSync, statSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO_ROOT = process.cwd();
const SCRIPT_PATH = realpathSync(fileURLToPath(import.meta.url));

// --------------------------------------------------------------------
// Scan scope
// --------------------------------------------------------------------
//
// Only runtime application code is scanned. Tests, docs, migrations,
// and scripts intentionally contain the forbidden strings (assertion
// text, runbook copy, the script's own rule list); they must not
// count as runtime call sites.
const SCAN_ROOTS = [
  "app",
  "lib",
  "middleware.ts",
  "next.config.ts",
];

const INCLUDE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

const TEST_FILE_PATTERN = /\.(test|spec)\.(ts|tsx|js|jsx)$/;

const ALWAYS_EXCLUDED_DIRECTORIES = new Set([
  "node_modules",
  ".next",
  ".git",
  ".github",
  "coverage",
  "docs",
  "tests",
  "supabase",
  "scripts",
]);

// --------------------------------------------------------------------
// Rules
// --------------------------------------------------------------------
//
// The set of patterns the codebase agreed to keep absent in runtime
// source. Each rule may carry an ALLOWLIST of paths where occurrences
// are explicitly permitted (with a rationale).
//
// `exactly` constrains the total runtime-source occurrence count to
// the given number. If unset, the rule defaults to "any number of
// occurrences, but only in allowlisted files." With both `exactly`
// and an allowlist, every occurrence must land in the allowlist AND
// the total must match `exactly`.
const RULES = [
  {
    name: "paymentIntents.create",
    pattern: /paymentIntents\.create/g,
    allowlist: [
      // PR #146 test-mode manual fee charge. Behind: practitioner
      // auth, evidence recheck, claim_manual_fee_charge_attempt RPC,
      // deterministic idempotency key, connected-account context,
      // inferStripeLivemode() test-mode gate, AND the DB CHECK
      // manual_fee_charge_attempts_livemode_false_check.
      "lib/billing/manual-fee-charge.ts",
      // PR #173 test-mode session payment charge. Behind: the same
      // safety chain plus a PR #170 current-card-authorization
      // re-check at execution time, the claim_session_payment_charge
      // _attempt RPC (migration 0075), and the
      // payment_charge_attempts_livemode_false_check (migration
      // 0073). Adding a third paymentIntents.create call site is a
      // deliberate review event; do not loosen this allowlist
      // without an accompanying decision in docs/13.
      "lib/billing/session-payment-charge.ts",
    ],
    exactly: 2,
  },
  {
    name: "charges.create",
    pattern: /charges\.create/g,
    allowlist: [],
    exactly: 0,
  },
  {
    name: "refunds.create",
    pattern: /refunds\.create/g,
    allowlist: [],
    exactly: 0,
  },
  {
    name: "checkout.sessions",
    // Match a real Stripe SDK access shape (`stripe.checkout.sessions`
    // or `checkout.sessions.create` etc.). The plain word "checkout"
    // appears in legitimate UI / booking copy; we only want to flag
    // the SDK namespace.
    pattern: /checkout\.sessions/g,
    allowlist: [],
    exactly: 0,
  },
  {
    name: "set_studio_require_card_on_file",
    pattern: /set_studio_require_card_on_file/g,
    allowlist: [],
    exactly: 0,
  },
  {
    name: "STRIPE_ALLOW_LIVE_MODE=true",
    pattern: /STRIPE_ALLOW_LIVE_MODE=true/g,
    allowlist: [
      // The string appears inside an operator-facing error message
      // in assertStripeKeyAllowed(). It is NOT a code path that
      // flips live mode; it tells the operator they need to set
      // the env to enable live mode in a separate reviewed PR.
      // Reference: lib/stripe/server.ts:assertStripeKeyAllowed.
      "lib/stripe/server.ts",
    ],
    // Allow ANY number of occurrences in the allowlisted file
    // (currently one). A new occurrence ANYWHERE else fails.
  },
];

// --------------------------------------------------------------------
// File walk
// --------------------------------------------------------------------

function toPosix(p) {
  return p.split(path.sep).join("/");
}

function isExcludedPath(absPath) {
  if (absPath === SCRIPT_PATH) return true;
  const rel = toPosix(path.relative(REPO_ROOT, absPath));
  if (rel.length === 0 || rel.startsWith("..")) return true;
  const segments = rel.split("/");
  for (const seg of segments) {
    if (ALWAYS_EXCLUDED_DIRECTORIES.has(seg)) return true;
  }
  if (TEST_FILE_PATTERN.test(rel)) return true;
  return false;
}

function walk(absRoot) {
  const out = [];
  const visit = (current) => {
    let stat;
    try {
      stat = statSync(current);
    } catch {
      return;
    }
    if (stat.isFile()) {
      if (isExcludedPath(current)) return;
      const ext = path.extname(current);
      if (!INCLUDE_EXTENSIONS.has(ext)) return;
      out.push(current);
      return;
    }
    if (stat.isDirectory()) {
      const basename = path.basename(current);
      if (ALWAYS_EXCLUDED_DIRECTORIES.has(basename)) return;
      let entries;
      try {
        entries = readdirSync(current);
      } catch {
        return;
      }
      for (const e of entries) {
        visit(path.join(current, e));
      }
    }
  };
  visit(absRoot);
  return out;
}

function collectScanFiles() {
  const files = [];
  for (const root of SCAN_ROOTS) {
    const absRoot = path.join(REPO_ROOT, root);
    let exists = true;
    try {
      statSync(absRoot);
    } catch {
      exists = false;
    }
    if (!exists) continue;
    files.push(...walk(absRoot));
  }
  return Array.from(new Set(files)).sort();
}

// --------------------------------------------------------------------
// Rule evaluation
// --------------------------------------------------------------------

function relPosix(abs) {
  return toPosix(path.relative(REPO_ROOT, abs));
}

function countMatches(source, pattern) {
  // The patterns are constructed with the /g flag above; matchAll
  // returns one entry per occurrence.
  return Array.from(source.matchAll(pattern)).length;
}

function evaluateRule(rule, files) {
  const occurrences = []; // [{ path: rel, count }]
  for (const abs of files) {
    let content;
    try {
      content = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const count = countMatches(content, rule.pattern);
    if (count > 0) {
      occurrences.push({ path: relPosix(abs), count });
    }
  }
  const allowlist = new Set(rule.allowlist ?? []);
  const offending = occurrences.filter((o) => !allowlist.has(o.path));
  const totalCount = occurrences.reduce((sum, o) => sum + o.count, 0);

  if (offending.length > 0) {
    return {
      ok: false,
      summary: `found in ${offending
        .map((o) => `${o.path} (${o.count})`)
        .join(", ")}`,
      occurrences,
    };
  }
  if (typeof rule.exactly === "number") {
    if (totalCount !== rule.exactly) {
      return {
        ok: false,
        summary: `expected exactly ${rule.exactly} runtime occurrence(s); found ${totalCount} (${
          occurrences.length === 0
            ? "none"
            : occurrences.map((o) => `${o.path}:${o.count}`).join(", ")
        })`,
        occurrences,
      };
    }
  }
  if (allowlist.size === 0 && occurrences.length === 0) {
    return { ok: true, summary: "zero runtime source occurrences" };
  }
  if (typeof rule.exactly === "number" && rule.exactly === 0 && occurrences.length === 0) {
    return { ok: true, summary: "zero runtime source occurrences" };
  }
  return {
    ok: true,
    summary: `${totalCount} occurrence(s), all in allowlisted file(s): ${occurrences.map((o) => `${o.path}:${o.count}`).join(", ")}`,
  };
}

// --------------------------------------------------------------------
// Main
// --------------------------------------------------------------------

function main() {
  const files = collectScanFiles();
  if (files.length === 0) {
    console.error(
      "check-stripe-gates: no runtime source files matched the scan scope. Is the repo intact?",
    );
    process.exit(2);
  }
  let allOk = true;
  for (const rule of RULES) {
    const result = evaluateRule(rule, files);
    const tag = result.ok ? "PASS" : "FAIL";
    process.stdout.write(`${tag} ${rule.name}: ${result.summary}\n`);
    if (!result.ok) allOk = false;
  }
  process.stdout.write(
    `\nScanned ${files.length} runtime source file(s) under ${SCAN_ROOTS.join(", ")}.\n`,
  );
  process.exit(allOk ? 0 : 1);
}

main();
