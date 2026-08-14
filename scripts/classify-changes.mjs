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

// ---------------------------------------------------------------------------
// Baseline risk tier (ENGINEERING_STANDARDS.md).
//
// This is DETERMINISTIC PATH EVIDENCE, NOT SEMANTIC PROOF. It cannot see what a
// file does, only where it lives. A file that looks ordinary here may still
// cross a trust boundary in its body, so every session and reviewer performs
// semantic risk judgement on top of this and escalates when warranted. This
// output may never be cited to DE-escalate a change whose behaviour crosses a
// higher-risk boundary. See ENGINEERING_STANDARDS.md §"Automated classification
// is not semantic proof".
//
// Each rule names one distinct failure class and either reuses an existing lane
// key above (so there is ONE path map, not a competing second one) or adds
// patterns for a boundary the lane map does not already isolate.
//
// Reasons are fixed literal strings containing no comma, semicolon or newline,
// so they survive `key=value` emission into $GITHUB_OUTPUT intact.
const TIER_RULES = [
  { tier: "T3", reason: "database migration or DB test surface changed", lane: "database" },
  { tier: "T3", reason: "security or privilege boundary path changed", lane: "security" },
  {
    tier: "T3",
    reason: "payment authority path changed",
    // DELIBERATELY NOT `lane: "payment"`. The CI payment lane matches the bare
    // words "payment"/"stripe" anywhere in a path, which is exactly right for
    // SELECTING tests (if a file mentions payment, run the payment suites) and
    // exactly wrong for assigning engineering ceremony. Under the lane,
    // `components/payment-method-card.tsx` baselined T3 even though it is
    // read-only practitioner UI with no Charge, Replace or Remove control: a
    // copy tweak there would have demanded the heaviest process in the system.
    // That is the speed principle inverted, so the TIER now names the authority
    // surfaces directly and the LANE is left untouched.
    //
    // What counts as authority: the money-moving and Stripe-credential modules,
    // their proof surfaces, and server ACTIONS named for the money they move.
    // Presentation never matches: every action pattern requires `-actions.ts`,
    // so a component cannot be dragged in by its filename. A presentation file
    // that later grows money-moving behaviour is caught by semantic escalation,
    // not by its name.
    //
    // A WORKED EXAMPLE OF THE LIMIT, because it is not hypothetical.
    // `lib/payment-methods/refresh-card-authorization-pointer.ts` baselines T1
    // here: it moves no money and matches no authority path. Its own header
    // calls it "the load-bearing write that closes the audit-trail gap", a
    // service-role write binding a stored card to the consent artefact that
    // authorizes it. A path cannot see that, and widening this rule to the word
    // "payment" to catch it would drag every presenter and copy file back to T3,
    // which is the defect this rule exists to remove. It is escalated by the
    // author under ENGINEERING_STANDARDS.md, which is the mechanism for exactly
    // this case. The tier is a FLOOR, never a ceiling.
    patterns: [
      /^lib\/billing\//,
      /^lib\/stripe\//,
      /^app\/api\/stripe\//,
      /^e2e-payment\//,
      /^tests\/lib\/billing\//,
      /^playwright\.payment\.config\./,
      // `payment-actions.ts` is here on evidence, not on its name: it carries
      // charge, refund and capture paths. `manual-fee` and `quick-checkout` are
      // named for the fee they charge and would otherwise miss every pattern.
      /(billing|checkout|charge|refund|payout|manual-fee|payment)[^/]*-actions\.ts$/i,
    ],
  },
  {
    tier: "T3",
    reason: "authentication or tenancy boundary path changed",
    patterns: [/^app\/\(auth\)\//, /^app\/admin\//, /^middleware\.[cm]?[jt]s$/, /^lib\/supabase\//, /^lib\/admin\.ts$/],
  },
  {
    // Unauthenticated and token-bearing entry points. The studio/client identity
    // is attacker-supplied here, which is why these fail conservatively.
    tier: "T3",
    reason: "public or token-authenticated route changed",
    patterns: [
      /^app\/(book|cancel|reschedule|manage|portal|intake|calendar-feed)\//,
      /^lib\/(portal|intake|calendar-feed)\//,
    ],
  },
  {
    tier: "T3",
    reason: "sensitive-data handling path changed",
    patterns: [/^lib\/(audit|record-keeping|export|rate-limit)\//],
  },
  {
    tier: "T2",
    reason: "business workflow path changed",
    patterns: [
      /^lib\/(booking|calendar|sessions|treatment-plans|treatment-time|clinical-notes|consent|clients|onboarding|import|conversion)\//,
      /^app\/\(app\)\/calendar\//,
    ],
  },
  {
    tier: "T2",
    reason: "external integration or messaging path changed",
    lane: "google_calendar",
    patterns: [/^lib\/(notifications|email|sms|portal-messages)\//, /^app\/api\/twilio\//],
  },
  { tier: "T2", reason: "background job or scheduled task changed", patterns: [/^lib\/cron\//, /^app\/api\/cron\//] },
  {
    tier: "T2",
    reason: "server API or server action boundary changed",
    // Three shapes, because Hone uses three. `app/api/**` and `app/actions/**`
    // are the explicit ones; `*-actions.ts` catches the named-suffix convention.
    // The fourth pattern catches the CONVENTIONAL Next colocated file: a bare
    // `actions.ts` beside the page it serves, e.g. `app/(app)/dashboard/actions.ts`,
    // which is `"use server"` and signs the user out. Without it that file
    // matched no boundary rule and fell to the generic T1 application signal,
    // which is a server action treated as ordinary UI.
    //
    // Anchored to `^app/` on purpose. A bare `/actions\.ts$/` would also sweep in
    // fixtures and any non-app module that happens to use the name, and a rule
    // that fires on unrelated files teaches people to ignore it.
    patterns: [/^app\/api\//, /^app\/actions\//, /-actions\.ts$/, /^app\/.*\/actions\.ts$/],
  },
  { tier: "T2", reason: "CI or build control system changed", lane: "ci_workflows" },
  { tier: "T2", reason: "shared build or runtime configuration changed", patterns: FULL_MATRIX },
];

const TIER_ORDER = ["T0", "T1", "T2", "T3"];

/**
 * Highest applicable deterministic tier wins, independent of the order rules are
 * declared in or matched in. Exported so the max rule is proved directly: today
 * every T3 rule happens to precede every T2 rule, so a first-match
 * implementation would pass every realistic path fixture and only break later,
 * when someone appends a T3 rule below the T2 block.
 */
export const highestTier = (tiers) =>
  tiers.reduce((a, t) => (TIER_ORDER.indexOf(t) > TIER_ORDER.indexOf(a) ? t : a), "T1");

const match = (file, patterns) => patterns.some((re) => re.test(file));

/**
 * Highest applicable deterministic tier wins. `lanes` MUST be the raw per-rule
 * hits, never the post-`full_matrix_required` expansion: that expansion sets
 * every lane true, which would misreport a `package.json` bump as T3.
 *
 * `riskReasons` explains why the baseline landed on the winning tier, so it
 * lists only reasons AT that tier.
 */
function baselineRisk(list, lanes, docsOnly) {
  if (list.length === 0) {
    return { baselineRiskTier: "T3", riskReasons: ["no detectable diff: failing safe to the highest tier"] };
  }
  if (docsOnly) return { baselineRiskTier: "T0", riskReasons: ["documentation and non-runtime files only"] };

  const hits = TIER_RULES.filter(
    (r) => (r.lane && lanes[r.lane]) || (r.patterns && list.some((f) => match(f, r.patterns))),
  );
  if (hits.length === 0) {
    return {
      baselineRiskTier: "T1",
      riskReasons: ["application or interface code with no higher-risk path signal"],
    };
  }
  const tier = highestTier(hits.map((h) => h.tier));
  return { baselineRiskTier: tier, riskReasons: hits.filter((h) => h.tier === tier).map((h) => h.reason) };
}

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
    baselineRiskTier: "T3",
    riskReasons: [],
  };

  if (list.length === 0) {
    // No detectable diff (e.g. a re-run). Be conservative: run everything.
    out.full_matrix_required = true;
    Object.assign(out, baselineRisk(list, {}, false));
    return out;
  }

  for (const rule of RULES) {
    if (list.some((f) => match(f, rule.patterns))) out[rule.key] = true;
  }

  // Snapshot the RAW lane hits before either the docs-only reset or the
  // full-matrix expansion rewrites them. The tier must describe the paths that
  // actually changed, not the lanes CI decided to run as a result.
  const rawLanes = { ...out };

  // Docs-only when EVERY changed file is documentation.
  out.docs_only = list.every((f) => match(f, DOCS));
  Object.assign(out, baselineRisk(list, rawLanes, out.docs_only));
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
  // `$GITHUB_OUTPUT` is newline-delimited, so a value may never contain one.
  const render = (v) => (Array.isArray(v) ? v.join("; ") : String(v)).replace(/\n/g, " ");
  const lines = Object.entries(result).map(([k, v]) => `${k}=${render(v)}`);
  if (process.argv.includes("--github-output") && process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, lines.join("\n") + "\n");
  }
  console.log(lines.join("\n"));
}
