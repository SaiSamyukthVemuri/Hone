import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// ===========================================================================
// CI-HARDEN-POSTTEST — a verification step must not be SKIPPED behind an
// earlier failure.
// ===========================================================================
//
// A GitHub step with no `if:` inherits `success()`, so it does not run once an
// earlier step in the same job has failed. It is not reported as failed and not
// meaningfully reported as skipped: the job is already red for the other
// reason, so nobody looks.
//
// MEASURED CONSEQUENCE, which is why this file exists. In `db-integration`,
// `npm run check:db-types` sits after `npm run test:db`. Every branch of the G1
// stack fails `test:db` on an inherited pending-suffix hole, so the drift check
// had NEVER executed there — while it had a real drift to report the whole
// time (0222 adds `practitioners.last_public_assignment_at`; the hand-rolled
// `Practitioner` type did not carry it). It surfaced only when a composed
// branch happened to make `test:db` pass. The guard was not weak; it was
// unreachable.
//
// So the general rule, and what this file pins: in every job, a step that can
// fail the job on its own and runs AFTER the job's test step must carry a
// condition that still runs after a failure.
//
// WHAT THIS FILE IS NOT. It does not check that the conditions are
// semantically ideal, and it deliberately says nothing about artifact, upload,
// diagnostic or cleanup steps — those are already `if: failure()` or
// `if: always()` by design and are not verification. See the limitations note
// at the bottom for what a future step could do to slip past this.

const ROOT = path.resolve(__dirname, "../..");
const CI_PATH = path.join(ROOT, ".github/workflows/ci.yml");
const CI_BODY = readFileSync(CI_PATH, "utf8");

// Same mechanism, and the same reasoning, as tests/ci/ci-config.test.ts:
// js-yaml is present transitively (via @eslint/eslintrc), ships no type
// declarations, and promoting it to an explicit devDependency is a dependency
// change this change is not authorised to make. If ESLint ever drops it this
// file fails to LOAD, which is loud and fail-closed rather than silently
// green — and the first test below states that requirement rather than
// assuming it.
const nodeRequire = createRequire(path.resolve("package.json"));
const yaml = nodeRequire("js-yaml") as { load(src: string): unknown };

