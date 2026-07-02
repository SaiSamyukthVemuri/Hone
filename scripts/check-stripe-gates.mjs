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
  // PR #314: also scan components/ so a Stripe write (server or browser
  // Stripe.js) added there can't evade the money-movement rules or the
  // unclassified-write catch-all. No Stripe write lives here today, so the
  // expected result is unchanged (money 1/1/0/0 + non-money pinned + catch-all).
  "components",
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
      // PR #173 test-mode session payment charge; since PR #196 the
      // unified executor for ALL three charge reasons (session
      // payment, no-show fee, late-cancellation fee). Behind:
      // practitioner auth, eligibility + current-card-authorization
      // re-checks at execution time, the claim_session_payment_charge
      // _attempt RPC (migration 0075, reasons widened in 0083),
      // deterministic reason-scoped idempotency keys,
      // inferStripeLivemode() test-mode gate, AND the DB CHECK
      // payment_charge_attempts_livemode_false_check (migration
      // 0073). PR #218 removed the dead legacy manual-fee executor
      // (lib/billing/manual-fee-charge.ts), so this is the ONLY
      // PaymentIntent call site. Adding a second one is a deliberate
      // review event; do not loosen this allowlist without an
      // accompanying decision in docs/13.
      "lib/billing/session-payment-charge.ts",
    ],
    exactly: 1,
  },
  {
    name: "paymentIntents.cancel",
    pattern: /paymentIntents\.cancel/g,
    allowlist: [
      // PR #320: the requires_action safety cancel. When an off-session
      // PaymentIntent returns requires_action (async SCA), it is canceled
      // (voided) BEFORE the terminal 'failed' outcome is written, so Stripe
      // cannot later succeed it while Hone records 'failed' (webhook
      // reconciliation only transitions from ready/pending_stripe). This VOIDS
      // money — it never moves it. One call site, in the charge executor's
      // finalizeRequiresActionPaymentIntent; test-mode gated via getStripe().
      // Adding a second cancel site is a deliberate review event.
      "lib/billing/session-payment-charge.ts",
    ],
    exactly: 1,
    stripComments: true,
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
    allowlist: [
      // PR #178 test-mode reason-agnostic refund helper. Behind:
      // (1) the inferStripeLivemode() short-circuit at function
      // entry, (2) the row-level CHECK constraint
      // payment_charge_attempts_livemode_false_check (migration
      // 0073), (3) the conditional UPDATE claim that requires
      // status='succeeded' AND stripe_livemode=false AND
      // (refund_status IS NULL OR refund_status='failed') before
      // the Stripe call runs, (4) the deterministic
      // hone:payment_refund:<attemptId>:v1 idempotency key + the
      // partial-unique payment_charge_attempts_refund_idempotency
      // _uniq (migration 0078). Adding a second refunds.create
      // call site is a deliberate review event; do not loosen
      // this allowlist without an accompanying decision in
      // docs/13.
      "lib/billing/payment-refund.ts",
    ],
    exactly: 1,
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
  // ------------------------------------------------------------------
  // Non-money Stripe writes (PR #309).
  //
  // These create Stripe OBJECTS/ACCOUNTS but move NO money. They are
  // intentionally ALLOWED and are test-mode gated at runtime (the shared
  // getStripe()/assertStripeKeyAllowed() key gate + inferStripeLivemode()).
  // They are pinned here — exactly one occurrence, in exactly one file —
  // so a NEW non-money write site (or a second occurrence) is a deliberate,
  // reviewed change, NOT a silent addition. This does NOT change runtime
  // behavior; it inventories what already exists. A count/allowlist change
  // must come with a decision in docs/13.
  {
    name: "customers.create",
    pattern: /customers\.create/g,
    allowlist: [
      // Card-on-file Stripe Customer provisioning (PR #135), serialised
      // against the 0032 customer RPCs. Test-mode gated via getStripe().
      "lib/stripe/setup-intent.ts",
    ],
    exactly: 1,
    stripComments: true,
  },
  {
    name: "setupIntents.create",
    pattern: /setupIntents\.create/g,
    allowlist: [
      // Card-on-file SetupIntent on the connected account (PR #135).
      // No money movement; test-mode gated + inferStripeLivemode() tagged.
      "lib/stripe/setup-intent.ts",
    ],
    exactly: 1,
    stripComments: true,
  },
  {
    name: "accounts.create",
    pattern: /accounts\.create\b/g,
    allowlist: [
      // Stripe Connect Express account provisioning (onboarding only;
      // no charges/SetupIntents here). Test-mode gated via getStripe().
      "lib/stripe/account.ts",
    ],
    exactly: 1,
    stripComments: true,
  },
  {
    name: "accountLinks.create",
    pattern: /accountLinks\.create/g,
    allowlist: [
      // Connect onboarding link creation (PR Connect Phase 1).
      "lib/stripe/account.ts",
    ],
    exactly: 1,
    stripComments: true,
  },
  {
    name: "accounts.createLoginLink",
    pattern: /accounts\.createLoginLink/g,
    allowlist: [
      // Connect dashboard login-link creation (PR Connect Phase 1).
      "lib/stripe/account.ts",
    ],
    exactly: 1,
    stripComments: true,
  },
  {
    name: "confirmSetup (browser)",
    // Browser Stripe.js card-save (SetupIntent confirmation) in the portal
    // payment-method form. No money movement. Pinned to the one client
    // component that mounts the PaymentElement.
    pattern: /confirmSetup/g,
    allowlist: [
      "app/portal/PortalPaymentMethodForm.tsx",
    ],
    exactly: 1,
    stripComments: true,
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
    // Non-money rules (PR #309) count CALL SITES only, so comment mentions of
    // the method (e.g. a doc-comment "wrapper around stripe.setupIntents.create")
    // don't inflate the exact count. The money-movement rules keep scanning raw
    // source (unchanged behavior). stripComments is hoisted (declared below).
    const scanned = rule.stripComments ? stripComments(content) : content;
    const count = countMatches(scanned, rule.pattern);
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
// Unknown / unclassified Stripe write catch-all (PR #309)
// --------------------------------------------------------------------
//
// The per-method rules above pin the KNOWN Stripe writes. This catch-all
// hard-fails if ANY OTHER Stripe mutating call appears — a new verb
// (.update/.cancel/.confirm/.capture/…), a new namespace, or a write in a
// new file — so no Stripe write can be added without either landing on the
// classified list or failing the gate.
//
// It matches Stripe write SHAPES (server: a `stripe.<...>.<write-verb>`
// chain; browser: confirmSetup/confirmPayment/confirmCardPayment) and
// subtracts every occurrence already accounted for by a CLASSIFIED pattern.
// Read-only calls (.retrieve/.list) are excluded by construction. Comments
// are stripped first so a prose mention of a Stripe method never trips it.

// Server: any `stripe.` client chain ending in a mutating verb. `createLoginLink`
// is listed before `create` so the longer verb wins.
const STRIPE_SERVER_WRITE_SHAPE =
  /\bstripe\.[a-zA-Z0-9_.]+\.(createLoginLink|create|update|delete|del|cancel|confirm|capture|finalize|void|expire|reject|attach|detach|approve|decline|release|increment|decrement|verify)\b/g;
// Browser Stripe.js write shapes (Elements confirmations).
const STRIPE_BROWSER_WRITE_SHAPE = /\b(confirmSetup|confirmPayment|confirmCardPayment)\s*\(/g;

// A write SHAPE occurrence is "classified" (already inventoried above) if its
// matched text hits one of these. Non-global so .test() is stateless.
const CLASSIFIED_WRITE_PATTERNS = [
  /paymentIntents\.create/,
  /paymentIntents\.cancel/,
  /refunds\.create/,
  /charges\.create/,
  /checkout\.sessions\.create/,
  /customers\.create/,
  /setupIntents\.create/,
  /accounts\.createLoginLink/,
  /accounts\.create\b/,
  /accountLinks\.create/,
  /confirmSetup\s*\(/,
];

// Strip /* */ and // comments so prose mentions of a Stripe method (e.g.
// "Call Stripe.accounts.create …") never count as a call site.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function isClassifiedWrite(snippet) {
  return CLASSIFIED_WRITE_PATTERNS.some((p) => p.test(snippet));
}

function evaluateUnknownStripeWrites(files) {
  const offenders = []; // [{ path, snippet }]
  for (const abs of files) {
    let content;
    try {
      content = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const code = stripComments(content);
    const matches = [
      ...code.matchAll(STRIPE_SERVER_WRITE_SHAPE),
      ...code.matchAll(STRIPE_BROWSER_WRITE_SHAPE),
    ];
    for (const m of matches) {
      if (!isClassifiedWrite(m[0])) {
        offenders.push({ path: relPosix(abs), snippet: m[0].trim() });
      }
    }
  }
  if (offenders.length > 0) {
    return {
      ok: false,
      summary: `unclassified Stripe write(s): ${offenders
        .map((o) => `${o.path} [${o.snippet}]`)
        .join(", ")}`,
    };
  }
  return {
    ok: true,
    summary: "no unclassified Stripe writes (all mutating calls are inventoried)",
  };
}

// --------------------------------------------------------------------
// getStripe() binding convention (PR #321)
// --------------------------------------------------------------------
//
// The unclassified-write catch-all above matches `stripe.<ns>.<method>` — it
// only fires when the Stripe client is the variable literally named `stripe`.
// A RENAMED client would evade the ENTIRE inventory (money rules + catch-all):
//   const s = getStripe(); await s.transfers.create(...)      // `s.*` unmatched
//   const client = getStripe(); await client.refunds.create() // `client.*`  "
//   await getStripe().payouts.create(...)                     // inline chain
//   const { paymentIntents } = getStripe();                   // destructured
// So we ENFORCE the convention: every getStripe() CALL must be bound as
// `const stripe = getStripe()` (or `let`). Renamed bindings, destructuring, and
// inline member access are hard failures. With `stripe` enforced, every mutating
// call is `stripe.<ns>.<method>` and is therefore covered by the classified
// rules + the catch-all — which together DENY every dangerous mutating resource
// v1 does not use (transfers, payouts, subscriptions, invoices, applicationFees,
// charges, checkout.sessions). This is the generic deny coverage: not a per-
// resource allowlist (harmless reads like `stripe.invoices.retrieve` stay fine),
// but "any unclassified mutation through the one enforced client name fails".
const GETSTRIPE_CALL_SHAPE = /getStripe\s*\(\s*\)/g;
function evaluateGetStripeBinding(files) {
  const offenders = []; // [{ path, snippet }]
  for (const abs of files) {
    let content;
    try {
      content = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const code = stripComments(content);
    const re = new RegExp(GETSTRIPE_CALL_SHAPE.source, "g");
    let m;
    while ((m = re.exec(code)) !== null) {
      const before = code.slice(Math.max(0, m.index - 48), m.index);
      // The function DEFINITION (`export function getStripe()`) is not a call.
      if (/function\s+$/.test(before)) continue;
      // Canonical binding: `const stripe = getStripe()` / `let stripe = …`.
      if (/\b(?:const|let)\s+stripe\s*=\s*$/.test(before)) continue;
      const snippet = (before.slice(-32) + m[0]).replace(/\s+/g, " ").trim();
      offenders.push({ path: relPosix(abs), snippet });
    }
  }
  if (offenders.length > 0) {
    return {
      ok: false,
      summary:
        "getStripe() must be bound as `const stripe = getStripe()` — a renamed/" +
        "aliased/destructured/inline client evades the write inventory: " +
        offenders.map((o) => `${o.path} [${o.snippet}]`).join(", "),
    };
  }
  return {
    ok: true,
    summary:
      "every getStripe() call binds to `const stripe` (no renamed client can evade the inventory)",
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
  // Hard-fail catch-all: any Stripe write not on the classified list above.
  const unknown = evaluateUnknownStripeWrites(files);
  process.stdout.write(
    `${unknown.ok ? "PASS" : "FAIL"} no-unclassified-stripe-writes: ${unknown.summary}\n`,
  );
  if (!unknown.ok) allOk = false;
  // PR #321: enforce the getStripe() binding convention so a renamed client
  // cannot slip a mutating call past the `stripe.<ns>.<method>` inventory above.
  const binding = evaluateGetStripeBinding(files);
  process.stdout.write(
    `${binding.ok ? "PASS" : "FAIL"} getStripe-binding: ${binding.summary}\n`,
  );
  if (!binding.ok) allOk = false;
  process.stdout.write(
    `\nScanned ${files.length} runtime source file(s) under ${SCAN_ROOTS.join(", ")}.\n`,
  );
  process.exit(allOk ? 0 : 1);
}

main();
