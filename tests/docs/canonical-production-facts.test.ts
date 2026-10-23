import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { currentProse, ignoreMarkers, matchAll } from "./helpers/canonical-facts";

// ---------------------------------------------------------------------------
// CANONICAL PRODUCTION FACTS — the anti-drift guard.
//
// THE FAILURE THIS EXISTS TO PREVENT
//
// Four derived facts — hosted migration max, repo migration max, the next free
// number, and the runtime-bearing production SHA — were hand-copied as prose
// literals into five documents. Nothing failed when a copy diverged, so every
// copy rotted independently and at its own rate. On 2026-08-23 the canonical
// set simultaneously claimed the production migration max was 0165, 0163, 0162,
// 0160 and 0157, while production stood at 0185. `current-state.md` managed
// THREE DIFFERENT NUMBERS IN ONE TABLE CELL.
//
// The derivation already existed. `scripts/migration-state.mjs` was written for
// exactly this and its own header names the incidents ("that happened on 0163,
// 0164 and 0165"). It succeeded for tests and for verify-production.mjs — and
// the canonical PROSE was never migrated onto it. CLAUDE.md §2 already states
// the rule ("Everything else … should reference the canonical record rather
// than repeating a number that changes"). It was policy with no enforcement.
//
// Worse: the previous guard MANDATED the stale number. A test required five
// documents to each assert "production migration max 0165", and it passed for
// the wrong reason — its regex matched a FROZEN HISTORICAL block further down
// the ledger, not the current one. A guard that cannot tell current from
// historical will eventually enforce the wrong one.
//
// WHAT THIS GUARD DOES, AND DELIBERATELY DOES NOT DO
//
// It does NOT ban literal migration numbers. Historical release rows, frozen
// apply records, per-migration descriptions and audit evidence must keep their
// literals — they are evidence of what was true at a point in time and are
// never rewritten.
//
// It targets CURRENT-STATE ASSERTIONS structurally: the sentence shapes that
// claim a number is true NOW. Those may live in exactly one prose location —
// migration-ledger.md's "## Current state" block — where they are validated
// against the canonical record rather than trusted.
//
// Frozen text is excluded by an explicit, auditable marker rather than by
// heuristics, so quoting a superseded claim stays legal and stays visible:
//
//   <!-- canonical-facts:ignore-start reason=why-this-is-historical -->
//   …superseded text, preserved verbatim…
//   <!-- canonical-facts:ignore-end -->
//
// Every marker must carry a reason. Adding one is a deliberate act that shows
// up in review, which is the point.
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const CURRENT_STATE = read("docs/production/current-state.md");
const CAPABILITY_REGISTER = read("docs/production/capability-register.md");
const KNOWN_LIMITATIONS = read("docs/production/known-limitations.md");
const RELEASE_CHANGELOG = read("docs/production/release-changelog.md");
const MIGRATION_LEDGER = read("docs/production/migration-ledger.md");

/** The one machine-readable declaration of hosted state. */
const CANONICAL_RECORD = JSON.parse(read("docs/production/migration-state.json"));

/** Repo state, derived from filenames — never hand-written. */
const DERIVED = JSON.parse(
  execFileSync("node", [path.join(ROOT, "scripts/migration-state.mjs"), "--json"], {
    encoding: "utf8",
    cwd: ROOT,
  }),
);

// ---------------------------------------------------------------------------
// Git access, used by the SHA rules below.
//
// Every helper returns null rather than throwing when git is unavailable or the
// history is shallow. A guard that hard-fails in an environment it cannot read
// teaches people to disable it; one that reports "could not check" keeps the
// rest of the suite meaningful. The rules that depend on these skip explicitly
// and say so, so a permanently-skipping rule is visible rather than silent.
// ---------------------------------------------------------------------------