type Step = {
  name?: string;
  id?: string;
  run?: string;
  uses?: string;
  if?: string;
};
type Job = { steps?: Step[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function jobs(body: string): Array<[string, Job]> {
  const doc = yaml.load(body);
  if (!isRecord(doc) || !isRecord(doc.jobs)) return [];
  return Object.entries(doc.jobs).map(([id, j]) => [id, (j ?? {}) as Job]);
}

/**
 * A step that EXECUTES the suite.
 *
 * `npm test` IS included, and that is not a detail: `validate`'s test step runs
 * exactly that, not `npm run test`. My first version of this predicate matched
 * only `npm run test…`, so it never found validate's test step and silently
 * swept NONE of its three later checks — the file passed while policing one job
 * instead of two. The non-vacuity assertion below is what caught it, which is
 * the whole reason it is written as a floor rather than as a comment.
 */
function isTestStep(s: Step): boolean {
  const run = s.run ?? "";
  return (
    /\bnpm test\b/.test(run) ||
    /\bnpm run test\b/.test(run) ||
    /\bnpm run test:/.test(run) ||
    /\bvitest\b/.test(run) ||
    /\bplaywright test\b/.test(run)
  );
}

/**
 * A step that can FAIL THE JOB ON ITS OWN and exists to assert something —
 * as opposed to uploading an artifact, printing diagnostics or cleaning up.
 *
 * Matched by the shape the repository actually uses for these: an `npm run
 * check…` / `verify…` / `lint` script, or an explicit `--check` flag. See the
 * limitations note for the shapes this does NOT see.
 */
function isVerificationStep(s: Step): boolean {
  const run = s.run ?? "";
  if (!run) return false;
  return (
    /\bnpm run (check|verify)/.test(run) ||
    /\bnpm run lint\b/.test(run) ||
    /--check\b/.test(run)
  );
}

/** Does this condition still run when an earlier step has failed? */
function survivesFailure(cond: string | undefined): boolean {
  if (!cond) return false;
  const c = cond.replace(/\s+/g, "");
  return c.includes("!cancelled()") || c.includes("always()");
}

/** The step ids a condition reads, e.g. `steps.db_chain.outcome`. */
function referencedStepIds(cond: string | undefined): string[] {
  if (!cond) return [];
  return [...cond.matchAll(/steps\.([A-Za-z0-9_-]+)\./g)].map((m) => m[1]!);
}

/**
 * A condition may require a PREREQUISITE to have succeeded — that is correct,
 * and `check:db-types` needs it. What it must never require is the success of
 * a TEST step, because that is the hiding this file exists to prevent, and
 * `!cancelled() && steps.<the tests>.outcome == 'success'` would smuggle it
 * back in while still containing `!cancelled()`.
 */
function gatesOnATestStep(job: Job, cond: string | undefined): boolean {
  const ids = referencedStepIds(cond);
  if (ids.length === 0) return false;
  const steps = job.steps ?? [];
  return ids.some((id) => {
    const target = steps.find((s) => s.id === id);
    return target ? isTestStep(target) : false;
  });
}

/** Every post-test verification step, with whether it is guarded. */
function postTestVerificationSteps(body: string): Array<{
  job: string;
  step: string;
  guarded: boolean;
}> {
  const out: Array<{ job: string; step: string; guarded: boolean }> = [];
  for (const [id, job] of jobs(body)) {
    const steps = job.steps ?? [];
    const firstTest = steps.findIndex(isTestStep);
    if (firstTest < 0) continue;
    for (const s of steps.slice(firstTest + 1)) {
      if (!isVerificationStep(s)) continue;
      out.push({
        job: id,
        step: s.name ?? "(unnamed)",
        guarded: survivesFailure(s.if),
      });
    }
  }
  return out;
}

describe("the instrument works at all", () => {
  it("the YAML parser is present and functioning", () => {
    expect(typeof yaml.load).toBe("function");
    expect(jobs(CI_BODY).length).toBeGreaterThan(5);
  });

  it("finds the post-test verification steps it claims to police", () => {
    // NON-VACUITY. An empty sweep would make every assertion below pass while
    // policing nothing — the exact way an absence assertion lies.
    const found = postTestVerificationSteps(CI_BODY);
    expect(found.length).toBeGreaterThanOrEqual(4);
  });

  it("CONTROL: an UNGUARDED post-test check is detected", () => {
    // The detector must be able to FAIL. This synthetic workflow has the
    // defect this file exists to prevent; if the predicate ever stops seeing
    // it, the sweep above is worthless.
    const synthetic = [
      "name: synthetic",
      "on: push",
      "jobs:",
      "  demo:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Unit tests",
      "        run: npm run test",
      "      - name: Some later gate",
      "        run: npm run check:something",
      "",
    ].join("\n");
    const found = postTestVerificationSteps(synthetic);
    expect(found).toEqual([
      { job: "demo", step: "Some later gate", guarded: false },
    ]);
  });

  it("CONTROL: `npm test` counts as the test step, not just `npm run test`", () => {
    // The exact shape that defeated the first version of isTestStep: validate
    // runs `npm test`. If this regresses, that job's checks stop being swept
    // and this file goes quietly back to policing one job.
    const npmTest = [
      "name: synthetic",
      "on: push",
      "jobs:",
      "  demo:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Unit tests",
      "        run: npm test",
      "      - name: Later gate",
      "        run: npm run check:something",
      "",
    ].join("\n");
    expect(postTestVerificationSteps(npmTest)).toEqual([
      { job: "demo", step: "Later gate", guarded: false },
    ]);
  });

  it("CONTROL: the same step WITH the condition reads as guarded", () => {
    const guarded = [
      "name: synthetic",
      "on: push",
      "jobs:",
      "  demo:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Unit tests",
      "        run: npm run test",
      "      - name: Some later gate",
      "        if: ${{ !cancelled() }}",
      "        run: npm run check:something",
      "",
    ].join("\n");
    expect(postTestVerificationSteps(guarded)).toEqual([
      { job: "demo", step: "Some later gate", guarded: true },
    ]);
  });
});

describe("ci.yml: no verification step is hidden behind an earlier failure", () => {
  it("EVERY post-test verification step carries a condition that survives failure", () => {
    // THE GENERAL ASSERTION, deliberately not a hardcoded list of the four
    // steps this change fixed: a NEW check appended after a test step in any
    // job is caught here without anyone remembering to update this file. A
    // hardcoded list is the failure mode where a fifth unguarded step is added
    // and nothing notices.
    const unguarded = postTestVerificationSteps(CI_BODY)
      .filter((s) => !s.guarded)
      .map((s) => `${s.job}: ${s.step}`);
    expect(unguarded).toEqual([]);
  });

  it("the drift check in particular is guarded, since it is the step that was unreachable", () => {
    const dbJob = jobs(CI_BODY).find(([id]) => id === "db-integration");
    expect(dbJob, "the db-integration job must exist").toBeTruthy();
    const steps = dbJob?.[1].steps ?? [];
    const drift = steps.find((s) => (s.run ?? "").includes("npm run check:db-types"));
    expect(drift, "the generated-types drift step must exist").toBeTruthy();
    expect(survivesFailure(drift?.if)).toBe(true);
    // ...and it must still come AFTER the tests. Moving it before them would
    // also "fix" the symptom, by changing what the job proves.
    const testIdx = steps.findIndex(isTestStep);
    const driftIdx = steps.findIndex((s) => (s.run ?? "").includes("npm run check:db-types"));
    expect(testIdx).toBeGreaterThanOrEqual(0);
    expect(driftIdx).toBeGreaterThan(testIdx);
  });

  it("no post-test check is gated on a TEST step's success", () => {
    // The hole in `survivesFailure` on its own: a condition can contain
    // `!cancelled()` and STILL be hidden behind the tests, by requiring the
    // test step's own outcome. That would reintroduce the defect while passing
    // the sweep above, so it is checked separately.
    const offenders: string[] = [];
    for (const [id, job] of jobs(CI_BODY)) {
      const steps = job.steps ?? [];
      const firstTest = steps.findIndex(isTestStep);
      if (firstTest < 0) continue;
      for (const s of steps.slice(firstTest + 1)) {
        if (!isVerificationStep(s)) continue;
        if (gatesOnATestStep(job, s.if)) offenders.push(`${id}: ${s.name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the drift check requires the migration chain to have applied", () => {
    // Codex P2 4307392979. `scripts/check-db-types.mjs` declares its own
    // prerequisite (`supabase db start && supabase db reset --local`), so
    // running it against an absent or half-migrated database reports BOGUS
    // drift — a misleading second failure on top of the real one.
    const dbJob = jobs(CI_BODY).find(([id]) => id === "db-integration")?.[1];
    const steps = dbJob?.steps ?? [];
    const drift = steps.find((s) => (s.run ?? "").includes("npm run check:db-types"));
    const ids = referencedStepIds(drift?.if);
    expect(ids.length, "the drift check must name a prerequisite step").toBeGreaterThan(0);
    // The referenced step must be the one that APPLIES THE CHAIN, and it must
    // really exist — a typo'd id silently evaluates to an empty outcome and
    // would skip the check forever.
    const prereqs = ids.map((id) => steps.find((s) => s.id === id));
    expect(prereqs.every(Boolean), `unknown step id in: ${drift?.if}`).toBe(true);
    expect(
      prereqs.some((s) => /db reset --local/.test(s?.run ?? "")),
      "the gate must be the migration-chain step",
    ).toBe(true);
    // ...and that prerequisite must NOT itself be a verification or a test, or
    // we are back to one check hiding another.
    for (const s of prereqs) {
      expect(isTestStep(s!)).toBe(false);
      expect(isVerificationStep(s!)).toBe(false);
    }
  });

  it("CONTROL: a bare !cancelled() on the drift check is NOT sufficient", () => {
    // Proves the assertion above can fail: the previous revision of this
    // change carried exactly this condition, and the reviewer was right that
    // it runs the check against a database that may not exist.
    const bare = [
      "name: synthetic",
      "on: push",
      "jobs:",
      "  db-integration:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Apply full migration chain from scratch",
      "        id: db_chain",
      "        run: supabase db reset --local",
      "      - name: DB/RLS integration tests",
      "        run: npm run test:db",
      "      - name: Generated types drift check",
      "        if: ${{ !cancelled() }}",
      "        run: npm run check:db-types",
      "",
    ].join("\n");
    const steps = jobs(bare).find(([id]) => id === "db-integration")?.[1].steps ?? [];
    const drift = steps.find((s) => (s.run ?? "").includes("check:db-types"));
    // It survives a test failure...
    expect(survivesFailure(drift?.if)).toBe(true);
    // ...but names no prerequisite, which is the defect the finding named.
    expect(referencedStepIds(drift?.if)).toEqual([]);
  });

  it("artifact, diagnostic and cleanup steps are left alone", () => {
    // Scope statement as a test: this change must not have widened conditions
    // on steps that already had deliberate ones. Upload-on-failure stays
    // failure-only; it is not verification and running it on success is waste.
    const conds: string[] = [];
    for (const [, job] of jobs(CI_BODY)) {
      for (const s of job.steps ?? []) {
        const n = (s.name ?? "").toLowerCase();
        if (n.includes("upload") && s.if) conds.push(s.if.replace(/\s+/g, ""));
      }
    }
    expect(conds.length).toBeGreaterThan(0);
    for (const c of conds) expect(c).toContain("failure()");
  });
});

// ---------------------------------------------------------------------------
// STATED LIMITATIONS — what this file does NOT catch.
//
// 1. A verification step whose `run` uses a shape `isVerificationStep` does not
//    match: a bare `node scripts/foo.mjs`, a `npx` invocation, or an inline
//    shell assertion with no `--check`. Such a step could sit unguarded after
//    the tests and this file would stay green. Broadening the predicate to
//    "any run: step" was rejected because it would sweep in the cleanup and
//    diagnostic steps that are correctly conditioned otherwise.
// 2. Job-level ordering via `needs:`. A whole JOB that depends on a failed job
//    is skipped, and that is GitHub's model working as intended, not this
//    defect. This file is about steps inside one job.
// 3. Whether a guarded check's own assertions are any good. That is the
//    check's own tests' business; this only establishes that it RUNS.
// ---------------------------------------------------------------------------
