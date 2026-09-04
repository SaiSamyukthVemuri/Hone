import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

// Workflow configuration + canonical migration-state guards. These replace the
// 18 hand-maintained migration-max pins that used to be scattered across
// tests/migrations, tests/docs and tests/scripts.

const CI = readFileSync(".github/workflows/ci.yml", "utf8");
const NIGHTLY = readFileSync(".github/workflows/nightly.yml", "utf8");

const WORKFLOW_DIR = ".github/workflows";

/** A workflow as the supply-chain guards see it: its file name, and its text. */
type Workflow = readonly [name: string, body: string];

/**
 * The workflow universe, ENUMERATED from the directory rather than named here.
 *
 * A hand-written list is the wrong shape for a repo-wide supply-chain guard.
 * With `[ci.yml, nightly.yml]` written into this file, a future
 * `.github/workflows/security.yaml` carrying a floating `actions/checkout@v4`,
 * `persist-credentials: true` and a write scope would simply never be loaded —
 * and every guard below would report GREEN while the exact thing they exist to
 * prevent sat in the repository. Enrolling a workflow must not depend on
 * somebody remembering to edit a test.
 *
 * Membership is by EXTENSION ONLY — `.yml` / `.yaml`, which is what GitHub
 * Actions itself reads — so a new workflow is enrolled by existing. Sorted, so
 * failures report in a stable order.
 *
 * `statSync` rather than `Dirent.isFile()`: it resolves symlinks, so a
 * symlinked workflow is enrolled instead of skipped. For a guard, inclusive is
 * the safe direction.
 */
function readWorkflowDir(dir: string = WORKFLOW_DIR): Workflow[] {
  return readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .filter((name) => statSync(path.join(dir, name)).isFile())
    .sort()
    .map((name): Workflow => [name, readFileSync(path.join(dir, name), "utf8")]);
}

// ---------------------------------------------------------------------------
// YAML semantics
// ---------------------------------------------------------------------------
// A workflow is YAML, and the guards below judge what GITHUB EXECUTES, so the
// parser — not a regular expression — is the authority for that. Every one of
//
//     uses: actions/checkout@v4
//     uses : actions/checkout@v4
//     "uses": actions/checkout@v4
//     'uses': actions/checkout@v4
//
// is the same key to YAML and to GitHub. Only the first is the same key to
// /uses: \S+/, so a text scan could be walked straight past with a mutable ref.
//
// js-yaml is already installed in this repository (4.1.1, via @eslint/eslintrc)
// and is reached through createRequire because it ships no type declarations
// and @types/js-yaml is not installed — importing it directly would fail
// `strict` typecheck, and adding either package is a dependency change this
// change is not authorised to make. It is a TRANSITIVE dev dependency, which is
// worth promoting to an explicit devDependency in its own change: if ESLint
// ever drops it this file fails to load, which is loud and fail-CLOSED, but it
// is still a phantom dependency. "the YAML parser is present and functioning"
// below states that requirement as a test rather than as a hope.
const nodeRequire = createRequire(path.resolve("package.json"));
const yaml = nodeRequire("js-yaml") as { load(src: string): unknown };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

type ParsedWorkflow = { file: string; body: string; doc: unknown; error: string | null };