function git(...args: string[]): string | null {
  try {
    return execFileSync("git", args, { encoding: "utf8", cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

const GIT_AVAILABLE = git("rev-parse", "--git-dir") !== null;
const SHALLOW = git("rev-parse", "--is-shallow-repository") === "true";
const GIT_USABLE = GIT_AVAILABLE && !SHALLOW;

// ---------------------------------------------------------------------------
// CANONICAL FRESHNESS POLICY (Sam, #825 6215529089).
//
// Eight checks below need history. In CI they used to "pass" by asserting that
// they could not run, because validate's checkout was shallow. A check that
// cannot run is now a FAILURE everywhere, never a skip.
//
// A3 and A5 are FRESHNESS facts about production, not about the branch under
// test, so they are measured against the verified production ref, never PR
// HEAD. Whether a stale result BLOCKS depends on CANONICAL_FRESHNESS:
//   enforce (default, and in CI for production-record changes, pushes to
//            production and the nightly unit lane): stale fails;
//   measure (CI for ordinary application PRs only): stale is reported as a
//            distinct non-blocking warning annotation, and the test title says
//            MEASURED, so it can never read as a checked-clean result.
// ---------------------------------------------------------------------------
const FRESHNESS_RAW = process.env.CANONICAL_FRESHNESS ?? "enforce";
const FRESHNESS: "enforce" | "measure" = FRESHNESS_RAW === "measure" ? "measure" : "enforce";
const FRESHNESS_TAG = FRESHNESS === "measure" ? " [MEASURED, non-blocking]" : "";

/** The history prerequisite as a pure decision: null when git is usable. */
export function gitPrerequisiteError(rule: string, available: boolean, shallow: boolean): string | null {
  if (available && !shallow) return null;
  return (
    `${rule} cannot run: ${available ? "this checkout is SHALLOW" : "git is not available"}. ` +
    "A canonical check that cannot run is a failure, not a pass (#825 6215529089). " +
    "Give the job full history (actions/checkout fetch-depth: 0)."
  );
}

/** Unusable git FAILS; it is never a quiet skip. */
function requireUsableGit(rule: string): void {
  if (GIT_USABLE) return;
  const err = gitPrerequisiteError(rule, GIT_AVAILABLE, SHALLOW);
  if (err) throw new Error(err);
}

type Git = (...args: string[]) => string | null;

/** The production branch is a recorded fact; read it from the document. */
function productionBranch(): string | null {
  return (
    currentProse(CURRENT_STATE).match(/\|\s*\*{0,2}Production branch\*{0,2}\s*\|\s*`([^`]+)`/i)?.[1] ??
    null
  );
}

/**
 * The verified production commit. The remote-tracking ref is preferred: on a
 * PR branch only it describes production, and on the production branch it is
 * the same commit. Missing or unresolvable is null, and callers FAIL on null.
 */
export function resolveProductionRef(g: Git, branch: string | null): string | null {
  if (!branch) return null;
  return (
    g("rev-parse", "--verify", "-q", `refs/remotes/origin/${branch}^{commit}`) ??
    g("rev-parse", "--verify", "-q", `refs/heads/${branch}^{commit}`)
  );
}

const RECORD_ONLY = /^docs\/production\//;

/**
 * (iv): every first-parent production commit after the recorded HEAD must
 * change ONLY docs/production/** against its first parent. Decided from the
 * actual changed paths, never from a title or label. Anything that cannot be
 * inspected is NOT record-only.
 */
export function recordOnlySince(
  g: Git,
  recorded: string,
  target: string,
): { ok: true; commits: number } | { ok: false; reason: string } {
  if (recorded === target) return { ok: true, commits: 0 };
  if (g("merge-base", "--is-ancestor", recorded, target) === null) {
    return { ok: false, reason: `recorded HEAD ${recorded.slice(0, 8)} is not an ancestor of production ${target.slice(0, 8)}, or the ancestry cannot be inspected` };
  }
  const listed = g("rev-list", "--first-parent", `${recorded}..${target}`);
  if (listed === null) return { ok: false, reason: "the first-parent history cannot be listed" };
  const commits = listed.split("\n").filter(Boolean);
  for (const c of commits) {
    const parents = g("rev-list", "--parents", "-n", "1", c)?.split(" ") ?? [];
    if (parents.length < 2) return { ok: false, reason: `${c.slice(0, 8)} has no inspectable first parent` };
    // --no-renames: both endpoints, so moving app/x.ts into docs/production/
    // is NOT record-only (Codex P1 4297335910).
    const files = g("diff", "--name-only", "--no-renames", parents[1], c);
    if (files === null) return { ok: false, reason: `${c.slice(0, 8)}'s changed paths cannot be read` };
    const other = files.split("\n").filter(Boolean).filter((f) => !RECORD_ONLY.test(f));
    if (other.length) {
      return { ok: false, reason: `${c.slice(0, 8)} changes ${other.length} non-record path(s), e.g. ${JSON.stringify(other.slice(0, 6))}` };
    }
  }
  return { ok: true, commits: commits.length };
}

/** A3 over the production boundary: runtime-bearing paths changed pinned..target. */
export async function runtimeChangedSince(g: Git, pinned: string, target: string): Promise<string[] | null> {
  // --no-renames: a runtime file MOVED into docs/ is a runtime deletion, and
  // rename detection would report only the docs destination (Codex P1 4297335910).
  const out = g("diff", "--name-only", "--no-renames", pinned, target);
  if (out === null) return null;
  const classify = await loadClassifier();
  return out
    .split("\n")
    .filter(Boolean)
    .filter((f) => nonShippingReason(f) === null && !classify([f]).docs_only);
}

/** A freshness verdict as a pure decision, so both modes are testable. */
export function freshnessOutcome(
  mode: "enforce" | "measure",
  rule: string,
  fresh: boolean,
  detail: string,
): { kind: "fresh" } | { kind: "warn"; line: string } | { kind: "fail"; message: string } {
  if (fresh) return { kind: "fresh" };
  if (mode === "measure") {
    // Existing Actions reporting: a workflow-command annotation on stdout.
    return { kind: "warn", line: `::warning title=Canonical record STALE (non-blocking, ${rule})::${detail.replace(/\s+/g, " ")}` };
  }
  return { kind: "fail", message: `${rule} (enforced): ${detail}` };
}

/**
 * Emit a workflow command so GitHub Actions actually PARSES it. Actions only
 * recognises "::warning" at the very START of a line, and vitest's console
 * interception prefixes output with colour resets ("\e[22m\e[39m::warning"),
 * so console.log silently produced no annotation: a stale record looked like a
 * green job with nothing on the PR (#887). Written straight to fd 1, on its own
 * line, it bypasses that interception.
 */
export function emitWorkflowCommand(line: string, write: (text: string) => void = (t) => writeSync(1, t)): void {
  write(`\n${line}\n`);
}

/** One verdict for a freshness fact: fresh passes; stale fails or warns by mode. */
function freshnessVerdict(rule: string, fresh: boolean, detail: string): void {
  const out = freshnessOutcome(FRESHNESS, rule, fresh, detail);
  if (out.kind === "warn") emitWorkflowCommand(out.line);
  if (out.kind === "fail") expect.fail(out.message);
}

// ---------------------------------------------------------------------------
// RUNTIME-BEARING CLASSIFICATION IS NOT DEFINED HERE.
//
// It was, once: a hand-written path list that omitted instrumentation.ts,
// instrumentation-client.ts, the Sentry edge/server configs, public/, hooks/
// and types/. A commit touching only instrumentation.ts produced an empty diff
// against that list, so A3 passed while the deployed runtime had changed.
//
// The repository already owns this taxonomy - scripts/classify-changes.mjs is
// the same map CI and `npm run ci:plan` use, and CLAUDE.md §3 states outright
// that there is "deliberately no second competing map". A partial copy here
// was exactly that second map. It is gone; the authority is imported.
//
// `classify(files).docs_only` is the repository's own answer to "is this
// documentation". It is NOT the same question as "does this ship", and an
// earlier revision treated the two as equivalent. They come apart on every
// non-shipping non-doc path: the classifier returns docs_only:false for
// `.github/workflows/ci.yml`, `scripts/verify-prepush.mjs` and
// `e2e/foo.spec.ts`, none of which is in the deployed application, so A3 would
// have demanded a fresh runtime baseline for a CI tweak.
//
// The classifier has no "ships" output to borrow, so the deployed decision is:
//
//   DEPLOYED  =  not documentation (asked of the classifier)
//                AND not in a non-shipping root (named below, with reasons)
//
// The roots are a category list, not a path taxonomy: each names a whole class
// of files that CI runs and Vercel never serves. Nothing here re-describes
// WHICH application paths are runtime - that judgement stays entirely with
// scripts/classify-changes.mjs, so `instrumentation.ts`, the Sentry configs,
// `public/`, `hooks/` and `types/` are covered without being listed.
// ---------------------------------------------------------------------------
const NON_SHIPPING_ROOTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^tests\//, "unit, DB and migration tests: run in CI, absent from the bundle"],
  [/^e2e[a-z-]*\//, "Playwright specs and their fixtures: run against a build, never part of one"],
  [/^\.github\//, "workflows and templates: they decide what CI does, not what production serves"],
  // NOTE: scripts/ is NOT blanket-exempt. See PRODUCTION_BUILD_SCRIPTS below -
  // a script the production `build` command executes can change what the
  // deployment does, and is subtracted from this exemption.
  [/^scripts\//, "operator and CI tooling — except those the production build runs"],
  [/^playwright(\.[\w.-]+)?\.config\./, "test-runner configuration"],
  [/^vitest(\.[\w.-]+)?\.config\./, "test-runner configuration"],
  [/^eslint\.config\./, "linter configuration: gates the build, never served by it"],
  // WIKI-AUTO-01. Each changed file is classified ALONE, and only Markdown is
  // docs-only, so OpenWiki's Claim sidecars and run metadata (JSON) counted as
  // runtime: every wiki regeneration would have invalidated a correct pin.
  [/^openwiki\//, "OpenWiki generated docs, Claim sidecars and run metadata: never built or served"],
  [/^\.openwikiignore$/, "OpenWiki read-boundary configuration: never built or served"],
];

/**
 * Scripts the PRODUCTION BUILD executes, derived from package.json.
 *
 * Exempting all of `scripts/` was too broad. `package.json` runs
 * `node scripts/check-production-env-gates.mjs && next build`, so that file
 * decides whether a production build proceeds at all - and these very documents
 * treat its fail-versus-report-only behaviour as a deployed capability fact
 * (known-limitations L25). A change to it after the pinned SHA must invalidate
 * the pin; a change to an operator utility beside it must not.
 *
 * Derived from the repository rather than listed here, so adding a gate to the
 * build brings it under this rule automatically. Scope is deliberately the
 * DIRECT build command: what it shells out to in turn is not traced, and that
 * limit is stated rather than hidden.
 */
function productionBuildScripts(): string[] {
  const pkg = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };
  const build = pkg.scripts?.build ?? "";
  return [...build.matchAll(/\bscripts\/[\w./-]+\.(?:mjs|cjs|js|ts)\b/g)].map((m) => m[0]);
}
const PRODUCTION_BUILD_SCRIPTS = productionBuildScripts();

function nonShippingReason(file: string): string | null {
  if (PRODUCTION_BUILD_SCRIPTS.includes(file)) return null; // the build runs it: it ships
  for (const [re, why] of NON_SHIPPING_ROOTS) if (re.test(file)) return why;
  return null;
}

async function loadClassifier(): Promise<(files: string[]) => { docs_only: boolean }> {
  const mod = await import(path.join(ROOT, "scripts/classify-changes.mjs"));
  return (mod as { classify: (f: string[]) => { docs_only: boolean } }).classify;
}

// ---------------------------------------------------------------------------
// PENDING-RELEASE RECEIPTS (HON-18 39ad5aaf "Production records").
//
// THE LOOP THIS REMOVES. A5 accepted only record-only merges after the
// recorded HEAD, so every other production merge turned its own post-merge
// run red until a dedicated record PR landed: on 2026-10-22 each of #1032,
// #1034, #1030, #1038, #1040, #1042 and #1044 needed its own record merge.
//
// WHAT CHANGES, AND WHAT DOES NOT. A non-record merge after the recorded HEAD
// is now acceptable when it is COVERED: a receipt under
// docs/production/pending-releases/ names it, and git itself confirms every
// claim the receipt makes. Nothing is taken on trust:
//
//   (a) it is a two-parent merge whose subject is GitHub's
//       "Merge pull request #N from ...";
//   (b) the receipt is bound to it - either added BY that merge (the in-PR
//       form, <N>.json absent from its first parent), or naming its exact SHA
//       in `merge` (the late form, for a merge that has already landed);
//   (c) the receipt's `runtime` equals A3's own deployed decision, recomputed
//       on the merge's first-parent diff;
//   (d) its `migrations` equals the supabase/migrations/** paths that diff
//       changes.
//
// A7 bounds the lag, so batching can never defer the narrative indefinitely.
// recordOnlySince and runtimeChangedSince are unchanged; coverage is a second
// acceptance path beside them, never a replacement. The receipt points at the
// operator's release receipt (Vercel READY, smoke), which CI cannot verify
// because workflows hold no deployment credentials: this rule claims git
// facts only, never deployment.
// ---------------------------------------------------------------------------
export const PENDING_RELEASES_DIR = "docs/production/pending-releases";
/** A7: at most this many covered merges after the recorded HEAD. */
export const MAX_COVERED_MERGES = 8;
/** A7: the oldest covered merge may trail the production tip by at most this (git committer time). */
export const MAX_COVERED_LAG_SECONDS = 72 * 60 * 60;

export type PendingReceipt = {
  pr: number;
  merge?: string;
  runtime: boolean;
  migrations: string[];
  release_receipt: string;
};

const RECEIPT_KEYS = new Set(["pr", "merge", "runtime", "migrations", "release_receipt"]);
const MERGE_SUBJECT = /^Merge pull request #(\d+) from /;

/** Strict: an unknown key, a wrong type or a mismatched pointer is malformed, never ignored. */
export function parseReceipt(text: string): { ok: true; receipt: PendingReceipt } | { ok: false; reason: string } {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not valid JSON" };
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return { ok: false, reason: "not a JSON object" };
  const o = v as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !RECEIPT_KEYS.has(k));
  if (extra.length) return { ok: false, reason: `unknown key(s) ${JSON.stringify(extra)}` };
  if (!Number.isInteger(o.pr) || (o.pr as number) <= 0) return { ok: false, reason: "pr must be a positive integer" };
  if (o.merge !== undefined && !(typeof o.merge === "string" && /^[0-9a-f]{40}$/.test(o.merge))) {
    return { ok: false, reason: "merge, when present, must be a full 40-character SHA" };
  }
  if (typeof o.runtime !== "boolean") return { ok: false, reason: "runtime must be true or false" };
  if (!Array.isArray(o.migrations) || !o.migrations.every((m) => typeof m === "string")) {
    return { ok: false, reason: "migrations must be an array of paths" };
  }
  if (o.release_receipt !== `01-ops/${o.pr}-release-receipt.json`) {
    return { ok: false, reason: `release_receipt must be 01-ops/${o.pr}-release-receipt.json` };
  }
  return { ok: true, receipt: o as unknown as PendingReceipt };
}

/** What a merge actually is, recomputed from git. Null when it cannot be inspected. */
async function mergeFacts(
  g: Git,
  c: string,
): Promise<{ parents: number; pr: number | null; firstParent: string | null; runtime: boolean; migrations: string[] } | null> {
  const parents = g("rev-list", "--parents", "-n", "1", c)?.split(" ").slice(1) ?? null;
  if (parents === null) return null;
  const subject = g("log", "-1", "--format=%s", c);
  if (subject === null) return null;
  const pr = subject.match(MERGE_SUBJECT)?.[1];
  const firstParent = parents[0] ?? null;
  const files = firstParent ? g("diff", "--name-only", "--no-renames", firstParent, c) : null;
  if (files === null) return null;
  const list = files.split("\n").filter(Boolean);
  const classify = await loadClassifier();
  return {
    parents: parents.length,
    pr: pr ? Number(pr) : null,
    firstParent,
    // A3's deployed decision, applied to this merge alone.
    runtime: list.some((f) => nonShippingReason(f) === null && !classify([f]).docs_only),
    migrations: list.filter((f) => f.startsWith("supabase/migrations/")).sort(),
  };
}

/** Is first-parent commit `c` covered by a receipt that git confirms? */
export async function receiptCoverage(
  g: Git,
  c: string,
  late: readonly PendingReceipt[],
): Promise<{ ok: true; runtime: boolean } | { ok: false; reason: string }> {
  const at = c.slice(0, 8);
  const facts = await mergeFacts(g, c);
  if (!facts) return { ok: false, reason: `${at} cannot be inspected` };
  if (facts.parents !== 2 || !facts.firstParent) return { ok: false, reason: `${at} is not a two-parent merge` };
  if (facts.pr === null) return { ok: false, reason: `${at} is not a GitHub pull-request merge` };

  let receipt: PendingReceipt | null = null;
  const named = late.filter((r) => r.merge === c);
  if (named.length > 1) return { ok: false, reason: `${at} is named by ${named.length} late receipts` };
  if (named.length === 1) {
    receipt = named[0];
  } else {
    // The in-PR form must have been ADDED by this merge: a receipt already
    // present before it is a reused or backdated one (N3).
    const file = `${PENDING_RELEASES_DIR}/${facts.pr}.json`;
    const text = g("show", `${c}:${file}`);
    if (text === null) return { ok: false, reason: `${at} (#${facts.pr}) has no receipt` };
    if (g("cat-file", "-e", `${facts.firstParent}:${file}`) !== null) {
      return { ok: false, reason: `${at}: ${file} already existed before this merge, so it does not cover it` };
    }
    const parsed = parseReceipt(text);
    if (!parsed.ok) return { ok: false, reason: `${at}: ${file} is malformed: ${parsed.reason}` };
    if (parsed.receipt.merge !== undefined && parsed.receipt.merge !== c) {
      return { ok: false, reason: `${at}: ${file} names a different merge` };
    }
    receipt = parsed.receipt;
  }
  if (receipt.pr !== facts.pr) return { ok: false, reason: `${at} merges #${facts.pr} but its receipt is for #${receipt.pr}` };
  if (receipt.runtime !== facts.runtime) {
    return { ok: false, reason: `${at}'s receipt says runtime:${receipt.runtime}, but its diff is runtime:${facts.runtime}` };
  }
  const declared = [...receipt.migrations].sort();
  if (JSON.stringify(declared) !== JSON.stringify(facts.migrations)) {
    return { ok: false, reason: `${at}'s receipt declares migrations ${JSON.stringify(declared)}, but it changes ${JSON.stringify(facts.migrations)}` };
  }
  return { ok: true, runtime: facts.runtime };
}

/**
 * A5 with receipts: every first-parent commit after the recorded HEAD is
 * record-only (exactly recordOnlySince's rule, asked one commit at a time) or
 * receipt-covered. Anything else is stale, with the same reasons as before.
 */
export async function coveredSince(
  g: Git,
  recorded: string,
  target: string,
  late: readonly PendingReceipt[],
): Promise<{ ok: true; commits: number; covered: string[] } | { ok: false; reason: string }> {
  if (recorded === target) return { ok: true, commits: 0, covered: [] };
  if (g("merge-base", "--is-ancestor", recorded, target) === null) {
    return { ok: false, reason: `recorded HEAD ${recorded.slice(0, 8)} is not an ancestor of production ${target.slice(0, 8)}, or the ancestry cannot be inspected` };
  }
  const listed = g("rev-list", "--first-parent", `${recorded}..${target}`);
  if (listed === null) return { ok: false, reason: "the first-parent history cannot be listed" };
  const commits = listed.split("\n").filter(Boolean);
  const covered: string[] = [];
  for (const c of commits) {
    const parent = g("rev-parse", "-q", "--verify", `${c}^1`);
    if (parent !== null && recordOnlySince(g, parent, c).ok) continue;
    const cov = await receiptCoverage(g, c, late);
    if (!cov.ok) return { ok: false, reason: `${c.slice(0, 8)} is neither record-only nor receipt-covered: ${cov.reason}` };
    covered.push(c);
  }
  return { ok: true, commits: commits.length, covered };
}

/**
 * A3 with receipts: every first-parent commit after the pin whose own diff is
 * runtime-bearing is covered by a receipt that says runtime:true. Only asked
 * when runtimeChangedSince is non-empty, so A3's unchanged fast path decides
 * every case it decided before.
 */
export async function runtimeCoveredSince(
  g: Git,
  pinned: string,
  target: string,
  late: readonly PendingReceipt[],
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const listed = g("rev-list", "--first-parent", `${pinned}..${target}`);
  if (listed === null) return { ok: false, reason: "the first-parent history cannot be listed" };
  for (const c of listed.split("\n").filter(Boolean)) {
    const parent = g("rev-parse", "-q", "--verify", `${c}^1`);
    if (parent === null) return { ok: false, reason: `${c.slice(0, 8)} has no inspectable first parent` };
    const shipped = await runtimeChangedSince(g, parent, c);
    if (shipped === null) return { ok: false, reason: `${c.slice(0, 8)}'s changed paths cannot be read` };
    if (shipped.length === 0) continue;
    const cov = await receiptCoverage(g, c, late);
    if (!cov.ok) return { ok: false, reason: `${c.slice(0, 8)} ships ${JSON.stringify(shipped.slice(0, 6))} and is not covered: ${cov.reason}` };
  }
  return { ok: true };
}

/** A7: batching is bounded in merges and in git time, so it cannot defer the record forever. */
export function coveredLag(
  g: Git,
  covered: readonly string[],
  target: string,
): { ok: true } | { ok: false; reason: string } {
  if (covered.length > MAX_COVERED_MERGES) {
    return { ok: false, reason: `${covered.length} receipt-covered merges follow the recorded HEAD; the bound is ${MAX_COVERED_MERGES}` };
  }
  if (covered.length === 0) return { ok: true };
  const time = (c: string) => Number(g("log", "-1", "--format=%ct", c));
  const tip = time(target);
  const oldest = Math.min(...covered.map(time));
  if (!Number.isFinite(tip) || !Number.isFinite(oldest)) return { ok: false, reason: "commit times cannot be read" };
  if (tip - oldest > MAX_COVERED_LAG_SECONDS) {
    return { ok: false, reason: `the oldest receipt-covered merge trails production by ${Math.round((tip - oldest) / 3600)}h; the bound is ${MAX_COVERED_LAG_SECONDS / 3600}h` };
  }
  return { ok: true };
}

/**
 * Every receipt the guard may use: the checkout's files and production's.
 * A file that does not parse FAILS here; it is never silently skipped.
 */
function loadLateReceipts(target: string | null): PendingReceipt[] {
  const texts = new Map<string, string>();
  const dir = path.join(ROOT, PENDING_RELEASES_DIR);
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    names = [];
  }
  for (const f of names) texts.set(`checkout:${f}`, readFileSync(path.join(dir, f), "utf8"));
  if (target) {
    const listed = git("ls-tree", "--name-only", `${target}:${PENDING_RELEASES_DIR}`);
    for (const f of (listed ?? "").split("\n").filter((n) => n.endsWith(".json"))) {
      const text = git("show", `${target}:${PENDING_RELEASES_DIR}/${f}`);
      if (text !== null) texts.set(`production:${f}`, text);
    }
  }
  const out: PendingReceipt[] = [];
  for (const [where, text] of texts) {
    const parsed = parseReceipt(text);
    if (!parsed.ok) throw new Error(`pending-release receipt ${where} is malformed: ${parsed.reason}`);
    if (parsed.receipt.merge) out.push(parsed.receipt);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Frozen-region handling
// ---------------------------------------------------------------------------

// currentProse / ignoreMarkers / matchAll live in ./helpers/canonical-facts so
// that this guard and tests/docs/clinical-finalization-retired.test.ts share ONE
// definition of which text is current. See that module for the marker contract.

// ---------------------------------------------------------------------------
// Rule 1 — current migration-max assertions
// ---------------------------------------------------------------------------

/**
 * Sentence shapes that assert a migration maximum AS CURRENT FACT.
 *
 * Each requires an assertive connective ("is", "are", "=", ":", or a table
 * cell boundary) between the subject and a four-digit version. A retrospective
 * mention — "the 0160/0163/0165 divergence", "migration 0185 is applied" — is
 * not an assertion of a maximum and is deliberately not matched.
 */
const CURRENT_MAX_PATTERNS: readonly RegExp[] = [
  // "production migration max is 0165" · "hosted max = 0163" · "repo max: 0185"
  /\b(?:production|hosted|repository|repo)\b[^.\n|]{0,30}\bmax(?:imum)?\b\s*(?:\bis\b|\bare\b|=|:)\s*(?:\bnow\b\s*)?\*{0,2}`?(0\d{3})\b/gi,
  // table row: | **Hosted (production) migration max** | **0185** … |
  //            | **Production migration max** | **0165** … |
  /\|\s*\*{0,2}(?:Hosted|Production|Repo(?:sitory)?)[^|]{0,40}migration\s+max\*{0,2}\s*\|\s*\*{0,2}`?(0\d{3})\b/gi,
  // "migration max is now 0157" · "production max is now 0157"
  /\b(?:migration|production|hosted|repo(?:sitory)?)\s+max\b[^.\n]{0,20}\bis\s+now\b\s*\*{0,2}`?(0\d{3})\b/gi,
  // "repository max and hosted max are both `0163`"
  /\bmax\b[^.\n]{0,40}\bare\s+both\b\s*\*{0,2}`?(0\d{3})\b/gi,
  // "Hosted max = repo max = **0169**"
  /\bmax\b\s*=\s*(?:\w+\s+max\s*=\s*)?\*{0,2}`?(0\d{3})\b/gi,
];

/**
 * CURRENT-POSITION assertions that never say "max".
 *
 * Every pattern above requires the literal word `max`, so "Production is
 * currently at migration 0165" and "Hosted production stands at 0165" asserted
 * exactly the fact this guard exists to ban and sailed straight through.
 *
 * The fix is NOT a growing phrase list. It is one shape: a SUBJECT from a
 * closed set, a POSITION VERB from a closed set, and a four-digit version -
 * with the whole thing confined to a single clause so an unrelated sentence
 * cannot be stitched into a false match. Both vocabularies are small and
 * closed on purpose; adding to them should feel like a decision.
 */
const POSITION_SUBJECT = String.raw`(?:production|hosted|repo(?:sitory)?|current\s+hosted|current\s+production)`;
// PRESENT TENSE ONLY. `was` is deliberately absent: "it read 0160 while
// production was at 0185" is a narrative ABOUT past drift, which these
// documents must be free to tell. Past tense is the marker of history, not of
// a current assertion, and banning it would turn the guard into a number ban.
// The set covers the ways a CURRENT POSITION gets stated, not every way English
// can join a subject to a number. It grew once, from six verbs to these, when
// "Production currently runs migration 0165" and "Production has reached
// migration 0165" both walked through - the first because `runs` was missing,
// the second because a present perfect reads as current. Still closed; adding
// to it should feel like a decision.
const POSITION_VERB = String.raw`(?:is|are|sits|stands|remains|rests|runs|run|has\s+reached|have\s+reached|reaches)`;
const CURRENT_POSITION_PATTERNS: readonly RegExp[] = [
  // "Production is currently at migration 0165" · "Hosted production stands at 0165"
  new RegExp(
    String.raw`\b${POSITION_SUBJECT}\b[^.\n|;]{0,30}?(?:\bnow\b|\bcurrently\b)?\s*\b${POSITION_VERB}\b\s*(?:\bnow\b|\bcurrently\b)?\s*(?:\bat\b|\bon\b)?\s*(?:\bmigration\b\s*)?\*{0,2}\`?(0\d{3})\b`,
    "gi",
  ),
  // "Current hosted migration is 0165" · "the production migration is now 0165"
  new RegExp(
    String.raw`\b(?:current|hosted|production|repo(?:sitory)?)\b[^.\n|;]{0,24}?\bmigration\b\s*${POSITION_VERB}\s*(?:\bnow\b|\bcurrently\b)?\s*\*{0,2}\`?(0\d{3})\b`,
    "gi",
  ),
];

/** "next free / next migration number is 0186" — a derived fact, never prose. */
const NEXT_FREE_PATTERNS: readonly RegExp[] = [
  /\bnext\s+(?:free\s+)?migration\s+(?:number\s+)?(?:\bis\b|=|:)\s*\*{0,2}`?(0\d{3})\b/gi,
  /\bnext\s+free\s+(?:migration\s+)?number\s+(?:\bis\b|=|:)\s*\*{0,2}`?(0\d{3})\b/gi,
];

export const findCurrentMaxAssertions = (t: string) =>
  matchAll(t, [...CURRENT_MAX_PATTERNS, ...CURRENT_POSITION_PATTERNS]);
export const findNextFreeAssertions = (t: string) => matchAll(t, NEXT_FREE_PATTERNS);

// ---------------------------------------------------------------------------
// Rule 2 — superseded whole-session-copy exercise claims
// ---------------------------------------------------------------------------

const STALE_EXERCISE_PATTERNS: readonly RegExp[] = [
  /session_copy_operations`?[^.\n]{0,40}(?:=|holds)\s*\*{0,2}`?0\s*rows/gi,
  /whole-session\s+copy\b[^.\n]{0,120}\b(?:NOT|never)\s+production[\s-]exercis/gi,
  /Production\s+exercise:\s*\*{0,2}none/gi,
];

/**
 * "NOT production exercised" as a bare status word.
 *
 * This is checked ONLY inside whole-session-copy context. The phrase is a
 * legitimate and necessary status for capabilities that genuinely have not run
 * — retired clinical corrections, and WAIT-02B Stage A, both correctly carry
 * it today. Banning it outright would push the register toward vagueness about
 * real dormancy, which is the opposite of what this guard is for.
 */
const BARE_UNEXERCISED = /\b(?:NOT|never)\s+production[\s-]exercised\b/gi;

/**
 * The section(s) headed "Whole-session copy".
 *
 * Scoped by HEADING, not by any line that happens to mention the phrase. The
 * capability-register summary legitimately writes "never production-exercised"
 * as a BUCKET LABEL on the same line as "Whole-session copy has left this
 * bucket" — a true sentence that a line-level match would flag. Prose claims
 * outside these sections are still caught by the subject-adjacent pattern
 * above, which requires the subject to come first.
 */
function wholeSessionCopyContext(doc: string): string {
  const lines = doc.split("\n");
  const out: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (/^#{2,3}\s/.test(line)) inSection = /whole-session copy/i.test(line);
    if (inSection) out.push(line);
  }
  return out.join("\n");
}

export const findStaleExerciseClaims = (t: string) => [
  ...matchAll(t, STALE_EXERCISE_PATTERNS),
  ...matchAll(wholeSessionCopyContext(t), [BARE_UNEXERCISED]),
];

/**
 * L2's heading is preserved verbatim as the historical title of a closed
 * limitation — the file's own convention, shared with L18 and L23. It is legal
 * ONLY while it is marked CLOSED on the same line. Strip the marker and the
 * heading becomes an active false claim again.
 */
const L2_TITLE = /^##\s+L2\s+—\s+No real production whole-session copy has ever been performed.*$/m;

// ---------------------------------------------------------------------------
// Rule 3 — synthetic rows presented as real-customer activity
// ---------------------------------------------------------------------------

/**
 * Every tenant row in §0, by slug, read from the register itself.
 *
 * The trap this exists to close: subtracting the Synthetic Twin from the
 * all-tenant totals does NOT yield real-customer activity, because the
 * controlled test studio is still in the remainder. §0 says so in words; this
 * makes the arithmetic checkable. A sentence claiming "real-customer activity:
 * 79 clients, 241 appointments" is false for exactly that reason, and the
 * earlier guard - which was handed only the all-tenant pair - passed it.
 */
function tenantRow(slug: string): number[] | null {
  const row = currentProse(CURRENT_STATE)
    .split("\n")
    .find((l) => l.includes(`\`${slug}\``) && l.trim().startsWith("|"));
  if (!row) return null;
  return [...row.matchAll(/\|\s*\*{0,2}(\d+)\*{0,2}\s*(?=\|)/g)].map((m) => Number(m[1]));
}

/** The all-tenant totals, read from the register itself rather than hardcoded. */
function allTenantTotals(): { clients: number; appointments: number } {
  const row = currentProse(CURRENT_STATE)
    .split("\n")
    .find((l) => /^\|\s*\*{0,2}All tenants/i.test(l));
  expect(row, "current-state §0 must carry an All tenants row").toBeTruthy();
  const nums = [...(row as string).matchAll(/\*\*(\d+)\*\*/g)].map((m) => Number(m[1]));
  expect(
    nums.length,
    "the All tenants row must state clients and appointments in bold",
  ).toBeGreaterThanOrEqual(2);
  return { clients: nums[0], appointments: nums[1] };
}

/**
 * An all-tenant total quoted inside a real-customer sentence. This is the
 * arithmetic trap the Synthetic Twin creates: the number is right and the
 * label is wrong.
 */
export function findSyntheticAsCustomer(text: string, totals: number[]): string[] {
  const hits: string[] = [];
  for (const line of text.split("\n")) {
    if (!/\b(?:real[\s-]customer|customer activity|Willow)\b/i.test(line)) continue;
    // A line may legally NAME a forbidden figure in order to LABEL or DISCLAIM
    // it. §0's own reading rule does exactly that: it names the Twin-subtracted
    // remainder precisely to say the remainder is not customer activity. The
    // exemption is therefore "is this line disclaiming?", not a list of the
    // three sentences that happened to exist when it was written - a
    // disclaimer being flagged as the claim it warns against is a false
    // positive that teaches people to delete the warning.
    const LABELLED = /\ball[\s-]tenants?\b|\bincludes?\s+synthetic\b/i;
    // `remainder` used to sit in this set on its own, which let a false claim
    // pass by using the very noun the rule polices:
    //   "Real-customer activity is the remainder: 79 clients and 241 appointments"
    // A line naming a forbidden figure must NEGATE it, not merely mention the
    // category. §0's genuine warning still qualifies - it says "not the same as
    // real-customer" and "Never present it as customer activity".
    const DISCLAIMED =
      /\bnot\b[^.]{0,48}\bcustomer\b|\bnever\s+present\b|\bis not the same as\b|\bnot\b[^.]{0,32}\bremainder\b/i;
    if (LABELLED.test(line) || DISCLAIMED.test(line)) continue;
    for (const total of totals) {
      if (new RegExp(`\\b${total}\\b`).test(line)) {
        hits.push(line.replace(/\s+/g, " ").trim().slice(0, 140));
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// The ledger's ONE current block
// ---------------------------------------------------------------------------

/**
 * migration-ledger.md is the single prose location permitted to state current
 * migration numbers, because it is the ledger. Its "## Current state" heading
 * bounds that block; every "## Previous state" block below it is frozen
 * history and is excluded.
 */
function ledgerCurrentBlock(): string {
  const lines = MIGRATION_LEDGER.split("\n");
  const start = lines.findIndex((l) => /^##\s+Current state\b/.test(l));
  expect(start, "migration-ledger.md must carry a '## Current state' block").toBeGreaterThan(-1);
  const rest = lines.slice(start + 1);
  const offset = rest.findIndex((l) => l.startsWith("## "));
  return lines.slice(start, offset === -1 ? undefined : start + 1 + offset).join("\n");
}

const NO_CURRENT_MAX_DOCS = [
  ["docs/production/current-state.md", CURRENT_STATE],
  ["docs/production/capability-register.md", CAPABILITY_REGISTER],
  ["docs/production/known-limitations.md", KNOWN_LIMITATIONS],
] as const;

/** The changelog's preamble: everything above the first `## ` heading. */
function changelogPreamble(): string {
  const idx = RELEASE_CHANGELOG.indexOf("\n## ");
  return idx === -1 ? RELEASE_CHANGELOG : RELEASE_CHANGELOG.slice(0, idx);
}

// ===========================================================================

describe("canonical production docs: no independently hardcoded CURRENT migration state", () => {
  it("current-state, capability-register and known-limitations assert no current migration max", () => {
    for (const [name, doc] of NO_CURRENT_MAX_DOCS) {
      const hits = findCurrentMaxAssertions(currentProse(doc));
      expect(
        hits,
        `${name} states a current migration maximum in prose. Reference ` +
          `docs/production/migration-state.json (hosted) or npm run migration:state ` +
          `(repo/next-free) instead. Offending text: ${JSON.stringify(hits)}`,
      ).toEqual([]);
    }
  });

  it("none of those three states a next-free migration number either", () => {
    for (const [name, doc] of NO_CURRENT_MAX_DOCS) {
      const hits = findNextFreeAssertions(currentProse(doc));
      expect(
        hits,
        `${name} states a next-free migration number, which is derived and goes ` +
          `stale on the next apply. Offending text: ${JSON.stringify(hits)}`,
      ).toEqual([]);
    }
  });

  it("the release-changelog PREAMBLE presents no current migration max or head", () => {
    const preamble = currentProse(changelogPreamble());
    expect(
      findCurrentMaxAssertions(preamble),
      "the changelog preamble must not restate the current migration max — it read " +
        "'the production migration max is 0157' long after production moved past it",
    ).toEqual([]);
    expect(findNextFreeAssertions(preamble)).toEqual([]);
    expect(
      preamble,
      "the changelog preamble must not pin a runtime-bearing head either; " +
        "current state lives in current-state.md",
    ).not.toMatch(/runtime-bearing head is\s*\*{0,2}`?[0-9a-f]{6,}/i);
  });

  it("HISTORICAL migration literals remain legal — this guard bans assertions, not numbers", () => {
    // The changelog's historical rows and the ledger's frozen blocks keep their
    // literals. If this ever fails, the guard has become a number ban and will
    // be switched off by the first person it obstructs.
    expect(RELEASE_CHANGELOG).toMatch(/\*\*0157\*\*/);
    expect(MIGRATION_LEDGER).toMatch(/\|\s*\*\*Hosted \(production\) migration max\*\*\s*\|\s*\*\*0165\*\*/);
    expect(
      MIGRATION_LEDGER.match(/^##\s+Previous state\b/gm)?.length ?? 0,
      "the ledger's frozen history must survive intact",
    ).toBeGreaterThan(5);
  });
});

describe("canonical production docs: the ledger's current block agrees with the canonical record", () => {
  const block = ledgerCurrentBlock();

  it("states the hosted max declared in migration-state.json", () => {
    const hosted = block.match(
      /\|\s*\*\*Hosted \(production\) migration max\*\*\s*\|\s*\*\*(\d{4})\*\*/,
    );
    expect(hosted, "the current block must carry a hosted-max row").toBeTruthy();
    expect(
      hosted?.[1],
      "the ledger's CURRENT hosted max must equal migration-state.json — the previous " +
        "guard matched a frozen historical block instead and passed while 20 migrations " +
        "of drift accumulated",
    ).toBe(CANONICAL_RECORD.hosted_migration_max);
  });

  it("states the repo max derived from filenames", () => {
    const repo = block.match(/\|\s*\*\*Repo migration max\*\*\s*\|\s*\*\*(\d{4})\*\*/);
    expect(repo, "the current block must carry a repo-max row").toBeTruthy();
    expect(repo?.[1]).toBe(DERIVED.repo_migration_max);
  });

  it("states the derived next free number, and never claims it", () => {
    const next = block.match(/Next free number is \*\*(\d{4})\*\*/);
    expect(next, "the current block must state the next free number").toBeTruthy();
    expect(Number(next?.[1])).toBe(DERIVED.next_free_migration_number);
    expect(
      block,
      "an available number must be recorded as NOT claimed, so a later reader cannot " +
        "mistake availability for allocation",
      ).toMatch(/not claimed/i);
  });

  // ---------------------------------------------------------------------
  // PARITY IS PENDING-AWARE, BECAUSE MIGRATION-FIRST DEPLOYMENT REQUIRES IT.
  //
  // The old invariant was `repo_migration_max === hosted_migration_max`. It
  // cannot coexist with the runbook this repository actually follows: a
  // migration is applied to production FROM the exact reviewed PR head, BEFORE
  // that PR merges. Between authoring and applying, the repo legitimately sits
  // ABOVE hosted, so NO pre-apply head of such a PR could ever satisfy it.
  //
  // That is not a hypothetical. The 0188 apply record states it as recorded
  // history: exactly one test failed out of 12,908 on the reviewed head —
  // this one — and the operator had to waive that specific red in writing to
  // authorize the apply. The record's own conclusion is quoted in it: "THE
  // GUARD SHOULD BE MADE PENDING-AWARE so a future migration-first apply is
  // not forced to choose between a red head and pre-filling this file."
  //
  // Waiving it again would be the third time. Pre-filling the canonical record
  // with an apply that has not happened would be a lie. So the invariant is
  // restated to admit EXACTLY TWO legal shapes and nothing else:
  //
  //   PARITY                 nothing pending, and hosted == repo
  //   MIGRATION-FIRST PENDING  hosted is the applied PREFIX, and the repo
  //                            carries a CONTIGUOUS pending suffix that
  //                            `pending_migrations` names exactly
  //
  // Both shapes forbid a remote-only migration (hosted ahead of repo), which is
  // the genuinely dangerous state the original guard existed to catch — and
  // which the equality caught only incidentally.
  // ---------------------------------------------------------------------
  it("the canonical record and the derived state agree about HOSTED state", () => {
    // Unconditional, and unchanged in force: the hosted head is DECLARED, never
    // derived from filenames, so these two must never disagree.
    expect(DERIVED.hosted_migration_max).toBe(CANONICAL_RECORD.hosted_migration_max);
  });

  it("repo/hosted is either PARITY or MIGRATION-FIRST PENDING, never anything else", () => {
    const repo = Number(DERIVED.repo_migration_max);
    const hosted = Number(DERIVED.hosted_migration_max);
    const pending: string[] = DERIVED.pending_migrations;

    // NEVER a remote-only migration. Production holding something the
    // repository does not is unreviewable and unreproducible, and it is the
    // one shape neither mode admits.
    expect(
      hosted,
      "hosted is AHEAD of the repository: production holds a migration this " +
        "repo does not contain, which no review can reach",
    ).toBeLessThanOrEqual(repo);

    if (pending.length === 0) {
      // PARITY.
      expect(repo).toBe(hosted);
    } else {
      // MIGRATION-FIRST PENDING.
      expect(repo).toBeGreaterThan(hosted);
      // `pending_migrations` must name the suffix EXACTLY — every version
      // above hosted, in order, and nothing else. A pending list that is
      // merely non-empty would let a gap or a stale entry through.
      const expectedSuffix = DERIVED.versions.filter((v: string) => Number(v) > hosted);
      expect(pending).toEqual(expectedSuffix);
      // CONTIGUOUS: hosted + 1 … repo, allowing for permanently-skipped slots.
      const skipped = new Set(DERIVED.permanently_skipped.map((v: string) => Number(v)));
      const contiguous: string[] = [];
      for (let n = hosted + 1; n <= repo; n += 1) {
        if (!skipped.has(n)) contiguous.push(String(n).padStart(4, "0"));
      }
      expect(
        pending,
        "the pending suffix has a HOLE in it: a migration between the hosted " +
          "head and the repo max is missing from the repository",
      ).toEqual(contiguous);
      // The repo max is itself the last pending entry.
      expect(pending[pending.length - 1]).toBe(DERIVED.repo_migration_max);
    }
  });

  it("the ledger's current block never claims parity while something is pending", () => {
    // THE LEDGER HALF. The derived state can be honest while the prose still
    // says "hosted == repo. Nothing pending." from a previous release — the
    // drift that made this file red after the 0188 apply.
    if (DERIVED.pending_migrations.length === 0) return;
    expect(
      block,
      "the current ledger block claims parity while migrations are pending",
    ).not.toMatch(/hosted == repo/i);
    expect(
      block,
      "the current ledger block claims nothing is pending while migrations are pending",
    ).not.toMatch(/Nothing pending/i);
    // ...and it must name the pending suffix rather than merely omitting the
    // parity claim.
    for (const v of DERIVED.pending_migrations) {
      expect(block, `the current block does not name pending migration ${v}`).toContain(v);
    }
  });

  // -----------------------------------------------------------------------
  // THE OTHER HALF, WHICH THIS SUITE PREVIOUSLY ONLY CLAIMED TO HAVE.
  //
  // The rule above is named for every document and inspects ONE: the ledger's
  // current block. So while it passed, current-state.md still said the two
  // states reconciled "with nothing pending" and known-limitations.md said they
  // were "at parity, with nothing pending" — both false against a recorded
  // repo > hosted, and both invisible to this suite.
  //
  // The durable law is NOT "say the right numbers everywhere". It is the one
  // these documents already apply to migration NUMBERS: outside the ledger,
  // canonical current prose does not carry its own copy of a mutable migration
  // fact — and the RELATIONSHIP between repo and hosted is exactly as mutable as
  // the numbers are. Those documents reference the declared and derived
  // authorities instead.
  //
  // THE LEDGER IS DELIBERATELY EXEMT FROM THIS RULE: stating the current
  // relationship, with apply evidence, is its whole job, and its historical
  // blocks legitimately record the parity that held when each apply landed.
  // -----------------------------------------------------------------------
  const MUTABLE_RELATIONSHIP_CLAIMS: ReadonlyArray<{ label: string; re: RegExp }> = [
    {
      label: "asserts repo and hosted are at parity / reconcile",
      re: /\brepo(sitory)?\b[^.]{0,40}\band hosted\b[^.]{0,80}\b(are at parity|at parity|reconciles?|reconciled)\b/i,
    },
    {
      label: "asserts nothing is pending",
      re: /\b(migration|repo(sitory)?|hosted)\b[^.]{0,120}\bnothing pending\b/i,
    },
    { label: "asserts no migrations are pending", re: /\bno migrations?\s+(are\s+)?pending\b/i },
    {
      // SYMMETRIC ON PURPOSE. The first draft matched only `hosted == repo`, so
      // the equally natural `repo == hosted` spelling slipped through and the
      // rule could pass with the very assertion it forbids still in a document.
      // One expression rather than two copies, so the two orders cannot drift.
      label: "asserts repo and hosted are equal (either operand order)",
      re: /\b(hosted\s*={1,3}\s*repo(sitory)?|repo(sitory)?\s*={1,3}\s*hosted)\b/i,
    },
    {
      label: "asserts a repo/hosted inequality (either operand order)",
      re: /\b(repo(sitory)?\s*[<>]\s*hosted|hosted\s*[<>]\s*repo(sitory)?)\b/i,
    },
    {
      label: "names a specific pending migration",
      re: /\b0\d{3}\b[^.]{0,60}\bis\s+(currently\s+)?pending\b/i,
    },
  ];

  /** Whitespace-flattened current prose, so a claim wrapped across lines still matches. */
  const flatCurrent = (doc: string) => currentProse(doc).replace(/\s+/g, " ");

  const NON_LEDGER_CANONICAL: ReadonlyArray<[string, string]> = [
    ["current-state.md", CURRENT_STATE],
    ["capability-register.md", CAPABILITY_REGISTER],
    ["known-limitations.md", KNOWN_LIMITATIONS],
    ["release-changelog.md (preamble)", changelogPreamble()],
  ];

  function relationshipClaims(text: string): string[] {
    const flat = text.replace(/\s+/g, " ");
    return MUTABLE_RELATIONSHIP_CLAIMS.filter((c) => c.re.test(flat)).map((c) => c.label);
  }

  it("NO canonical current prose outside the ledger copies the migration relationship", () => {
    for (const [name, doc] of NON_LEDGER_CANONICAL) {
      expect(
        relationshipClaims(flatCurrent(doc)),
        `${name} carries its own copy of a mutable migration-state relationship; ` +
          `reference migration-state.json / npm run migration:state / migration-ledger.md instead`,
      ).toEqual([]);
    }
  });

  it("NEGATIVE CONTROL: each stale shape is caught, in EVERY document collection", () => {
    // Mutates copies; no file is touched. Without this the rule above could be
    // satisfied by a regex that matches nothing at all.
    const shapes = [
      "Repo and hosted migration state are at parity, with nothing pending.",
      "Repository and hosted migration state reconcile, with nothing pending and nothing remote-only.",
      "There are no migrations pending.",
      "Migration state: hosted == repo.",
      "Migration state: repo == hosted.",
      "Migration state: repository == hosted.",
      "Migration state: repo > hosted.",
      "Migration state: hosted < repo.",
    ];
    for (const shape of shapes) {
      expect(relationshipClaims(shape), `not caught: ${shape}`).not.toEqual([]);
    }
    // ...and it is not ledger-only any more: injected into EACH document's own
    // current prose, every one is flagged.
    for (const [name, doc] of NON_LEDGER_CANONICAL) {
      const poisoned = `${flatCurrent(doc)} ${shapes[0]}`;
      expect(relationshipClaims(poisoned), `${name} would not have been checked`).not.toEqual([]);
    }
  });

  it("operand order alone cannot defeat the equality rule", () => {
    // The reported hole: `hosted == repo` was caught and `repo == hosted` was
    // not. Asserted as a PAIR so a future edit cannot silently drop one side.
    for (const [a, b] of [
      ["Migration state: hosted == repo.", "Migration state: repo == hosted."],
      ["Migration state: hosted = repository.", "Migration state: repository = hosted."],
      ["Migration state: repo > hosted.", "Migration state: hosted < repo."],
    ]) {
      expect(relationshipClaims(a), `not caught: ${a}`).not.toEqual([]);
      expect(relationshipClaims(b), `not caught in reversed order: ${b}`).not.toEqual([]);
    }
  });

  it("ordinary uses of `pending` and `parity` stay legal", () => {
    for (const benign of [
      "12 pending_invitations all-tenant, 5 of them expired.",
      "The reconciled position with apply evidence is migration-ledger.md.",
      "repo max and the next free number are derived by `npm run migration:state`.",
      "Reproduced on a CI-parity database, then independently re-reproduced.",
      "export-emission-parity.test.ts builds a real archive and compares it.",
      "A pending invitation is not an appointment.",
      // `==` must not become a generic ban: ordinary code prose keeps using it.
      "The guard asserts `wait_event_type == 'Lock'` before proceeding.",
      "hosted_migration_max is declared in migration-state.json.",
    ]) {
      expect(relationshipClaims(benign), `false positive: ${benign}`).toEqual([]);
    }
  });

  it("historical claims inside an auditable ignore region remain allowed", () => {
    // currentProse() strips ignore-marked regions, which is how superseded
    // evidence stays readable without becoming a current assertion. Proven on a
    // synthetic document rather than by adding a marker to a real one.
    const doc = [
      "# synthetic",
      "<!-- canonical-facts:ignore-start reason=then-state -->",
      "Repo and hosted migration state are at parity, with nothing pending.",
      "<!-- canonical-facts:ignore-end -->",
      "Current prose says nothing about the relationship.",
    ].join("\n");
    expect(relationshipClaims(doc.replace(/\s+/g, " ")), "the control text is not detectable")
      .not.toEqual([]);
    expect(relationshipClaims(flatCurrent(doc))).toEqual([]);
  });

  it("the ledger keeps its authority to state the current relationship", () => {
    // The exemption is real and load-bearing: the ledger's current block DOES
    // assert the relationship today, and must stay legal.
    expect(relationshipClaims(block.replace(/\s+/g, " ")).length).toBeGreaterThan(0);
  });
});

describe("canonical production docs: whole-session copy is exercised, and L2 stays closed", () => {
  it("no CURRENT-state doc still claims whole-session copy is unexercised", () => {
    // The changelog's ROWS are excluded on purpose. PR #478's row records
    // "NOT production-exercised; session_copy_operations = 0 rows", which was
    // TRUE on 2026-07-27 when it was written. A changelog row is THEN-state by
    // construction and is never rewritten because the world moved — that is
    // what a changelog is for. Only its preamble is current, and the preamble
    // is checked separately above.
    for (const [name, doc] of NO_CURRENT_MAX_DOCS) {
      const hits = findStaleExerciseClaims(currentProse(doc));
      expect(
        hits,
        `${name} still says whole-session copy is unexercised. It is: 24 production ` +
          `operations at Willow, 2026-07-28 to 2026-08-23. Offending text: ${JSON.stringify(hits)}`,
      ).toEqual([]);
    }
    // …and the preamble must not carry the claim either.
    expect(findStaleExerciseClaims(currentProse(changelogPreamble()))).toEqual([]);
  });

  it("the frozen #478 changelog row KEEPS its THEN-state wording", () => {
    // Guard-on-the-guard. If a later pass "helpfully" rewrites this row to
    // match today, the changelog stops being a record of what shipped.
    expect(
      RELEASE_CHANGELOG,
      "PR #478's row must still say what was true when it shipped",
    ).toMatch(/\*\*#478\*\*[\s\S]{0,200}NOT production-exercised/);
  });

  it("L2's heading is preserved verbatim AND marked CLOSED", () => {
    const title = KNOWN_LIMITATIONS.match(L2_TITLE)?.[0];
    expect(title, "L2's historical heading must be preserved, not deleted").toBeTruthy();
    expect(
      title,
      "L2's heading states something that is no longer true, so it may only stand " +
        "while it is marked CLOSED on the same line — the convention L18 and L23 already use",
    ).toMatch(/\bCLOSED\b/);
  });

  it("L1 stays OPEN and keeps exercise separate from acceptance", () => {
    expect(
      KNOWN_LIMITATIONS,
      "L1 must still exist — production exercise did not close it",
    ).toMatch(/^##\s+L1\s+—\s+Chloe's human acceptance testing is outstanding\s*$/m);
    expect(
      currentProse(KNOWN_LIMITATIONS),
      "L1 must state plainly that usage is not acceptance",
    ).toMatch(/evidence of exercise, not of acceptance/i);
    expect(
      currentProse(KNOWN_LIMITATIONS),
      "L1 must not have been quietly marked closed alongside L2",
    ).not.toMatch(/^##\s+L1\s+—[^\n]*\bCLOSED\b/m);
  });

  it("no canonical doc claims Chloe has accepted anything", () => {
    for (const [name, doc] of NO_CURRENT_MAX_DOCS) {
      expect(
        currentProse(doc),
        `${name} must not record an acceptance that has not been given`,
      ).not.toMatch(/Chloe\s+(?:has\s+)?(?:accepted|signed off|validated)\b(?!\s+anything she)/i);
    }
  });
});

describe("canonical production docs: synthetic rows are never customer activity", () => {
  const totals = allTenantTotals();

  /**
   * Figures that are NOT real-customer activity but are arithmetically
   * derivable from §0, so a plausible-looking sentence can reach for one:
   *   - the all-tenant totals (include the Twin AND the controlled studio);
   *   - the Twin-subtracted remainder (still includes the controlled studio).
   * Derived, never hardcoded, so a re-measurement moves them automatically.
   */
  function forbiddenCustomerFigures(): number[] {
    const out = [totals.clients, totals.appointments];
    const twin = tenantRow("hone-synthetic-twin");
    if (twin && twin.length >= 2) {
      out.push(totals.clients - twin[0], totals.appointments - twin[1]);
    }
    return [...new Set(out)].filter((n) => Number.isFinite(n) && n > 0);
  }

  it("current-state §0 classifies every tenant, naming the synthetic one", () => {
    const register = currentProse(CURRENT_STATE);
    expect(register, "the tenant register must exist").toMatch(/^##\s+0\.\s+Tenant register/m);
    expect(
      register,
      "hone-synthetic-twin must be classified as synthetic, by name",
    ).toMatch(/`hone-synthetic-twin`[^|]*\|[^|]*\*\*Synthetic\*\*/);
    expect(
      register,
      "willow-electrolysis must be classified as the real-customer tenant",
    ).toMatch(/`willow-electrolysis`[^|]*\|[^|]*\*\*Real customer\*\*/);
    expect(
      register,
      "the register must warn that the non-synthetic remainder is NOT real-customer activity — " +
        "subtracting the Twin still leaves the controlled test studio",
    ).toMatch(/Non-synthetic is not the same as real-customer/i);
  });

  it("the stated real-customer figures are the WILLOW row, not a subtraction", () => {
    const willow = tenantRow("willow-electrolysis");
    expect(willow, "§0 must carry a willow-electrolysis row with numbers").toBeTruthy();
    const [clients, appts] = willow as number[];
    const rule = currentProse(CURRENT_STATE).match(
      /Real-customer activity is `willow-electrolysis` only:\s*\*{0,2}(\d+)\*{0,2}\s*clients,\s*\*{0,2}(\d+)\*{0,2}\s*appointments/i,
    );
    expect(
      rule,
      "§0's reading rule must state the customer figures explicitly, so they are tied to the " +
        "customer-classified tenant rather than inferred by subtracting the Twin",
    ).toBeTruthy();
    expect(Number(rule?.[1]), "customer clients must equal the Willow row").toBe(clients);
    expect(Number(rule?.[2]), "customer appointments must equal the Willow row").toBe(appts);
  });

  it("no CURRENT-state doc labels an all-tenant total as customer activity", () => {
    // Changelog rows excluded for the same reason as above: THEN-state history.
    for (const [name, doc] of NO_CURRENT_MAX_DOCS) {
      const hits = findSyntheticAsCustomer(currentProse(doc), forbiddenCustomerFigures());
      expect(
        hits,
        `${name} presents an all-tenant total (which includes the Synthetic Twin) as ` +
          `real-customer activity. Label it, or use the Willow-only figure. ` +
          `Offending line(s): ${JSON.stringify(hits)}`,
      ).toEqual([]);
    }
  });

  it("the capability register defers tenant classification rather than restating it", () => {
    expect(
      CAPABILITY_REGISTER,
      "the register must point at current-state §0 rather than keeping a second copy " +
        "of the tenant classification, which is how the counts drifted in the first place",
    ).toMatch(/current-state\.md\)\s*\*\*§0\*\*|§0/);
  });
});

// ===========================================================================
// WAIT-02B — POLARITY CORRECTED 2026-09-19 (WAIT-DOCS-RECON).
//
// THIS BLOCK USED TO MANDATE A CLAIM PRODUCTION HAD ALREADY DISPROVED.
//
// It required current-state.md to say the durable waitlist is "NOT ENABLED"
// with "0 rows" and an "absent" allowlist, and it forbade any canonical
// document from calling the feature enabled. Every one of those was true when
// written. None of them was true when this was corrected.
//
// A read-only hosted query on 2026-09-19 returned 31 rows in
// `new_client_waitlist_entries`, 28 of them for `willow-electrolysis`, the
// oldest joined 2026-08-25. The guard was therefore not merely stale: it was
// actively holding the canonical documentation at a falsehood, and a lane that
// tried to tell the truth would have gone red for doing so.
//
// THE ACTIVATION IS PROVEN STRUCTURALLY, WITHOUT READING ANY ENV VALUE - which
// matters, because that value is Sensitive and no record may depend on reading
// it. Migration 0193's CHECK constraints make `source = 'public_booking'`
// exclusive to the public path (it holds if and only if
// `joined_at_provenance = 'form'` AND `created_by_practitioner_id IS NULL`); a
// practitioner-created entry is `'practitioner'` and an imported one is
// `'legacy_import'`. The only writer of `'public_booking'` is
// `join_new_client_waitlist`, whose only caller is
// `app/book/[slug]/waitlist-actions.ts`, reached only after BOTH
// `isNewClientWaitlistEnabled` and `isNewClientWaitlistDurableEnabled` return
// true. One durable public row therefore proves both allowlists name that
// studio.
//
// THE GUARD'S PURPOSE IS UNCHANGED - canonical documents must match production
// - so only its polarity moves. It now refuses the STALE posture rather than
// requiring it, which keeps the same class of drift caught in the direction
// drift can now travel.
// ===========================================================================
describe("canonical production docs: WAIT-02B's durable waitlist is recorded as ACTIVATED", () => {
  /**
   * The documents these rules read.
   *
   * The roadmap is here but NOT in NO_CURRENT_MAX_DOCS, and the distinction is
   * deliberate: it is not a production-state document, so it must not be held to
   * the migration-number rules — but it IS what operators and the migration
   * allocator plan from, and it carried the disproved posture inside its own
   * "CURRENT SNAPSHOT" for three weeks while every guard stayed green.
   */
  /** Read the durable-waitlist flag name from the module that owns it. */
  function durableFlagName(): string {
    const name = read("lib/booking/new-client-waitlist.ts").match(
      /DURABLE_SLUGS_ENV\s*=\s*\n?\s*"([A-Z0-9_]+)"/,
    )?.[1];
    expect(name, "the durable-waitlist env var name must be derivable").toBeTruthy();
    return name as string;
  }

  const SCANNED_DOCS = [
    ...NO_CURRENT_MAX_DOCS,
    ["docs/roadmap/CANONICAL_ROADMAP.md", read("docs/roadmap/CANONICAL_ROADMAP.md")],
    // ADDED after Codex #740 observed that the security and deployment docs
    // carried the same disproved claims and were not scanned AT ALL. A guard
    // that reads three documents while the claim lives in five is a guard
    // against three documents.
    ["docs/03_SECURITY_AND_PRIVACY.md", read("docs/03_SECURITY_AND_PRIVACY.md")],
    ["docs/10_DEPLOYMENT_AND_ENV.md", read("docs/10_DEPLOYMENT_AND_ENV.md")],
  ] as const;

  it("current-state records the durable activation as a DATED BOUND, with a non-zero row count", () => {
    const cs = currentProse(CURRENT_STATE);
    // THIS RULE USED TO REQUIRE THE WORD "ACTIVATED", FULL STOP.
    //
    // That was the last place the original defect was still living. The guard
    // this branch began by inverting MANDATED "NOT ENABLED"; replacing it with
    // one that MANDATES a present-tense "ACTIVATED" reproduces the same failure
    // with the sign flipped -- if an operator cleared the allowlist after the
    // last measured row, every persisted row would remain, no studio would be
    // activated, and CI would still be demanding the document say otherwise.
    //
    // So the requirement is now the BOUND, which stays true forever: one studio
    // WAS activated at every measured instant. A bound is a historical fact and
    // cannot rot; a posture is a reading of configuration and rots the moment
    // the configuration changes.
    expect(
      cs,
      "current-state must record the durable activation as a DATED BOUND -- one studio was " +
        "activated at the measured instants -- never as a current posture. Rows outlive the " +
        "flag, so they can bound an activation in time and can never report configuration now.",
    ).toMatch(/\bWAS activated at every measured instant\b/i);
    // SCOPED TO THE SECTION, AND TO ITS DATE. Codex #740 P2: this previously
    // scanned the WHOLE document for /[1-9]\d* rows/, and current-state.md
    // carries several unrelated counts ("24 rows", "7 rows"). Every measured
    // durable-waitlist number could have been deleted and this still passed on
    // a sentence about something else entirely — a positive assertion that
    // cannot detect loss of the evidence it names is not evidence of anything.
    const stageA = cs.match(
      /###\s+WAIT-02B Stage A[\s\S]*?(?=\n###\s|\n##\s|$)/,
    )?.[0];
    expect(
      stageA,
      "current-state must still carry a WAIT-02B Stage A section for the durable-waitlist " +
        "posture to live in",
    ).toBeTruthy();
    expect(
      stageA,
      "the Stage A section must carry a MEASURED, NON-ZERO row count. A bare adjective, or a " +
        "count that lives somewhere else in the document, does not establish that production " +
        "is collecting.",
    ).toMatch(/\b[1-9]\d*\s*rows\b/i);
    expect(
      stageA,
      "...and the DATE it was measured, in the same section. A dated 31 is no more a standing " +
        "fact than a dated 0 was; an undated count is the exact defect the previous polarity " +
        "enforced, restated with the opposite number.",
    ).toMatch(/\b20\d\d-\d\d-\d\d\b/);
  });

  it("no canonical doc still calls the durable waitlist dormant, dark or zero-rowed", () => {
    // The stale shapes, in the exact phrasings the canonical set actually used.
    // Historical rows stay legal: `currentProse` strips every explicitly-marked
    // frozen region first, so a superseded claim preserved inside an auditable
    // ignore block is untouched by this rule.
    const STALE: RegExp[] = [
      // THE CLAIM CLASS, NOT ONE PHRASING. Codex #740, second round: the list
      // below previously held only "durable … waitlist … is dormant/dark", and
      // the canonical set was carrying the same disproved posture in at least
      // six other wordings — "reachable by nobody", "unreachable", "NO STUDIO
      // ENABLED", "enabled for nobody", "NOT STARTED", and the durable waitlist
      // sitting inside a Dormant list. A blacklist that matches one phrasing is
      // a guard against one sentence, not against the claim.
      //
      // SCOPED TO THE SUBJECT so unrelated capabilities keep their own honest
      // "unreachable" and "not started" — clinical finalization, whole-session
      // copy and the retired corrections backend are all legitimately those.
      /durable[^.\n]{0,40}waitlist[^.\n]{0,40}\bis\s+(?:dormant|dark)\b/i,
      /durable[^.\n]{0,60}\b(?:reachable by nobody|unreachable|enabled for nobody)\b/i,
      /\b(?:reachable by nobody|enabled for nobody)[^.\n]{0,60}(?:durable|waitlist)/i,
      /waitlist[^.\n]{0,60}\bdormant and enabled for nobody\b/i,
      /\bNO STUDIO ENABLED\b/,
      /durable[^\n]{0,80}\bNOT STARTED\b/i,
      // The same claim as a SWITCH rather than a state. Codex #740, third
      // round: the roadmap said "Willow durable WAIT is deliberately OFF" in
      // its own CURRENT SNAPSHOT, and an operator planning from that row would
      // have re-performed a cutover that had already happened.
      // PRESENT-TENSE STANDING CLAIMS ONLY. A first draft of this matched any
      // "durable WAIT ... OFF" and produced two false positives that are worth
      // recording, because both are shapes a stale-wording guard must tolerate:
      //   * a genuine PAST observation -- "the navigation disappeared while
      //     durable WAIT was intentionally OFF" -- which is true history; and
      //   * a CONDITIONAL -- "navigation can disappear when the durable flag is
      //     off" -- which describes a behaviour, not a current state.
      // Neither asserts that the flag is off now, and banning them would push
      // real history out of the document to satisfy a regex.
      /durable\s+WAIT\s+(?:is|remains|stays)\s+(?:deliberately\s+|intentionally\s+)?OFF\b/i,
      /Willow[^.\n]{0,40}durable[^.\n]{0,40}\b(?:is|remains|stays)\s+(?:deliberately\s+|intentionally\s+)?off\b/i,
      // ADJECTIVE FORM, where OFF modifies "durable" instead of following the
      // verb: "Willow remains legacy-enabled and durable-OFF". Codex #740,
      // fourth round, found this after the narrowing above -- the hole was
      // real, and it sat in an active roadmap row. Still anchored on a
      // present-tense verb, so "was durable-OFF" stays legal history.
      /\b(?:is|remains|stays)\b[^.\n]{0,60}\bdurable[-\u2011\s]?OFF\b/i,
      /\bNOT ENABLED anywhere\b/i,
      /durable[^.\n]{0,60}\b0 rows\b/i,
    ];

    /**
     * DISABLED-STATE CLAIMS, which are stale ONLY while undated.
     *
     * Codex #740, sixth round, and it is the same defect one last time. These
     * shapes were in the list above, rejected unconditionally, in every scanned
     * document, forever. But the committed rows bound an activation INTERVAL --
     * 2026-08-25T22:27Z through 2026-09-15 -- and say nothing about what
     * follows it. If an operator clears the allowlist tomorrow, "no studio was
     * enabled as of <tomorrow>" becomes the truthful observation, every
     * persisted row still exists, and CI would have forbidden recording it.
     *
     * A guard that forbids the opposite claim PINS THE POSTURE just as surely as
     * one that mandates it. So these are rejected only as STANDING claims: carry
     * a date, in either direction within the sentence, and the observation is
     * admissible.
     */
    const DISABLED_STATE: RegExp[] = [
      // EVERY CONJUGATION, not one. Codex #740 P2: the list previously held
      // only "is enabled", so `known-limitations.md` sat green while its L25
      // table still said "No studio HAS BEEN enabled" three rows below the
      // correction that contradicted it.
      /\bNo studio (?:is|has been|was|had been) enabled\b/i,
      /\bWillow is\s+\*{0,2}not\s+enabled\*{0,2}/i,
      // The activation-authorization claim, which is the same falsehood stated
      // as a gate rather than as a count.
      /activation\s+(?:—|-|--)?\s*is ungranted/i,
      /Stage B2[^.\n]{0,40}\b(?:has not been granted|remains blocked|is ungranted)\b/i,
      // ROUTE OCCUPANCY. Codex #740, sixth direction on this class: "WAIT-01
      // currently serves NO studio" and "applies only to ... — currently none".
      // Which route a studio occupies is decided by configuration re-read on
      // every request, so persisted rows cannot establish it either way. Same
      // rule as the rest: date it and it is an observation.
      /WAIT-01[^.\n]{0,60}\b(?:currently\s+)?serves\s+(?:NO|no|nobody|any)\b/i,
      /\bcurrently serves\s+(?:NO|no|nobody)\s+studio\b/i,
      // BROADENED: the first draft required an em-dash immediately before
      // "currently none", so "of which there are currently none" and "the
      // allowlist names none" both walked past it. Membership and occupancy are
      // the same claim class -- what the environment holds RIGHT NOW -- and
      // neither is derivable from rows.
      // SCOPED TO THE SUBJECT. Codex #740: the first draft of these two was
      // SUBJECT-FREE -- any "currently none" or "there are none" anywhere in six
      // canonical documents would have failed a WAIT-specific test, including a
      // perfectly legitimate statement about alerts, migrations or any other
      // capability. An over-broad guard does not merely annoy; it taxes
      // unrelated work with a failure whose message names the wrong subject.
      // Punctuation support is kept; WAIT context is now required.
      //
      // AND `studio` IS NOT WAIT CONTEXT. A second pass by Codex showed the
      // token was still too generic -- "The studio has unresolved payment
      // alerts; currently none remain" matches within 70 characters and fails a
      // WAIT test about an absence of alerts. Only allowlist / WAIT-01 /
      // durable / waitlist count.
      /(?:allowlist|WAIT-01|durable|waitlist)[^.\n]{0,70}\bcurrently none\b/i,
      /\bcurrently none\b[^.\n]{0,70}(?:allowlist|WAIT-01|durable|waitlist)/i,
      /(?:allowlist|WAIT-01|durable|waitlist)[^.\n]{0,70}\bthere are\s+(?:currently\s+)?none\b/i,
      /\bthere are\s+(?:currently\s+)?none\b[^.\n]{0,70}(?:allowlist|WAIT-01|durable|waitlist)/i,
      /\ballowlist\s+names\s+(?:none|no studio)\b/i,
      /\ballowlist\s+(?:is|remains)\s+empty\b/i,
    ];

    /** A date anywhere in the surrounding sentence makes it an observation. */
    const DATED = /\b(?:as of|as at|20\d\d-\d\d-\d\d)\b/i;
    const sentenceAround = (text: string, at: number): string => {
      const start = Math.max(0, text.lastIndexOf(".", at) + 1, text.lastIndexOf("\n", at) + 1);
      const dot = text.indexOf(".", at);
      const nl = text.indexOf("\n", at);
      const ends = [dot, nl].filter((n) => n !== -1);
      return text.slice(start, ends.length > 0 ? Math.min(...ends) : text.length);
    };
    // (SCANNED_DOCS is defined once for the whole block, below.)
    // THE ROADMAP IS IN SCOPE FOR THIS RULE, THOUGH NOT FOR THE MIGRATION-NUMBER
    // RULES ABOVE. It is not a production-state document, so it is correctly
    // absent from NO_CURRENT_MAX_DOCS — but it IS what operators and the
    // migration allocator plan from, and it carried the disproved posture in its
    // own "CURRENT SNAPSHOT" for three weeks while every guard stayed green.
    for (const [name, doc] of SCANNED_DOCS) {
      const prose = currentProse(doc);
      for (const shape of STALE) {
        expect(
          prose.match(shape)?.[0] ?? null,
          `${name} still describes the durable waitlist with a posture production has ` +
            `disproved. Correct it, or move the sentence into an auditable ` +
            `canonical-facts:ignore block if it is being preserved as history.`,
        ).toBeNull();
      }
      for (const shape of DISABLED_STATE) {
        const hit = [...prose.matchAll(new RegExp(shape.source, `${shape.flags}g`))].find(
          (m) => !DATED.test(sentenceAround(prose, m.index ?? 0)),
        );
        expect(
          hit?.[0] ?? null,
          `${name} states a disabled posture as a STANDING claim. The committed rows bound the ` +
            `activation to 2026-08-25T22:27Z - 2026-09-15 and say nothing about what follows, ` +
            `so a later observation is legitimate -- DATE IT ("as of <date>") and it is ` +
            `admissible. What is banned is the undated standing form.`,
        ).toBeNull();
      }
    }
  });

  it("no canonical doc presents WAIT-01's email as Willow's commit point", () => {
    // CLASS, NOT INSTANCE. Codex #740 found this in one table row; a sweep by
    // CLAIM found it in four places across three documents. `waitlist-actions.ts`
    // routes a studio on BOTH allowlists to the durable branch, so for Willow the
    // email is a notification and the row is the record. Getting it backwards
    // hands an operator the wrong commit point AND the wrong kill switch.
    for (const [name, doc] of SCANNED_DOCS) {
      const prose = currentProse(doc);
      for (const shape of [
        // BROADENED after Codex #740 found two survivors: the first draft could
        // not cross the period before "LIVE" and accepted only "at Willow", so
        // a heading reading "WAIT-01 - the email-delivered waitlist. LIVE at
        // Willow." and a row reading "LIVE for Willow" both slipped through.
        // `[\s\S]` spans sentences; at|for covers both prepositions.
        /WAIT-01[\s\S]{0,90}?\b(?:enabled|live)\b[^\n]{0,40}?\b(?:at|for)\s+Willow\b/i,
        /\bWillow\b[^.\n]{0,50}\bWAIT-01\b[^.\n]{0,40}\bcommit point\b/i,
        /WAIT-01[^.\n]{0,40}\bcommit point\b[^.\n]{0,40}\bWillow\b/i,
      ]) {
        expect(
          prose.match(shape)?.[0] ?? null,
          `${name} still presents WAIT-01's email as Willow's commit point. Willow has been ` +
            `on the durable commit point since on or before 2026-08-25.`,
        ).toBeNull();
      }
    }
  });

  it("the durable waitlist is never rounded down to flatly unexercised", () => {
    // Zero invitations proves the LATER STAGES are unexercised. The join path is
    // live and taking real prospects, and a rollup that erases that is how an
    // active collection surface gets planned as if it were dark.
    for (const [name, doc] of SCANNED_DOCS) {
      const prose = currentProse(doc);
      const shape =
        /durable[^.\n]{0,50}(?:waitlist|path)[^.\n]{0,60}\b(?:is|remains)\s+(?:still\s+)?not\s+(?:production-)?exercised\b/i;
      expect(
        prose.match(shape)?.[0] ?? null,
        `${name} calls the durable waitlist unexercised. Say "not exercised beyond joining" — ` +
          `31 rows were measured on 2026-09-19.`,
      ).toBeNull();
    }
  });

  it("no canonical doc still instructs enabling durable WAIT for Willow as future work", () => {
    // PRE-CUTOVER INSTRUCTIONS OUTLIVE THE CUTOVER. Two rows still told an
    // operator to durable-enable Willow after reconciliation; the enable happened
    // first, in August, before any of it. Following them would mean manipulating
    // an activation that already exists.
    for (const [name, doc] of SCANNED_DOCS) {
      const prose = currentProse(doc);
      for (const shape of [
        /\bthen\s+explicitly\s+enable\s+durable\b/i,
        /\b(?:before|prior to)\s+Willow\s+migration\b/i,
        /\bsilently\s+durable-enabling\s+Willow\b/i,
        // Codex #740, eighth round: the same instruction phrased as a CUTOVER
        // rather than an enable. Five active sections still sequenced work
        // "before" or "only then authorize" a cutover performed in August.
        /\b(?:before|prior to)\s+(?:Willow\s+)?durable\s+cutover\b/i,
        /\bonly then\s+authoriz\w*[^.\n]{0,40}\bcutover\b/i,
        /\bauthorize\s+Willow\s+durable\s+cutover\b/i,
        // GENERIC "before migration", with no Willow or durable token in the
        // sentence at all. Codex #740, twelfth direction: an acceptance-debt row
        // told operators to close WAIT-CONTINUITY-01 "before migration". Scoped
        // to WAIT work items so unrelated migrations keep their own ordering
        // language.
        /\b(?:WAIT|waitlist|continuity)[^.\n]{0,60}\bbefore migration\b/i,
        /\bbefore migration\b[^.\n]{0,60}\b(?:WAIT|waitlist|rollout state)\b/i,
        // BARE WORDING. Codex #740, ninth round: "then Willow cutover" listed as
        // remaining work, with no "durable" and no verb to anchor on. The guard
        // had been matching the decorated forms only.
        /\bthen\s+Willow\s+cutover\b/i,
        /\bWillow\s+cutover\b[^.\n]{0,30}\bremain\w*/i,
        /\bremain\w*[^.\n]{0,40}\bWillow\s+cutover\b/i,
      ]) {
        expect(
          prose.match(shape)?.[0] ?? null,
          `${name} carries a pre-cutover Willow instruction. The durable enable happened on ` +
            `or before 2026-08-25; what remains is retrospective reconciliation.`,
        ).toBeNull();
      }
    }
  });

  it("no doc presents 0199 as claimable — it is applied and frozen", () => {
    // THE ONE FINDING IN THIS FAMILY WITH A CONCRETE HAZARD. An allocator
    // reading "0199 is unclaimed" from an ACTIVE allocation section would author
    // against a number already applied to production and frozen. Codex #740
    // found it in two such sections -- "Current allocation" and "Current
    // assigned WIP" -- after four earlier rounds had corrected the same claim
    // elsewhere in the same file.
    //
    // Scoped to CLAIMABILITY, not to the literal. Apply records, checksums and
    // historical rows must keep saying 0199 freely; what is banned is calling it
    // free.
    for (const [name, doc] of SCANNED_DOCS) {
      const prose = currentProse(doc);
      for (const shape of [
        /`?0199`?[^.\n]{0,40}\b(?:is|remains|stays)\s+(?:still\s+)?(?:unclaimed|unallocated|not claimed|not allocated|available|free)\b/i,
        /\bnext[- ]free[^.\n]{0,30}\b0199\b/i,
        /\bnext free (?:number|migration)[^.\n]{0,25}\b0199\b/i,
        /\b0199\b[^.\n]{0,30}\bclaimable\b/i,
      ]) {
        expect(
          prose.match(shape)?.[0] ?? null,
          `${name} presents 0199 as claimable. It was APPLIED to production on 2026-09-18 and ` +
            `is frozen; the next free number is 0200. An allocator acting on this collides ` +
            `with a live migration.`,
        ).toBeNull();
      }
    }
  });

  it("no doc infers CURRENT allowlist configuration from persisted rows", () => {
    // THE SYMMETRY THIS GUARD EXISTS TO HOLD. The original version of this block
    // mandated "NOT ENABLED" and carried a dated ABSENCE forward as a standing
    // posture for three weeks. Correcting it to mandate a present-tense ENABLED
    // would be the same error wearing the other sign, and Codex #740 caught the
    // documents doing exactly that.
    //
    // A durable row proves both allowlists matched AT THE INSTANT IT WAS
    // WRITTEN. It proves nothing about now: rows outlive the flag, and
    // lib/booking/new-client-waitlist.ts re-reads process.env on every call, so
    // clearing the variable returns new submissions to WAIT-01 immediately while
    // every existing row stays put.
    //
    // So the documents may state a DATED BOUND and must not state a current
    // configuration. This rule bans the inference; the row-count rule above
    // requires the date that makes the bound legible.
    for (const [name, doc] of SCANNED_DOCS) {
      const prose = currentProse(doc);
      for (const shape of [
        /\brows?\b[^.\n]{0,70}\b(?:prove|proves|proof|shows?|confirms?)\b[^.\n]{0,50}\b(?:currently|right now|today)\b[^.\n]{0,40}\b(?:named?|enabled|configured)\b/i,
        // THE FLAG NAME IS DERIVED, NEVER WRITTEN HERE.
        // tests/app/book/new-client-waitlist-durable-commit.test.ts keeps a
        // deliberately CLOSED census of non-markdown files naming that variable
        // — the mechanism that stops a config file or seed switching a studio on
        // quietly. Writing the literal in this regex ADDED THIS FILE to that
        // census and went red, which is the census working exactly as intended.
        // Deriving it keeps the census closed and survives a rename.
        //
        // No \b before the identifier: it is preceded by "_" in the full name,
        // "_" is a word character, and \b never matches there. A negative
        // control caught that too.
        new RegExp(`${durableFlagName()}\`?\\s+(?:currently\\s+)?names\\b`, "i"),
        /\bproduction\s+(?:currently\s+)?names\s+one\s+studio\b/i,
        // PRESENT-TENSE ENABLEMENT IN ANY WORDING. Codex #740: the first draft
        // rejected only "names one studio" and an explicit rows-to-currently
        // phrase, while the register said "ENABLED for one studio" and the
        // security doc "PRODUCTION ENABLES ONE STUDIO". All are the same
        // inference. Past tense ("was enabled", "at every measured instant")
        // stays legal -- that is the bound the documents are supposed to state.
        /\bPRODUCTION\s+ENABLES\s+ONE\s+STUDIO\b/,
        /\b(?:is|are)\s+ENABLED\s+for\s+one\s+studio\b/i,
        // CASE-INSENSITIVE LOOKBEHIND. A negative control caught this: the
        // lookbehinds were written lowercase with no `i` flag, so documents
        // writing "WAS ENABLED" in caps -- which several of these tables do --
        // would have tripped the rule for using the LEGAL past-tense form.
        /(?<!\bwas\s)(?<!\bwere\s)\bENABLED\s+for\s+one\s+studio\b(?![^.\n]{0,60}\bat every measured instant\b)/i,
        /\bone studio (?:is|remains) on the durable allowlist\b/i,
        // BARE NOUN PHRASES, with no verb at all to anchor tense on. Codex
        // #740: status cells are written as pipe-separated fragments --
        // "Deployed · ONE STUDIO ENABLED · exercised" -- so every shape above
        // that keys on is/are/was walked straight past them. A sweep found the
        // same fragment in a second document Codex had not named.
        //
        // The negative lookahead is what keeps the LEGAL form legal: the claim
        // is admissible the moment it carries its dated boundary, which is the
        // whole point of the rule rather than a loophole in it.
        /\bONE STUDIO ENABLED\b(?![^.\n|]{0,80}\b(?:at every measured instant|dated bound|20\d\d-\d\d-\d\d)\b)/i,
        /\bONE STUDIO ON THE DURABLE ALLOWLIST\b(?![^.\n|]{0,80}\b(?:at every measured instant|dated bound|20\d\d-\d\d-\d\d)\b)/i,
        // THE ADJECTIVE FORM, AND THE POSTURE NOUN. Codex #740's fifth family:
        // "Current posture: ACTIVATED for one studio", derived explicitly from
        // committed rows. Same lookahead, so the dated form stays admissible.
        /(?<!\bwas\s)(?<!\bwere\s)\bACTIVATED\s+for\s+one\s+studio\b(?![^.\n|]{0,80}\b(?:at every measured instant|dated bound|20\d\d-\d\d-\d\d)\b)/i,
        /\bCurrent posture:\s*ACTIVATED\b/i,
      ]) {
        expect(
          prose.match(shape)?.[0] ?? null,
          `${name} infers CURRENT allowlist configuration from persisted rows. Rows prove the ` +
            `allowlists matched WHEN THEY WERE WRITTEN — state that dated bound, and confirm ` +
            `present configuration in the product instead.`,
        ).toBeNull();
      }
    }
  });

  it("the activation is never recorded as read from the environment variable", () => {
    // The allowlist VALUE is Sensitive and is never read back. A record that
    // claimed to have read it would be unreproducible by the next reader, which
    // is how the previous "absent from Vercel Production" line survived three
    // weeks past the activation it described.
    const cs = currentProse(CURRENT_STATE);
    const durableFlag = read("lib/booking/new-client-waitlist.ts").match(
      /DURABLE_SLUGS_ENV\s*=\s*\n?\s*"([A-Z0-9_]+)"/,
    )?.[1];
    expect(durableFlag, "the durable-waitlist env var name must be derivable").toBeTruthy();
    expect(
      cs,
      `current-state must not assert that ${durableFlag}'s VALUE was read. Activation is ` +
        `established from committed rows, not from configuration.`,
    ).not.toMatch(new RegExp(`${durableFlag}[\\s\\S]{0,80}\\bvalue (?:was |is )?read\\b`, "i"));
  });
});

const APPLY_HISTORY_ENTRIES = 13;
const APPLY_HISTORY_DIGEST =
  "fed1cd9b704626f739f9459a1bdc3b4a9b786a881b052fbd117fac1eaab98e33";

describe("canonical production docs: the apply history is append-only", () => {
  /**
   * HISTORICAL APPLY RECORDS ARE NOT REWRITTEN -- and until now nothing enforced it.
   *
   * CLAUDE.md states the rule, `hosted_note` carries a "PREVIOUS ENTRY, PRESERVED"
   * boundary by convention, and `$comment` accumulates one dated entry per apply.
   * No test read any of it. #779 Codex P2 found that out the hard way: I appended an
   * evidence correction, wrote that the superseded entry "is asserted byte-identical
   * programmatically", and what I actually had was a one-time check inside the script
   * that performed the edit. A transient verification described as a standing
   * guarantee is worse than no guarantee, because it stops anyone looking.
   *
   * So the prefix is pinned the same way the execution record is: entries may be
   * ADDED, never edited or removed. Advance ENTRIES and DIGEST together, and only
   * when a genuinely new apply record is appended.
   */
  const comments = CANONICAL_RECORD["$comment"] as unknown;

  it("$comment is an array of dated entries, not a single blob", () => {
    expect(Array.isArray(comments)).toBe(true);
  });

  it("no entry is removed", () => {
    expect(
      (comments as string[]).length,
      "an entry was REMOVED from the apply history. Historical apply records are " +
        "not deleted; if one is wrong, append a dated correction entry as entry [9] " +
        "and entry [11] do",
    ).not.toBeLessThan(APPLY_HISTORY_ENTRIES);
  });

  it("an APPEND must advance the pin, so the new entry is immutable immediately", () => {
    // THE PIN IS AN EQUALITY, NOT A FLOOR. A floor pinned only the history that
    // existed when the constant was written: entry [12] would have been appendable
    // and then freely rewritten or deleted for as long as the count stayed above
    // the floor. That preserves a snapshot, not an append-only history -- which is
    // the property this block claims, so the floor was the claim outrunning the
    // code for the second time in one round.
    //
    // With equality, recording a new apply means advancing ENTRIES and DIGEST in the
    // same commit, and the entry you just recorded is frozen from that moment.
    expect(
      (comments as string[]).length,
      "a new apply entry was appended without advancing the pin. Update " +
        "APPLY_HISTORY_ENTRIES and APPLY_HISTORY_DIGEST in the SAME commit, so the " +
        "entry you just recorded becomes immutable immediately rather than staying " +
        "editable until someone notices",
    ).not.toBeGreaterThan(APPLY_HISTORY_ENTRIES);
  });

  it("no existing entry may be rewritten", () => {
    // Hashed WHOLE, not as a prefix: with the equality above, the array and the
    // pinned prefix are the same thing, and slicing would quietly re-admit the gap.
    expect(
      createHash("sha256")
        .update(JSON.stringify(comments as string[]))
        .digest("hex"),
      "a recorded apply entry was edited. Historical records are not rewritten -- " +
        "append a dated correction entry instead, as entry [9] and entry [11] do, " +
        "and advance APPLY_HISTORY_ENTRIES with the new DIGEST in the same commit",
    ).toBe(APPLY_HISTORY_DIGEST);
  });
});

describe("canonical production docs: frozen-region markers are explicit and justified", () => {
  /**
   * EVERY DOCUMENT WHOSE IGNORE BLOCKS ARE VALIDATED.
   *
   * Codex #740: the marker tests inspected NO_CURRENT_MAX_DOCS, the changelog
   * and the ledger, while the durable-waitlist rules had since grown to scan the
   * roadmap, the security doc and the deployment doc too. A balanced block
   * without `reason=` in any of those three would have silently exempted
   * arbitrary text -- the exact invariant the helper header says is
   * non-negotiable -- and nothing would have gone red. An exemption mechanism
   * that is itself unguarded in half the documents it applies to is not an
   * exemption mechanism.
   */
  const MARKER_VALIDATED_DOCS = [
    ...NO_CURRENT_MAX_DOCS,
    ["docs/production/release-changelog.md", RELEASE_CHANGELOG],
    ["docs/production/migration-ledger.md", MIGRATION_LEDGER],
    ["docs/roadmap/CANONICAL_ROADMAP.md", read("docs/roadmap/CANONICAL_ROADMAP.md")],
    ["docs/03_SECURITY_AND_PRIVACY.md", read("docs/03_SECURITY_AND_PRIVACY.md")],
    ["docs/10_DEPLOYMENT_AND_ENV.md", read("docs/10_DEPLOYMENT_AND_ENV.md")],
  ] as const;

  it("every ignore marker declares a reason", () => {
    for (const [name, doc] of MARKER_VALIDATED_DOCS) {
      for (const marker of ignoreMarkers(doc)) {
        expect(
          marker,
          `${name} has a canonical-facts:ignore block with no reason=. An unexplained ` +
            `exemption is how a guard quietly stops guarding.`,
        ).toMatch(/reason=\S+/);
      }
    }
  });

  it("every ignore block is closed", () => {
    for (const [name, doc] of MARKER_VALIDATED_DOCS) {
      const starts = (doc.match(/canonical-facts:ignore-start/g) ?? []).length;
      const ends = (doc.match(/canonical-facts:ignore-end/g) ?? []).length;
      expect(starts, `${name} has unbalanced ignore markers`).toBe(ends);
    }
  });
});

// ===========================================================================
// NEGATIVE CONTROLS
//
// A guard nobody has watched fail is a guard nobody knows works. Each control
// feeds the rule the exact shape it exists to catch and asserts it goes red.
// ===========================================================================

describe("NEGATIVE CONTROLS — the guard actually goes red", () => {
  it("catches a stale current max in every shape that has actually occurred", () => {
    const shapes = [
      "| **Production migration max** | **0165** — 164 migrations applied |",
      "Production migration max is 0162, applied and verified 2026-08-02.",
      "Repository max and hosted max are both `0163`; repository and hosted match.",
      "The production migration max is **0157** and the runtime-bearing head is `96b28d6…`.",
      "| **Hosted (production) migration max** | **0165** (applied 2026-08-02) |",
      "historical detail — the production max is now 0157 and the newest six are 0152–0157",
      "Repository and hosted migration max are both `0160`.",
    ];
    for (const shape of shapes) {
      expect(
        findCurrentMaxAssertions(shape),
        `the guard MISSED a stale-current-max shape that really shipped: ${shape}`,
      ).not.toEqual([]);
    }
  });

  it("catches a hardcoded next-free number", () => {
    for (const shape of [
      "The next migration number is **`0164`**.",
      "Repo and hosted are at parity; next free number is `0163`.",
      "Next free migration number is 0186.",
    ]) {
      expect(findNextFreeAssertions(shape), `MISSED: ${shape}`).not.toEqual([]);
    }
  });

  it("does NOT fire on historical or descriptive uses of the same numbers", () => {
    for (const shape of [
      "0163 (intake INSERT boundary) was APPLIED to production 2026-08-02T17:37Z and is frozen.",
      "that is how the `0160`/`0163`/`0165` divergence happened",
      "Migration **0185** was applied to production on 2026-08-23 and is frozen.",
      "| #477 | **0156** | Live | Conditional numbing notes |",
      "migration 0159 retires it (nothing dropped)",
      "See migration 0184's least-privilege repair for the same root cause.",
    ]) {
      expect(
        [...findCurrentMaxAssertions(shape), ...findNextFreeAssertions(shape)],
        `FALSE POSITIVE — this is historical or descriptive, not a current-max ` +
          `assertion, and banning it would turn the guard into a number ban: ${shape}`,
      ).toEqual([]);
    }
  });

  it("catches the superseded whole-session-copy claims", () => {
    for (const shape of [
      "**Production exercise: none.** `session_copy_operations` holds **0 rows**.",
      "`session_copy_operations` = **0 rows**",
      "## 2. Whole-session copy\nDB applied · deployed · enabled · NOT production exercised · human acceptance pending.",
      "Do not describe whole-session copy as production-exercised — it is never production exercised.",
    ]) {
      expect(findStaleExerciseClaims(shape), `MISSED: ${shape}`).not.toEqual([]);
    }
  });

  it("does NOT fire on the corrected exercise wording", () => {
    for (const shape of [
      "`session_copy_operations` holds **24 rows**, all at Willow.",
      "**Production exercise: yes.** 24 operations between 2026-07-28 and 2026-08-23.",
      "Whole-session copy is production exercised and not human accepted.",
    ]) {
      expect(findStaleExerciseClaims(shape), `FALSE POSITIVE: ${shape}`).toEqual([]);
    }
  });

  it("leaves 'NOT production exercised' legal for capabilities that really are dormant", () => {
    // WAIT-02B Stage A and the retired 0120 corrections backend both carry this
    // status truthfully. A guard that banned the phrase outright would push the
    // register toward vagueness about genuine dormancy — the opposite of the goal.
    for (const shape of [
      "## 5b. New-client waitlist\nDB applied · deployed · NOT ENABLED · NOT production exercised.",
      "Phase 2 — corrections & amendments backend (0120) | **RETIRED.** **Never production-exercised**",
    ]) {
      expect(
        findStaleExerciseClaims(shape),
        `FALSE POSITIVE — this is a different capability, truthfully unexercised: ${shape}`,
      ).toEqual([]);
    }
  });

  it("catches an all-tenant total dressed as customer activity", () => {
    for (const shape of [
      "One live studio with real clients: Willow Electrolysis (2 practitioners, 129 clients, 382 appointments).",
      "Real-customer activity: 382 appointments across production.",
    ]) {
      expect(
        findSyntheticAsCustomer(shape, [129, 382]),
        `MISSED — this counts the Synthetic Twin as customer activity: ${shape}`,
      ).not.toEqual([]);
    }
  });

  it("does NOT fire when an all-tenant total is honestly labelled", () => {
    for (const shape of [
      "Willow: 215 appointments. All tenants: 382, which includes synthetic rows.",
      "| **All tenants** *(includes synthetic — not a customer figure)* | — | **129** | **382** |",
      "**215 appointments at Willow**, the live studio",
    ]) {
      expect(
        findSyntheticAsCustomer(shape, [129, 382]),
        `FALSE POSITIVE — this total is labelled: ${shape}`,
      ).toEqual([]);
    }
  });

  it("strips only explicitly-marked frozen regions, and nothing else", () => {
    const doc = [
      "Production migration max is 0999.",
      "<!-- canonical-facts:ignore-start reason=historical-quotation -->",
      "It used to read: Production migration max is 0165.",
      "<!-- canonical-facts:ignore-end -->",
    ].join("\n");
    const stripped = currentProse(doc);
    expect(stripped, "the frozen quotation must be removed").not.toMatch(/0165/);
    expect(stripped, "the live claim must survive stripping").toMatch(/0999/);
    expect(
      findCurrentMaxAssertions(stripped),
      "the live claim must still be caught after stripping",
    ).not.toEqual([]);
  });
});

// ===========================================================================
// RULE A — current-state.md must not pin a stale or unreal production SHA
//
// THE FAILURE THIS EXISTS TO PREVENT. On 2026-08-26 `current-state.md` pinned
// `96b28d62` as the current branch HEAD while production stood at `6786b07b` —
// fourteen merges and two applied migrations later. Every behavioural claim in
// the document was anchored to that SHA, so the staleness was not cosmetic: it
// silently re-scoped the whole file to a runtime that had not existed for days.
//
// The document already CLAIMED to derive this ("Verified mechanically, not
// asserted: the diff from X to Y touches no runtime path"). That sentence was
// true when written and nothing re-checked it afterwards. These rules make the
// same derivation executable, which is the only version that survives.
//
// A drafting note, from a real mistake made while writing this reconciliation:
// A1 exists because a SHA was once written into this document from memory and
// resolved to nothing. A 40-hex string looks equally authoritative whether or
// not it names a commit, and no human reading review notices the difference.
// ===========================================================================

/** Every 40-hex string in a document, deduplicated. */
export function shasIn(doc: string): string[] {
  return [...new Set(doc.match(/\b[0-9a-f]{40}\b/g) ?? [])];
}

/** The SHA current-state.md pins as the runtime-bearing baseline. */
function pinnedRuntimeSha(): string | null {
  const row = currentProse(CURRENT_STATE)
    .split("\n")
    .find((l) => /Last runtime-bearing application HEAD/i.test(l));
  return row?.match(/\b([0-9a-f]{40})\b/)?.[1] ?? null;
}

/**
 * The CURRENT PRODUCTION GIT HEAD, which is a different fact from the pin above
 * and has its own row in the header.
 *
 * MERGE_COUNT_AUTHORITY != RUNTIME_SHA. A documentation-only production merge
 * advances the branch HEAD while leaving the runtime-bearing SHA exactly where
 * it was - that is the whole reason the two rows exist separately. Counting
 * merges from the runtime pin therefore UNDERCOUNTS by every docs-only merge,
 * silently, and the guard would keep passing while the prose drifted.
 *
 * The two rows are the same commit today, which is precisely why this was
 * invisible: the wrong authority produced the right answer.
 *
 * Runtime-BEHAVIOUR claims keep using `pinnedRuntimeSha()`. Only the
 * merge-count fact uses this.
 */
function currentGitHeadSha(): string | null {
  const row = currentProse(CURRENT_STATE)
    .split("\n")
    .find((l) => /Current Git branch HEAD/i.test(l));
  return row?.match(/\b([0-9a-f]{40})\b/)?.[1] ?? null;
}

describe("RULE A — current-state.md pins a real, current production SHA", () => {
  // WHERE THIS RULE ACTUALLY ENFORCES, stated so nobody mistakes a green CI run
  // for a checked one. All three A-rules need real history. CI clones with
  // `fetch-depth: 1`, so in CI they SKIP and this test records that they did.
  // They enforce where a full clone exists: a developer's checkout, and so
  // `npm run verify:changed` / `verify:prepush` before every push. That is not
  // a weakness dressed up as a feature - it is a real gap, and closing it means
  // raising the checkout depth in the CI workflow, which is deliberately out of
  // this change's authorized file surface and belongs to its own PR.
  it("A0: records whether the A-rules could run at all in this environment", () => {
    const mode = !GIT_AVAILABLE ? "no-git" : SHALLOW ? "shallow (A-rules SKIPPED)" : "full history (A-rules ENFORCED)";
    expect(
      ["no-git", "shallow (A-rules SKIPPED)", "full history (A-rules ENFORCED)"],
      `git environment: ${mode}`,
    ).toContain(mode);
  });

  it("A1: every SHA written in current-state.md resolves to a real commit", () => {
    // GIT_USABLE, not GIT_AVAILABLE. This rule shipped guarding on the latter
    // and went red on its first CI run against a document whose three SHAs were
    // all genuine: `.github/workflows/ci.yml` checks out with `fetch-depth: 1`,
    // so a shallow clone holds ONE commit and every SHA a document names is
    // absent — including the production head the checkout is derived from.
    // "Not in this clone" and "not a commit" are different claims and only the
    // second is a defect.
    requireUsableGit("A1");
    const unreal = shasIn(CURRENT_STATE).filter((sha) => git("cat-file", "-t", sha) !== "commit");
    expect(
      unreal,
      "current-state.md names one or more 40-hex SHAs that are not commits in this " +
        "repository. A fabricated or mistyped SHA reads exactly like a real one; this is the " +
        "only thing that tells them apart. Offending: " + JSON.stringify(unreal),
    ).toEqual([]);
  });

  it("A1b: every abbreviated SHA presented as the CURRENT baseline matches the pin", () => {
    // The header pins the runtime-bearing SHA; the capability sections then say
    // "At `<short sha>` ..." when describing what is true NOW. Those are two
    // statements of one fact, so they can drift - and a section pinned to a
    // superseded head reads as current while describing a runtime that has
    // moved. This ties them: an abbreviated SHA introduced by "At `...`" must
    // be a prefix of the full pin.
    //
    // Scoped to that one phrasing on purpose. Historical references elsewhere
    // ("merged `a3b85af2`", "superseded by `6786b07b`") are evidence of past
    // events and must stay free to name any commit.
    const pinned = pinnedRuntimeSha();
    expect(pinned, "current-state.md must pin a runtime-bearing HEAD").toBeTruthy();
    const claims = [...currentProse(CURRENT_STATE).matchAll(/\bAt\s+`([0-9a-f]{7,40})`/g)].map(
      (m) => m[1],
    );
    const stale = claims.filter((c) => !(pinned as string).startsWith(c));
    expect(
      stale,
      'a section says "At `<sha>` ..." about CURRENT behaviour using a commit that is not the ' +
        `pinned runtime baseline ${(pinned as string).slice(0, 8)}. Re-pin the section or the ` +
        `header - they are one fact. Offending: ${JSON.stringify(stale)}`,
    ).toEqual([]);
    expect(claims.length, "at least one section should tie itself to the pin").toBeGreaterThan(0);
  });

  it("A2: the pinned runtime-bearing SHA exists and is an ancestor of HEAD", () => {
    const pinned = pinnedRuntimeSha();
    expect(pinned, "current-state.md must pin a runtime-bearing application HEAD").toBeTruthy();
    requireUsableGit("A2");
    expect(git("cat-file", "-t", pinned as string), `${pinned} is not a commit`).toBe("commit");
    expect(
      git("merge-base", "--is-ancestor", pinned as string, "HEAD"),
      `${pinned} is not an ancestor of HEAD — current-state.md is pinned to a commit that is ` +
        "not in this branch's history at all",
    ).toBe("");
  });

  it(`A3${FRESHNESS_TAG}: nothing SHIPPED to production after the pinned SHA changes the runtime — via the repo's own classifier`, async () => {
    const pinned = pinnedRuntimeSha();
    expect(pinned, "current-state.md must pin a runtime-bearing application HEAD").toBeTruthy();
    requireUsableGit("A3");
    // The production boundary (#825 6215529089): pinned -> the verified
    // production ref, NEVER this branch's HEAD. An unmerged application PR's
    // own diff has not shipped, so it cannot make the production record stale.
    const branch = productionBranch();
    const target = resolveProductionRef(git, branch);
    if (!target) {
      throw new Error(`A3 cannot run: the production ref for ${branch ?? "(no branch recorded)"} is not present in this clone. Fetch it (fetch-depth: 0).`);
    }
    const deployed = await runtimeChangedSince(git, pinned as string, target);
    if (deployed === null) throw new Error(`A3 cannot run: git cannot diff ${String(pinned).slice(0, 8)}..${target.slice(0, 8)}`);

    // Pending-release receipts (HON-18 39ad5aaf): a runtime change that shipped
    // after the pin is acceptable only when every runtime-bearing merge since
    // the pin is receipt-covered with runtime:true. An empty diff is decided
    // exactly as before, without consulting receipts.
    const covered = deployed.length === 0 ? null : await runtimeCoveredSince(git, pinned as string, target, loadLateReceipts(target));
    freshnessVerdict(
      "A3",
      deployed.length === 0 || covered?.ok === true,
      `current-state.md pins ${String(pinned).slice(0, 8)} as the runtime-bearing baseline, but ` +
        `${deployed.length} file(s) changed between it and production ${target.slice(0, 8)} are ` +
        "classified as runtime-bearing by scripts/classify-changes.mjs, so the pin is stale: a " +
        "runtime change shipped and the record has not caught up. This is the check the " +
        'document\'s own "verified mechanically, not asserted" sentence describes. Changed: ' +
        JSON.stringify(deployed.slice(0, 12)) +
        (covered && !covered.ok ? `. Receipt coverage: ${covered.reason}` : ""),
    );
  });

  it("A3's deployed decision: runtime paths ship, CI/test/tooling paths do not", async () => {
    const classify = await loadClassifier();
    const deployed = (f: string) => nonShippingReason(f) === null && !classify([f]).docs_only;

    // SHIPS - a change to any of these after the pin must invalidate it.
    for (const f of [
      "app/(app)/dashboard/page.tsx",
      "lib/export/resource-registry.ts",
      "components/pending-link.tsx",
      "instrumentation.ts",
      "instrumentation-client.ts",
      "sentry.server.config.ts",
      "sentry.edge.config.ts",
      "public/favicon.ico",
      "hooks/use-thing.ts",
      "types/thing.ts",
      "middleware.ts",
      "next.config.ts",
    ]) {
      expect(deployed(f), `${f} must count as deployed runtime`).toBe(true);
    }

    // B - a script the PRODUCTION BUILD runs. Derived from package.json, and
    // asserted non-empty so this control cannot pass by finding nothing.
    expect(
      PRODUCTION_BUILD_SCRIPTS.length,
      "package.json's build command must name at least one script for this rule to have work",
    ).toBeGreaterThan(0);
    for (const f of PRODUCTION_BUILD_SCRIPTS) {
      expect(deployed(f), `${f} runs in the production build and must count as deployed`).toBe(true);
    }

    // DOES NOT SHIP - a change to any of these must NOT demand a new baseline.
    for (const f of [
      ".github/workflows/ci.yml",
      "scripts/verify-prepush.mjs",
      "scripts/classify-changes.mjs",
      "e2e/perceived-speed.spec.ts",
      "e2e-payment/checkout.spec.ts",
      "tests/docs/canonical-production-facts.test.ts",
      "tests/db/export-resource-registry.db.test.ts",
      "playwright.config.ts",
      "vitest.config.ts",
      "docs/production/current-state.md",
      "README.md",
      "openwiki/.claims/payments/stripe-payments-and-settlement.json",
      "openwiki/.last-update.json",
      "openwiki/.page-manifest.json",
      ".openwikiignore",
    ]) {
      expect(deployed(f), `${f} must NOT count as deployed runtime`).toBe(false);
    }
  });

  it("A3 uses the repository's classifier, not a private path list", async () => {
    // Guard-on-the-guard. If someone reintroduces a hand-written runtime list,
    // this fails and points at CLAUDE.md §3's "no second competing map" rule.
    const classify = await loadClassifier();
    for (const f of [
      "instrumentation.ts",
      "instrumentation-client.ts",
      "sentry.server.config.ts",
      "sentry.edge.config.ts",
      "public/favicon.ico",
      "hooks/use-thing.ts",
      "types/thing.ts",
    ]) {
      expect(
        classify([f]).docs_only,
        `${f} must be recognised as runtime-bearing by the shared classifier - it was ` +
          "omitted by the hand-written list this rule used to carry",
      ).toBe(false);
    }
    expect(classify(["docs/production/current-state.md"]).docs_only).toBe(true);
  });
});

// ===========================================================================
// RULE F — an OPEN pull request is never described as production
//
// A branch, a green CI run and a mergeable state are not deployment. The
// canonical docs are read as a statement of what IS live, so a capability
// written down before its merge commit is an ancestor of production is a false
// production claim regardless of how likely the merge is.
// ===========================================================================

const OPEN_PR_SECTION = "### Open pull requests are not production";

/** The section current-state.md uses to declare its open set. */
function openPrSection(): string {
  const start = CURRENT_STATE.indexOf(OPEN_PR_SECTION);
  if (start === -1) return "";
  const rest = CURRENT_STATE.slice(start + OPEN_PR_SECTION.length);
  const end = rest.search(/\n#{2,3}\s/);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * PR numbers current-state.md declares OPEN.
 *
 * Read from each row's SUBJECT CELL - the first `|`-delimited column, which is
 * what the row is ABOUT - and not from anywhere in the section. An earlier
 * revision scraped every `#NNN` in the block, so the moment a row's prose
 * referenced another PR ("#648 records it as untouched") that PR was treated as
 * declared-open, and Rule F then flagged every truthful mention of it - and its
 * changelog row - as describing an open PR as shipped.
 *
 * A row may legitimately cite a MERGED PR to explain itself. Only the subject
 * of the row is a declaration about that PR's state.
 */
export function declaredOpenPrs(): string[] {
  const subjects = openPrSection()
    .split("\n")
    .filter((l) => l.trim().startsWith("|") && !/^\|\s*-{2,}/.test(l))
    .map((l) => l.split("|")[1] ?? "")
    .filter((cell) => !/^\s*PR\s*$/i.test(cell));
  return [...new Set(subjects.flatMap((c) => [...c.matchAll(/#(\d{3,5})\b/g)].map((m) => m[1])))];
}

const SHIPPED_WORD = /\b(?:deployed|shipped|is live|in production|production[\s-]exercised|merged to production)\b/i;

// ===========================================================================
// RULE A4 — the runtime-bearing SHA has exactly ONE canonical home
//
// current-state.md, capability-register.md and known-limitations.md each
// carried the same 40-hex pin. Only current-state.md's copy was validated, so
// after the next deployment either of the other two could drift silently -
// reproducing, for the fourth derived fact, precisely the defect this whole
// reconciliation exists to close for the first three.
//
// The migration numbers were fixed by REMOVING the copies rather than
// correcting them. This does the same: the other two documents reference
// current-state.md instead of restating the SHA, and this rule keeps it that
// way. A guard that merely banned the phrase "runtime-bearing head is" would
// be satisfied by any other wording around the same literal.
// ===========================================================================

// ===========================================================================
// RULE C2 — the 0169 clinical write boundary is stated once, correctly
//
// Migration 0169 (applied 2026-08-03) revoked `insert, update, delete` from
// `authenticated` on all six clinical tables by name, leaving SELECT only.
// Three canonical documents nonetheless carried the PRE-0169 sentence as
// current fact - "authenticated still holds row INSERT/UPDATE/DELETE", "row
// DML on the five app-written tables is NOT revoked" - and two of them cited
// L18 as corroboration while L18's own heading says CLOSED.
//
// The first remediation pass fixed ONE of the three and believed it had swept
// the class. This rule is why the second pass could not repeat that: it is a
// CLASS check over every canonical document, not three fixed line numbers.
//
// A correction may quote the old sentence - that is how the fix stays
// auditable - so a hit is permitted on a line that also carries an explicit
// correction marker. Everything else is a live contradiction.
// ===========================================================================

const PRE_0169_DML =
  /(?:\bstill\s+holds\b[^.\n|]{0,60}\b(?:DML|INSERT)|(?:row\s+)?DML\b[^.\n|]{0,40}\bis\s+NOT\s+revoked\b|\bis\s+NOT\s+revoked\b[^.\n|]{0,40}\bDML\b)/i;
const CORRECTION_MARKER =
  /\bCORRECTED\b|\bcorrected\b|\bpreviously\s+(?:read|continued|said)\b|\bused\s+to\s+(?:read|carry|say)\b|\bprevious\s+wording\b|\bthis\s+(?:row|passage|clause|bullet|section|entry)\s+(?:previously|used\s+to)\b|\bwithdrawn\s+wording\b/i;

/**
 * Blank out QUOTED SPANS, preserving offsets and line structure.
 *
 * C2 used to exempt the whole Markdown line whenever a correction marker
 * appeared anywhere on it. That is far too coarse, and it is porous in exactly
 * the place these documents are densest - a single-line table row, where one
 * legitimate historical correction licensed every other assertion in the row.
 * `CORRECTED: authenticated still holds row INSERT/UPDATE/DELETE` passed while
 * stating the defect as current fact.
 *
 * The narrower rule: a correction stays auditable by QUOTING what it replaces,
 * so the historical text is the quoted span and nothing else. Mask the quotes;
 * whatever is left on the line is being asserted in the document's own voice.
 * Bounded span reasoning, not a Markdown parser.
 */
/**
 * The FULL introducing phrase, longest form first.
 *
 * Adjacency is enforced below by requiring the gap between marker and quotation
 * to be punctuation only, which means the marker pattern must swallow the whole
 * introducing phrase or the trailing verb would look like intervening prose:
 * `This row previously read *"X"` matches `this row previously` under the
 * generic vocabulary, leaving ` read *` in the gap and failing adjacency for a
 * row that is perfectly well formed. Ordered longest-first because JS
 * alternation returns the first branch that matches, not the longest.
 */
const PREPOSITIVE_BIND =
  /\b(?:this\s+(?:row|passage|clause|bullet|section|entry|parenthetical)\s+(?:previously|used\s+to)\s+(?:read|continued|said|carry|carried|quoted?|stated?)|previously\s+(?:read|continued|said|carried|quoted|stated)|used\s+to\s+(?:read|carry|say|quote)|previous\s+wording|withdrawn\s+wording)\b/gi;

/**
 * Everything a marker and its quotation may legitimately have between them.
 *
 * Punctuation and markdown emphasis ONLY - no word characters, no `;`, no `|`.
 * A semicolon starts a new statement, a pipe starts a new cell, and any word at
 * all means some OTHER subject has intervened:
 *
 *   "X" was corrected                          adjacent - X is historical
 *   "X" — is superseded                        adjacent - X is historical
 *   "X"; an unrelated table was corrected      NOT adjacent - X stays live
 *
 * This is the whole of the adjacency rule. It is deliberately not a distance
 * heuristic: "how far away is the nearest marker" is what produced every
 * previous version of this defect.
 */
const BINDING_GAP = /^[\s*_:()[\]—–,-]*$/;

/** A marker that DESCRIBES the quotation before it rather than introducing one. */
const POSTPOSITIVE_MARKER =
  /\b(?:was|were|is|are|has\s+been|have\s+been|had\s+been)\s+(?:corrected|withdrawn|superseded|retracted|amended|replaced)\b/gi;

type MarkerSpan = { start: number; end: number };

/**
 * Locate correction markers and classify each by the direction it binds.
 *
 * A postpositive phrase contains a correction word, so the generic marker
 * pattern matches inside it - "was corrected" contains "corrected". Any generic
 * match overlapping a postpositive phrase is therefore NOT counted as
 * prepositive, which is what stops `"X" was corrected` from also reading as an
 * introduction of the quotation that follows.
 */
function markerSpans(text: string): { pre: MarkerSpan[]; post: MarkerSpan[] } {
  const post: MarkerSpan[] = [...text.matchAll(POSTPOSITIVE_MARKER)].map((m) => ({
    start: m.index ?? 0,
    end: (m.index ?? 0) + m[0].length,
  }));
  const pre: MarkerSpan[] = [];
  for (const m of text.matchAll(PREPOSITIVE_BIND)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (post.some((p) => start < p.end && end > p.start)) continue;
    pre.push({ start, end });
  }
  return { pre, post };
}

function maskQuotedSpans(text: string): string {
  // A quote is masked only when a correction/history marker INTRODUCES it -
  // i.e. the marker appears earlier on the same line than the quote does.
  //
  // Masking every quotation was the previous revision, and it was worse than
  // the line-wide exemption it replaced: `Current posture: "authenticated still
  // holds row INSERT/UPDATE/DELETE"` was erased and passed. Quotation marks
  // attribute and emphasise CURRENT claims at least as often as they preserve
  // superseded ones, so quoting cannot itself be the signal.
  //
  // "Introduced by" is the bounded version of "belongs to": a correction says
  // what it is replacing and then shows it. A live claim that happens to be
  // quoted has no such preamble, and a row carrying a real correction plus a
  // separate live assertion still fails on the assertion, which sits outside
  // any marker-introduced quote.
  let out = text;
  // A MARKER OWNS EXACTLY ONE QUOTATION, AND DIRECTION DECIDES WHICH.
  //
  // Three scopes were tried and each let one legitimate correction license an
  // unrelated LIVE assertion: line scope, then cell scope, then "the span since
  // the previous quotation". The last one closed forward inheritance for
  // PREPOSITIVE markers and left the mirror image open, because a POSTPOSITIVE
  // marker sits between the quote it describes and the next one:
  //
  //     "A harmless statement" was corrected; current posture: "<live claim>"
  //                            ^^^^^^^^^^^^^ describes the quote BEFORE it,
  //                                          but lands in the NEXT quote's span
  //
  // So the live claim inherited a marker that was never about it. Association
  // is now explicit and directional rather than "did the text since the last
  // quote contain the word corrected":
  //
  //   PREPOSITIVE  `Corrected previous wording "X"`   introduces the quote after it
  //   POSTPOSITIVE `"X" was corrected`                describes the quote before it
  //
  // Each marker is examined only in the window it can legitimately govern, so
  // neither direction can spill onto a neighbouring quotation. A quote with no
  // marker of its own in either window is the document speaking.
  const quotes = [...text.matchAll(/"[^"\n]*"|“[^”\n]*”/g)];
  const { pre, post } = markerSpans(text);
  for (let i = 0; i < quotes.length; i += 1) {
    const m = quotes[i];
    const start = m.index ?? 0;
    const end = start + m[0].length;

    const lineStart = text.lastIndexOf("\n", start) + 1;
    const cellSep = text.lastIndexOf("|", start);
    const cellStart = Math.max(lineStart, cellSep === -1 ? lineStart : cellSep + 1);
    const previous = i > 0 ? (quotes[i - 1].index ?? 0) + quotes[i - 1][0].length : -1;
    const scanFrom = Math.max(cellStart, previous);

    const nl = text.indexOf("\n", end);
    const lineEnd = nl === -1 ? text.length : nl;
    const nextSep = text.indexOf("|", end);
    const cellEnd = Math.min(lineEnd, nextSep === -1 ? lineEnd : nextSep);
    const next = i + 1 < quotes.length ? (quotes[i + 1].index ?? 0) : cellEnd;
    const scanTo = Math.min(cellEnd, next);

    // ADJACENCY, both directions. Membership of the window is necessary and NOT
    // sufficient: the marker must also sit immediately beside the quotation,
    // with nothing but punctuation between them. Window membership alone let
    //   "<live claim>"; an unrelated table was corrected; note: "safe"
    // mask the live claim, because "was corrected" was merely somewhere before
    // the next quotation while belonging to a different subject entirely.
    const introduced = pre.some(
      (k) => k.start >= scanFrom && k.end <= start && BINDING_GAP.test(text.slice(k.end, start)),
    );
    const described = post.some(
      (k) => k.start >= end && k.end <= scanTo && BINDING_GAP.test(text.slice(end, k.start)),
    );
    if (!introduced && !described) continue;
    out = out.slice(0, start) + " ".repeat(m[0].length) + out.slice(start + m[0].length);
  }
  return out;
}

describe("a correction marker owns exactly one ADJACENT quotation", () => {
  // Five scopes were tried. Line, cell, "since the previous quotation", then
  // directional windows - and each one still let a legitimate correction
  // license an unrelated LIVE assertion, because window membership was treated
  // as sufficient. It is only necessary. A marker must ALSO sit immediately
  // beside its quotation, with nothing but punctuation between, or some other
  // subject has intervened and the marker is not about this quote at all.
  const live = "authenticated still holds row INSERT/UPDATE/DELETE";
  const old = "row DML is NOT revoked";
  const isLive = (row: string) => maskQuotedSpans(row).includes(live);
  const flags = (row: string) => PRE_0169_DML.test(maskQuotedSpans(row));

  it("1. POSTPOSITIVE ADJACENT — the described quote is historical", () => {
    expect(maskQuotedSpans(`| "A harmless statement" was corrected. |`)).not.toContain(
      "A harmless statement",
    );
  });

  it("2. POSTPOSITIVE NON-ADJACENT — an unrelated subject's correction does not reach back", () => {
    // THE DEFECT THIS EXISTS FOR. "was corrected" belongs to "an unrelated
    // table"; it says nothing about the DML quotation two clauses earlier.
    const row = `| Current posture: "${live}"; an unrelated table was corrected; note: "safe" |`;
    expect(isLive(row), "the DML quotation must stay visible to C2").toBe(true);
    expect(flags(row), "C2 must go red on this row").toBe(true);
  });

  it("3. POSTPOSITIVE DIFFERENT SUBJECT — same shape, one clause away", () => {
    const row = `| "${live}"; the previous migration description was corrected. |`;
    expect(isLive(row)).toBe(true);
    expect(flags(row)).toBe(true);
  });

  it("4. PREPOSITIVE ADJACENT — the introduced quote is historical", () => {
    expect(maskQuotedSpans(`| Corrected previous wording: "${old}" |`)).not.toContain(old);
  });

  it("5. PREPOSITIVE NON-ADJACENT — a marker about another section does not carry forward", () => {
    const row = `| Corrected previous wording in another section; current posture: "${live}" |`;
    expect(isLive(row)).toBe(true);
    expect(flags(row)).toBe(true);
  });

  it("6. SAME CELL, TWO QUOTES — only the introduced one is historical", () => {
    const row = `| Corrected previous wording "${old}"; current posture "${live}" |`;
    const masked = maskQuotedSpans(row);
    expect(masked).not.toContain(old);
    expect(masked).toContain(live);
  });

  it("7. CROSS CELL — a marker in cell A does not license a quotation in cell B", () => {
    expect(isLive(`| Corrected: previously read "${old}" | "${live}" is current |`)).toBe(true);
  });

  it("8. NO MARKER — the document is speaking", () => {
    const row = `| Current posture: "${live}" |`;
    expect(isLive(row)).toBe(true);
    expect(flags(row)).toBe(true);
  });

  it("the supported canonical shapes still read as historical", () => {
    // Drawn from the shapes the canonical documents actually use, so the
    // grammar is pinned to real writing rather than to invented English.
    for (const row of [
      `| This row previously read *"${old}"* and 0169 revoked it |`,
      `| This passage previously continued: *"${old}"* |`,
      `| This row used to read *"${old}"* |`,
      `| *(Earlier wording — "${old}" — is superseded.)* |`,
    ]) {
      expect(maskQuotedSpans(row), `must stay historical: ${row.slice(0, 70)}`).not.toContain(old);
    }
  });
});

describe("RULE C2 — no canonical doc says authenticated still holds clinical row DML", () => {
  it.each(NO_CURRENT_MAX_DOCS)("%s carries no live pre-0169 assertion", (name, doc) => {
    const offenders = currentProse(doc)
      .split("\n")
      // Quoted text is the correction's evidence; the rest of the line is the
      // document speaking. Mask the quotes and judge only what remains.
      .filter((l) => PRE_0169_DML.test(maskQuotedSpans(l)))
      // A preserved historical heading is legal while it is marked CLOSED -
      // the same convention L2, L18 and L23 already use.
      .filter((l) => !(/^##\s/.test(l) && /\bCLOSED\b/.test(l)))
      .map((l) => l.trim().slice(0, 150));

    expect(
      offenders,
      `${name} states as CURRENT fact that authenticated holds clinical row DML. ` +
        "Migration 0169 revoked it on all six tables and L18 is CLOSED, so this contradicts " +
        "both the migration and the sibling document it usually cites. Mark it historical or " +
        `remove it. Offending: ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });

  it("C2 controls: the exemption covers the quoted span, and nothing else", () => {
    const live = (line: string) => PRE_0169_DML.test(maskQuotedSpans(line));

    // A - bare assertion.
    expect(live("`authenticated` still holds INSERT/UPDATE/DELETE on the clinical tables")).toBe(true);

    // B - a correction MARKER does not launder an unquoted assertion. This is
    // the hole: the marker was enough on its own.
    expect(live("CORRECTED: authenticated still holds row INSERT/UPDATE/DELETE")).toBe(true);

    // C - the genuine shape, quoted and past-tense.
    expect(
      live('Previous wording: "authenticated still held INSERT/UPDATE/DELETE before 0169"'),
    ).toBe(false);

    // D - a row carrying a legitimate quoted correction AND a separate live
    // assertion outside the quotes. The row must still fail.
    expect(
      live(
        '| Clinical | ⚠️ corrected: this read *"row DML is NOT revoked"* | and row DML on the five app-written tables is NOT revoked |',
      ),
    ).toBe(true);

    // F - Codex's bypass: a quotation that ATTRIBUTES a live claim rather than
    // preserving a superseded one. No marker introduces it, so it is not masked.
    expect(live('Current posture: "authenticated still holds row INSERT/UPDATE/DELETE"')).toBe(true);

    // G - the same sentence, genuinely introduced as history, stays legal.
    expect(
      live('This row previously read: "authenticated still holds row INSERT/UPDATE/DELETE"'),
    ).toBe(false);

    // E - current, correct post-0169 wording.
    expect(
      live("`0169` revoked insert, update and delete from `authenticated` on all six tables"),
    ).toBe(false);
  });

  it("L18 is still recorded as CLOSED, so the correction has something to point at", () => {
    expect(
      KNOWN_LIMITATIONS,
      "L18's heading must remain, marked CLOSED by 0169",
    ).toMatch(/^##\s+L18\s+—[^\n]*\bCLOSED\b[^\n]*0169/m);
  });
});

// ===========================================================================
// RULE X — CROSS-DOCUMENT PARITY
//
// THE PATTERN THIS EXISTS TO BREAK. Three review rounds found the same shape:
// a class was fixed thoroughly in current-state.md and left standing in a
// sibling. F-RET-001 was re-derived to P2 in L27 while a summary bullet four
// hundred lines above still said P1. The capability register kept naming
// "PR #644 ... eight runtime files" across two production moves. A dated
// waitlist zero was corrected in one document and stayed present-tense in two
// others.
//
// Every rule above this one reads ONE document at a time, which is exactly why
// none of them caught it. These read ACROSS documents and fail when two
// canonical files disagree about one fact - so fixing the cited line and
// leaving its twin is red, not green.
// ===========================================================================

/** All five canonical documents, for rules that must see the whole set. */
const CANONICAL_SET = [
  ["docs/production/current-state.md", CURRENT_STATE],
  ["docs/production/capability-register.md", CAPABILITY_REGISTER],
  ["docs/production/known-limitations.md", KNOWN_LIMITATIONS],
  ["docs/production/release-changelog.md", RELEASE_CHANGELOG],
  ["docs/production/migration-ledger.md", MIGRATION_LEDGER],
] as const;

/**
 * Parse a count these documents write, as a WORD or as DIGITS.
 *
 * This replaced a fixed lookup table that stopped at twenty, and then at
 * thirty. Both ceilings were the same bug: production advances, the true count
 * eventually exceeds the table, and a guard that cannot REPRESENT the fact it
 * checks starts failing documents that are correct - which pressures the
 * document to be wrong. Raising the ceiling to 31, 32, 33 just reschedules it.
 *
 * So the parser is COMPOSITIONAL rather than enumerated: units, teens, tens,
 * optional hyphen or space, optional hundreds, optional "and". Digits are
 * accepted too and are unbounded, which is the escape hatch if a count ever
 * outgrows comfortable English. Nothing here needs editing when production
 * moves.
 */
const UNITS: Readonly<Record<string, number>> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19,
};
const TENS: Readonly<Record<string, number>> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/** Number a count word/phrase denotes, or null when it is not a count at all. */
function parseCount(raw: string): number | null {
  const text = raw.trim().toLowerCase();
  if (/^\d+$/.test(text)) return Number(text);
  const tokens = text.split(/[\s-]+/).filter((t) => t && t !== "and");
  if (tokens.length === 0) return null;
  let total = 0;
  let current = 0;
  let sawAny = false;
  for (const t of tokens) {
    if (t === "hundred") {
      if (current === 0) return null; // "hundred" with nothing before it
      current *= 100;
      sawAny = true;
      continue;
    }
    if (t in TENS) {
      current += TENS[t];
      sawAny = true;
      continue;
    }
    if (t in UNITS) {
      current += UNITS[t];
      sawAny = true;
      continue;
    }
    return null; // any non-number token means this is not a count
  }
  if (!sawAny) return null;
  total += current;
  return total;
}

const isCountWord = (w: string) => parseCount(w) !== null;

/**
 * Regex source matching a COMPLETE count phrase, and nothing else.
 *
 * `parseCount` already understood "one hundred and five"; the CONSUMERS did
 * not. Both extraction sites captured a single `\w+` (later `[\w-]+`) token, so
 * the parser was handed "one" and the rest of the phrase was dropped on the
 * floor - a capable parser defeated by its caller, which is worse than a
 * limited parser because the limitation is invisible.
 *
 * Built FROM the parser's own vocabulary rather than written alongside it, so
 * the two cannot drift: adding a word to UNITS/TENS extends this automatically.
 * It is a bounded grammar, not a wildcard - only number tokens joined by a
 * space or hyphen, with an optional "and". Ordinary prose cannot be swallowed,
 * because the first non-number token ends the match.
 */
const NUM_TOKEN = [...Object.keys(UNITS), ...Object.keys(TENS), "hundred"]
  .sort((a, b) => b.length - a.length) // longest-first: "nineteen" before "nine"
  .join("|");
const COUNT_PHRASE =
  // `\b` AT BOTH ENDS, and it is load-bearing rather than defensive. Without
  // it the alternation happily starts INSIDE an ordinary word: "none",
  // "someone", "stone" and "alone" all yielded "one", so a document asserting
  // **none** carry a capability parsed as the number 1 and passed silently
  // wherever 1 was the expected count. A wrong number that parses is the
  // failure mode this whole grammar exists to remove.
  `\\b(?:\\d+|(?:${NUM_TOKEN})(?:[\\s-]+(?:and[\\s-]+)?(?:${NUM_TOKEN}))*)\\b`;

/**
 * Split a document into units a CLAIM can live in.
 *
 * A table row is one unit - it is one statement, however long. Ordinary prose
 * is unwrapped paragraph-first and then split on sentence terminators, because
 * these files wrap at ~95 columns and a claim is routinely separated from the
 * qualification that withdraws it by nothing but a newline.
 */
function sentenceUnits(doc: string): string[] {
  const units: string[] = [];
  for (const block of doc.split(/\n\s*\n/)) {
    const lines = block.split("\n");
    if (lines.some((l) => l.trim().startsWith("|"))) {
      units.push(...lines);
      continue;
    }
    const joined = lines.join(" ").replace(/\s+/g, " ").trim();
    if (!joined) continue;
    units.push(...joined.split(/(?<=[.;])\s+/));
  }
  return units;
}

describe("RULE X — canonical documents agree with each other", () => {
  it("X1: F-RET-001's severity is stated in L27 and matched wherever else it appears", () => {
    const sectionStart = KNOWN_LIMITATIONS.indexOf("## L27");
    expect(sectionStart, "L27 must exist").toBeGreaterThan(-1);
    const authority = KNOWN_LIMITATIONS.slice(sectionStart).match(/\*\*(P\d) — OPEN\.\*\*/)?.[1];
    expect(authority, "L27 must state a severity in the form **Pn — OPEN.**").toBeTruthy();

    const wrong: string[] = [];
    for (const [name, doc] of CANONICAL_SET) {
      for (const line of currentProse(doc).split("\n")) {
        if (!/F-RET-001/.test(line)) continue;
        if (!/\bP\d\b/.test(line)) continue;
        if (CORRECTION_MARKER.test(line) || /revision of this entry|\bWas P\d\b/i.test(line)) continue;
        const levels = [...line.matchAll(/\bP(\d)\b/g)].map((m) => "P" + m[1]);
        if (levels.some((l) => l !== authority)) wrong.push(`${name}: ${line.trim().slice(0, 130)}`);
      }
    }
    expect(
      wrong,
      `a canonical document states an F-RET-001 severity other than L27's ${authority}. L27 is ` +
        "the authority; every other mention must match it or be marked as the withdrawn wording. " +
        `Offending: ${JSON.stringify(wrong)}`,
    ).toEqual([]);
  });

  it("X2: only current-state.md names WHICH PR is the current runtime baseline", () => {
    // A4 stops a second document copying the SHA. The PR number and the runtime
    // file count are the same fact wearing different clothes, and they rotted
    // for two production moves while the SHA beside them stayed correct.
    const offenders: string[] = [];
    for (const [name, doc] of CANONICAL_SET) {
      if (name.endsWith("current-state.md") || name.endsWith("release-changelog.md")) continue;
      for (const line of currentProse(doc).split("\n")) {
        if (!/runtime[- ]bearing/i.test(line)) continue;
        if (CORRECTION_MARKER.test(line)) continue;
        if (/#\d{3,4}\b/.test(line) || /\b(?:four|eight|twelve|\d+)\s+(?:runtime|deployed)\s+files?\b/i.test(line)) {
          offenders.push(`${name}: ${line.trim().slice(0, 130)}`);
        }
      }
    }
    expect(
      offenders,
      "a canonical document other than current-state.md names the PR or the runtime file count " +
        "of the current baseline. That is the same derived fact as the SHA and rots the same way. " +
        `Reference current-state.md instead. Offending: ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });

  it("X3: no canonical document turns a dated measurement into a present-tense one", () => {
    // THREE REMEMBERED PHRASES WAS NOT A CLASS. The first revision matched only
    // "currently holds/has/stands/contains", "holds ... now" and "is being
    // collected", and three live claims walked straight through it:
    //   "that count is currently **4 unresolved ops_alerts rows** (2026-08-23)"
    //   the settlement table "holds 0 rows"
    //   "No settlement has been recorded in production"
    //
    // The shape that actually matters is a PRESENT-TENSE STATE VERB carrying a
    // COUNT - including zero, and including zero expressed as a negation, which
    // is the form that hides best. Every production figure in this set is dated
    // evidence, so the tense is the defect regardless of the noun.
    const COUNT = String.raw`(?:\*{0,2}(?:\d+|zero|no)\b)`;
    const STATE_VERB = String.raw`(?:holds?|has|have|contains?|stands?\s+at|is|are|remains?)`;
    const PRESENT_TENSE_MEASURE = new RegExp(
      [
        // "currently holds 4" · "is currently 4 unresolved rows" · "now holds 0 rows"
        String.raw`\b(?:currently|now)\b[^.\n|]{0,20}\b${STATE_VERB}\b[^.\n|]{0,20}${COUNT}`,
        String.raw`\b${STATE_VERB}\b[^.\n|]{0,20}\b(?:currently|now)\b[^.\n|]{0,20}${COUNT}`,
        // A BARE present-tense count, with the FULL state-verb set rather than
        // two of them. Restricting this branch to holds/contains meant the
        // commonest phrasings walked straight through without needing
        // "currently" or "now" anywhere:
        //   "appointment_settlements has 0 rows"
        //   "There are 4 unresolved ops_alerts rows"
        //   "the queue remains 4 records"
        // The noun anchor keeps it bounded, and the gap allows the qualifiers
        // these documents actually write ("4 unresolved ops_alerts rows").
        // A NUMERAL, deliberately, not the full COUNT. With "currently"/"now"
        // above, any count form is a claim about today. WITHOUT a temporal
        // qualifier only a numeral is unambiguous evidence of a measurement:
        // the word forms "no"/"zero" are just as often structural rather than
        // measured ("there is no `NAV_ENTRIES` row", "these merges have no row
        // here"), and matching them turned this rule against the document's own
        // prose. Zero stated as a negation is already covered by its own branch
        // below, which is anchored on recorded/created/collected.
        String.raw`\b${STATE_VERB}\s+\*{0,2}\d+\b[^.\n|]{0,30}?(?:rows?|entries|records)\b`,
        // "No settlement has been recorded" - a zero stated as a negation
        String.raw`\b(?:no|zero)\s+\w[\w-]{2,}(?:\s+\w[\w-]{2,})?\s+(?:has|have)\s+been\s+(?:recorded|created|collected|made)\b`,
        // the original inference form
        String.raw`\bis\s+being\s+collected\b`,
      ].join("|"),
      "i",
    );
    // SENTENCE-SCOPED, NOT LINE-SCOPED. These documents wrap prose at ~95
    // columns, so a claim and the disclaimer that qualifies it routinely land on
    // different lines - "it does not prove the table is empty now, nor / that no
    // prospect entry has been created since" is one sentence and two lines. A
    // line-scoped rule reported the second half as a claim while the first half
    // withdrew it. Table rows stay single units, which is also correct: a row is
    // one statement.
    const offenders: string[] = [];
    for (const [name, doc] of CANONICAL_SET) {
      for (const line of sentenceUnits(currentProse(doc))) {
        if (!PRESENT_TENSE_MEASURE.test(line)) continue;
        // A date beside the figure does NOT license the present tense - that was
        // the whole defect. Only an explicit correction, or a negated form
        // ("no prospect data is NOT being collected" style disclaimers), is
        // exempt. `when last measured` is the sanctioned past-tense phrasing and
        // never matches the pattern in the first place.
        // A DISCLAIMER is not a claim. "it does not prove the table is empty
        // now, nor that no prospect entry has been created since" states the
        // absence of knowledge, and the negated-count shape above matches it by
        // construction. Flagging a warning as the claim it warns against is the
        // false positive that teaches people to delete the warning.
        const DISCLAIMER =
          /\bdoes\s+not\s+prove\b|\bnor\s+that\b|\bis\s+not\s+a\s+claim\b|\bnever\s+a\s+claim\b|\bcannot\s+(?:be\s+)?(?:known|assumed)\b/i;
        if (CORRECTION_MARKER.test(line) || DISCLAIMER.test(line)) continue;
        offenders.push(`${name}: ${line.trim().slice(0, 130)}`);
      }
    }
    expect(
      offenders,
      "a canonical document states a measured figure in the present tense. Every production count " +
        "in this set is dated evidence - none was re-measured at this reconciliation - so say when " +
        `it was measured, not that it holds now. Offending: ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });

  it("X4: both documents' merge counts equal the count Git actually reports", async () => {
    // This used to compare one prose number with the other, so two documents
    // agreeing on a WRONG number passed. They did: both said "fourteen" while
    // the ancestry had moved, and the rule was green throughout. Prose-to-prose
    // agreement is consistency, not correctness - the Git graph is the
    // authority, and it is the thing that moves.
    const cs = currentProse(CURRENT_STATE).match(
      new RegExp(`full merge ancestry back to \`b9e0003f\` \\((${COUNT_PHRASE}) merges\\)`, "i"),
    )?.[1];
    const cr = currentProse(CAPABILITY_REGISTER).match(
      new RegExp(`\\*{0,2}(${COUNT_PHRASE})\\*{0,2}\\s+production merges landed between \`b9e0003f\``, "i"),
    )?.[1];
    expect(cs, "current-state must state the merge count").toBeTruthy();
    expect(cr, "capability-register must state the merge count").toBeTruthy();

    const csN = parseCount(cs as string);
    const crN = parseCount(cr as string);
    expect(csN, `current-state's count is not parseable: ${cs}`).not.toBeNull();
    expect(crN, `capability-register's count is not parseable: ${cr}`).not.toBeNull();

    // They must still agree with each other - a cheap check that survives a
    // shallow clone, where the authoritative one below cannot run.
    expect(
      crN,
      "the two documents count the same merges since the same baseline and must agree",
    ).toBe(csN);

    requireUsableGit("X4's Git derivation");
    // ENDPOINT = the CURRENT PRODUCTION GIT HEAD. Two wrong endpoints were
    // tried before this one, and both produced a confidently wrong number:
    //
    //   `HEAD`              - on a PR branch `--first-parent` walks the PR's
    //                         OWN chain. It reported 5, this branch's successive
    //                         "merge production in" commits, against a true 27.
    //   runtime-bearing pin - a DOCS-ONLY production merge advances the branch
    //                         HEAD without moving the runtime SHA, so counting
    //                         from the pin undercounts by every such merge and
    //                         does it silently. MERGE_COUNT_AUTHORITY is not
    //                         RUNTIME_SHA; they are separate rows for exactly
    //                         this reason, and they happen to be equal today,
    //                         which is what hid the error.
    //
    // Runtime-behaviour rules keep using the pin. Only this count uses the head.
    const baseline = currentGitHeadSha();
    expect(baseline, "current-state must record a Current Git branch HEAD for X4 to count against").toBeTruthy();
    const log = git("log", "--first-parent", "--merges", "--format=%H", `b9e0003f..${baseline}`);
    expect(log, "git could not enumerate the ancestry from b9e0003f").not.toBeNull();
    const actual = (log as string).split("\n").filter(Boolean).length;
    expect(
      actual,
      "b9e0003f must be reachable with merges after it, or this rule proves nothing",
    ).toBeGreaterThan(0);
    expect(
      csN,
      `both documents state ${csN} merges since \`b9e0003f\`, but git log --first-parent ` +
        `--merges b9e0003f..${(baseline as string).slice(0, 8)} reports ${actual}. The graph is the ` +
        `authority; the prose is a ` +
        "copy of it, and this is the copy going stale.",
    ).toBe(actual);
  });

  it(`A5${FRESHNESS_TAG}: the recorded Current Git branch HEAD is the production ref, or only record-only or receipt-covered merges follow it`, async () => {
    // READING THE VALUE FROM THE DOCUMENT IS NOT VERIFYING IT. X4 counts to the
    // recorded Git head, which closed one hole and left a subtler one: the
    // RECORDED VALUE can itself be stale. After a documentation-only production
    // merge, A2/A3 stay green by construction - the runtime-bearing SHA has not
    // moved and no runtime file changed - while the branch has advanced, the
    // recorded head still names the older commit, and X4 dutifully counts to
    // that stale commit and agrees with a stale prose count. Every rule passes
    // and every number is wrong.
    //
    // So the head is checked against the actual ref. The branch NAME is read
    // from the document (it is a recorded fact like any other) and resolved
    // locally - no network. Where the ref is not present, as in a shallow CI
    // clone, this reports that it could not run rather than passing quietly,
    // the same contract A1/A2/A3 use.
    //
    // (iv), #825 6215529089: equality alone was unsatisfiable ON production -
    // a record refresh records its own base, and its own merge is a newer HEAD.
    // So later first-parent merges that change ONLY docs/production/** are
    // record-only and do not make the recorded HEAD stale. Anything else - any
    // other path, or ancestry that cannot be inspected - still does.
    //
    // HON-18 39ad5aaf: a non-record merge whose pending-release receipt git
    // confirms (coveredSince) is batched rather than stale. A7 bounds how many
    // and how old; everything uncovered still fails exactly as before.
    const recorded = currentGitHeadSha();
    expect(recorded, "current-state must record a Current Git branch HEAD").toBeTruthy();

    const branch = productionBranch();
    expect(branch, "current-state must name the production branch for this rule to resolve it").toBeTruthy();

    requireUsableGit("A5");
    const ref = resolveProductionRef(git, branch);
    if (!ref) {
      throw new Error(`A5 cannot run: neither origin/${branch} nor ${branch} is present in this clone. Fetch it (fetch-depth: 0).`);
    }
    const since = await coveredSince(git, recorded as string, ref, loadLateReceipts(ref));
    freshnessVerdict(
      "A5",
      since.ok,
      `current-state records the Current Git branch HEAD as ${(recorded as string).slice(0, 8)}, but ` +
        `${branch} points at ${ref.slice(0, 8)} and not everything after the recorded HEAD is ` +
        `record-only or receipt-covered: ${since.ok ? "" : since.reason}. A non-record production merge advances the ` +
        "branch, so this row and every count derived from it are stale until the record is refreshed, " +
        `or until the merge carries a ${PENDING_RELEASES_DIR}/<PR>.json receipt.`,
    );
  });

  it(`A7${FRESHNESS_TAG}: receipt-covered merges after the recorded HEAD stay within the batching bound`, async () => {
    // Batching is a deferral, never an exemption. At most MAX_COVERED_MERGES
    // covered merges may follow the recorded HEAD, and the oldest may trail the
    // production tip by at most MAX_COVERED_LAG_SECONDS of git committer time
    // (git time, so the verdict is reproducible rather than a wall-clock bomb).
    const recorded = currentGitHeadSha();
    expect(recorded, "current-state must record a Current Git branch HEAD").toBeTruthy();
    const branch = productionBranch();
    requireUsableGit("A7");
    const ref = resolveProductionRef(git, branch);
    if (!ref) throw new Error(`A7 cannot run: the production ref for ${branch ?? "(no branch recorded)"} is not present in this clone.`);
    const since = await coveredSince(git, recorded as string, ref, loadLateReceipts(ref));
    // An uncovered history is A5's failure, reported there; A7 judges only the batch.
    const lag = since.ok ? coveredLag(git, since.covered, ref) : ({ ok: true } as const);
    freshnessVerdict(
      "A7",
      lag.ok,
      `the production record is batched past its bound: ${lag.ok ? "" : lag.reason}. Land the batched ` +
        "record PR (narrative, Current Git branch HEAD and runtime pin) before more releases.",
    );
  });

  it("X4's endpoint is the production GIT HEAD, not the runtime pin — they are different facts", () => {
    // A DOCS-ONLY production merge advances the branch head and leaves the
    // runtime-bearing SHA where it was. Counting merges from the pin therefore
    // undercounts by every docs-only merge, silently. Constructed proof, run
    // against a real throwaway history rather than asserted:
    //
    //   baseline -> merge #1 (app/x.ts)   <- runtime pin stops here, count 1
    //            -> merge #2 (docs/y.md)  <- branch head is here,   count 2
    //
    // Prose still saying "one" passes when counted from the pin and fails when
    // counted from the head. That is the whole defect, and it is invisible on
    // this repository today because the two rows name the same commit.
    const head = currentGitHeadSha();
    const pin = pinnedRuntimeSha();
    expect(head, "current-state must record a Current Git branch HEAD").toBeTruthy();
    expect(pin, "current-state must pin a runtime-bearing HEAD").toBeTruthy();

    // The two authorities are read from DIFFERENT rows. Equal values are legal
    // and are the normal case; reading them from one row would not be.
    const rows = currentProse(CURRENT_STATE).split("\n");
    const headRow = rows.findIndex((l) => /Current Git branch HEAD/i.test(l));
    const pinRow = rows.findIndex((l) => /Last runtime-bearing application HEAD/i.test(l));
    expect(headRow, "the Git-head row must exist").toBeGreaterThan(-1);
    expect(pinRow, "the runtime-pin row must exist").toBeGreaterThan(-1);
    expect(
      headRow,
      "the merge-count authority and the runtime-behaviour authority must be separate rows - " +
        "collapsing them is what makes a docs-only production merge invisible to the count",
    ).not.toBe(pinRow);

    requireUsableGit("the endpoint check");
    // The head must be an ancestor-or-equal of nothing weaker than the pin:
    // production only ever moves forward, so the head can never be BEHIND the
    // runtime pin. If it ever is, one of the two rows is stale.
    expect(
      git("merge-base", "--is-ancestor", pin as string, head as string),
      `the runtime pin ${(pin as string).slice(0, 8)} is not an ancestor of the recorded Git ` +
        `head ${(head as string).slice(0, 8)} - one of the two header rows is stale`,
    ).toBe("");
  });

  it("count extraction hands parseCount the WHOLE phrase, at every consumer", () => {
    // The parser understood "one hundred and five" long before the consumers
    // did. Both extraction sites captured a single token, so X5 did not merely
    // fail to parse "twenty-seven" - it captured "seven" and compared against
    // SEVEN. A wrong number that parses is worse than one that does not.
    const cases: ReadonlyArray<readonly [string, number]> = [
      ["27", 27],
      ["250", 250],
      ["4096", 4096],
      ["twenty-seven", 27],
      ["thirty-one", 31],
      ["forty-two", 42],
      ["one hundred and five", 105],
    ];
    const registerRe = new RegExp(
      `\\*{0,2}(${COUNT_PHRASE})\\*{0,2}\\s+production merges landed between \`b9e0003f\``,
      "i",
    );
    const capabilityRe = new RegExp(
      `\\*{0,2}(${COUNT_PHRASE})\\*{0,2}\\s+carry\\s+a\\s+capability`,
      "i",
    );
    for (const [phrase, value] of cases) {
      const reg = `**${phrase}** production merges landed between \`b9e0003f\` and the baseline.`;
      const cap = `**${phrase}**\ncarry a capability that belongs in this register.`;
      expect(parseCount(reg.match(registerRe)?.[1] ?? ""), `register: ${phrase}`).toBe(value);
      expect(parseCount(cap.match(capabilityRe)?.[1] ?? ""), `capability: ${phrase}`).toBe(value);
    }

    // The grammar is bounded: a non-number word is not a count, and must not
    // match at all rather than matching some fragment of itself.
    const bananaReg = "**banana** production merges landed between \`b9e0003f\` and the baseline.";
    const bananaCap = "**banana**\ncarry a capability that belongs in this register.";
    expect(bananaReg.match(registerRe)?.[1], "banana must not match the register grammar").toBeUndefined();
    expect(bananaCap.match(capabilityRe)?.[1], "banana must not match the capability grammar").toBeUndefined();
    expect(parseCount("banana"), "banana is not a count").toBeNull();
  });

  it("X6: the changelog covers every production PR that actually merged in its range", () => {
    // ENDPOINT AGREEMENT IS NOT COVERAGE. This compared the claimed upper bound
    // with `Math.max(...rows)`, so "#632-#650" was satisfied by carrying #632
    // and #650 and nothing in between - a range can be complete at both ends
    // and hollow in the middle, which is precisely the shape a hand-maintained
    // table drifts into.
    //
    // The authority is the first-parent production history, not the numbers in
    // the table. And it must be the set of PRs that ACTUALLY MERGED: PR numbers
    // are not contiguous production history, so a draft or abandoned PR (#647
    // is open and drafted today) leaves a legitimate numeric gap that is not
    // missing coverage. Enumerating integers would manufacture that defect.
    const rows = new Set(
      [...RELEASE_CHANGELOG.matchAll(/^\|\s*\*{0,2}#(\d{3,4})\*{0,2}\s*\|/gm)]
        .map((m) => Number(m[1]))
        .filter((n) => n >= 632),
    );
    expect(rows.size, "the changelog must carry rows in the reconciled range").toBeGreaterThan(0);

    const claims = [...RELEASE_CHANGELOG.matchAll(/#632[–-]#?(\d{3,4})/g)].map((m) => Number(m[1]));
    expect(
      claims.length,
      "the changelog must state the range it covers, so the claim can be checked",
    ).toBeGreaterThan(0);

    // Every coverage sentence states one derived fact and they must agree.
    const distinct = [...new Set(claims)];
    expect(
      distinct.length,
      `the changelog states more than one coverage upper bound: ${JSON.stringify(distinct)}`,
    ).toBe(1);
    const upper = distinct[0];

    requireUsableGit("X6's completeness check");
    // THE DOCUMENT'S CLAIM MUST NEVER NARROW THE AUTHORITY. The previous
    // revision filtered the merged set to `pr <= upper`, so a production merge
    // BEYOND the stated bound was removed from the evidence before comparison:
    // production gains #660, the document still claims through #659 and still
    // ends its rows at #659, and the rule passed because the one PR that would
    // have exposed the staleness had been filtered out by the very claim under
    // test. The set is derived over the whole reconciliation span, and the
    // claim is then checked against it.
    const baseline = currentGitHeadSha();
    expect(baseline, "current-state must record a Current Git branch HEAD").toBeTruthy();
    const subjects = git("log", "--first-parent", "--merges", "--format=%s", `b9e0003f..${baseline}`) ?? "";
    // TWO SUBJECT FORMS, AND ONLY ONE WAS READ. GitHub's merge button writes
    // "Merge pull request #N from ...", but this repository also carries
    // squash-style merges whose subject ends in "(#N)" — `8e1e5009` (#696) and
    // `db4762db` (#697). Matching only the first form silently shrank the
    // authority: Git held 81 PR merges in the span, the extraction saw 79, and
    // a changelog missing both rows was certified COMPLETE. A completeness rule
    // that cannot see part of the history is not a completeness rule, and the
    // failure is invisible precisely because the omission is on the evidence
    // side rather than the claim side.
    const merged = new Set(
      [...subjects.matchAll(/Merge pull request #(\d{3,4})\b|\(#(\d{3,4})\)\s*$/gm)]
        .map((m) => Number(m[1] ?? m[2]))
        // Lower bound only: this is the reconciliation span. NO upper bound -
        // that is the defect above.
        .filter((n) => n >= 632),
    );
    expect(
      merged.size,
      "no merged production PRs were found in the reconciliation span, so this rule would prove nothing",
    ).toBeGreaterThan(0);

    // 1 + 3. Every PR that ACTUALLY MERGED needs a row. This catches an
    //        internal gap and a stale tail with the same assertion, because
    //        neither is filtered out of `merged` any more.
    const missing = [...merged].filter((pr) => !rows.has(pr)).sort((a, b) => a - b);
    expect(
      missing,
      `${missing.length} production PR(s) that actually merged have no changelog row. A range ` +
        "complete at both ends can still be hollow, and a newly merged tail is invisible if the " +
        `document's own claim is allowed to bound the evidence. Missing: ${JSON.stringify(missing)}`,
    ).toEqual([]);

    // 2 + 4. The stated endpoint must equal the highest PR that actually
    //        merged - so a tail beyond the claim fails even in the hypothetical
    //        case where someone added the row but left the sentence behind.
    const highestMerged = Math.max(...merged);
    expect(
      upper,
      `the changelog claims coverage through #${upper}, but the highest production PR that ` +
        `actually merged in this span is #${highestMerged}. The claim is checked against Git; ` +
        "Git is never narrowed by the claim.",
    ).toBe(highestMerged);

    // The upper bound must still BE a merged PR and the highest one covered -
    // otherwise coverage could be claimed through a number that never landed.
    expect(
      rows.has(upper),
      `the changelog claims coverage through #${upper} but carries no row for it`,
    ).toBe(true);
  });

  it("X5: the register's capability section counts what it actually lists, contiguously", () => {
    // The real defect had two halves and neither was a counting error alone:
    // section 15 said "Six" while production had moved twice past it, AND the
    // #646 row was appended after a BLANK LINE, which severs a Markdown table -
    // the row rendered outside it and was excluded from every count.
    //
    // This deliberately does NOT try to decide which merges are "capabilities".
    // That is an editorial judgement; a stated count disagreeing with the rows
    // beneath it, or a table broken in half, is not.
    const start = CAPABILITY_REGISTER.indexOf("## 15. Capabilities added");
    expect(start, "the register must carry its capability section").toBeGreaterThan(-1);
    const rest = CAPABILITY_REGISTER.slice(start);
    const end = rest.indexOf("\n## ", 1);
    const section = end === -1 ? rest : rest.slice(0, end);

    // `\s+` throughout: the prose wraps, so "**Eight** carry\na capability" is
    // one sentence across two lines and a literal space would miss it.
    const stated = section.match(
      new RegExp(`\\*{0,2}(${COUNT_PHRASE})\\*{0,2}\\s+carry\\s+a\\s+capability`, "i"),
    )?.[1];
    expect(stated, "the section must state how many capabilities it carries").toBeTruthy();
    expect(isCountWord(stated as string), `unexpected count word: ${stated}`).toBe(true);

    const lines = section.split("\n");
    const headerIdx = lines.findIndex((l) => /^\|\s*Capability\s*\|/i.test(l));
    expect(headerIdx, "the section must carry a capability table").toBeGreaterThan(-1);

    // Walk from the header: the contiguous table ends at the first non-table
    // line. THEN keep looking. Stopping at the break made this rule REPRODUCE
    // the orphaning bug instead of detecting it - six rows, a blank line, an
    // orphan seventh, count says six, equality passes. That is the exact old
    // #646 layout, and the rule written to catch it would have signed it off.
    let rows = 0;
    let k = headerIdx + 1;
    for (; k < lines.length; k++) {
      const l = lines[k];
      if (!l.trim().startsWith("|")) break;
      if (/^\|\s*-{2,}/.test(l)) continue;
      rows++;
    }

    const orphans = lines
      .slice(k)
      .filter((l) => l.trim().startsWith("|"))
      .filter((l) => !/^\|\s*-{2,}/.test(l))
      .map((l) => l.trim().slice(0, 110));
    expect(
      orphans,
      "section 15 has table row(s) AFTER its table ends. A blank line severs a Markdown table, " +
        "so these render outside it and no count includes them - which is how the #646 row went " +
        `missing. Re-attach them to the table above. Offending: ${JSON.stringify(orphans)}`,
    ).toEqual([]);

    expect(
      rows,
      `section 15 says it carries ${stated} capabilities but its table holds ${rows} contiguous ` +
        "row(s). Either the count is stale, or a row was appended after a blank line and fell " +
        "out of the table - both have happened here.",
    ).toBe(parseCount(stated as string));
  });
});

describe("RULE A4 — only current-state.md pins the runtime-bearing SHA", () => {
  const SHA_FREE_DOCS = [
    ["docs/production/capability-register.md", CAPABILITY_REGISTER],
    ["docs/production/known-limitations.md", KNOWN_LIMITATIONS],
  ] as const;

  it.each(SHA_FREE_DOCS.map(([n, d]) => [n, d] as const))(
    "%s contains no 40-hex commit SHA at all",
    (name, doc) => {
      const shas = shasIn(currentProse(doc));
      expect(
        shas,
        `${name} names a commit SHA. Only current-state.md may pin one; every other canonical ` +
          "document must reference it, because a second copy is a second thing to go stale and " +
          `nothing validates this one. Offending: ${JSON.stringify(shas)}`,
      ).toEqual([]);
    },
  );

  it("both documents actually point at the authority rather than just omitting it", () => {
    for (const [name, doc] of SHA_FREE_DOCS) {
      expect(
        doc,
        `${name} must reference current-state.md for the runtime-bearing baseline. Silently ` +
          "dropping the SHA without saying where it lives leaves the reader with nothing",
      ).toMatch(/current-state\.md/);
    }
  });
});

describe("RULE F — open PRs are declared, and never described as shipped", () => {
  it("current-state.md declares its open set explicitly", () => {
    expect(
      openPrSection(),
      `current-state.md must carry an "${OPEN_PR_SECTION}" section. Without it there is no ` +
        "record of what was deliberately excluded, and the next reader cannot tell an omission " +
        "from a decision",
    ).not.toBe("");
    expect(
      declaredOpenPrs().length,
      "the open-PR section must name at least one PR, or say plainly that the set is empty",
    ).toBeGreaterThan(0);
  });

  it("every declared-open PR carries a non-production state word", () => {
    for (const line of openPrSection().split("\n")) {
      if (!/#\d{3,5}\b/.test(line) || !line.trim().startsWith("|")) continue;
      expect(
        line,
        `an open-PR row must say what state it is in (OPEN / IN DEVELOPMENT / not merged): ${line.trim().slice(0, 120)}`,
      ).toMatch(/\bOPEN\b|\bIN DEVELOPMENT\b|\bnot merged\b|\bno PR merged\b/i);
    }
  });

  it("no canonical doc OUTSIDE the declaration describes a declared-open PR as shipped", () => {
    const open = declaredOpenPrs();
    const declaration = openPrSection();
    for (const [name, doc] of NO_CURRENT_MAX_DOCS) {
      for (const line of currentProse(doc).split("\n")) {
        if (line.trim() !== "" && declaration.includes(line)) continue; // rows checked below
        for (const pr of open) {
          if (!new RegExp(`#${pr}\\b`).test(line)) continue;
          expect(
            SHIPPED_WORD.test(line),
            `${name} describes OPEN PR #${pr} as shipped. An open PR is not production, ` +
              `however green its CI. Offending line: ${line.trim().slice(0, 160)}`,
          ).toBe(false);
        }
      }
    }
  });

  // -------------------------------------------------------------------------
  // The declaration table is the LIKELIEST place for this defect, so it is the
  // one place the rule may not skip.
  //
  // The earlier revision excluded the whole section from the shipped-word scan,
  // which meant `| #646 | OPEN | deployed in production |` passed: the state
  // cell said OPEN, and nothing ever read the third cell.
  //
  // Scanning the row for shipped WORDS alone does not work either - a truthful
  // row legitimately says "nothing it adds is live" and "byte-for-byte
  // unchanged, so nothing here is live". Both contain a shipped word, negated.
  //
  // So the rule is clause-scoped: split the row on clause boundaries, and any
  // clause carrying a shipped word must also carry a NEGATOR. Two small closed
  // vocabularies, not a phrase list, and it generalises to wordings nobody has
  // written yet.
  // -------------------------------------------------------------------------
  // CLOSED SET, enumerated. It was `un\w+` once, which made every word starting
  // "un" a negator - so `deployed in production under PR #646` passed Rule F
  // because `under` "negated" it. `unit` and `unknown` did the same. The
  // un-prefixed forms that genuinely negate are few enough to name.
  const NEGATOR =
    /\b(?:not|no|nothing|none|never|neither|nor|cannot|can't|isn't|aren't|without|yet to|unmerged|unreleased|unshipped|undeployed|unavailable)\b/i;

  it("every open-PR ROW is scanned, and a shipped claim there must be negated", () => {
    const rows = openPrSection()
      .split("\n")
      .filter((l) => l.trim().startsWith("|") && /#\d{3,5}\b|IN DEVELOPMENT/i.test(l))
      .filter((l) => !/^\|\s*-{2,}/.test(l));
    expect(rows.length, "the declaration must contain rows to scan").toBeGreaterThan(0);

    for (const row of rows) {
      for (const clause of row.split(/[|.;]/)) {
        if (!SHIPPED_WORD.test(clause)) continue;
        expect(
          NEGATOR.test(clause),
          "an open-PR row asserts, unnegated, that the PR is shipped. This is the exact " +
            "defect Rule F exists to prevent, in the row that is supposed to deny it. " +
            `Offending clause: ${JSON.stringify(clause.trim().slice(0, 140))}`,
        ).toBe(true);
      }
    }
  });

  it("no DECLARED-OPEN PR has actually merged — the converse, and the gap this closes", () => {
    // Rule F stops an open PR being called shipped. Nothing stopped the
    // opposite: a PR that HAS merged still sitting in the open table, which is
    // the same falsehood pointing the other way and is what a production move
    // produces by default. #646 sat there merged until this refresh, and only a
    // human noticed.
    //
    // Decided from the Git graph, not from GitHub: a merge commit reachable
    // from HEAD whose subject names the PR is proof it landed. Skips on a
    // shallow clone for the same reason A2/A3 do.
    requireUsableGit("the converse check");
    const merged = git("log", "--merges", "--format=%s", "HEAD") ?? "";
    // Both subject forms, for the same reason X6 reads both: a PR squash-merged
    // as "(#N)" would otherwise be invisible here, so it could sit in the
    // open-PR table for ever while being part of production — exactly the
    // falsehood this rule exists to catch.
    const landed = declaredOpenPrs().filter((pr) =>
      new RegExp(`Merge pull request #${pr}\\b|\\(#${pr}\\)\\s*$`, "m").test(merged),
    );
    expect(
      landed,
      "current-state.md declares PR(s) OPEN that have already merged into this history. " +
        "A shipped PR described as open is the same defect as an open PR described as shipped, " +
        `and production moving creates it by default. Offending: ${JSON.stringify(landed)}`,
    ).toEqual([]);
  });

  it("the changelog carries no row for a declared-open PR", () => {
    for (const pr of declaredOpenPrs()) {
      expect(
        RELEASE_CHANGELOG,
        `release-changelog.md has a table row for OPEN PR #${pr}. The changelog records what ` +
          "SHIPPED; adding a row before the merge is how an intention becomes a fact",
      ).not.toMatch(new RegExp(`^\\|\\s*\\*{0,2}#${pr}\\*{0,2}\\s*\\|`, "m"));
    }
  });
});

// ===========================================================================
// RULE G — current-state.md is not its own authority
// ===========================================================================

describe("RULE G — no canonical doc is evidence for itself", () => {
  it("current-state.md states plainly that it is not self-evidence", () => {
    expect(
      currentProse(CURRENT_STATE),
      "current-state.md must say that it is not evidence for itself. Without that sentence a " +
        "reader re-verifying one section by reading another is following the document's own " +
        "instructions, and a self-consistent document can be entirely wrong",
    ).toMatch(/not evidence for (?:itself|any other document)|is not evidence for itself/i);
  });

  it("the re-verify block orders external sources, and puts documentation last", () => {
    const cs = currentProse(CURRENT_STATE);
    expect(cs, "a source-of-truth order must be stated").toMatch(/Source-of-truth order:/i);
    const order = cs.slice(cs.indexOf("Source-of-truth order:"));
    expect(
      order,
      "existing documentation must be named LAST and explicitly as claims to verify, never " +
        "as evidence",
    ).toMatch(/existing documentation \(as claims to verify, never as evidence\)/i);
  });

  it("capability-register defers to current-state rather than re-deciding tenancy", () => {
    expect(
      CAPABILITY_REGISTER,
      "the register and current-state must not both be authorities for the same fact",
    ).toMatch(/neither document is evidence for the other/i);
  });
});

// ===========================================================================
// RULE H — the ledger asserts a current maximum in exactly ONE place
//
// The existing guard validates the "## Current state" block against the
// canonical record, and bans current-max prose in the other three documents.
// Nothing checked the REST of the ledger — which is how "Production max is
// 0157", "the production max is 0159" and "the production migration max is
// 0160" all came to sit in its prose at once, each one a CORRECTION that had
// gone stale exactly the way the claim it corrected had.
// ===========================================================================

/** Ledger text with ignore blocks blanked IN PLACE, so offsets survive. */
function ledgerMasked(): string {
  return MIGRATION_LEDGER.replace(IGNORE_BLOCK_G, (m) => " ".repeat(m.length));
}
const IGNORE_BLOCK_G =
  /<!--\s*canonical-facts:ignore-start([^>]*)-->[\s\S]*?<!--\s*canonical-facts:ignore-end\s*-->/g;

/**
 * Which `## ` section an offset belongs to.
 *
 * `## Current state` is the one authorized current position. `## Previous
 * state …` and `## Recent tail …` are frozen history by construction — the
 * same heading-scoped reasoning ledgerCurrentBlock() already uses — and their
 * literals are evidence of what was true at each apply.
 */
function ledgerSectionAt(offset: number): string {
  const lines = MIGRATION_LEDGER.split("\n");
  const lineNo = MIGRATION_LEDGER.slice(0, offset).split("\n").length - 1;
  let heading = "(preamble)";
  for (let i = 0; i <= lineNo && i < lines.length; i++) {
    if (lines[i].startsWith("## ")) heading = lines[i];
  }
  return heading;
}

const LEDGER_FROZEN_SECTION = /^##\s+(?:Current state|Previous state|Recent tail)\b/;

describe("RULE H — the ledger states a current maximum only under '## Current state'", () => {
  it("no current-max assertion sits in ledger prose outside a frozen section", () => {
    const masked = ledgerMasked();
    const strays: string[] = [];
    for (const re of CURRENT_MAX_PATTERNS) {
      for (const m of masked.matchAll(new RegExp(re.source, re.flags))) {
        const section = ledgerSectionAt(m.index ?? 0);
        if (LEDGER_FROZEN_SECTION.test(section)) continue;
        strays.push(`${section.slice(0, 40)} :: ${m[0].replace(/\s+/g, " ").trim().slice(0, 80)}`);
      }
    }
    expect(
      strays,
      "migration-ledger.md asserts a current migration maximum outside its '## Current state' " +
        "block and outside frozen history. A correction must state that something is SUPERSEDED, " +
        "not name a replacement maximum — three corrections in this file did the latter and all " +
        "three went stale. Offending: " + JSON.stringify(strays),
    ).toEqual([]);
  });

  it("the frozen sections KEEP their literals — this is not a number ban", () => {
    const masked = ledgerMasked();
    let frozenHits = 0;
    for (const re of CURRENT_MAX_PATTERNS) {
      for (const m of masked.matchAll(new RegExp(re.source, re.flags))) {
        if (LEDGER_FROZEN_SECTION.test(ledgerSectionAt(m.index ?? 0))) frozenHits++;
      }
    }
    expect(
      frozenHits,
      "the ledger's frozen apply records must still carry their own maxima. If this reaches " +
        "zero the rule above has become a number ban and history has been rewritten to satisfy it",
    ).toBeGreaterThan(10);
  });
});

// ===========================================================================
// RULE D+ — a live limitation cannot vanish, and a closed one cannot revive
// ===========================================================================

/** Limitations that must remain present AND must not be marked closed. */
//
// Each pattern MUST span the WHOLE heading line (`.*$`). An earlier revision
// stopped at the limitation id, so the matched text excluded the rest of the
// line and a `**CLOSED**` marker appended after the id sailed straight through
// the not-closed assertion. Mutation-testing caught it; reading it did not.
const MUST_STAY_OPEN = [
  ["L27", /^##\s+L27\s+—\s+`F-RET-001`.*$/m, "retention and deletion commitments with no implementing code"],
  ["L19", /^##\s+L19\s+—\s+`TRUNCATE`.*$/m, "TRUNCATE breadth outside the clinical tables"],
  ["L20", /^##\s+L20\s+—\s+`service_role`.*$/m, "service_role retains TRIGGER on the clinical tables"],
  ["L25", /^##\s+L25\s+—\s+The durable new-client waitlist.*$/m, "durable waitlist activation"],
] as const;

/** Headings preserved verbatim that state something no longer true. */
const MUST_BE_MARKED_CLOSED = ["L2", "L18", "L23", "L30"] as const;

/** Every `## Lnn` heading id in known-limitations.md, in document order. */
function limitationIds(doc: string): string[] {
  return [...doc.matchAll(/^##\s+(L\d+)\s+—/gm)].map((m) => m[1]);
}

// ===========================================================================
// RULE D0 — a limitation identifier is unique, and this runs BEFORE D+
// ===========================================================================
//
// THE DEFECT THIS EXISTS FOR, exactly as it happened. Production recorded the
// onboarding-celebration limitation as L25 in #658 while this branch had
// independently issued L25 to the durable waitlist. An ordinary merge produced
// TWO `## L25` sections, out of order, and:
//
//   * `git merge-tree --write-tree` returned exit 0 - no textual conflict;
//   * every D+ rule passed, because `MUST_STAY_OPEN` resolves an id with
//     `KNOWN_LIMITATIONS.match(re)?.[0]`, a FIRST-match lookup. The waitlist
//     L25 appears first, satisfied the assertion, and the duplicate sat 35
//     lines below it unmentioned.
//
// So a clean merge, a green CI run and a green guard all coexisted with a
// document that had two different limitations under one identifier. Uniqueness
// has to be asserted over the WHOLE set before any per-id rule reads it,
// because every per-id rule is a first-match lookup and cannot see the second.
describe("RULE D0 — limitation identifiers are unique across the whole document", () => {
  it("no `## Lnn` identifier appears twice", () => {
    const ids = limitationIds(KNOWN_LIMITATIONS);
    expect(ids.length, "known-limitations.md must carry limitation headings").toBeGreaterThan(0);
    const seen = new Map<string, number>();
    for (const id of ids) seen.set(id, (seen.get(id) ?? 0) + 1);
    const duplicated = [...seen.entries()].filter(([, n]) => n > 1).map(([id, n]) => `${id}x${n}`);
    expect(
      duplicated,
      "known-limitations.md issues the same limitation identifier more than once. Two different " +
        "limitations under one id is not a formatting slip: every per-id rule below resolves by " +
        "FIRST match, so the second one is invisible to all of them. Production moving is what " +
        `creates this, by merging cleanly. Offending: ${JSON.stringify(duplicated)}`,
    ).toEqual([]);
  });

  // DISCRIMINATION PROOF. Reproduces the exact merge-collision class above and
  // shows the new rule goes RED on it while the OLD first-match lookup stays
  // green - which is the whole reason this rule had to be added rather than
  // trusting D+ to have caught it.
  it("goes RED on the exact collision that escaped, where a first-match lookup stays green", () => {
    const collided = KNOWN_LIMITATIONS.replace(
      /^##\s+L31\s+—/m,
      "## L25 —",
    );
    expect(
      collided,
      "the fixture must actually differ, or this control proves nothing",
    ).not.toBe(KNOWN_LIMITATIONS);

    const ids = limitationIds(collided);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dupes, "the reproduced collision must contain a duplicate id").toContain("L25");

    // The old per-id shape - `match(/^## L25 —.*$/m)` - still resolves, and
    // still resolves to the WAITLIST heading, exactly as it did in the real
    // merge. That is the blindness this rule covers.
    const firstMatch = collided.match(/^##\s+L25\s+—\s+The durable new-client waitlist.*$/m)?.[0];
    expect(
      firstMatch,
      "the first-match lookup must still succeed on the collided document - if it did not, D+ " +
        "would already have caught this and RULE D0 would be unnecessary",
    ).toBeTruthy();
  });

  it("does NOT fire on a document whose identifiers are merely out of order", () => {
    // Order is a readability question and several ids in this file are already
    // out of sequence for good reasons. Only REUSE is a defect, and a rule that
    // conflated the two would be deleted the first time it fired on a
    // deliberate ordering.
    const shuffled = ["L3", "L1", "L2"];
    const seen = new Map<string, number>();
    for (const id of shuffled) seen.set(id, (seen.get(id) ?? 0) + 1);
    expect([...seen.values()].filter((n) => n > 1)).toEqual([]);
  });
});

describe("RULE D+ — open limitations persist, closed ones stay labelled", () => {
  it.each(MUST_STAY_OPEN.map(([id, re, what]) => [id, re, what] as const))(
    "%s is still present and is not marked closed",
    (id, re, what) => {
      const heading = KNOWN_LIMITATIONS.match(re)?.[0];
      expect(
        heading,
        `${id} (${what}) has disappeared from known-limitations.md. A limitation leaves this ` +
          "file by being CLOSED with evidence on its own heading, never by deletion",
      ).toBeTruthy();
      expect(
        heading,
        `${id} (${what}) has been marked CLOSED in its heading. Closing it requires evidence in ` +
          "the row, and this guard requires a deliberate edit here to acknowledge that",
      ).not.toMatch(/\bCLOSED\b/);
    },
  );

  it("F-RET-001 states a severity, and says it is downgraded rather than closed", () => {
    // The severity pinned here is P2, re-derived at 6786b07b. It was P1 while
    // the published policy still promised a 30-day hard delete and a 90-day
    // backup purge; commit 0acc6773 retired both, so the published-breach
    // driver is gone and what remains is a capability gap. The pin exists so
    // that number cannot move again without this line moving with it.
    const start = KNOWN_LIMITATIONS.indexOf("## L27");
    const rest = KNOWN_LIMITATIONS.slice(start);
    const end = rest.indexOf("\n## ");
    const section = end === -1 ? rest : rest.slice(0, end);
    expect(section, "L27 must state its severity explicitly").toMatch(/\*\*P2 — OPEN\.\*\*/);
    expect(
      section,
      "L27 must record that the P1 framing was WITHDRAWN, not merely edited away - " +
        "a severity that drops without its reason is indistinguishable from one dropped to " +
        "make a gate go green",
    ).toMatch(/WITHDRAWN|withdrawn/);
    expect(
      section,
      "L27 must state that it is downgraded rather than closed, and that the implementation " +
        "gap is untouched",
    ).toMatch(/downgraded, not closed/i);
  });

  it.each(MUST_BE_MARKED_CLOSED)(
    "%s's preserved heading is marked CLOSED on the same line",
    (id) => {
      const heading = KNOWN_LIMITATIONS.match(new RegExp(`^##\\s+${id}\\s+—.*$`, "m"))?.[0];
      expect(heading, `${id}'s heading must be preserved, not deleted`).toBeTruthy();
      expect(
        heading,
        `${id}'s heading states something that is no longer true, so it may only stand while it ` +
          "is marked CLOSED on the same line",
      ).toMatch(/\bCLOSED\b/);
    },
  );
});

// ===========================================================================
// NEGATIVE CONTROLS for rules A, F, G, H and D+
//
// Two kinds appear below, and the difference is deliberate.
//
// PURE-FUNCTION CONTROLS feed a helper the exact string shape it exists to
// catch, exactly as the older controls above do.
//
// MUTATION CONTROLS cannot be written that way: rules A2, A3, G, H and D+ read
// whole files and the Git graph, so the only way to watch them fail is to break
// the real tree and look. That was done, once per rule, and the matrix is
// recorded here because a reader cannot re-derive it from the code:
//
//   A1  a fabricated 40-hex SHA added to current-state.md          -> RED
//   A3  the runtime-bearing pin moved back one merge (#643)        -> RED
//   F   "#646 is deployed and live in production" added            -> RED
//   G   the not-self-evidence sentence removed                     -> RED
//   H   "The production migration max is 0157." added to ledger    -> RED
//   D+  L27 marked **CLOSED** mid-heading                          -> RED
//   D+  L27 severity flipped P1 -> P2                              -> RED
//   D+  L27 deleted outright                                       -> RED
//   D+  "— **CLOSED**" appended to the L19 heading                 -> RED
//
// And one environment case, added after CI proved it the hard way:
//
//   A1  same document, unchanged, in a `--depth 1` clone            -> GREEN (skips)
//   A1  fabricated SHA, in a FULL clone                             -> RED
//
// Second remediation round (Codex review of 5f659927), one defect fact at a
// time, each producing EXACTLY ONE failure and that failure naming the rule
// under test - a control that goes red because something unrelated broke
// proves nothing:
//
//   F    open-PR row rewritten to "deployed in production"          -> RED (row scan)
//   H3   "Production is currently at migration 0165"                -> RED (current-position)
//   H3   "Hosted production stands at 0165"                         -> RED (current-position)
//   H3   "Current hosted migration is 0165"                         -> RED (current-position)
//   H4   "Real-customer activity: 79 clients and 241 appointments"  -> RED (Twin remainder)
//   A4   duplicate SHA reintroduced in known-limitations.md         -> RED (single authority)
//   A4   duplicate SHA reintroduced in capability-register.md       -> RED (single authority)
//   A3   pin moved back one merge, runtime changed since            -> RED (via classifier)
//
// Third round (Codex review of 397d2a2d), same discipline:
//
//   C2   pre-0169 DML claim reintroduced in current-state.md         -> RED
//   C2   ... in capability-register.md                               -> RED
//   C2   ... in known-limitations.md                                 -> RED
//   F    "deployed in production under PR #646"                      -> RED (was GREEN: `under`
//                                                                       satisfied the old `un\w+`)
//   H4   "Real-customer activity is the remainder: 79 clients ..."   -> RED (was GREEN: the bare
//                                                                       word `remainder` exempted it)
//   H3   "Production currently runs migration 0165"                  -> RED (verb was missing)
//   H3   "Production has reached migration 0165"                     -> RED (present perfect)
//   A3   pin moved back one merge                                    -> RED (unchanged)
//
// Fourth round - the local refresh onto production 8418a755 (#648). This one
// is different in kind: it is the first time the guard met a REAL production
// move rather than a synthetic mutation, and A3 fired on its own, naming all
// four deployed files, before any documentation was touched. Re-proved on the
// refreshed tree:
//
//   C2   pre-0169 DML claim reintroduced                              -> RED
//   A3   pin rolled back to the pre-#648 head                         -> RED (with A1b)
//   H4   "Real-customer activity is the remainder: 79 clients ..."    -> RED
//   F    "deployed in production under PR #646"                       -> RED
//   H3   "Production currently runs migration 0165"                   -> RED
//   H3   "Production has reached migration 0165"                      -> RED
//   A1b  section 1 says "At `6786b07b`" while the header pins 8418a755 -> RED
//
// A1b is new, and exists because the refresh created the failure mode: the
// header pins the runtime SHA and the capability sections then say "At
// `<short sha>` ..." about current behaviour. Two statements of one fact drift,
// and a section pinned to a superseded head reads as current while describing a
// runtime that has moved.
//
// Fifth round - the refresh onto production 5ad81129 (#646, FIN-01A Slice 1).
// A3 fired unprompted again, this time naming twelve deployed files, before any
// documentation was touched. Re-proved on that tree:
//
//   C2   pre-0169 DML claim reintroduced                              -> RED
//   A3   pin rolled back to the pre-#646 head                         -> RED (with A1b)
//   H4   "Real-customer activity is the remainder: 79 clients ..."    -> RED
//   F    "deployed in production under PR #646"                       -> RED
//   H3   "Production currently runs migration 0165"                   -> RED
//   H3   "Production has reached migration 0165"                      -> RED
//   F-converse  merged #646 re-declared OPEN                          -> RED
//
// THE CONVERSE RULE IS NEW, AND THIS REFRESH IS WHY. Rule F stopped an open PR
// being called shipped. Nothing stopped the opposite - a PR that HAS merged
// still sitting in the open table - which is the same falsehood pointing the
// other way, and is what a production move produces BY DEFAULT. #646 sat there
// merged and only a human noticed. It is decided from the Git graph rather
// than from GitHub, so it works offline and in CI.
//
// Sixth round - the six fresh P2s from the review of 00fdbf43, repaired as
// THREE CLASSES rather than six lines, because three consecutive rounds found
// the same shape: a class fixed thoroughly in current-state.md and left
// standing in a sibling.
//
// CLASS A got cross-document rules (X1-X5), which is the structural answer to
// that pattern. Every rule before them reads ONE document, which is exactly why
// none of them caught it:
//
//   X2   register restates the baseline as "PR #644 ... eight runtime files"  -> RED
//   X4   register merge count diverges from current-state                     -> RED
//   X1   F-RET-001 severity stated as P1 in a sibling while L27 says P2       -> RED
//   X3   "currently holds 0 rows" on a dated measurement                      -> RED
//   X5   a section-15 row orphaned by a blank line, count vs rows             -> RED
//
// CLASS B: C2's exemption was the whole Markdown LINE whenever a correction
// marker appeared, so `CORRECTED: authenticated still holds row
// INSERT/UPDATE/DELETE` passed while stating the defect as current fact. It now
// masks QUOTED SPANS only - a correction stays auditable by quoting what it
// replaces, so the quote is the historical part and the rest of the line is the
// document speaking. Five controls (A-E) pin the boundary directly.
//
//   B    "CORRECTED: authenticated still holds ..." added to a document       -> RED
//
// CLASS C: A3 exempted every scripts/ path, but package.json runs
// `node scripts/check-production-env-gates.mjs && next build`, and these
// documents treat that gate's fail-versus-report-only behaviour as a deployed
// capability fact (L25). Build scripts are now DERIVED from package.json and
// subtracted from the exemption, so adding a gate to the build brings it under
// the rule automatically. Operator utilities beside it stay exempt.
//
// All seven earlier controls were re-proved unchanged on this tree.
//
// declaredOpenPrs() was also repaired here, by this refresh rather than by
// review: it scraped every `#NNN` in the open-PR block, so the moment a row's
// prose cited another PR ("#648 records it as untouched") that PR counted as
// declared-open and Rule F flagged every truthful mention of it, changelog row
// included. It now reads only each row's SUBJECT CELL.
//
// C2 exists because the previous round fixed ONE of three copies of the same
// false sentence and believed the class was swept. It is a class check over
// every canonical document, not three line numbers.
//
// A3's GREEN controls are asserted directly rather than by mutation, since a
// CI-only commit cannot be made from inside this PR's file surface: the
// deployed-decision test pins `.github/workflows/ci.yml`,
// `scripts/verify-prepush.mjs`, `e2e/*.spec.ts`, `tests/**`, the runner configs
// and docs as NON-deployed, and `app/`, `lib/`, `components/`,
// `instrumentation*.ts`, the Sentry configs, `public/`, `hooks/`, `types/`,
// `middleware.ts` and `next.config.ts` as deployed. This branch is itself a
// docs+tests change after the pin, and A3 stays green throughout - the
// live docs-only/test-only control.
//
// Positive controls, proving the rules are not simply always-red: this branch
// changes only documentation and tests after the pinned SHA, and A3 stays
// green throughout; the past-tense narrative "it read 0160 while production
// was at 0185" stays legal; and §0's own warning naming the Twin-subtracted
// remainder in order to disclaim it is exempt rather than flagged.
//
// A1 originally guarded on GIT_AVAILABLE and went red on its first CI run
// against three SHAs that were all genuine. `fetch-depth: 1` leaves one commit
// in the clone, so every SHA a document names is absent — the production head
// included. Reproduced locally with `git clone --depth 1` before the fix was
// trusted, rather than fixed by reasoning about it.
//
// The D+ mid-heading case is why this matrix exists. The first revision of
// MUST_STAY_OPEN stopped its pattern at the limitation id, so the matched text
// excluded the rest of the heading line and a `**CLOSED**` marker placed after
// the id passed the not-closed assertion. The rule read correctly and did
// nothing. Only mutation exposed it.
// ===========================================================================

describe("NEGATIVE CONTROLS — rules A, F and G go red on the shapes they target", () => {
  it("shasIn finds every 40-hex SHA, and nothing shorter", () => {
    const doc = "head `6786b07be57a9c01ff4421378f22d7dbca68a5c9`, short `6786b07b`, dpl_5jGQkF";
    expect(shasIn(doc)).toEqual(["6786b07be57a9c01ff4421378f22d7dbca68a5c9"]);
  });

  it("shasIn does not treat a deployment id or a checksum sentence as a commit", () => {
    // A Vercel id is not hex-40; a sha256 is 64 and must not be truncated into one.
    const doc = "dpl_nZ6UBkGhK8vTAs8butVWwqNFXqmb and sha256 " + "a".repeat(64);
    expect(shasIn(doc)).toEqual([]);
  });

  it("the shipped-word pattern catches every phrasing that has actually been used", () => {
    for (const shape of [
      "#646 is deployed",
      "#646 shipped on 2026-08-26",
      "the FIN surface (#646) is live",
      "#646 is in production",
      "#646 is production-exercised",
      "#646 merged to production",
    ]) {
      expect(SHIPPED_WORD.test(shape), `MISSED a shipped claim: ${shape}`).toBe(true);
    }
  });

  it("the shipped-word pattern does NOT fire on truthful open-PR wording", () => {
    for (const shape of [
      "#646 is OPEN, not draft, mergeable, CI green",
      "its head b03611ac is not an ancestor of 6786b07b",
      "#646 carries no migration; nothing it adds is live yet",
      "TRUTH-01B-1 is in development, no PR merged",
    ]) {
      // "nothing it adds is live yet" deliberately contains "is live"; the rule is
      // line-scoped and PR-scoped, so a row that names the PR must still not assert
      // shipping. This control pins the pattern's own behaviour, which is that it
      // WOULD fire here - and is why the rule reads the declared-open SECTION as an
      // exclusion rather than trusting the pattern alone.
      const fires = SHIPPED_WORD.test(shape);
      if (shape.includes("nothing it adds is live")) {
        expect(fires, "documented false positive; handled by section exclusion").toBe(true);
      } else {
        expect(fires, `FALSE POSITIVE on truthful open-PR wording: ${shape}`).toBe(false);
      }
    }
  });

  it("declaredOpenPrs reads the declared set from the document, not from a literal", () => {
    const open = declaredOpenPrs();
    expect(open.length, "the open set must be derived from current-state.md").toBeGreaterThan(0);
    expect(
      open.every((n) => /^\d{3,5}$/.test(n)),
      "every declared-open entry must be a PR number",
    ).toBe(true);
  });
});

// ===========================================================================
// FRESHNESS POLICY CONTROLS (#825 6215529089). Each required control runs on
// a real throwaway Git repository - never asserted - plus the wiring that
// makes the strict paths actually run in CI.
// ===========================================================================
describe("freshness policy controls (#825 6215529089)", () => {
  function throwaway() {
    const dir = mkdtempSync(path.join(tmpdir(), "canon-fresh-"));
    const g: Git = (...args) => {
      try {
        return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      } catch {
        return null;
      }
    };
    const run = (...args: string[]) =>
      execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], { cwd: dir, stdio: "ignore" });
    const write = (f: string, body: string) => {
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      writeFileSync(path.join(dir, f), body);
    };
    const head = () => g("rev-parse", "HEAD") as string;
    run("init", "-q", "-b", "prod");
    write("app/page.tsx", "v1\n");
    write("docs/production/current-state.md", "r1\n");
    run("add", "-A");
    run("commit", "-qm", "baseline");
    let n = 0;
    /** Merge a branch carrying `files` into prod with a real merge commit. */
    const land = (files: Record<string, string>) => {
      const br = `b${++n}`;
      run("checkout", "-q", "-b", br, "prod");
      for (const [f, body] of Object.entries(files)) write(f, body);
      run("add", "-A");
      run("commit", "-qm", br);
      run("checkout", "-q", "prod");
      run("merge", "-q", "--no-ff", br, "-m", `Merge pull request #${n} from x/${br}`);
      return head();
    };
    return { dir, g, run, write, head, land };
  }

  it("1. an application PR's OWN diff does not violate A3 (production boundary, not PR HEAD)", async () => {
    const r = throwaway();
    const pinned = r.head();
    const prod = r.land({ "docs/production/current-state.md": "r2\n" });
    // The PR: an unmerged application change on top of production.
    r.run("checkout", "-q", "-b", "pr", "prod");
    r.write("app/page.tsx", "v2 (unmerged)\n");
    r.run("add", "-A");
    r.run("commit", "-qm", "pr");
    expect(await runtimeChangedSince(r.g, pinned, prod)).toEqual([]);
    // The old HEAD-based measure would have condemned every application PR.
    expect(await runtimeChangedSince(r.g, pinned, r.head())).toEqual(["app/page.tsx"]);
    // And the real A3 rule measures to the RESOLVED PRODUCTION REF, not HEAD:
    // on a branch whose own diff is non-runtime the two agree, so only the call
    // site can tell them apart.
    const src = read("tests/docs/canonical-production-facts.test.ts");
    const a3 = src.slice(src.indexOf("it(`A3${FRESHNESS_TAG}"), src.indexOf("it(\"A3's deployed decision"));
    expect(a3).toMatch(/const target = resolveProductionRef\(git, branch\);/);
    expect(a3).toMatch(/runtimeChangedSince\(git, pinned as string, target\)/);
    expect(a3).not.toMatch(/"HEAD"/);
  });

  it("2. a runtime change SHIPPED after the pin IS caught by A3", async () => {
    const r = throwaway();
    const pinned = r.head();
    const prod = r.land({ "app/page.tsx": "v2 shipped\n" });
    expect(await runtimeChangedSince(r.g, pinned, prod)).toEqual(["app/page.tsx"]);
  });

  it("3. record-only merges after the recorded HEAD pass A5", () => {
    const r = throwaway();
    const recorded = r.head();
    r.land({ "docs/production/current-state.md": "r2\n" });
    const prod = r.land({ "docs/production/release-changelog.md": "c\n" });
    expect(recordOnlySince(r.g, recorded, prod)).toEqual({ ok: true, commits: 2 });
    expect(recordOnlySince(r.g, prod, prod)).toEqual({ ok: true, commits: 0 });
  });

  it("4. ANY non-record later change IS caught by A5 — application, guide, or mixed", () => {
    const nonRecord: Array<Record<string, string>> = [
      { "app/page.tsx": "v2\n" },
      { "CLAUDE.md": "guide\n" },
      { "docs/production/current-state.md": "r2\n", "lib/x.ts": "x\n" },
      { "docs/marketing/x.md": "m\n" },
    ];
    for (const files of nonRecord) {
      const r = throwaway();
      const recorded = r.head();
      r.land({ "docs/production/release-changelog.md": "c\n" });
      const prod = r.land(files);
      const out = recordOnlySince(r.g, recorded, prod);
      expect(out.ok, JSON.stringify(files)).toBe(false);
    }
  });

  it("5. missing or unusable refs FAIL: no branch, unknown ref, non-ancestor, shallow history", () => {
    const r = throwaway();
    expect(resolveProductionRef(r.g, null)).toBeNull();
    expect(resolveProductionRef(r.g, "no-such-branch")).toBeNull();
    expect(resolveProductionRef(r.g, "prod")).toBe(r.head());
    // A recorded HEAD that is not in production's history is not record-only.
    r.run("checkout", "-q", "--orphan", "elsewhere");
    r.write("x.md", "x\n");
    r.run("add", "-A");
    r.run("commit", "-qm", "unrelated");
    const stranger = r.head();
    r.run("checkout", "-q", "prod");
    expect(recordOnlySince(r.g, stranger, r.head()).ok).toBe(false);
    expect(recordOnlySince(r.g, "0".repeat(40), r.head()).ok).toBe(false);
    // A shallow clone cannot inspect the ancestry: not record-only, never a pass.
    const recorded = r.head();
    const prod = r.land({ "docs/production/current-state.md": "r2\n" });
    const shallowDir = mkdtempSync(path.join(tmpdir(), "canon-shallow-"));
    execFileSync("git", ["clone", "-q", "--depth", "1", "--branch", "prod", `file://${r.dir}`, shallowDir], { stdio: "ignore" });
    const sg: Git = (...args) => {
      try {
        return execFileSync("git", args, { cwd: shallowDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      } catch {
        return null;
      }
    };
    expect(sg("rev-parse", "--is-shallow-repository")).toBe("true");
    expect(recordOnlySince(sg, recorded, prod).ok).toBe(false);
    // And the prerequisite itself fails loudly for shallow or no-git.
    expect(gitPrerequisiteError("A5", true, true)).toMatch(/SHALLOW.*failure, not a pass/);
    expect(gitPrerequisiteError("A5", false, false)).toMatch(/git is not available/);
    expect(gitPrerequisiteError("A5", true, false)).toBeNull();
  });

  it("the STABLE required aggregator carries the record check, failing closed (Codex P1 4296967177)", () => {
    // Runs the aggregator's REAL shell block from ci.yml, not a paraphrase.
    const ci = read(".github/workflows/ci.yml");
    const agg = ci.slice(ci.indexOf("\n  browser-e2e:\n"), ci.indexOf("\n  payment-browser-e2e:"));
    expect(agg).toMatch(/needs: \[changes, browser-e2e-shard, canonical-record\]/);
    expect(agg).toMatch(/RECORD_RESULT: \$\{\{ needs\.canonical-record\.result \}\}/);
    const body = agg.slice(agg.indexOf("run: |\n") + "run: |\n".length);
    const script = body
      .split("\n")
      .map((l) => l.replace(/^ {10}/, ""))
      .join("\n");
    const exitOf = (env: Record<string, string>) => {
      try {
        execFileSync("bash", ["-c", script], {
          env: {
            NODE_ENV: "test",
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "/tmp",
            CHANGES_RESULT: "success",
            SHARD_RESULT: "",
            BROWSER_RUN: "false",
            FULL_MATRIX: "false",
            EXTENDED: "false",
            SHARDS: "[1]",
            ...env,
          },
          stdio: "ignore",
        });
        return 0;
      } catch (e) {
        return (e as { status?: number }).status ?? -1;
      }
    };
    const record = { DOCS_ONLY: "true", PRODUCTION_RECORD: "true" };
    expect(exitOf({ ...record, RECORD_RESULT: "success" })).toBe(0);
    for (const bad of ["failure", "cancelled", "skipped", ""]) {
      expect(exitOf({ ...record, RECORD_RESULT: bad }), `record change, result "${bad}"`).toBe(1);
    }
    // Not a record change: a skipped record job is legitimate; a failed one is not.
    expect(exitOf({ DOCS_ONLY: "false", PRODUCTION_RECORD: "false", RECORD_RESULT: "skipped" })).toBe(0);
    expect(exitOf({ DOCS_ONLY: "false", PRODUCTION_RECORD: "true", RECORD_RESULT: "failure" })).toBe(1);
  });

  it("measure mode WARNS distinctly and never reads as clean; enforce FAILS", () => {
    expect(freshnessOutcome("measure", "A5", true, "x")).toEqual({ kind: "fresh" });
    const warn = freshnessOutcome("measure", "A5", false, "stale\nrecord");
    expect(warn).toEqual({ kind: "warn", line: "::warning title=Canonical record STALE (non-blocking, A5)::stale record" });
    expect(freshnessOutcome("enforce", "A5", false, "stale")).toEqual({ kind: "fail", message: "A5 (enforced): stale" });
    // The emitted bytes put the command at the START of its own line, with no
    // prefix: Actions ignores a workflow command anywhere else (#887 run
    // 38935982909 lost its annotation to vitest's colour prefix).
    let written = "";
    emitWorkflowCommand((warn as { line: string }).line, (t) => (written += t));
    const lines = written.split("\n");
    expect(lines.some((l) => l.startsWith("::warning title=Canonical record STALE"))).toBe(true);
    expect(written.startsWith("\n")).toBe(true);
    expect(read("tests/docs/canonical-production-facts.test.ts")).not.toMatch(/console\.log\(out\.line\)/);
  });

  // ---- Renames (Codex P1 4297335910): a move lists BOTH endpoints ----------
  /** Run ci.yml's REAL PR changed-files command in a repo, then its real record grep. */
  function ciChangedFiles(dir: string, base: string, head: string) {
    const ci = read(".github/workflows/ci.yml");
    const diffLine = ci.split("\n").find((l) => /git diff --name-only[^\n]*> changed\.txt/.test(l));
    expect(diffLine, "ci.yml's PR changed-files command").toBeTruthy();
    execFileSync("bash", ["-c", (diffLine as string).trim()], {
      cwd: dir,
      env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp", MB: base, HEAD_SHA: head },
      stdio: "ignore",
    });
    const changed = readFileSync(path.join(dir, "changed.txt"), "utf8").split("\n").filter(Boolean);
    const recordStep = ci.slice(ci.indexOf("id: record"), ci.indexOf("- name: Classify"));
    const grepBlock = recordStep.slice(recordStep.indexOf("run: |\n") + "run: |\n".length)
      .split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
    const out = path.join(dir, "gh-output");
    writeFileSync(out, "");
    execFileSync("bash", ["-c", grepBlock], {
      cwd: dir,
      env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp", GITHUB_OUTPUT: out },
      stdio: "ignore",
    });
    const productionRecord = /production_record=true/.test(readFileSync(out, "utf8"));
    const classified = execFileSync("node", [path.join(ROOT, "scripts/classify-changes.mjs"), "--files-from", path.join(dir, "changed.txt")], {
      encoding: "utf8",
    });
    const flag = (k: string) => new RegExp(`^${k}=true$`, "m").test(classified);
    return { changed, productionRecord, docsOnly: flag("docs_only"), database: flag("database") };
  }

  it("R1. moving docs/production/x.md to docs/x.md is a production-record change; the record job runs", () => {
    const r = throwaway();
    r.write("docs/production/x.md", "l1\nl2\nl3\nl4\n");
    r.run("add", "-A");
    r.run("commit", "-qm", "x");
    const base = r.head();
    r.run("mv", "docs/production/x.md", "docs/x.md");
    r.run("commit", "-qm", "move");
    const ci = ciChangedFiles(r.dir, base, r.head());
    expect(ci.changed).toEqual(expect.arrayContaining(["docs/production/x.md", "docs/x.md"]));
    expect(ci.productionRecord).toBe(true);
    // docs-only AND production_record: exactly the canonical-record job's condition.
    expect(ci.docsOnly).toBe(true);
  });

  it("R2. moving a migration into docs/ is NOT docs-only: the database lane is selected", () => {
    const r = throwaway();
    r.write("supabase/migrations/0300_x.sql", "create table t();\n-- a\n-- b\n");
    r.run("add", "-A");
    r.run("commit", "-qm", "m");
    const base = r.head();
    r.run("mv", "supabase/migrations/0300_x.sql", "docs/0300_x.sql");
    r.run("commit", "-qm", "move");
    const ci = ciChangedFiles(r.dir, base, r.head());
    expect(ci.changed).toContain("supabase/migrations/0300_x.sql");
    expect(ci.docsOnly).toBe(false);
    expect(ci.database).toBe(true);
  });

  it("R3. A5: moving an application file INTO docs/production/ is not record-only", () => {
    const r = throwaway();
    const recorded = r.head();
    r.run("checkout", "-q", "-b", "mv", "prod");
    r.run("mv", "app/page.tsx", "docs/production/page.md");
    r.run("commit", "-qm", "move");
    r.run("checkout", "-q", "prod");
    r.run("merge", "-q", "--no-ff", "mv", "-m", "Merge mv");
    expect(recordOnlySince(r.g, recorded, r.head()).ok).toBe(false);
  });

  it("R4. A3: moving a runtime file into docs/ is a shipped runtime change", async () => {
    const r = throwaway();
    const pinned = r.head();
    r.run("checkout", "-q", "-b", "mv", "prod");
    r.run("mv", "app/page.tsx", "docs/page.md");
    r.run("commit", "-qm", "move");
    r.run("checkout", "-q", "prod");
    r.run("merge", "-q", "--no-ff", "mv", "-m", "Merge mv");
    expect(await runtimeChangedSince(r.g, pinned, r.head())).toEqual(["app/page.tsx"]);
  });

  it("R5. EVERY changed-file producer sees both rename endpoints — grepped, not pinned", () => {
    for (const wf of [".github/workflows/ci.yml", ".github/workflows/nightly.yml"]) {
      const exec = read(wf).split("\n").filter((l) => !l.trim().startsWith("#"));
      for (const l of exec.filter((x) => /--name-only/.test(x) && /\b(diff|show|log)\b/.test(x))) {
        expect(l, `${wf}: a --name-only producer without --no-renames`).toMatch(/--no-renames/);
      }
    }
    const ci = read(".github/workflows/ci.yml");
    expect((ci.match(/> changed\.txt/g) ?? []).length, "changed.txt producers").toBe(2);
    const plan = read("scripts/ci-plan.mjs");
    expect(plan).toMatch(/"diff", "--name-only", "--no-renames"/);
    expect(plan).not.toMatch(/"diff", "--name-only", base/);
    const src = read("tests/docs/canonical-production-facts.test.ts");
    expect(src).toMatch(/g\("diff", "--name-only", "--no-renames", pinned, target\)/);
    expect(src).toMatch(/g\("diff", "--name-only", "--no-renames", parents\[1\], c\)/);
  });

  it("6. the strict paths really run: docs-PR job, push/record validate, nightly — all with full history", () => {
    const ci = read(".github/workflows/ci.yml");
    const nightly = read(".github/workflows/nightly.yml");
    const job = (src: string, name: string) => {
      const start = src.indexOf(`\n  ${name}:\n`);
      expect(start, `${name} job must exist`).toBeGreaterThan(-1);
      const rest = src.slice(start + 1);
      const next = rest.slice(1).search(/\n {2}[a-z0-9_-]+:\n/);
      return next === -1 ? rest : rest.slice(0, next + 1);
    };
    // changes publishes the production-record signal from its changed files.
    const changes = job(ci, "changes");
    expect(changes).toMatch(/production_record: \$\{\{ steps\.record\.outputs\.production_record \}\}/);
    expect(changes).toMatch(/grep -q '\^docs\/production\/' changed\.txt/);
    // validate: full history, and enforce on push or a record change.
    const validate = job(ci, "validate");
    expect(validate).toMatch(/fetch-depth: 0/);
    expect(validate).toMatch(
      /CANONICAL_FRESHNESS: \$\{\{ \(github\.event_name != 'pull_request' \|\| needs\.changes\.outputs\.production_record == 'true'\) && 'enforce' \|\| 'measure' \}\}/,
    );
    // docs-only record PRs (validate skipped) still run the docs tests, enforced.
    const record = job(ci, "canonical-record");
    expect(record).toMatch(/docs_only == 'true' && needs\.changes\.outputs\.production_record == 'true'/);
    expect(record).toMatch(/fetch-depth: 0/);
    expect(record).toMatch(/run: npx vitest run tests\/docs/);
    expect(record).toMatch(/CANONICAL_FRESHNESS: enforce/);
    expect(record).toMatch(/persist-credentials: false/);
    // nightly: full history, enforced.
    expect(nightly).toMatch(/persist-credentials: false\n(?:\s*#[^\n]*\n)*\s*fetch-depth: 0/);
    expect(nightly).toMatch(/run: \$\{\{ matrix\.command \}\}\n\s*env:\n\s*#[^\n]*\n\s*CANONICAL_FRESHNESS: enforce/);
  });
});

// ===========================================================================
// PENDING-RELEASE RECEIPT CONTROLS (HON-18 39ad5aaf "Production records";
// 01-ops/RECORD-BATCHING-PROPOSAL.md Option A). Every control runs on a real
// throwaway Git repository. Each NEGATIVE control injects one bad shape and is
// paired with a twin that differs only in that shape and passes, so the
// failure is attributable to the defect and not to the fixture. Each POSITIVE
// control also proves the shape was RED under the rule before this change.
// The existing controls 3, 4, 5 and R3 above are untouched and still pin
// recordOnlySince, which coveredSince reuses unchanged.
// ===========================================================================
describe("pending-release receipt controls (HON-18 39ad5aaf)", () => {
  function receiptRepo() {
    const dir = mkdtempSync(path.join(tmpdir(), "canon-receipt-"));
    const g: Git = (...args) => {
      try {
        return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      } catch {
        return null;
      }
    };
    let clock = 1_800_000_000; // fixed git time, so lag controls are deterministic
    const run = (args: string[], at?: number) => {
      const when = `${at ?? clock} +0000`;
      execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], {
        cwd: dir,
        stdio: "ignore",
        env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
      });
    };
    const write = (f: string, body: string) => {
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      writeFileSync(path.join(dir, f), body);
    };
    const head = () => g("rev-parse", "HEAD") as string;
    run(["init", "-q", "-b", "prod"]);
    write("app/page.tsx", "v1\n");
    write("app/x.ts", "x1\n");
    write("docs/production/current-state.md", "r1\n");
    run(["add", "-A"]);
    run(["commit", "-qm", "baseline"]);
    let n = 0;
    /** Merge a PR branch carrying `files` into prod as GitHub would title it. */
    const land = (pr: number, files: Record<string, string>, opts: { at?: number; mv?: [string, string] } = {}) => {
      const br = `b${++n}`;
      clock += 60;
      run(["checkout", "-q", "-b", br, "prod"]);
      if (opts.mv) {
        mkdirSync(path.dirname(path.join(dir, opts.mv[1])), { recursive: true });
        run(["mv", opts.mv[0], opts.mv[1]]);
      }
      for (const [f, body] of Object.entries(files)) write(f, body);
      run(["add", "-A"]);
      run(["commit", "-qm", br], opts.at);
      run(["checkout", "-q", "prod"]);
      run(["merge", "-q", "--no-ff", br, "-m", `Merge pull request #${pr} from x/${br}`], opts.at);
      return head();
    };
    /** A direct, single-parent commit on prod (what branch protection forbids). */
    const direct = (files: Record<string, string>) => {
      clock += 60;
      for (const [f, body] of Object.entries(files)) write(f, body);
      run(["add", "-A"]);
      run(["commit", "-qm", "direct push"]);
      return head();
    };
    return { g, land, direct, head };
  }
  const receipt = (pr: number, runtime: boolean, migrations: string[] = [], merge?: string) =>
    JSON.stringify({ pr, ...(merge ? { merge } : {}), runtime, migrations, release_receipt: `01-ops/${pr}-release-receipt.json` });
  const file = (pr: number) => `${PENDING_RELEASES_DIR}/${pr}.json`;
  const late = (text: string) => {
    const p = parseReceipt(text);
    if (!p.ok) throw new Error(p.reason);
    return p.receipt;
  };

  it("P1. a CI-only merge with a correct runtime:false receipt (the #1048 shape) is covered — and was RED before", async () => {
    const r = receiptRepo();
    const recorded = r.head();
    const prod = r.land(11, { ".github/workflows/ci.yml": "ci\n", "tests/ci/x.test.ts": "t\n", [file(11)]: receipt(11, false) });
    expect(recordOnlySince(r.g, recorded, prod).ok).toBe(false); // the old rule: red
    expect(await coveredSince(r.g, recorded, prod, [])).toEqual({ ok: true, commits: 1, covered: [prod] });
    expect(await runtimeChangedSince(r.g, recorded, prod)).toEqual([]); // A3 green without receipts
  });

  it("P2. a runtime merge with a correct runtime:true receipt is covered by A5 and A3 — and both were RED before", async () => {
    const r = receiptRepo();
    const pinned = r.head();
    const prod = r.land(12, { "app/page.tsx": "v2\n", [file(12)]: receipt(12, true) });
    expect(recordOnlySince(r.g, pinned, prod).ok).toBe(false); // old A5: red
    expect(await runtimeChangedSince(r.g, pinned, prod)).toEqual(["app/page.tsx"]); // old A3: red
    expect(await runtimeCoveredSince(r.g, pinned, prod, [])).toEqual({ ok: true });
    const since = await coveredSince(r.g, pinned, prod, []);
    expect(since).toEqual({ ok: true, commits: 1, covered: [prod] });
    expect(coveredLag(r.g, (since as { covered: string[] }).covered, prod)).toEqual({ ok: true }); // A7 counts it
  });

  it("N1. THE #1042 SHAPE: a runtime merge (lib/stripe/account.ts) with NO receipt stays red on A3 and A5", async () => {
    const r = receiptRepo();
    const pinned = r.head();
    const prod = r.land(1042, { "lib/stripe/account.ts": "guard\n" });
    const a5 = await coveredSince(r.g, pinned, prod, []);
    expect(a5.ok).toBe(false);
    expect((a5 as { reason: string }).reason).toMatch(/has no receipt/);
    expect((await runtimeCoveredSince(r.g, pinned, prod, [])).ok).toBe(false);
    // Twin: the same merge WITH its receipt is covered, so the absence is the cause.
    const t = receiptRepo();
    const tPinned = t.head();
    const tProd = t.land(1042, { "lib/stripe/account.ts": "guard\n", [file(1042)]: receipt(1042, true) });
    expect((await coveredSince(t.g, tPinned, tProd, [])).ok).toBe(true);
    expect((await runtimeCoveredSince(t.g, tPinned, tProd, [])).ok).toBe(true);
  });

  it("N2. a receipt that says runtime:false for a merge that ships lib/x.ts is a lie: A3 and A5 red", async () => {
    const r = receiptRepo();
    const pinned = r.head();
    const prod = r.land(21, { "lib/x.ts": "x\n", [file(21)]: receipt(21, false) });
    const a3 = await runtimeCoveredSince(r.g, pinned, prod, []);
    expect(a3.ok).toBe(false);
    expect((a3 as { reason: string }).reason).toMatch(/receipt says runtime:false, but its diff is runtime:true/);
    expect((await coveredSince(r.g, pinned, prod, [])).ok).toBe(false);
    // And the converse lie, runtime:true on a CI-only merge, is refused too.
    const c = receiptRepo();
    const cr = c.head();
    const cp = c.land(22, { ".github/workflows/ci.yml": "ci\n", [file(22)]: receipt(22, true) });
    expect((await coveredSince(c.g, cr, cp, [])).ok).toBe(false);
  });

  it("N3. a receipt already present before the merge (reused or backdated) does not cover it", async () => {
    const r = receiptRepo();
    const recorded = r.head();
    r.land(30, { [file(31)]: receipt(31, true) }); // record-only merge that pre-places #31's receipt
    const prod = r.land(31, { "app/page.tsx": "v2\n" }); // #31 itself adds no receipt
    const out = await coveredSince(r.g, recorded, prod, []);
    expect(out.ok).toBe(false);
    expect((out as { reason: string }).reason).toMatch(/already existed before this merge/);
    // Twin: the same receipt added BY merge #31 is covered.
    const t = receiptRepo();
    const tr = t.head();
    const tp = t.land(31, { "app/page.tsx": "v2\n", [file(31)]: receipt(31, true) });
    expect((await coveredSince(t.g, tr, tp, [])).ok).toBe(true);
  });

  it("N4. a direct (single-parent) commit changing app code is never covered, even carrying a receipt", async () => {
    const r = receiptRepo();
    const recorded = r.head();
    const prod = r.direct({ "app/page.tsx": "v2\n", [file(40)]: receipt(40, true) });
    const out = await coveredSince(r.g, recorded, prod, []);
    expect(out.ok).toBe(false);
    expect((out as { reason: string }).reason).toMatch(/not a two-parent merge/);
    // Nor by a late receipt naming its exact SHA.
    expect((await coveredSince(r.g, recorded, prod, [late(receipt(40, true, [], prod))])).ok).toBe(false);
  });

  it("N5. a receipt for a different PR number than the merge subject does not cover it", async () => {
    // (a) the file is named for another PR: merge #50 has no 50.json.
    const a = receiptRepo();
    const ar = a.head();
    const ap = a.land(50, { "app/page.tsx": "v2\n", [file(51)]: receipt(51, true) });
    expect((await coveredSince(a.g, ar, ap, [])).ok).toBe(false);
    // (b) the file name matches, its contents claim another PR.
    const b = receiptRepo();
    const br = b.head();
    const bp = b.land(50, { "app/page.tsx": "v2\n", [file(50)]: receipt(51, true) });
    const out = await coveredSince(b.g, br, bp, []);
    expect(out.ok).toBe(false);
    expect((out as { reason: string }).reason).toMatch(/merges #50 but its receipt is for #51/);
    // (c) a late receipt naming the merge's SHA but another PR number.
    expect((await coveredSince(a.g, ar, ap, [late(receipt(51, true, [], ap))])).ok).toBe(false);
  });

  it("N6. an undeclared migration (migrations: [] but the merge adds 0251) is refused", async () => {
    const mig = "supabase/migrations/0251_x.sql";
    const r = receiptRepo();
    const recorded = r.head();
    const prod = r.land(60, { [mig]: "select 1;\n", [file(60)]: receipt(60, true, []) });
    const out = await coveredSince(r.g, recorded, prod, []);
    expect(out.ok).toBe(false);
    expect((out as { reason: string }).reason).toMatch(/declares migrations \[\], but it changes \["supabase\/migrations\/0251_x\.sql"\]/);
    // Twin: declared, it is covered. (A migration is runtime-bearing by A3's rule:
    // supabase/ is not a non-shipping root, so its receipt says runtime:true.)
    const t = receiptRepo();
    const tr = t.head();
    const tp = t.land(60, { [mig]: "select 1;\n", [file(60)]: receipt(60, true, [mig]) });
    expect((await coveredSince(t.g, tr, tp, [])).ok).toBe(true);
  });

  it("N7. A7: more than 8 covered merges, or the oldest more than 72h behind the tip, is out of bound", async () => {
    // The bound is the ruling's number, pinned literally: a fixture derived from
    // the constant would move with it and could never catch a loosened bound.
    expect(MAX_COVERED_MERGES).toBe(8);
    expect(MAX_COVERED_LAG_SECONDS).toBe(72 * 60 * 60);
    const r = receiptRepo();
    const recorded = r.head();
    let prod = recorded;
    for (let i = 0; i < 9; i += 1) {
      prod = r.land(70 + i, { [`tests/ci/x${i}.test.ts`]: "t\n", [file(70 + i)]: receipt(70 + i, false) });
    }
    const nine = await coveredSince(r.g, recorded, prod, []);
    expect(nine.ok).toBe(true); // every merge is individually covered...
    expect(coveredLag(r.g, (nine as { covered: string[] }).covered, prod).ok).toBe(false); // ...but the batch is not
    // Twin: exactly the bound is accepted.
    const eight = (nine as { covered: string[] }).covered.slice(-8);
    expect(coveredLag(r.g, eight, prod)).toEqual({ ok: true });
    // Age: two covered merges 80h apart in git committer time.
    const t = receiptRepo();
    const tr = t.head();
    t.land(80, { "tests/ci/a.test.ts": "t\n", [file(80)]: receipt(80, false) }, { at: 1_900_000_000 });
    const tp = t.land(81, { "tests/ci/b.test.ts": "t\n", [file(81)]: receipt(81, false) }, { at: 1_900_000_000 + 80 * 3600 });
    const aged = await coveredSince(t.g, tr, tp, []);
    expect(aged.ok).toBe(true);
    expect((coveredLag(t.g, (aged as { covered: string[] }).covered, tp) as { reason: string }).reason).toMatch(/trails production by 80h/);
    // Twin: 71h apart is within the bound.
    const u = receiptRepo();
    const ur = u.head();
    u.land(80, { "tests/ci/a.test.ts": "t\n", [file(80)]: receipt(80, false) }, { at: 1_900_000_000 });
    const up = u.land(81, { "tests/ci/b.test.ts": "t\n", [file(81)]: receipt(81, false) }, { at: 1_900_000_000 + 71 * 3600 });
    const fresh = await coveredSince(u.g, ur, up, []);
    expect(coveredLag(u.g, (fresh as { covered: string[] }).covered, up)).toEqual({ ok: true });
  });

  it("N8. moving app/x.ts INTO docs/production/pending-releases/ is neither record-only nor covered", async () => {
    const r = receiptRepo();
    const recorded = r.head();
    const prod = r.land(90, {}, { mv: ["app/x.ts", `${PENDING_RELEASES_DIR}/x.ts`] });
    expect(recordOnlySince(r.g, recorded, prod).ok).toBe(false);
    const out = await coveredSince(r.g, recorded, prod, []);
    expect(out.ok).toBe(false);
    expect((await runtimeChangedSince(r.g, recorded, prod))).toEqual(["app/x.ts"]); // the deletion ships
  });

  it("late receipts: an exact-SHA receipt covers a merge that landed without one; one for another SHA does not", async () => {
    const r = receiptRepo();
    const recorded = r.head();
    const prod = r.land(95, { ".github/workflows/ci.yml": "ci\n" }); // landed with no receipt
    expect((await coveredSince(r.g, recorded, prod, [])).ok).toBe(false);
    expect((await coveredSince(r.g, recorded, prod, [late(receipt(95, false, [], prod))])).ok).toBe(true);
    expect((await coveredSince(r.g, recorded, prod, [late(receipt(95, false, [], recorded))])).ok).toBe(false);
    // Two late receipts naming one merge are ambiguous, never merged.
    const twice = [late(receipt(95, false, [], prod)), late(receipt(95, false, [], prod))];
    expect((await coveredSince(r.g, recorded, prod, twice)).ok).toBe(false);
  });

  it("a malformed receipt is refused, never ignored", () => {
    const good = JSON.parse(receipt(7, false));
    expect(parseReceipt(JSON.stringify(good)).ok).toBe(true);
    for (const bad of [
      "not json",
      "[]",
      JSON.stringify({ ...good, extra: 1 }),
      JSON.stringify({ ...good, pr: 0 }),
      JSON.stringify({ ...good, runtime: "false" }),
      JSON.stringify({ ...good, migrations: "none" }),
      JSON.stringify({ ...good, release_receipt: "01-ops/8-release-receipt.json" }),
      JSON.stringify({ ...good, merge: "a1164b9b" }),
    ]) {
      expect(parseReceipt(bad).ok, bad).toBe(false);
    }
  });

  it("every receipt in this repository parses, and the only README is documentation", () => {
    const dir = path.join(ROOT, PENDING_RELEASES_DIR);
    const names = readdirSync(dir);
    expect(names).toContain("README.md");
    for (const f of names.filter((n) => n.endsWith(".json"))) {
      const parsed = parseReceipt(readFileSync(path.join(dir, f), "utf8"));
      expect(parsed.ok, `${f}: ${parsed.ok ? "" : parsed.reason}`).toBe(true);
      expect(f, "a receipt is named for its PR").toBe(`${(parsed as { receipt: PendingReceipt }).receipt.pr}.json`);
    }
    expect(names.filter((n) => !n.endsWith(".json") && n !== "README.md")).toEqual([]);
  });

  it("A5 and A3 consult receipts only through coveredSince / runtimeCoveredSince (wiring, grepped)", () => {
    const src = read("tests/docs/canonical-production-facts.test.ts");
    const a5 = src.slice(src.indexOf("it(`A5${FRESHNESS_TAG}"), src.indexOf("it(`A7${FRESHNESS_TAG}"));
    expect(a5).toMatch(/await coveredSince\(git, recorded as string, ref, loadLateReceipts\(ref\)\)/);
    const a3 = src.slice(src.indexOf("it(`A3${FRESHNESS_TAG}"), src.indexOf("it(\"A3's deployed decision"));
    expect(a3).toMatch(/deployed\.length === 0 \|\| covered\?\.ok === true/);
    expect(a3).toMatch(/runtimeCoveredSince\(git, pinned as string, target, loadLateReceipts\(target\)\)/);
  });
});
