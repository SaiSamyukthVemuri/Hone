import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

// CI-DRAFT-01. Draft PRs skip the heavy lanes; the stable required aggregator must
// then FAIL (DRAFT-DEFERRED) whenever the diff needs any of them, never report the
// deferred coverage as passed. Behaviour is proved by EXECUTING the aggregator
// extracted from ci.yml, and the job conditions are proved against the BASE commit
// read from git, so "existing condition unchanged" is demonstrated, not asserted.

const ROOT = path.resolve(__dirname, "../..");
const CI = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
// tip of claude/build-hone-saas-hOex7 this change was cut from
const BASE_SHA = "a70bcf7813727ac4f6b2f98f8dceae986dcfffc5";

const HEAVY = [
  "db-integration",
  "browser-e2e-shard",
  "payment-browser-e2e",
  "mobile-completion-e2e",
  "google-browser-e2e",
  "storage-photos",
  "webkit-hon-62",
];
const UNGATED = ["changes", "validate", "canonical-record"];

function jobBlock(src: string, job: string): string {
  const lines = src.split("\n");
  const i = lines.findIndex((l) => l === `  ${job}:`);
  if (i < 0) throw new Error(`job ${job} not found`);
  let end = lines.length;
  for (let k = i + 1; k < lines.length; k += 1) {
    if (/^ {2}[A-Za-z][\w-]*:/.test(lines[k])) { end = k; break; }
  }
  return lines.slice(i, end).join("\n");
}
function ifLine(src: string, job: string): string | null {
  const m = jobBlock(src, job).match(/^ {4}if: (.*)$/m);
  return m ? m[1] : null;
}
function baseCi(): string {
  try {
    return execFileSync("git", ["show", `${BASE_SHA}:.github/workflows/ci.yml`], {
      cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    throw new Error(`base commit ${BASE_SHA} is not reachable: CI-DRAFT-01 needs full history (fetch-depth: 0)`);
  }
}

describe("CI-DRAFT-01 triggers", () => {
  it("ready_for_review is an enabled pull_request event, with the defaults kept", () => {
    expect(CI).toMatch(/^on:\n {2}pull_request:\n {4}types: \[opened, synchronize, reopened, ready_for_review\]\n {2}push:\n {4}branches:\n {6}- claude\/build-hone-saas-hOex7/m);
  });
});

describe("CI-DRAFT-01 job conditions", () => {
  const base = baseCi();
  it("every Supabase-starting job is one of the gated heavy jobs (none missed)", () => {
    const starters = CI.split("\n").flatMap((l, i, a) => {
      if (!/^ {2}[A-Za-z][\w-]*:$/.test(l)) return [];
      const name = l.trim().slice(0, -1);
      return /supabase start/.test(jobBlock(CI, name)) ? [name] : [];
    });
    expect(starters.sort()).toEqual([...HEAVY].sort());
  });
  for (const job of HEAVY) {
    it(`${job}: condition is draft != true && ( <base condition, unchanged> )`, () => {
      const was = ifLine(base, job);
      expect(was, `${job} had a condition at the base`).not.toBeNull();
      const inner = was!.match(/^\$\{\{ (.*) \}\}$/)![1];
      expect(ifLine(CI, job)).toBe(`\${{ github.event.pull_request.draft != true && ( ${inner} ) }}`);
    });
  }
  for (const job of UNGATED) {
    it(`${job}: not draft-gated and its condition is untouched`, () => {
      expect(ifLine(CI, job)).toBe(ifLine(base, job));
      expect(jobBlock(CI, job)).not.toMatch(/pull_request\.draft/);
    });
  }
});

describe("CI-DRAFT-01 spec lists cannot drift from the job conditions (G1)", () => {
  const specsIn = (text: string) => [...text.matchAll(/e2e\/[\w.-]+\.spec\.ts/g)].map((x) => x[0]).sort();
  const aggregator = (() => {
    const b = jobBlock(CI, "browser-e2e");
    return b;
  })();
  // the aggregator's `case` arm that sets a given flag
  const armSpecs = (flag: string) => {
    const m = aggregator.match(new RegExp(`case "\\$\\{BROWSER_SPECS:-\\}" in\\n([^\\n]*)\\n\\s*esac`, "g")) ?? [];
    const arm = m.find((a) => a.includes(`${flag}="true"`));
    if (!arm) throw new Error(`no case arm sets ${flag}`);
    return specsIn(arm);
  };
  const jobSpecs = (job: string) => specsIn(ifLine(CI, job)!);

  it("SPEC_PHOTO lists exactly the spec names in storage-photos' condition", () => {
    expect(jobSpecs("storage-photos").length).toBeGreaterThan(0);
    expect(armSpecs("SPEC_PHOTO")).toEqual(jobSpecs("storage-photos"));
  });
  it("SPEC_WEBKIT lists exactly the spec names in webkit-hon-62's condition", () => {
    expect(jobSpecs("webkit-hon-62").length).toBeGreaterThan(0);
    expect(armSpecs("SPEC_WEBKIT")).toEqual(jobSpecs("webkit-hon-62"));
  });
});

// ---- aggregator behaviour ----------------------------------------------------------
function script(): string {
  const lines = CI.split("\n");
  const start = lines.findIndex((l) => l === "  browser-e2e:");
  const run = lines.findIndex((l, i) => i > start && l === "        run: |");
  const body: string[] = [];
  for (let i = run + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (l.trim() === "") { body.push(""); continue; }
    if (l.length - l.trimStart().length < 10) break;
    body.push(l.slice(10));
  }
  const s = body.join("\n");
  if (s.length < 1500 || !s.includes("DRAFT-DEFERRED")) throw new Error("wrong aggregator block");
  return s;
}
const SCRIPT = script();

const GREEN = {
  CHANGES_RESULT: "success", SHARD_RESULT: "skipped", RECORD_RESULT: "skipped",
  BROWSER_RUN: "false", FULL_MATRIX: "false", EXTENDED: "false", SHARDS: "[]",
  DOCS_ONLY: "false", PRODUCTION_RECORD: "false", DOCS_CONSISTENCY: "false",
  IS_DRAFT: "true", DATABASE: "false", SECURITY: "false", PAYMENT: "false",
  MOBILE: "false", GOOGLE_CALENDAR: "false", BROWSER_SPECS: "",
};
function run(over: Record<string, string>) {
  try {
    const out = execFileSync("bash", ["-c", SCRIPT], {
      env: { ...process.env, ...GREEN, ...over }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    const x = e as { status?: number; stdout?: string; stderr?: string };
    return { code: x.status ?? 1, out: `${x.stdout ?? ""}${x.stderr ?? ""}` };
  }
}
const DEFERRED_LINE =
  "::error title=DRAFT-DEFERRED::draft PR: required coverage for this diff was deferred. Mark the PR ready for review to run it.";

describe("CI-DRAFT-01 aggregator on a draft", () => {
  const needs: Array<[string, Record<string, string>]> = [
    ["application/browser (browser_run)", { BROWSER_RUN: "true", SHARDS: "[1]" }],
    ["database-only, every browser flag false", { DATABASE: "true" }],
    ["security-only", { SECURITY: "true" }],
    ["payment", { PAYMENT: "true" }],
    ["mobile", { MOBILE: "true" }],
    ["google calendar", { GOOGLE_CALENDAR: "true" }],
    ["full matrix", { FULL_MATRIX: "true" }],
    ["browser_extended only (storage-photos / webkit)", { EXTENDED: "true" }],
    ["storage-photos spec only", { BROWSER_SPECS: "e2e/fett-client-portrait.spec.ts" }],
    ["webkit spec only", { BROWSER_SPECS: "e2e/finish-appointment-mobile.spec.ts" }],
  ];
  for (const [name, env] of needs) {
    it(`defers (exit 1, exact one-line error) for ${name}`, () => {
      const r = run(env);
      expect(r.code).toBe(1);
      expect(r.out.split("\n").filter((l) => l.includes("DRAFT-DEFERRED"))).toEqual([DEFERRED_LINE]);
    });
  }
  it("a draft that needs no heavy lane (docs-only, no record) passes", () => {
    const r = run({ DOCS_ONLY: "true" });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("DRAFT-DEFERRED");
  });
  it("classifier failure is reported as such, never masked by draft handling", () => {
    for (const result of ["failure", "cancelled", "skipped", ""]) {
      const r = run({ CHANGES_RESULT: result });
      expect(r.code).toBe(1);
      expect(r.out).toContain("changed-path detection did not succeed");
      expect(r.out).not.toContain("DRAFT-DEFERRED");
    }
  });
  it("a failing canonical-record on a docs-only draft that requires it is not masked", () => {
    for (const result of ["failure", "cancelled", "skipped"]) {
      const r = run({ DOCS_ONLY: "true", PRODUCTION_RECORD: "true", RECORD_RESULT: result });
      expect(r.code).toBe(1);
      expect(r.out).toContain("canonical production record");
      expect(r.out).not.toContain("DRAFT-DEFERRED");
    }
    expect(run({ DOCS_ONLY: "true", PRODUCTION_RECORD: "true", RECORD_RESULT: "success" }).code).toBe(0);
  });
});

describe("CI-DRAFT-01 aggregator on ready PRs and production pushes", () => {
  const READY = { IS_DRAFT: "false" };
  it("never emits DRAFT-DEFERRED when not a draft, whatever the classifier says", () => {
    const r = run({ ...READY, DATABASE: "true", BROWSER_RUN: "true", SHARD_RESULT: "success", SHARDS: "[1]" });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("DRAFT-DEFERRED");
  });
  it("a push (IS_DRAFT false) keeps its existing outcomes", () => {
    expect(run({ ...READY, SHARD_RESULT: "skipped" }).code).toBe(0);
    expect(run({ ...READY, BROWSER_RUN: "true", SHARD_RESULT: "skipped" }).code).toBe(1);
    expect(run({ ...READY, FULL_MATRIX: "true", SHARD_RESULT: "" }).code).toBe(1);
  });
  for (const result of ["failure", "cancelled", "skipped", ""]) {
    it(`required browser shard result "${result || "missing"}" on a ready PR cannot yield success`, () => {
      expect(run({ ...READY, BROWSER_RUN: "true", SHARDS: "[1]", SHARD_RESULT: result }).code).toBe(1);
    });
  }
  it("a ready PR with a shard failure or cancel is a failure even if nothing else is required", () => {
    expect(run({ ...READY, SHARD_RESULT: "failure" }).code).toBe(1);
    expect(run({ ...READY, SHARD_RESULT: "cancelled" }).code).toBe(1);
  });
});