function parseAll(sources: readonly Workflow[]): ParsedWorkflow[] {
  return sources.map(({ 0: file, 1: body }) => {
    try {
      return { file, body, doc: yaml.load(body), error: null };
    } catch (e) {
      return { file, body, doc: null, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

/**
 * One executable `uses`, located semantically.
 *
 * GitHub executes a `uses` in exactly two places, and this reads exactly those
 * two — NOT a deep search for the name, so a `uses` buried in an action's input
 * data is never mistaken for something that runs:
 *
 *   jobs.<job>.steps[*].uses   an action
 *   jobs.<job>.uses            a reusable-workflow call
 */
type UseSite = {
  file: string;
  where: string;
  value: string;
  with: Record<string, unknown> | null;
};

function executableUses(file: string, doc: unknown): UseSite[] {
  const out: UseSite[] = [];
  if (!isRecord(doc) || !isRecord(doc.jobs)) return out;
  for (const [job, node] of Object.entries(doc.jobs)) {
    if (!isRecord(node)) continue;
    const inputs = (n: Record<string, unknown>) => (isRecord(n.with) ? n.with : null);
    if (typeof node.uses === "string") {
      out.push({ file, where: `jobs.${job}.uses`, value: node.uses, with: inputs(node) });
    }
    if (!Array.isArray(node.steps)) continue;
    node.steps.forEach((step: unknown, i: number) => {
      if (!isRecord(step) || typeof step.uses !== "string") return;
      out.push({
        file,
        where: `jobs.${job}.steps[${i}].uses`,
        value: step.uses,
        with: inputs(step),
      });
    });
  }
  return out;
}

const allUses = (sources: readonly Workflow[]): UseSite[] =>
  parseAll(sources).flatMap(({ file, doc }) => executableUses(file, doc));

/**
 * The canonical identity of a REMOTE action or reusable-workflow reference —
 * `Actions/Checkout@<sha>` -> `actions/checkout` — or null when the value is not
 * a remote reference at all.
 *
 * GitHub matches owner and repository case-INSENSITIVELY, so `Actions/checkout`,
 * `ACTIONS/CHECKOUT` and `actions/checkout` are one action to it. They were three
 * different strings to the action-specific guards, which compared against
 * lowercase literals: a checkout written `Actions/checkout@<approved sha>` was
 * not recognised as a checkout, so its missing `persist-credentials: false` was
 * never demanded and it never reached the reviewed checkout total — while the
 * SHA-pinning and annotation guards, which never look at the identifier's case,
 * went on reporting clean.
 *
 * Folded HERE and nowhere else, so the fold cannot leak:
 *   - the SHA is returned untouched by this function and compared as written;
 *   - a LOCAL action (`./…`) is a path in this repository, which GitHub does not
 *     case-fold — it returns null rather than a rewritten remote identity;
 *   - arbitrary YAML scalars never reach it.
 */
function canonicalActionIdentity(value: string): string | null {
  if (value.startsWith("./") || value.startsWith("../")) return null; // a path, not an identifier
  const at = value.lastIndexOf("@");
  const target = at > 0 ? value.slice(0, at) : value; // the ref is NOT part of identity
  if (!/^[\w.-]+\/[\w./-]+$/.test(target)) return null; // docker://, or malformed
  return target.toLowerCase();
}

/**
 * Immutable = a 40-character commit SHA, or a path inside THIS repository
 * (`./...`), which is fixed by the commit under review and has no ref to pin.
 * A tag, a branch, `docker://image:tag` and a short SHA are all mutable.
 */
function isImmutableRef(value: string): boolean {
  if (value.startsWith("./")) return true;
  const at = value.lastIndexOf("@");
  if (at <= 0) return false;
  return /^[0-9a-f]{40}$/.test(value.slice(at + 1)) && /^[\w.-]+\/[\w./-]+$/.test(value.slice(0, at));
}

/**
 * Every LINE that assigns a `uses` key, with its value and trailing comment.
 *
 * This is NOT discovery. executableUses() is the authority for what runs; this
 * exists only because comments are absent from the parsed model, so the
 * human-readable `# vX.Y.Z` annotation can be read nowhere else. Every guard
 * that uses it first requires it to RECONCILE with the parser, so it can never
 * quietly become the authority again.
 */
type UsesLine = { file: string; line: number; value: string; annotation: string | null };

function usesLines(file: string, body: string): UsesLine[] {
  const out: UsesLine[] = [];
  body.split("\n").forEach((raw, i) => {
    if (/^\s*#/.test(raw)) return; // a commented-out step is not a step
    const m = /^\s*(?:-\s+)?(?:uses|"uses"|'uses')\s*:\s*(.*)$/.exec(raw);
    if (!m) return;
    out.push({ file, line: i + 1, ...splitScalarAndComment(m[1]) });
  });
  return out;
}

/** `actions/checkout@sha # v7.0.1` -> value plus the annotation, minus its `#`. */
function splitScalarAndComment(rest: string): { value: string; annotation: string | null } {
  const s = rest.trim();
  for (const q of ['"', "'"]) {
    if (!s.startsWith(q)) continue;
    const end = s.indexOf(q, 1);
    if (end === -1) break;
    const after = s.slice(end + 1).trim();
    return { value: s.slice(1, end), annotation: after.startsWith("#") ? after.slice(1).trim() : null };
  }
  const hash = s.indexOf(" #");
  if (hash === -1) return { value: s, annotation: null };
  return { value: s.slice(0, hash).trim(), annotation: s.slice(hash + 1).replace(/^#/, "").trim() };
}

/**
 * Every string in the parsed document, KEYS INCLUDED — `env: { GITHUB_TOKEN: ... }`
 * hides the token in a key, so a values-only walk would miss it. Comments are
 * not in the model at all, which is why this replaced a comment-stripping
 * text scan: a comment can no longer read as a credential, or hide one.
 *
 * Each string carries the key it was stored under, because one key changes how
 * its value must be read: `if:` is an expression WITHOUT the `${{ }}` wrapper.
 */
type TaggedString = { key: string | null; value: string };

function taggedStrings(node: unknown, key: string | null = null, out: TaggedString[] = []): TaggedString[] {
  if (typeof node === "string") out.push({ key, value: node });
  else if (Array.isArray(node)) for (const v of node) taggedStrings(v, key, out);
  else if (isRecord(node)) {
    for (const [k, v] of Object.entries(node)) {
      out.push({ key: null, value: k });
      taggedStrings(v, k, out);
    }
  }
  return out;
}

/**
 * Every `${{ ... }}` body in a string, found by SCANNING rather than by a
 * non-greedy match, plus a count of expressions that never closed.
 *
 * `${{ format('}}', secrets.DEPLOY_PAT) }}` is one expression whose string
 * literal happens to contain the closing delimiter. A non-greedy /\$\{\{(.*?)\}\}/
 * stops at that inner `}}`, yields ` format('`, and the credential after it is
 * never inspected — the whole expression scans clean. Quote state has to be
 * tracked to know which `}}` is a terminator and which is data.
 *
 * Both quote styles hold literal state. GitHub's expression grammar documents
 * SINGLE quotes, and this repository carries no evidence about double ones, so
 * this is deliberately a conservative superset rather than a claim: if double
 * quotes are not literals then `format("}}", …)` is a syntax error that never
 * runs, and treating them as literals only makes the scanner capture MORE text
 * to inspect. `''` (and `""`) escape a quote inside a literal.
 *
 * An expression that never closes is REPORTED, not silently dropped — returning
 * its partial content would be exactly the truncation this replaced.
 */
type ExpressionScan = { expressions: string[]; unterminated: string[] };

function extractGithubExpressions(text: string): ExpressionScan {
  const expressions: string[] = [];
  const unterminated: string[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("${{", i);
    if (open === -1) break;
    let j = open + 3;
    let quote: string | null = null;
    let closed = -1;
    while (j < text.length) {
      const c = text[j];
      if (quote !== null) {
        if (c === quote) {
          if (text[j + 1] === quote) {
            j += 2; // an escaped quote: still inside the literal
            continue;
          }
          quote = null;
        }
        j++;
        continue;
      }
      if (c === "'" || c === '"') {
        quote = c;
        j++;
        continue;
      }
      if (c === "}" && text[j + 1] === "}") {
        closed = j;
        break;
      }
      j++;
    }
    if (closed === -1) {
      unterminated.push(text.slice(open));
      break; // nothing after an unclosed expression can be read reliably
    }
    expressions.push(text.slice(open + 3, closed));
    i = closed + 2;
  }
  return { expressions, unterminated };
}

/**
 * The expression with its string literals emptied — same quote rules as the
 * scanner, so `'it''s'` is one literal. Their CONTENT is data, never a context
 * reference: `format('secrets.DEPLOY_PAT')` names nothing.
 */
function stripExpressionLiterals(expr: string): string {
  let out = "";
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (c !== "'" && c !== '"') {
      out += c;
      i++;
      continue;
    }
    i++;
    while (i < expr.length) {
      if (expr[i] === c) {
        if (expr[i + 1] === c) {
          i += 2;
          continue;
        }
        i++;
        break;
      }
      i++;
    }
    out += c + c; // the literal was here; its content was not code
  }
  return out;
}

/**
 * Does this expression reference the `secrets` CONTEXT?
 *
 * The context, not a spelling. These are one reference to GitHub and must be
 * one reference here:
 *
 *     secrets.DEPLOY_PAT      secrets['DEPLOY_PAT']
 *     secrets["DEPLOY_PAT"]   secrets . DEPLOY_PAT
 *
 * The regex this replaced was /secrets\.[A-Z_]/ — dot access, uppercase first
 * character. A bracket access walked straight past a control whose entire point
 * is that these workflows hold no credential at all, and pinning the receiving
 * action to a SHA does not make handing it a PAT safe.
 *
 * No secret NAME is enumerated: the context is what is refused.
 */
function expressionReferencesSecrets(expr: string): boolean {
  // Literals emptied first, so `format('no secrets here')` — which references
  // nothing — cannot report one. That step also reduces `secrets['X']` to
  // `secrets['']`, leaving the bracket access plainly visible.
  const code = stripExpressionLiterals(expr);
  // Not preceded by a dot, so `needs.build.outputs.secrets` — a property that
  // merely shares the name — is not mistaken for the context.
  //
  // Case-insensitive deliberately. That is the fail-CLOSED direction and needs
  // no claim about GitHub's parser to justify it: matching more can only add
  // findings inside an expression, where no other meaning of the bare
  // identifier `secrets` exists.
  return /(?<![A-Za-z0-9_.-])secrets(?![A-Za-z0-9_-])/i.test(code);
}

/** Minimal structural check — job keys are two-space indented under `jobs:`. */
function jobNames(yaml: string): string[] {
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => l === "jobs:");
  if (start === -1) return [];
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^\S/.test(l) && l.trim()) break;
    const m = /^ {2}([a-z0-9][a-z0-9-]*):\s*$/.exec(l);
    if (m) out.push(m[1]);
  }
  return out;
}

/**
 * Parse the browser shard's conditional `timeout-minutes` into its two
 * branches. Parsing beats matching a literal expression: the guard then
 * survives whitespace and formatting changes, and states the two budgets as
 * NUMBERS rather than as one brittle regex.
 *
 *   timeout-minutes: ${{ ... browser_extended == 'true' && <extended> || <targeted> }}
 */
function shardTimeoutBudgets(): { extended: number; targeted: number } {
  const m =
    /timeout-minutes:\s*\$\{\{\s*needs\.changes\.outputs\.browser_extended\s*==\s*'true'\s*&&\s*(\d+)\s*\|\|\s*(\d+)\s*\}\}/.exec(
      CI,
    );
  if (!m) throw new Error("browser shard timeout-minutes expression not found in ci.yml");
  return { extended: Number(m[1]), targeted: Number(m[2]) };
}

describe("PR CI — path-aware lane selection", () => {
  const jobs = jobNames(CI);

  it("has a changed-path detection job that runs first", () => {
    expect(jobs).toContain("changes");
    expect(CI).toMatch(/id: classify/);
    expect(CI).toMatch(/scripts\/classify-changes\.mjs/);
  });

  it("diffs against the PR merge base, not merely the previous commit", () => {
    expect(CI).toMatch(/pull_request\.base\.sha/);
    expect(CI).toMatch(/git merge-base/);
    expect(CI).toMatch(/fetch-depth: 0/);
  });

  it("emits every documented boolean output", () => {
    for (const k of [
      "docs_only",
      "application",
      "database",
      "security",
      "payment",
      "google_calendar",
      "browser_core",
      "mobile",
      "ci_workflows",
      "full_matrix_required",
    ]) {
      expect(CI, `${k} must be a job output`).toMatch(
        new RegExp(`${k}: \\$\\{\\{ steps\\.classify\\.outputs\\.${k} \\}\\}`),
      );
    }
  });

  it("preserves the existing required-check names", () => {
    for (const name of [
      "typecheck / lint / build / test / safety gates",
      "db integration (local supabase)",
      "browser e2e (local stack)",
      "payment browser e2e (fake stripe)",
      "mobile completion e2e (chromium iphone-profile)",
      "google browser e2e (fake google)",
    ]) {
      expect(CI, `required check "${name}" must still exist`).toContain(name);
    }
  });

  it("every expensive lane is gated on the classifier", () => {
    for (const job of [
      "validate",
      "db-integration",
      "browser-e2e-shard",
      "browser-e2e",
      "payment-browser-e2e",
      "mobile-completion-e2e",
      "google-browser-e2e",
    ]) {
      expect(jobs, `${job} must still exist`).toContain(job);
    }
    // Six gated lanes declare `needs: changes` + an `if:` on classifier output.
    expect((CI.match(/^ {4}needs: changes$/gm) ?? []).length).toBe(6);
    expect((CI.match(/^ {4}if: \$\{\{ needs\.changes\.outputs\./gm) ?? []).length).toBe(6);
  });

  it("the required browser check is a STABLE aggregator, not a dynamic shard name", () => {
    // Branch protection must never depend on "browser shard 1 (extended)".
    expect(CI).toMatch(/ {2}browser-e2e:\n {4}name: browser e2e \(local stack\)/);
    expect(CI).toMatch(/needs: \[changes, browser-e2e-shard\]/);
    expect(CI).toMatch(/if: always\(\)/);
  });

  it("the aggregator fails on a failed or cancelled shard and passes on a legitimate skip", () => {
    expect(CI).toMatch(/needs\.browser-e2e-shard\.result/);
    expect(CI).toMatch(/skipped\)/);
    expect(CI).toMatch(/browser_run.*= "true".*exit 1|exit 1/s);
    expect(CI).toMatch(/browser shard\(s\) passed/);
  });

  it("extended coverage creates exactly FOUR shards", () => {
    // Run 30767725631 cancelled both 2-shard jobs at the 10-minute hard
    // timeout with ZERO test failures (shard 2 reached 72/90). Four shards
    // halve the per-shard load to ~45 tests.
    expect(CI).toMatch(/browser_shards=\$\{r\.extended \? "\[1,2,3,4\]" : "\[1\]"\}/);
    expect(CI).toMatch(/--shard=\$\{\{ matrix\.shard \}\}\/4/);
    expect(CI).toMatch(/fromJson\(needs\.changes\.outputs\.browser_shards\)/);
  });

  it("targeted coverage remains a SINGLE browser job", () => {
    expect(CI).toMatch(/: "\[1\]"/);
  });

  it("the aggregator requires all four extended shards", () => {
    expect(CI).toMatch(/EXPECTED=\$\(node -e/);
    expect(CI).toMatch(/must run exactly 4 shards/);
  });

  it("a CANCELLED shard fails the aggregator", () => {
    expect(CI).toMatch(/cancelled\)/);
    expect(CI).toMatch(/were CANCELLED[\s\S]{0,80}treated as failure/);
    // The cancelled branch must exit non-zero.
    const seg = CI.slice(CI.indexOf("cancelled)"), CI.indexOf("cancelled)") + 400);
    expect(seg).toMatch(/exit 1/);
  });

  it("a MISSING shard result fails the aggregator when coverage was required", () => {
    expect(CI).toMatch(/shard result is MISSING while browser coverage was required/);
    expect(CI).toMatch(/if \[ -z "\$\{SHARD_RESULT:-\}" \]/);
  });

  it("the shard hard timeouts EXCEED their performance targets", () => {
    // A hard timeout is a FAILURE CEILING, not a target. A job whose ceiling
    // equals its target gets cancelled for being merely slow — how run
    // 30767725631 (extended) and later run 30814919019 (targeted) were both
    // misreported as test failures.
    const b = shardTimeoutBudgets();
    expect(b.targeted, "targeted hard timeout").toBe(15);
    expect(b.extended, "extended hard timeout").toBe(18);
    expect(CI).toMatch(/hard timeout 15 min/i);
    expect(CI).toMatch(/hard timeout 18 min/i);
    expect(CI).toMatch(/target <10 min per shard/i);
    expect(CI).toMatch(/FAILURE CEILING, not a performance target/i);
  });

  it("the ceiling clears SETUP plus tests, not just tests", () => {
    // The reason 12 was not survivable had nothing to do with test health, and
    // it is not a fixed cost either - the job STRADDLED the ceiling. The same
    // 81 tests took 508s before the first test on one runner and 266s on
    // another; per-test speed barely moved (3.8s vs 3.6s). So the lane passed
    // or was cancelled depending on which runner it drew.
    //
    // Both halves have to stay in the file: a ceiling justified only by test
    // duration will keep cancelling healthy shards, and one justified by a
    // single observation invites shaving it back to just above that number.
    expect(CI).toMatch(/before the first test executes/i);
    expect(CI).toMatch(/508s/);
    expect(CI).toMatch(/266s/);
    expect(CI).toMatch(/straddled the ceiling/i);
  });

  it("records the evidence for the extended-ceiling correction", () => {
    // Run 31852791688 cancelled shard 3 at 12m15s having run 60 of its 81
    // assigned tests with every one of them passing. The same shard passed in
    // 9m11s on the prior head with 60 tests assigned: the extended suite grew
    // and Playwright redistributed, handing that shard +35% work.
    expect(CI).toMatch(/31852791688/);
    expect(CI).toMatch(/60 of 81/);
    expect(CI).toMatch(/ALL 60 passed/);
    expect(CI).toMatch(/9m11s/);
  });

  it("records the evidence for the targeted-ceiling correction", () => {
    // Run 30814919019 hit the old 10-minute targeted ceiling TWICE on one
    // unchanged head, both times with zero recorded test failures.
    expect(CI).toMatch(/30814919019/);
    expect(CI).toMatch(/101\/105/);
    expect(CI).toMatch(/95\/105/);
    expect(CI).toMatch(/ZERO recorded test failures/i);
  });

  it("shard traces are uploaded independently", () => {
    expect(CI).toMatch(/playwright-traces-shard-\$\{\{ matrix\.shard \}\}/);
  });

  it("EVERY browser-driving job caches Playwright browsers", () => {
    // The previous head claimed caching but wired it only into nightly.yml, so
    // all four PR browser jobs re-downloaded Chromium + FFmpeg + headless shell
    // on every run.
    const caches = CI.match(/path: ~\/\.cache\/ms-playwright/g) ?? [];
    expect(caches.length, "all four browser jobs must cache").toBe(4);
    // CI-HARDEN-01B pinned every action to a commit SHA, so this counts the
    // ACTION rather than a version tag. The claim under test is "every browser
    // job caches", which a ref should never have been able to falsify.
    expect((CI.match(/uses: actions\/cache@/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it("the cache key is bound to runner OS and the exact Playwright version", () => {
    expect(CI).toMatch(
      /key: playwright-\$\{\{ runner\.os \}\}-\$\{\{ steps\.pw\.outputs\.version \}\}-\$\{\{ hashFiles\('package-lock\.json'\) \}\}/,
    );
    expect(CI).toMatch(/require\('@playwright\/test\/package\.json'\)\.version/);
  });

  it("a cache HIT skips the browser download and installs only system deps", () => {
    expect((CI.match(/if: steps\.pw-cache\.outputs\.cache-hit != 'true'/g) ?? []).length).toBe(4);
    expect((CI.match(/if: steps\.pw-cache\.outputs\.cache-hit == 'true'/g) ?? []).length).toBe(4);
    expect((CI.match(/playwright install-deps chromium/g) ?? []).length).toBe(4);
  });

  it("no browser download runs unconditionally", () => {
    const lines = CI.split("\n");
    const unguarded: number[] = [];
    lines.forEach((l, i) => {
      if (l.includes("playwright install --with-deps chromium")) {
        const ctx = lines.slice(Math.max(0, i - 4), i).join("\n");
        if (!ctx.includes("cache-hit != 'true'")) unguarded.push(i + 1);
      }
    });
    expect(unguarded, "every browser download must be behind a cache-miss guard").toEqual([]);
  });

  it("emits timing diagnostics including a timeout hint", () => {
    expect(CI).toMatch(/Timing diagnostics/);
    expect(CI).toMatch(/test duration \(s\)/);
    expect(CI).toMatch(/exceeded its timeout budget/);
  });

  it("docs-only skips the build/unit lane", () => {
    expect(CI).toMatch(/if: \$\{\{ needs\.changes\.outputs\.docs_only != 'true' \}\}/);
  });

  it("full_matrix_required can still force every lane", () => {
    const forced = CI.match(/needs\.changes\.outputs\.full_matrix_required == 'true'/g) ?? [];
    expect(forced.length).toBeGreaterThanOrEqual(5);
  });

  it("keeps PR-scoped concurrency cancellation for superseded runs", () => {
    expect(CI).toMatch(
      /group: hone-pr-ci-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}/,
    );
    expect(CI).toMatch(/cancel-in-progress: true/);
  });

  it("honours the documented latency budgets", () => {
    const budget = (job: string): number => {
      const m = new RegExp(`  ${job}:\\n(?:.*\\n)*?    timeout-minutes: (\\d+)`).exec(CI);
      return m ? Number(m[1]) : -1;
    };
    expect(budget("changes")).toBeLessThanOrEqual(2);
    // validate: TARGET unchanged, HARD TIMEOUT 15. On head e77b83cd `npm ci`
    // alone took 7.1 min against a lane that normally finishes in 3.7-4.7 min
    // TOTAL; typecheck then passed and Lint was 0.2 min in when the 8-minute
    // ceiling killed the job, skipping Build, Unit tests and every safety gate.
    // No assertion failed -- most were never run. Lower bound 8 so a revert
    // turns this red.
    expect(budget("validate")).toBeGreaterThan(8);
    expect(budget("validate")).toBeLessThanOrEqual(15);
    // db-integration: TARGET unchanged, HARD TIMEOUT 12. It carried a single 8
    // that served as both, which is the same shape as the payment lane below.
    // The lane historically finished at 6.1-7.5 min — the ceiling and the
    // observed run time were effectively the same number. Both attempts on head
    // 3013de3 were cancelled at ~8.3 min at DIFFERENT points: the first inside
    // "Start local Supabase", with the migration chain and every test skipped;
    // the second after Supabase started (2.7 min), the full 0001->0190 chain
    // applied (0.9 min) and the suite had completed 1,030 tests across 21 files
    // with ZERO failures. Startup plus chain alone were ~3.6 min, and dependency
    // install added ~2.6 min, so ~6.3 min elapsed before the first test ran.
    //
    // 12 was still not enough: on head e77b83cd `npm ci` alone took 7.1 min, and
    // install plus Supabase startup plus the chain came to 10.6 min before the
    // suite began. It ran real tests -- the WAIT-03 wall-clock suite passed
    // 80/80 -- and was cancelled at 12.3 min with no assertion failing.
    //
    // The lower bound is 12, not 19, so a revert to either old ceiling turns
    // this red rather than silently reinstating the cancellation.
    expect(budget("db-integration")).toBeGreaterThan(12);
    expect(budget("db-integration")).toBeLessThanOrEqual(20);
    // payment-browser-e2e: TARGET ~10 min, HARD TIMEOUT 18. It carried a single
    // 10 that served as both, which is precisely the shape the comment below
    // warns about. F-PAY-002 measured the lane at 9.6-10.4 min locally across
    // repeated runs of 57 serial specs — i.e. the ceiling and the observed run
    // time were the same number, with nothing left for a slow runner.
    //
    // The lower bound is 14, not 11, for the same reason the extended shards
    // clear their target by ~8: setup is not a fixed cost, and the measured
    // runner spread before the first test executes is ~4 minutes (266s vs 508s
    // for the same work). A ceiling of 12 would sit inside that spread and the
    // lane would pass or be cancelled according to which runner it drew.
    expect(budget("payment-browser-e2e")).toBeGreaterThan(14);
    expect(budget("payment-browser-e2e")).toBeLessThanOrEqual(18);
    // google-browser-e2e: TARGET unchanged, HARD TIMEOUT 15. On head 2a23e3e7
    // `npm ci` alone consumed ~5 min; the Supabase stack then started, the full
    // migration chain applied from scratch, and Playwright reported
    // `Running 13 tests using 1 worker`. Tests 1-12 PASSED with zero assertion
    // failures and the 10-minute ceiling cancelled the job as test 13 began --
    // a healthy suite cut mid-run, which reads like a broken diff and is not one.
    //
    // The lower bound is 10, not 14, so a revert to the old ceiling turns this
    // red rather than silently reinstating the cancellation. The upper bound
    // keeps the ceiling FINITE: a removed timeout would let a hung lane burn a
    // full runner allocation.
    expect(budget("google-browser-e2e")).toBeGreaterThan(10);
    expect(budget("google-browser-e2e")).toBeLessThanOrEqual(15);
    expect(budget("mobile-completion-e2e")).toBeLessThanOrEqual(10);
    // Targeted hard timeout 15, extended shard hard timeout 18 — both above
    // their <10 min targets. Parsed, not line-matched, so reformatting the
    // workflow cannot silently break this guard.
    //
    // The extended ceiling exceeds the targeted one because setup is NOT a
    // fixed cost. Everything before the first test - Supabase stack, full
    // migration chain from scratch, Playwright, and the `next build` inside
    // Playwright's webServer - was measured at 266s on one runner and 508s on
    // another for the SAME 81 tests, while per-test execution barely moved
    // (3.6s vs 3.8s). A ceiling has to clear that observed runner spread PLUS
    // test execution, or the lane passes or is cancelled according to which
    // runner it drew rather than according to test health.
    //
    // The upper bounds here are a brake on ceilings drifting upward instead of
    // slow lanes being investigated, so they stay tight enough to notice: a
    // shard that needs more than 18 minutes is a problem to fix, not a number
    // to raise again.
    const b = shardTimeoutBudgets();
    expect(b.targeted).toBeGreaterThan(10);
    expect(b.extended).toBeGreaterThan(10);
    expect(b.targeted).toBeLessThanOrEqual(15);
    expect(b.extended).toBeLessThanOrEqual(18);
  });

  it("every job declares an explicit timeout", () => {
    const jobCount = jobNames(CI).length;
    const timeouts = (CI.match(/^ {4}timeout-minutes:/gm) ?? []).length;
    expect(timeouts).toBe(jobCount);
  });

  it("exposes the browser selection as job outputs", () => {
    for (const k of ["browser_run", "browser_extended", "browser_specs", "browser_shards", "browser_reason"]) {
      expect(CI, `${k} must be a job output`).toMatch(new RegExp(`${k}: \\$\\{\\{ steps\\.browser\\.outputs\\.${k} \\}\\}`));
    }
  });
});

describe("nightly / manual full matrix", () => {
  it("runs on a schedule and on demand", () => {
    expect(NIGHTLY).toMatch(/schedule:/);
    expect(NIGHTLY).toMatch(/cron: "0 7 \* \* \*"/);
    expect(NIGHTLY).toMatch(/workflow_dispatch:/);
  });

  it("covers every lane PR CI may skip", () => {
    for (const lane of [
      "typecheck / lint / build / unit / safety gates",
      "full migration chain + db/rls integration",
      "core browser e2e",
      "payment e2e (fake stripe)",
      "mobile completion e2e",
      "google e2e (fake google)",
    ]) {
      expect(NIGHTLY, `nightly must cover: ${lane}`).toContain(lane);
    }
  });

  it("does not fail fast — one broken lane must not hide the others", () => {
    expect(NIGHTLY).toMatch(/fail-fast: false/);
  });

  it("cancels superseded nightly runs", () => {
    expect(NIGHTLY).toMatch(/cancel-in-progress: true/);
  });

  it("only starts Supabase and browsers for lanes that need them", () => {
    expect(NIGHTLY).toMatch(/if: matrix\.needs_supabase/);
    expect(NIGHTLY).toMatch(/if: matrix\.needs_browsers/);
    expect(NIGHTLY).toMatch(/needs_supabase: false/);
  });

  it("caches Playwright browsers and uploads traces only on failure", () => {
    expect(NIGHTLY).toMatch(/Cache Playwright browsers/);
    expect(NIGHTLY).toMatch(/if: failure\(\) && matrix\.needs_browsers/);
  });

  it("pins the Supabase CLI to the grants-parity version", () => {
    expect(NIGHTLY).toMatch(/version: 2\.102\.0/);
  });
});

describe("canonical migration state", () => {
  const state = JSON.parse(
    execFileSync("node", ["scripts/migration-state.mjs", "--json"], { encoding: "utf8" }),
  );

  it("derives the repository max from filenames", () => {
    expect(state.repo_migration_max).toMatch(/^\d{4}$/);
    expect(state.repo_migration_max_number).toBe(Number(state.repo_migration_max));
  });

  it("derives the next free number, skipping permanently-skipped slots", () => {
    expect(state.next_free_migration_number).toBe(state.repo_migration_max_number + 1);
    expect(state.permanently_skipped).toContain("0158");
    expect(state.versions).not.toContain("0158");
  });

  it("declares hosted state in exactly one canonical record", () => {
    expect(existsSync("docs/production/migration-state.json")).toBe(true);
    const rec = JSON.parse(readFileSync("docs/production/migration-state.json", "utf8"));
    expect(rec.hosted_migration_max).toMatch(/^\d{4}$/);
    expect(state.hosted_migration_max).toBe(rec.hosted_migration_max);
  });

  it("no test hard-codes a repository migration max any more", () => {
    // The pins this PR removed. If one comes back, it will drift again.
    const offenders = execFileSync(
      "bash",
      [
        "-lc",
        String.raw`grep -rlE 'expect\((nums\[nums\.length - 1\]|maxNum)\)\.toBe\(' tests/ 2>/dev/null | grep -v 'tests/ci/ci-config.test.ts' || true`,
      ],
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    expect(
      offenders,
      "import isRepoMax/versionsAbove from tests/migrations/helpers/migration-state instead",
    ).toEqual([]);
  });

  it("no test carries a hand-maintained 'trip on the next migration' regex", () => {
    const offenders = execFileSync(
      "bash",
      [
        "-lc",
        // Exclude this guard file itself — it necessarily contains the pattern
        // it forbids, and a self-match would make the check permanently red.
        String.raw`grep -rlE '\^01\(6\[[0-9]-9\]' tests/ 2>/dev/null | grep -v 'tests/ci/ci-config.test.ts' || true`,
      ],
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    expect(offenders).toEqual([]);
  });
});

describe("pre-push verification", () => {
  const SCRIPT = readFileSync("scripts/verify-prepush.mjs", "utf8");

  it("is wired as an npm script", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.scripts["verify:prepush"]).toBe("node scripts/verify-prepush.mjs");
  });

  it("checks every required condition", () => {
    expect(SCRIPT).toMatch(/status", "--porcelain/);
    expect(SCRIPT).toMatch(/diff", "HEAD"/);
    expect(SCRIPT).toMatch(/diff", "--check"/);
    expect(SCRIPT).toMatch(/conflict markers/i);
    expect(SCRIPT).toMatch(/NOT in the commit/);
  });

  it("installs no global Git hook", () => {
    expect(SCRIPT).not.toMatch(/core\.hooksPath|\.git\/hooks|husky/);
  });

  it("is documented in the contributor instructions", () => {
    const claude = readFileSync("CLAUDE.md", "utf8");
    expect(claude).toMatch(/verify:prepush/);
    expect(claude).toMatch(/git diff HEAD --exit-code/);
    expect(claude).toMatch(/git add -A/);
  });
});

// ---------------------------------------------------------------------------
// CI-HARDEN-01B — supply chain and least privilege
// ---------------------------------------------------------------------------
// Closes the pinning half of HNE-CI-001 (P2, docs/audits/2026-07-30/
// MASTER_FINDINGS_REGISTER.csv, recorded UNMAPPED_HISTORICAL /
// NOT_INDIVIDUALLY_RE_VERIFIED). That row is a frozen historical artifact and is
// referenced here, never rewritten: every source_* cell of the register is
// SHA-256 digest-pinned by tests/audits/findings-register-consistency.test.ts.
//
// Guards 1-4 were each verified to read FALSE against the pre-hardening
// workflows at base 32dfd329 before the workflows were touched, so none of them
// is a guard that passes no matter what. Guards 5-7 are invariants: they were
// green before this change and must stay green, which is the point of them.
//
// Every guard is a PURE FUNCTION of an injected workflow collection, and the
// collection is read from the directory (readWorkflowDir). Two things follow,
// and both are asserted below: a new workflow is enrolled merely by existing,
// and the discrimination controls can hand the same guards a synthetic third
// workflow without writing a hostile file into this repository.
describe("CI-HARDEN-01B — supply chain and least privilege", () => {
  /**
   * The universe under guard — READ FROM DISK, deliberately not listed here.
   * "the guarded universe IS the workflow directory" below is the tripwire
   * against anyone re-hardcoding it.
   */
  const WORKFLOWS: readonly Workflow[] = readWorkflowDir();

  /** Canonical identities — lowercase, because canonicalActionIdentity folds. */
  const CHECKOUT_ACTION = "actions/checkout";

  const checkoutCount = (sources: readonly Workflow[]) =>
    allUses(sources).filter((u) => canonicalActionIdentity(u.value) === CHECKOUT_ACTION).length;

  it("the YAML parser is present and functioning", () => {
    // Stated, not assumed: js-yaml is a TRANSITIVE dev dependency here, and
    // every guard below rests on it. If it ever disappears this reads RED
    // rather than letting a text fallback quietly take over.
    const doc = yaml.load('jobs:\n  j:\n    steps:\n      - "uses" : a/b@c\n');
    expect(executableUses("probe", doc).map((u) => u.value)).toEqual(["a/b@c"]);
  });

  it("every workflow parses as YAML", () => {
    expect(parseAll(WORKFLOWS).filter((w) => w.error).map((w) => `${w.file}: ${w.error}`)).toEqual([]);
  });

  // 1. A mutable ref means the code a job runs can change without a commit
  //    here. `supabase/setup-cli@v1` was the sharpest case: it resolves to a
  //    BRANCH (refs/heads/v1), not a tag — that repository's tags run
  //    v1.7.1 -> v2.0.0 -> v3 — so anyone with push access to it could alter
  //    what every database-touching job in this file executed.
  //
  //    Discovered from the PARSED document. The regex this replaced matched
  //    `uses: ` literally, so `uses : actions/checkout@v4` and
  //    `"uses": actions/checkout@v4` — the same key to YAML, the same action to
  //    GitHub — were invisible to it, and a mutable ref could ride in on either.
  function unpinnedRefViolations(sources: readonly Workflow[]): string[] {
    return allUses(sources)
      .filter((u) => !isImmutableRef(u.value))
      .map((u) => `${u.file} ${u.where}: ${u.value} is not pinned to a 40-character SHA`);
  }

  it("every action reference is pinned to a commit SHA", () => {
    // Anti-vacuity on the COLLECTION. Per file it would have forced every
    // future workflow to declare an action, which is not the contract: a
    // workflow of pure `run:` steps is compliant, and demanding otherwise is
    // how a guard gets weakened later.
    expect(allUses(WORKFLOWS).length, "no workflow declares an action at all").toBeGreaterThan(0);
    expect(unpinnedRefViolations(WORKFLOWS)).toEqual([]);
  });

  // 2. A bare 40-character SHA is unreadable. The trailing tag comment is how a
  //    reviewer knows WHICH version was vetted without leaving the diff.
  //
  //    The ONE place text is still read — a comment cannot be anywhere else.
  //    It is fenced: the line scan must first agree, exactly, with what the
  //    parser says executes. If a `uses` reaches the document by a route the
  //    scan cannot see (or the scan sees one the document does not run), that
  //    disagreement is itself the violation, and no annotation verdict is given.
  function annotationViolations(sources: readonly Workflow[]): string[] {
    const bad: string[] = [];
    for (const { file, body, doc } of parseAll(sources)) {
      const semantic = executableUses(file, doc).map((u) => u.value).sort();
      const lines = usesLines(file, body);
      const textual = lines.map((l) => l.value).sort();
      if (JSON.stringify(semantic) !== JSON.stringify(textual)) {
        bad.push(
          `${file}: the annotation scan sees ${JSON.stringify(textual)} but the parser executes ` +
            `${JSON.stringify(semantic)} — the text scan cannot be trusted to carry the annotation check`,
        );
        continue;
      }
      for (const l of lines) {
        if (l.value.startsWith("./")) continue; // in-repo action: no version to report
        if (!/^v\d+\.\d+\.\d+$/.test(l.annotation ?? "")) {
          bad.push(`${file}:${l.line}: ${l.value} has no # vX.Y.Z annotation`);
        }
      }
    }
    return bad;
  }

  it("every pinned ref carries a trailing version comment", () => {
    expect(allUses(WORKFLOWS).length, "no workflow declares an action at all").toBeGreaterThan(0);
    expect(annotationViolations(WORKFLOWS)).toEqual([]);
  });

  // 3. THE credential control. persist-credentials belongs to the checkout STEP,
  //    so it is read off that step's own `with:` in the parsed document.
  //
  //    What this replaced compared two counts over the raw file — how many
  //    `uses: actions/checkout@` strings, how many `persist-credentials: false`
  //    strings. A COMMENT reading `# checkout must keep persist-credentials:
  //    false` counts as one, so a checkout that had LOST its input, and was
  //    therefore persisting the token again, could be balanced by prose about
  //    the very control it had dropped. Comments are not in the parsed model,
  //    so that is now impossible by construction rather than by care.
  //
  //    NOT redundant with the action default: persist-credentials still
  //    defaults to TRUE in actions/checkout v7.0.1, verified in its action.yml
  //    at the exact SHA pinned here.
  //
  //    The property belongs to the STEP, not to the workflow: a workflow with
  //    no checkout is vacuously compliant (requiring one would fail a
  //    legitimate future workflow, and the pressure would then be to relax this
  //    guard), while guard 7 pins the TOTAL so a checkout cannot be deleted to
  //    dodge the opt-out instead. Each step is judged alone, so one step's
  //    opt-out can never cover for another step's missing one.
  function persistCredentialViolations(sources: readonly Workflow[]): string[] {
    const bad: string[] = [];
    for (const u of allUses(sources)) {
      if (canonicalActionIdentity(u.value) !== CHECKOUT_ACTION) continue;
      if (u.with === null || !("persist-credentials" in u.with)) {
        bad.push(
          `${u.file} ${u.where}: checkout sets no persist-credentials input, so the token is persisted by default`,
        );
        continue;
      }
      const v = u.with["persist-credentials"];
      // Strictly the YAML boolean. `"false"` is refused too: it is quoted, and
      // the canonical unquoted form is what every checkout here already uses,
      // so requiring it costs nothing and removes a shape to argue about.
      if (v !== false) {
        bad.push(
          `${u.file} ${u.where}: persist-credentials is ${JSON.stringify(v)}, not the boolean false`,
        );
      }
    }
    return bad;
  }

  it("every checkout refuses to persist the token", () => {
    expect(checkoutCount(WORKFLOWS), "no checkout was found to judge").toBeGreaterThan(0);
    expect(persistCredentialViolations(WORKFLOWS)).toEqual([]);
  });

  // 4. A workflow with no `permissions:` block inherits the REPOSITORY default,
  //    which is not necessarily read-only — so this is required of every file,
  //    and a new workflow that simply omits the block is refused. Read from the
  //    parsed document for the same reason as guard 1: `"permissions":` and
  //    `permissions :` are the same key to GitHub, and were not the same key to
  //    the anchored regex this replaced.
  function permissionViolations(sources: readonly Workflow[]): string[] {
    const bad: string[] = [];
    for (const { file, doc } of parseAll(sources)) {
      if (!isRecord(doc)) {
        bad.push(`${file}: is not a YAML mapping`);
        continue;
      }
      const top = doc.permissions;
      if (!isRecord(top) || Object.keys(top).length !== 1 || top.contents !== "read") {
        bad.push(
          `${file}: top-level permissions is ${JSON.stringify(top ?? null)}, not exactly { contents: read }`,
        );
      }
      const blocks: [string, unknown][] = [["permissions", doc.permissions]];
      if (isRecord(doc.jobs)) {
        for (const [job, node] of Object.entries(doc.jobs)) {
          if (isRecord(node) && node.permissions !== undefined) {
            blocks.push([`jobs.${job}.permissions`, node.permissions]);
          }
        }
      }
      for (const [where, block] of blocks) {
        if (typeof block === "string" && block !== "read-all") {
          bad.push(`${file} ${where}: grants a write scope — ${block}`);
        } else if (isRecord(block)) {
          for (const [scope, level] of Object.entries(block)) {
            if (level === "write") bad.push(`${file} ${where}: grants a write scope — ${scope}: write`);
          }
        }
      }
    }
    return bad;
  }

  it("every workflow declares contents: read and grants nothing wider", () => {
    expect(permissionViolations(WORKFLOWS)).toEqual([]);
  });

  // 5. The credential opt-out and the read-only token are only safe while this
  //    stays true, so the claim is pinned rather than left as a comment: a
  //    future `git push`, `gh` write or secret read would have to confront this
  //    test. It is also what keeps Codex exact-head review OUT of CI —
  //    scripts/eng/* reads GitHub with the operator's credential and must stay
  //    operator-side.
  //
  //    Scanned over the parsed document's strings AND KEYS. The comment-strip
  //    this replaced existed only because the permissions block explains itself
  //    by naming GITHUB_TOKEN; the parser drops comments outright, so the hack
  //    is gone, and keys are included because `env: { GITHUB_TOKEN: ... }` hides
  //    the token in one.
  //
  //    The secrets half is now the CONTEXT, found inside GitHub expressions,
  //    not one textual spelling of a property access — see
  //    expressionReferencesSecrets. Pinning is not a substitute: a SHA-pinned
  //    third-party action handed a PAT writes through the API just the same,
  //    while `permissions: contents: read` and the absence of `git push` and
  //    `gh` all still read clean.
  function writeCredentialViolations(sources: readonly Workflow[]): string[] {
    const bad: string[] = [];
    for (const { file, doc } of parseAll(sources)) {
      const strings = taggedStrings(doc);
      const text = strings.map((s) => s.value).join("\n");
      if (/GITHUB_TOKEN/.test(text)) bad.push(`${file}: uses GITHUB_TOKEN`);
      if (/\bgit (push|tag)\b/.test(text)) bad.push(`${file}: pushes`);
      if (/\bgh (pr|release|issue|api)\b/.test(text)) bad.push(`${file}: calls a gh write`);

      // The contract is not "no KNOWN write secret" — it is that these
      // workflows need no credential at all, so ANY reference to the secrets
      // context is refused and there is no allowlist to argue with.
      const found = new Set<string>();
      for (const { key, value } of strings) {
        const scan = extractGithubExpressions(value);
        // Fail CLOSED: an expression that never closes is refused outright
        // rather than inspected in part. Truncated content is exactly what let
        // `format('}}', secrets.X)` scan clean.
        for (const partial of scan.unterminated) {
          bad.push(`${file}: unterminated GitHub expression — ${partial.trim()}`);
        }
        const bodies = scan.expressions;
        // `if:` is evaluated as an expression with no `${{ }}` around it, so
        // `if: secrets.FOO != ''` reads a credential without ever writing a
        // brace. Only when the value carries none, or the braces are scanned
        // twice and one reference reports as two.
        if (key === "if" && bodies.length === 0 && scan.unterminated.length === 0) bodies.push(value);
        for (const expr of bodies) {
          if (expressionReferencesSecrets(expr)) found.add(expr.trim());
        }
      }
      for (const expr of [...found].sort()) {
        bad.push(`${file}: references the secrets context — ${expr}`);
      }

      // `jobs.<job>.secrets` hands credentials to a called workflow, and the
      // bare `secrets: inherit` passes EVERY one while containing no
      // expression for the scan above to find.
      if (isRecord(doc) && isRecord(doc.jobs)) {
        for (const [job, node] of Object.entries(doc.jobs)) {
          if (isRecord(node) && node.secrets !== undefined) {
            bad.push(`${file} jobs.${job}.secrets: passes secrets to a called workflow`);
          }
        }
      }
    }
    return bad;
  }

  it("no workflow writes to GitHub, which is what makes the opt-out safe", () => {
    expect(writeCredentialViolations(WORKFLOWS)).toEqual([]);
  });

  // 6. The Supabase CLI pin is a DB-SAFETY invariant, not a preference: a newer
  //    CLI's `db reset` strips Data-API grants and every authenticated query
  //    then fails at the privilege layer, which looks exactly like an
  //    application bug (CLAUDE.md §3). The action was pinned to a commit but
  //    deliberately NOT bumped past the v1 line — v3 is a composite action that
  //    installs the CLI from npm via Bun with different `version` semantics.
  //
  //    Stated as the APPROVED POSTURE, not as the absence of a forbidden
  //    string. The previous form of this guard asserted
  //    `not.toMatch(/supabase\/setup-cli@v[23]/)`, which guard 1 had already
  //    made unreachable: once every ref must be a 40-character SHA, the literal
  //    `@v2` / `@v3` can never appear in these files, so that limb could not
  //    fire for any diff. Replacing all six refs with a v3 commit and
  //    relabelling the comments `# v3.0.0` — while keeping `version: 2.102.0` —
  //    would have kept it green.
  //
  //    The SHA is the supply-chain authority; the annotation is the
  //    human-readable consistency check, believed only after the SHA agrees;
  //    the CLI version is the grants-parity invariant. All three are pinned,
  //    plus the number of uses, so a seventh unreviewed site is not silent.
  const SETUP_CLI_SHA = "ab058987d8d6c725971f6cf9d0b5c98467e30bd1";
  const SETUP_CLI_TAG = "v1.7.1";
  const SETUP_CLI_VERSION = "2.102.0";
  const SETUP_CLI_USES = 6; // 5 in ci.yml + 1 in nightly.yml

  const SETUP_CLI_ACTION = "supabase/setup-cli";

  /**
   * Every way the observed setup-cli posture departs from the approved one.
   *
   * The step and its `version:` input are read from the PARSED document. The
   * hand-rolled scanner this replaced walked from a `uses:` line to the end of
   * that step by indentation, which was both fragile and blind to the key
   * shapes YAML accepts — a seventh site written `uses : supabase/setup-cli@...`
   * would not have been counted, and the "expected six" check would have gone
   * on reporting six.
   *
   * The annotation is still text, because a comment is only ever text; it is
   * fenced by the same reconciliation guard 2 uses.
   */
  function setupCliViolations(sources: readonly Workflow[]): string[] {
    const bad: string[] = [];
    const uses = allUses(sources).filter((u) => canonicalActionIdentity(u.value) === SETUP_CLI_ACTION);

    if (uses.length !== SETUP_CLI_USES) {
      bad.push(`${uses.length} setup-cli uses, expected ${SETUP_CLI_USES}`);
    }
    for (const u of uses) {
      const ref = u.value.slice(u.value.lastIndexOf("@") + 1);
      if (ref !== SETUP_CLI_SHA) {
        bad.push(`${u.file} ${u.where}: ref ${ref} is not the vetted ${SETUP_CLI_TAG} commit`);
      }
      const version = u.with?.["version"];
      if (version !== SETUP_CLI_VERSION) {
        const shown =
          version === undefined ? "(absent)" : typeof version === "string" ? version : JSON.stringify(version);
        bad.push(
          `${u.file} ${u.where}: CLI version ${shown} is not the grants-parity pin ${SETUP_CLI_VERSION}`,
        );
      }
    }

    for (const { file, body, doc } of parseAll(sources)) {
      const executed = executableUses(file, doc).filter(
        (u) => canonicalActionIdentity(u.value) === SETUP_CLI_ACTION,
      ).length;
      const lines = usesLines(file, body).filter((l) => canonicalActionIdentity(l.value) === SETUP_CLI_ACTION);
      if (lines.length !== executed) {
        bad.push(
          `${file}: ${lines.length} setup-cli lines but ${executed} executed — the text scan cannot be ` +
            `trusted to carry the annotation check`,
        );
        continue;
      }
      for (const l of lines) {
        if (l.annotation !== SETUP_CLI_TAG) {
          bad.push(
            `${file}:${l.line}: annotation ${JSON.stringify(l.annotation ?? "(none)")} does not report ${SETUP_CLI_TAG}`,
          );
        }
      }
    }
    return bad;
  }

  it("every supabase/setup-cli use is the vetted v1.7.1 commit on the grants-parity CLI", () => {
    expect(setupCliViolations(WORKFLOWS)).toEqual([]);
  });

  // A guard that cannot fail is not a guard — which is exactly what the removed
  // `@v[23]` limb was. These three drive the substitutions the pin exists to
  // refuse THROUGH THE REAL WORKFLOW TEXT and require each to be reported, so
  // the check is proved reachable rather than assumed to be. No network is
  // involved: the vetted SHA is a constant here and the test is string equality
  // against it.
  //
  // Each control asserts the substitution actually landed before judging the
  // result, so a stale `from` string cannot turn a control into a no-op that
  // "passes" against unmutated text.
  const withMutatedCi = (from: string, to: string): Workflow[] => {
    // Replaces the FIRST occurrence only: one of the six uses departs, which is
    // the realistic shape of the change and proves the guard is per-site. The
    // mutation is applied to the ENUMERATED universe, so these controls and the
    // guard they exercise read the same collection.
    const out = WORKFLOWS.map(([name, body]): Workflow =>
      name === "ci.yml" ? [name, body.replace(from, to)] : [name, body],
    );
    expect(
      out.map(([, body]) => body).join("\n"),
      `negative control needs "${from}" in ci.yml`,
    ).not.toEqual(WORKFLOWS.map(([, body]) => body).join("\n"));
    return out;
  };

  // A synthetic 40-hex value, NOT a published supabase/setup-cli commit. That
  // makes the control stronger than "a v3 commit is refused": the posture is
  // equality with the vetted v1.7.1 commit, so a v3 commit, a re-tagged v1 and
  // an attacker's commit are all refused by the same assertion — and the test
  // carries no unverifiable claim about which SHA v3 actually is.
  const UNAPPROVED_SHA = "0123456789abcdef0123456789abcdef01234567";

  it("RED: a setup-cli ref moved off the vetted commit is refused", () => {
    const violations = setupCliViolations(
      withMutatedCi(`setup-cli@${SETUP_CLI_SHA}`, `setup-cli@${UNAPPROVED_SHA}`),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/is not the vetted v1\.7\.1 commit/);
  });

  it("RED: a setup-cli annotation claiming another major is refused", () => {
    const violations = setupCliViolations(
      withMutatedCi(`${SETUP_CLI_SHA} # ${SETUP_CLI_TAG}`, `${SETUP_CLI_SHA} # v3.0.0`),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/annotation "v3\.0\.0" does not report v1\.7\.1/);
  });

  it("RED: a setup-cli step on another CLI version is refused", () => {
    const violations = setupCliViolations(
      withMutatedCi(`version: ${SETUP_CLI_VERSION}`, "version: 2.103.0"),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/CLI version 2\.103\.0 is not the grants-parity pin/);
  });

  // 7. The browser-e2e aggregator has NO checkout — it is shell arithmetic over
  //    needs.*.result and is covered by the top-level permissions block alone.
  //    Counting the checkouts stops guard 3 from silently assuming nine, and is
  //    what lets guard 3 treat a checkout-free workflow as compliant: a
  //    checkout cannot be DELETED to dodge the opt-out without moving this
  //    number. Counted over the whole directory, so a checkout added by a new
  //    workflow lands here too.
  it("the checkout count across the workflow directory is the reviewed one", () => {
    expect(
      checkoutCount(WORKFLOWS),
      "7 in ci.yml (the aggregator has none) + 1 in nightly.yml",
    ).toBe(8);
  });

  // -------------------------------------------------------------------------
  // The directory-universe contract
  // -------------------------------------------------------------------------
  // The guards above are repo-wide only if the COLLECTION is. These controls
  // prove the enumeration itself — that a workflow becomes subject to every
  // guard merely by existing under .github/workflows, with no edit to this
  // file — because a guard whose universe is hand-written reports on the
  // workflows somebody remembered, not on the ones the repository runs.
  //
  // No hostile workflow is written into .github/workflows to prove this. The
  // synthetic workflows live in memory, or in a temporary directory handed to
  // the real enumerator.

  /** Every CI-HARDEN supply-chain / least-privilege violation, in one call. */
  function supplyChainViolations(sources: readonly Workflow[]): string[] {
    return [
      ...unpinnedRefViolations(sources),
      ...annotationViolations(sources),
      ...persistCredentialViolations(sources),
      ...permissionViolations(sources),
      ...writeCredentialViolations(sources),
      ...setupCliViolations(sources),
    ];
  }

  /**
   * A COMPLIANT future workflow. Each control below varies exactly one property
   * of it, so a RED is attributable to that property and not to the scaffold —
   * which "the compliant baseline is GREEN" is here to establish first.
   */
  const COMPLIANT = [
    "name: Future",
    "on: push",
    "permissions:",
    "  contents: read",
    "jobs:",
    "  scan:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
    "        with:",
    "          persist-credentials: false",
  ];

  const synthetic = (name: string, lines: string[]): Workflow => [name, lines.join("\n") + "\n"];

  /** Vary one line of the baseline, asserting the substitution actually landed. */
  const variant = (name: string, from: string, to: string): Workflow => {
    const lines = COMPLIANT.map((l) => l.replace(from, to));
    expect(lines, `control needs "${from}" in the compliant baseline`).not.toEqual(COMPLIANT);
    return synthetic(name, lines);
  };

  it("control 4: the real workflow directory alone is GREEN", () => {
    expect(supplyChainViolations(WORKFLOWS)).toEqual([]);
  });

  it("the compliant baseline is GREEN, so each RED below is attributable", () => {
    expect(supplyChainViolations([...WORKFLOWS, synthetic("future.yaml", COMPLIANT)])).toEqual([]);
  });

  it("control 1 RED: a future security.yaml with a floating actions/checkout@v4", () => {
    const hostile = variant(
      "security.yaml",
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
      "actions/checkout@v4",
    );
    expect(supplyChainViolations([...WORKFLOWS, hostile])).toContain(
      "security.yaml jobs.scan.steps[0].uses: actions/checkout@v4 is not pinned to a 40-character SHA",
    );
  });

  it("control 2 RED: a future .yaml file with persist-credentials: true", () => {
    const hostile = variant("future.yaml", "persist-credentials: false", "persist-credentials: true");
    expect(supplyChainViolations([...WORKFLOWS, hostile])).toContain(
      "future.yaml jobs.scan.steps[0].uses: persist-credentials is true, not the boolean false",
    );
  });

  it("control 3 RED: a future workflow granting contents: write", () => {
    const hostile = variant("wide.yml", "  contents: read", "  contents: write");
    const violations = supplyChainViolations([...WORKFLOWS, hostile]);
    expect(violations).toContain("wide.yml permissions: grants a write scope — contents: write");
    expect(violations.join("\n")).toMatch(/wide\.yml: top-level permissions is .* not exactly \{ contents: read \}/);
  });

  it("controls 5 and 6: the enumeration takes every .yml and .yaml, and nothing else", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hone-workflow-universe-"));
    try {
      writeFileSync(path.join(dir, "b.yml"), "name: B\n", "utf8");
      writeFileSync(path.join(dir, "a.yaml"), "name: A\n", "utf8");
      writeFileSync(path.join(dir, "README.md"), "# not a workflow\n", "utf8");
      writeFileSync(path.join(dir, "notes.txt"), "not a workflow\n", "utf8");
      writeFileSync(path.join(dir, "ci.yml.bak"), "name: stale\n", "utf8");
      mkdirSync(path.join(dir, "nested.yml")); // a DIRECTORY named like a workflow
      const found = readWorkflowDir(dir);
      // Both extensions, sorted, and the file BODIES — so this proves the
      // enumerator reads the workflow, not merely that it lists a name.
      expect(found).toEqual([
        ["a.yaml", "name: A\n"],
        ["b.yml", "name: B\n"],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The one that matters most: the path from "a file exists in the directory"
  // to "every guard judges it", driven end to end through the REAL enumerator.
  // Nothing in this file names security.yaml as a member of the universe — it
  // is enrolled by existing, which is the whole contract.
  it("a workflow is enrolled in every guard merely by existing in the directory", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hone-workflow-enrol-"));
    try {
      for (const [name, body] of WORKFLOWS) writeFileSync(path.join(dir, name), body, "utf8");
      expect(supplyChainViolations(readWorkflowDir(dir)), "the copy must start GREEN").toEqual([]);

      writeFileSync(
        path.join(dir, "security.yaml"),
        [
          "name: Security",
          "on: push",
          "permissions:",
          "  contents: write",
          "jobs:",
          "  scan:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - uses: actions/checkout@v4",
          "        with:",
          "          persist-credentials: true",
          "      - run: git push origin HEAD",
        ].join("\n") + "\n",
        "utf8",
      );

      const enrolled = readWorkflowDir(dir);
      expect(enrolled.map(([name]) => name)).toContain("security.yaml");

      const violations = supplyChainViolations(enrolled);
      const reported = violations.filter((v) => v.startsWith("security.yaml"));
      // Not merely "something failed": each guard must name the new file.
      expect(reported.join("\n")).toMatch(/is not pinned to a 40-character SHA/);
      expect(reported.join("\n")).toMatch(/persist-credentials is true, not the boolean false/);
      expect(reported.join("\n")).toMatch(/grants a write scope/);
      expect(reported.join("\n")).toMatch(/top-level permissions is .* not exactly \{ contents: read \}/);
      expect(reported.join("\n")).toMatch(/pushes/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Tripwire against a future re-hardcoding: if somebody replaces the
  // enumeration with a list again, WORKFLOWS stops matching the directory.
  // ci.yml and nightly.yml are asserted PRESENT, not asserted to be the whole
  // universe — presence is a fact about today, membership is the directory's.
  // -------------------------------------------------------------------------
  // P2-A — YAML KEY SHAPES
  // -------------------------------------------------------------------------
  // `uses:`, `uses :`, `"uses":` and `'uses':` are ONE key to YAML and one
  // action to GitHub. They were not one key to the text regex that used to do
  // the discovering, so two of the four could carry a mutable ref straight past
  // the pinning guard. Each shape is driven through the real guards below.

  const PINNED_CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1";
  const USES_LINE = `      - uses: ${PINNED_CHECKOUT}`;

  /** The compliant baseline with its single `uses` line rewritten. */
  const withUsesLine = (name: string, replacement: string): Workflow => {
    expect(COMPLIANT.filter((l) => l === USES_LINE), "baseline holds exactly one uses line").toHaveLength(1);
    return synthetic(name, COMPLIANT.map((l) => (l === USES_LINE ? replacement : l)));
  };

  const KEY_SHAPES: [string, string][] = [
    ["uses:", "uses:"],
    ["uses : (space before the colon)", "uses :"],
    ['"uses": (double-quoted key)', '"uses":'],
    ["'uses': (single-quoted key)", "'uses':"],
  ];

  it("the text regex this replaced was blind to three of the four key shapes", () => {
    const LEGACY = /uses: \S+/; // what discovery used to be
    const blind = KEY_SHAPES.filter(([, key]) => !LEGACY.test(`      - ${key} actions/checkout@v4`));
    expect(blind.map(([label]) => label)).toEqual([
      "uses : (space before the colon)",
      '"uses": (double-quoted key)',
      "'uses': (single-quoted key)",
    ]);
    // ...and the parser sees every one of them as the same executable action.
    for (const [, key] of KEY_SHAPES) {
      const doc = yaml.load(["jobs:", "  j:", "    steps:", `      - ${key} actions/checkout@v4`].join("\n"));
      expect(executableUses("probe", doc).map((u) => u.value)).toEqual(["actions/checkout@v4"]);
    }
  });

  for (const [label, key] of KEY_SHAPES) {
    it(`control A4 GREEN: a correctly pinned ref written as ${label}`, () => {
      const ok = withUsesLine("future.yaml", `      - ${key} ${PINNED_CHECKOUT}`);
      expect(supplyChainViolations([...WORKFLOWS, ok])).toEqual([]);
    });

    it(`control A1-A3 RED: a mutable actions/checkout@v4 written as ${label}`, () => {
      const hostile = withUsesLine("security.yaml", `      - ${key} actions/checkout@v4`);
      expect(supplyChainViolations([...WORKFLOWS, hostile])).toContain(
        "security.yaml jobs.scan.steps[0].uses: actions/checkout@v4 is not pinned to a 40-character SHA",
      );
    });
  }

  it("a `uses` that is only input DATA is not treated as an executable action", () => {
    // Discovery reads jobs.<job>.steps[*].uses and jobs.<job>.uses, and nothing
    // else — a deep search for the name would call this an unpinned action.
    const doc = yaml.load(
      ["jobs:", "  j:", "    steps:", `      - uses: ${PINNED_CHECKOUT.split(" ")[0]}`,
       "        with:", "          uses: not-an-action@v1"].join("\n"),
    );
    expect(executableUses("probe", doc).map((u) => u.value)).toEqual([PINNED_CHECKOUT.split(" ")[0]]);
  });

  // -------------------------------------------------------------------------
  // P2-B — persist-credentials BELONGS TO THE CHECKOUT STEP
  // -------------------------------------------------------------------------

  const checkoutWorkflow = (...steps: string[][]): string[] => [
    "name: Future",
    "on: push",
    "permissions:",
    "  contents: read",
    "jobs:",
    "  scan:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    ...steps.flat(),
  ];
  const OPTED_OUT = [`      - uses: ${PINNED_CHECKOUT}`, "        with:", "          persist-credentials: false"];
  const MASKED = [`      - uses: ${PINNED_CHECKOUT}`, "        # persist-credentials: false"];
  const NO_OPT_OUT = "masked.yaml jobs.scan.steps[0].uses: checkout sets no persist-credentials input, so the token is persisted by default";

  it("the count comparison this replaced was satisfied by the COMMENT alone", () => {
    const [, body] = synthetic("masked.yaml", checkoutWorkflow(MASKED));
    // Exactly the legacy check: count checkout uses, count the opt-out STRING.
    const checkouts = (body.match(/uses: actions\/checkout@/g) ?? []).length;
    const optOuts = (body.match(/persist-credentials: false/g) ?? []).length;
    expect(checkouts).toBe(1);
    expect(optOuts, "the comment supplied the count").toBe(1);
    expect(checkouts === optOuts, "so the legacy guard read GREEN").toBe(true);
    // The step itself carries no such input, and the token is persisted.
    expect(persistCredentialViolations([synthetic("masked.yaml", checkoutWorkflow(MASKED))])).toEqual([
      NO_OPT_OUT,
    ]);
  });

  it("control B1 GREEN: a checkout with persist-credentials: false", () => {
    expect(supplyChainViolations([...WORKFLOWS, synthetic("future.yaml", checkoutWorkflow(OPTED_OUT))])).toEqual([]);
  });

  it("control B2 RED: a checkout missing the input, with a comment naming it", () => {
    expect(supplyChainViolations([...WORKFLOWS, synthetic("masked.yaml", checkoutWorkflow(MASKED))])).toContain(
      NO_OPT_OUT,
    );
  });

  it("control B3 RED: two checkouts, one opted out and one not", () => {
    const mixed = synthetic("mixed.yaml", checkoutWorkflow(OPTED_OUT, [`      - uses: ${PINNED_CHECKOUT}`]));
    const violations = persistCredentialViolations([mixed]);
    // One opt-out cannot cover for the other step: the SECOND step is named.
    expect(violations).toEqual([
      "mixed.yaml jobs.scan.steps[1].uses: checkout sets no persist-credentials input, so the token is persisted by default",
    ]);
  });

  it("control B4 RED: every value that is not the boolean false", () => {
    const cases: [string, string][] = [
      ["true", "true"],
      ['"true"', '"true"'],
      ['"false"', '"false"'],
      ["(empty)", ""],
      ["null", "null"],
      ["no", "no"],
    ];
    for (const [label, value] of cases) {
      const wf = synthetic(
        "value.yaml",
        checkoutWorkflow([`      - uses: ${PINNED_CHECKOUT}`, "        with:", `          persist-credentials: ${value}`]),
      );
      expect(persistCredentialViolations([wf]), `persist-credentials: ${label} must be refused`).toHaveLength(1);
    }
    // ...while the canonical boolean, in any YAML casing, is accepted.
    for (const value of ["false", "False", "FALSE"]) {
      const wf = synthetic(
        "value.yaml",
        checkoutWorkflow([`      - uses: ${PINNED_CHECKOUT}`, "        with:", `          persist-credentials: ${value}`]),
      );
      expect(persistCredentialViolations([wf]), `persist-credentials: ${value} is the opt-out`).toEqual([]);
    }
  });

  // -------------------------------------------------------------------------
  // THE SECRETS CONTEXT
  // -------------------------------------------------------------------------
  // The contract is not "no known write secret". It is that these workflows
  // need NO credential, so any reference to the context is refused and there is
  // no allowlist. A ticket that genuinely needs a secret has to redesign this.

  it("the property-access regex this replaced saw only one of the three spellings", () => {
    const LEGACY = /secrets\.[A-Z_]/; // what the check used to be
    const spellings = ["secrets.DEPLOY_PAT", "secrets['DEPLOY_PAT']", 'secrets["DEPLOY_PAT"]'];
    expect(spellings.filter((e) => LEGACY.test(e))).toEqual(["secrets.DEPLOY_PAT"]);
    expect(spellings.filter(expressionReferencesSecrets)).toEqual(spellings);
  });

  it("spacing and casing do not change which context is referenced", () => {
    for (const expr of [
      "secrets.DEPLOY_PAT",
      "secrets . DEPLOY_PAT",
      "secrets['DEPLOY_PAT']",
      'secrets[ "DEPLOY_PAT" ]',
      "SECRETS.DEPLOY_PAT",
      "toJSON(secrets)",
    ]) {
      expect(expressionReferencesSecrets(expr), expr).toBe(true);
    }
  });

  it("something that merely shares the name is NOT the context", () => {
    for (const expr of [
      " needs.build.outputs.secrets ", // a property, reached through a dot
      " env.MY_SECRETS ", // a longer identifier
      " format('no secrets here') ", // a string literal
      " github.sha ", // control 6: an ordinary expression
    ]) {
      expect(expressionReferencesSecrets(expr), expr).toBe(false);
    }
  });

  const SECRET_SITES: [string, string[]][] = [
    ["control 1 — env, dot access", ["        env:", "          TOKEN: ${{ secrets.DEPLOY_PAT }}"]],
    ["control 2 — env, single-quoted bracket", ["        env:", "          TOKEN: ${{ secrets['DEPLOY_PAT'] }}"]],
    ["control 3 — with, double-quoted bracket", ['          token: ${{ secrets["DEPLOY_PAT"] }}']],
    ["an if: condition, which needs no braces at all", ["        if: secrets.DEPLOY_PAT != ''"]],
    [
      "control 4 — a SHA-PINNED third-party action handed the secret",
      [
        "      - uses: owner/action@1111111111111111111111111111111111111111 # v1.0.0",
        "        with:",
        "          token: ${{ secrets.DEPLOY_PAT }}",
      ],
    ],
  ];

  for (const [label, extra] of SECRET_SITES) {
    it(`RED: a secrets reference in ${label}`, () => {
      const hostile = synthetic("leaky.yaml", [...COMPLIANT, ...extra]);
      const violations = supplyChainViolations([...WORKFLOWS, hostile]);
      expect(violations.join("\n")).toMatch(/leaky\.yaml: references the secrets context/);
      // Control 4's point: the receiving action is immutably pinned, carries its
      // annotation, the workflow is contents: read, and nothing pushes or calls
      // gh — every other guard reads clean, and the credential is still refused.
      expect(unpinnedRefViolations([hostile]), "the refs are pinned").toEqual([]);
      expect(annotationViolations([hostile]), "the refs are annotated").toEqual([]);
      expect(permissionViolations([hostile]), "the token is read-only").toEqual([]);
    });
  }

  it("control 5 GREEN: a COMMENT naming the secrets context is not a reference", () => {
    const commented = synthetic("commented.yaml", [
      ...COMPLIANT,
      "        # never use ${{ secrets.DEPLOY_PAT }} here",
    ]);
    expect(supplyChainViolations([...WORKFLOWS, commented])).toEqual([]);
    // ...and this is not hypothetical: the real workflows discuss secrets in
    // comments already, which is why the check must read the parsed model.
    expect(CI + NIGHTLY, "the real workflows mention secrets in prose").toMatch(/No secrets/);
  });

  it("control 6 GREEN: an ordinary expression is untouched", () => {
    const ordinary = synthetic("ordinary.yaml", [
      ...COMPLIANT,
      "        env:",
      "          SHA: ${{ github.sha }}",
      "        if: github.ref == 'refs/heads/main'",
    ]);
    expect(supplyChainViolations([...WORKFLOWS, ordinary])).toEqual([]);
  });

  it("RED: `secrets: inherit` hands every secret on without an expression", () => {
    const inheriting = synthetic("inherit.yaml", [
      "name: Caller",
      "on: push",
      "permissions:",
      "  contents: read",
      "jobs:",
      "  call:",
      "    uses: owner/repo/.github/workflows/x.yml@1111111111111111111111111111111111111111 # v1.0.0",
      "    secrets: inherit",
    ]);
    expect(supplyChainViolations([...WORKFLOWS, inheriting])).toContain(
      "inherit.yaml jobs.call.secrets: passes secrets to a called workflow",
    );
  });

  it("control 7: a future .yaml with a secrets reference is refused by existing", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hone-workflow-secret-"));
    try {
      for (const [name, body] of WORKFLOWS) writeFileSync(path.join(dir, name), body, "utf8");
      expect(supplyChainViolations(readWorkflowDir(dir)), "the copy must start GREEN").toEqual([]);
      writeFileSync(
        path.join(dir, "deploy.yaml"),
        [...COMPLIANT, "        env:", "          TOKEN: ${{ secrets['DEPLOY_PAT'] }}"].join("\n") + "\n",
        "utf8",
      );
      expect(supplyChainViolations(readWorkflowDir(dir)).join("\n")).toMatch(
        /deploy\.yaml: references the secrets context/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // ACTION IDENTITY IS CASE-INSENSITIVE
  // -------------------------------------------------------------------------

  const APPROVED_CHECKOUT_SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";

  const oneStep = (ref: string, rest: string[] = []): string[] => [
    "name: Future",
    "on: push",
    "permissions:",
    "  contents: read",
    "jobs:",
    "  scan:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    `      - uses: ${ref} # v7.0.1`,
    ...rest,
  ];
  const OPT_OUT = ["        with:", "          persist-credentials: false"];

  it("identity control 4: canonicalActionIdentity folds the identifier, and only the identifier", () => {
    for (const written of [
      `Actions/checkout@${APPROVED_CHECKOUT_SHA}`,
      `actions/CHECKOUT@${APPROVED_CHECKOUT_SHA}`,
      `ACTIONS/CHECKOUT@${APPROVED_CHECKOUT_SHA}`,
    ]) {
      expect(canonicalActionIdentity(written), written).toBe(CHECKOUT_ACTION);
    }
    expect(canonicalActionIdentity(`Supabase/Setup-Cli@${SETUP_CLI_SHA}`)).toBe(SETUP_CLI_ACTION);

    // A LOCAL action is a path, which GitHub does not case-fold: it must not be
    // rewritten into a remote identity at all.
    expect(canonicalActionIdentity("./.github/actions/Foo")).toBeNull();
    expect(canonicalActionIdentity("../Shared/Action")).toBeNull();
    expect(canonicalActionIdentity("docker://Alpine:3")).toBeNull();

    // The SHA is not part of identity and is never folded — so an uppercase ref
    // is still refused as unpinned rather than quietly accepted.
    expect(isImmutableRef(`actions/checkout@${APPROVED_CHECKOUT_SHA.toUpperCase()}`)).toBe(false);
  });

  it("the case-preserving comparison this replaced did not see a mixed-case checkout", () => {
    const legacyActionOf = (v: string) => v.slice(0, v.lastIndexOf("@") + 1 || undefined).replace(/@$/, "");
    const ref = `Actions/checkout@${APPROVED_CHECKOUT_SHA}`;
    expect(legacyActionOf(ref) === CHECKOUT_ACTION, "the old comparison saw no checkout").toBe(false);
    expect(canonicalActionIdentity(ref)).toBe(CHECKOUT_ACTION);
  });

  it("identity control 1 RED: Actions/checkout with no persist-credentials", () => {
    const hostile = synthetic("cased.yaml", oneStep(`Actions/checkout@${APPROVED_CHECKOUT_SHA}`));
    expect(persistCredentialViolations([hostile])).toEqual([
      "cased.yaml jobs.scan.steps[0].uses: checkout sets no persist-credentials input, so the token is persisted by default",
    ]);
  });

  it("identity control 2: ACTIONS/CHECKOUT is recognised as a checkout and counted", () => {
    const shouty = synthetic("shouty.yaml", oneStep(`ACTIONS/CHECKOUT@${APPROVED_CHECKOUT_SHA}`, OPT_OUT));
    expect(checkoutCount([shouty]), "it reaches the reviewed checkout total").toBe(1);
    expect(persistCredentialViolations([shouty]), "and its opt-out is honoured").toEqual([]);
    expect(supplyChainViolations([...WORKFLOWS, shouty])).toEqual([]);
  });

  it("identity control 3: Supabase/Setup-Cli is held to the vetted v1.7.1 / 2.102.0 contract", () => {
    const cased = synthetic(
      "cli.yaml",
      oneStep(`Supabase/Setup-Cli@${SETUP_CLI_SHA}`, ["        with:", "          version: 2.103.0"]),
    );
    const violations = setupCliViolations([...WORKFLOWS, cased]).join("\n");
    // Recognised at all — the reviewed count moves, which it could not do while
    // the identifier was compared case-sensitively...
    expect(violations).toMatch(/7 setup-cli uses, expected 6/);
    // ...and, being recognised, it is subject to the grants-parity pin.
    expect(violations).toMatch(/cli\.yaml jobs\.scan\.steps\[0\]\.uses: CLI version 2\.103\.0 is not the grants-parity pin 2\.102\.0/);
  });

  // -------------------------------------------------------------------------
  // EXPRESSION SCANNING IS QUOTE-AWARE
  // -------------------------------------------------------------------------

  it("extractGithubExpressions does not end an expression at a }} inside a literal", () => {
    expect(extractGithubExpressions("${{ format('}}', secrets.DEPLOY_PAT) }}").expressions).toEqual([
      " format('}}', secrets.DEPLOY_PAT) ",
    ]);
    expect(extractGithubExpressions('${{ format("}}", secrets.DEPLOY_PAT) }}').expressions).toEqual([
      ' format("}}", secrets.DEPLOY_PAT) ',
    ]);
    // An escaped quote does not end the literal either.
    expect(extractGithubExpressions("${{ format('it''s }}', secrets.X) }}").expressions).toEqual([
      " format('it''s }}', secrets.X) ",
    ]);
    // Ordinary expressions are unaffected, including several in one scalar.
    expect(extractGithubExpressions("a ${{ github.sha }} b ${{ github.ref }}").expressions).toEqual([
      " github.sha ",
      " github.ref ",
    ]);
  });

  it("the non-greedy match this replaced truncated before the credential", () => {
    const LEGACY = /\$\{\{([\s\S]*?)\}\}/; // what extraction used to be
    const adversarial = "${{ format('}}', secrets.DEPLOY_PAT) }}";
    expect(LEGACY.exec(adversarial)?.[1], "it stopped at the } inside the literal").toBe(" format('");
    expect(expressionReferencesSecrets(" format('")).toBe(false); // ...and so scanned clean
    expect(extractGithubExpressions(adversarial).expressions.some(expressionReferencesSecrets)).toBe(true);
  });

  it("expression control 7: an unterminated expression is reported, never partly inspected", () => {
    const scan = extractGithubExpressions("${{ secrets.DEPLOY_PAT");
    expect(scan.expressions).toEqual([]);
    expect(scan.unterminated).toEqual(["${{ secrets.DEPLOY_PAT"]);
    const broken = synthetic("broken.yaml", [...COMPLIANT, "        env:", '          TOKEN: "${{ secrets.DEPLOY_PAT"']);
    expect(supplyChainViolations([...WORKFLOWS, broken])).toContain(
      "broken.yaml: unterminated GitHub expression — ${{ secrets.DEPLOY_PAT",
    );
  });

  it("expression control 5 GREEN: a string literal naming the context is not a reference", () => {
    expect(expressionReferencesSecrets(" format('secrets.DEPLOY_PAT') ")).toBe(false);
    expect(expressionReferencesSecrets(" format('}}', secrets.DEPLOY_PAT) ")).toBe(true);
    const quoted = synthetic("quoted.yaml", [
      ...COMPLIANT,
      "        env:",
      "          NOTE: \"${{ format('secrets.DEPLOY_PAT') }}\"",
    ]);
    expect(supplyChainViolations([...WORKFLOWS, quoted])).toEqual([]);
  });

  const ADVERSARIAL: [string, string][] = [
    ["expression control 3 — a single-quoted literal holding the delimiter", "${{ format('}}', secrets.DEPLOY_PAT) }}"],
    ["expression control 4 — a double-quoted literal holding the delimiter", '${{ format("}}", secrets.DEPLOY_PAT) }}'],
  ];

  for (const [label, expr] of ADVERSARIAL) {
    it(`RED: ${label}`, () => {
      const hostile = synthetic("leaky.yaml", [...COMPLIANT, "        env:", `          TOKEN: ${JSON.stringify(expr)}`]);
      expect(supplyChainViolations([...WORKFLOWS, hostile]).join("\n")).toMatch(
        /leaky\.yaml: references the secrets context/,
      );
    });
  }

  it("expression control 8: the adversarial form is refused in a future .yaml by existing", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hone-workflow-adversarial-"));
    try {
      for (const [name, body] of WORKFLOWS) writeFileSync(path.join(dir, name), body, "utf8");
      expect(supplyChainViolations(readWorkflowDir(dir)), "the copy must start GREEN").toEqual([]);
      writeFileSync(
        path.join(dir, "ship.yaml"),
        [...COMPLIANT, "        env:", "          TOKEN: \"${{ format('}}', secrets.DEPLOY_PAT) }}\""].join("\n") + "\n",
        "utf8",
      );
      expect(supplyChainViolations(readWorkflowDir(dir)).join("\n")).toMatch(
        /ship\.yaml: references the secrets context/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the guarded universe IS the workflow directory, not a list in this file", () => {
    const onDisk = readdirSync(WORKFLOW_DIR)
      .filter((name) => /\.ya?ml$/.test(name))
      .sort();
    expect(onDisk.length, "the workflow directory is empty").toBeGreaterThan(0);
    expect(WORKFLOWS.map(([name]) => name)).toEqual(onDisk);
    expect(onDisk).toEqual(expect.arrayContaining(["ci.yml", "nightly.yml"]));
  });
});
