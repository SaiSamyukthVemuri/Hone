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
// diagnostic or cleanup steps — those have deliberate retention/cleanup
// conditions and are not verification. See the limitations note
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
  with?: Record<string, unknown>;
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

/**
 * Does `success()` appear as a REQUIREMENT in this expression?
 *
 * Codex P2 4307482784. `success()` is FALSE once an earlier step in the job has
 * failed, so `${{ success() && !cancelled() }}` is skipped exactly as an absent
 * `if:` would be — while containing the token this file used to accept. Matching
 * `!cancelled()` as a substring was therefore adjacent to the property, not the
 * property: the suite would have stayed green while the failure-hiding it
 * exists to prevent was reintroduced verbatim.
 *
 * `!success()` is not a requirement of success, so the negative form is
 * excluded.
 */
function requiresSuccess(normalized: string): boolean {
  return /(?:^|[^!A-Za-z0-9_])success\(\)/.test(normalized);
}

/**
 * The bounded grammar used by these workflow guards: status atoms and step
 * outcome comparisons joined by &&. Unknown syntax (including OR, grouped
 * expressions and negated comparisons) fails closed, rather than treating a
 * mentioned status/prerequisite as mandatory. This is not a general Actions
 * expression evaluator. Quoted values are validated before normalization.
 */
function guardConjuncts(cond: string | undefined): string[] | null {
  if (!cond) return null;
  let expression = cond.trim();
  if (expression.startsWith("${{")) {
    if (!expression.endsWith("}}")) return null;
    expression = expression.slice(3, -2).trim();
  }
  const atoms: string[] = [];
  for (const raw of expression.split("&&")) {
    const atom = raw.trim();
    if (/^(?:!cancelled|always|!?success|!?failure)\(\)$/.test(atom)) {
      atoms.push(atom);
      continue;
    }
    const step = atom.match(
      /^steps\.([A-Za-z0-9_-]+)\.(outcome|conclusion)\s*==\s*(['"])(success|failure|cancelled|skipped)\3$/,
    );
    if (!step) return null;
    atoms.push(`steps.${step[1]}.${step[2]}=='${step[4]}'`);
  }
  return atoms;
}

/** Does this condition run after either success or failure of earlier steps? */
function survivesFailure(cond: string | undefined): boolean {
  const atoms = guardConjuncts(cond);
  if (!atoms?.some((a) => a === "!cancelled()" || a === "always()")) return false;
  // success()/!failure() hide failures; failure()/!success() hide clean runs.
  return !atoms.some((a) =>
    requiresSuccess(a) || ["!failure()", "failure()", "!success()"].includes(a),
  );
}

/**
 * Is `id`'s outcome required to be SUCCESS by this condition?
 *
 * Codex P2 4307482788. Asserting only that a condition MENTIONS the reset step
 * is satisfied by `steps.db_chain.outcome == 'failure'`, which would run the
 * drift check against a FAILED reset and skip it after a successful one — the
 * inversion of the production fix, with the fence still green. So the
 * comparison itself is read, not merely the step name.
 */
function requiresStepSuccess(cond: string | undefined, id: string): boolean {
  const atoms = guardConjuncts(cond) ?? [];
  const comparisons = atoms.filter((a) => a.startsWith(`steps.${id}.`));
  // Every comparison must require success. A success atom alongside failure,
  // cancelled or skipped (even on the other property) makes the guard dead.
  return comparisons.length > 0 && comparisons.every((a) =>
    a === `steps.${id}.outcome=='success'` || a === `steps.${id}.conclusion=='success'`,
  );
}

/** The step ids a condition reads, e.g. `steps.db_chain.outcome`. */
function referencedStepIds(cond: string | undefined): string[] {
  if (!cond) return [];
  return [...cond.matchAll(/steps\.([A-Za-z0-9_-]+)\./g)].map((m) => m[1]!);
}

/** A prerequisite must identify exactly one earlier step in this job. */
function isEarlierDeclaredStep(job: Job, guarded: Step, id: string): boolean {
  const steps = job.steps ?? [];
  const targets = steps.filter((s) => s.id === id);
  const guardedIndex = steps.indexOf(guarded);
  return targets.length === 1 && guardedIndex >= 0 &&
    steps.indexOf(targets[0]!) < guardedIndex;
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

/**
 * THE MIRROR: every TEST step that runs after a VERIFICATION step, with
 * whether it is guarded.
 *
 * The same defect in the other direction, and it costs more when it bites: a
 * red `check:fresh-managed` used to skip the ENTIRE DB/RLS suite, and a lint
 * failure used to skip the entire unit suite. One check's failure should not
 * cost every test result in the lane.
 */
function postVerificationTestSteps(body: string): Array<{
  job: string;
  step: string;
  guarded: boolean;
}> {
  const out: Array<{ job: string; step: string; guarded: boolean }> = [];
  for (const [id, job] of jobs(body)) {
    const steps = job.steps ?? [];
    const firstVerification = steps.findIndex(isVerificationStep);
    if (firstVerification < 0) continue;
    for (const s of steps.slice(firstVerification + 1)) {
      if (!isTestStep(s)) continue;
      out.push({
        job: id,
        step: s.name ?? "(unnamed)",
        guarded: survivesFailure(s.if),
      });
    }
  }
  return out;
}

/** Is this condition gated on some VERIFICATION step's success? */
function gatesOnAVerificationStep(job: Job, cond: string | undefined): boolean {
  const steps = job.steps ?? [];
  return referencedStepIds(cond).some((id) => {
    const target = steps.find((s) => s.id === id);
    return target ? isVerificationStep(target) : false;
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
  it("standalone checks require checkout and npm checks also require Node setup", () => {
    const steps = jobs(CI_BODY).find(([id]) => id === "validate")?.[1].steps ?? [];
    for (const [command, needsNode] of [
      ["git diff --check HEAD", false],
      ["npm run check:stripe-gates", true],
      ["npm run check:migration-extensions", true],
    ] as const) {
      const step = steps.find((s) => s.run === command);
      expect(step, command).toBeTruthy();
      const required = needsNode ? ["checkout", "node_setup"] : ["checkout"];
      expect(referencedStepIds(step?.if), command).toEqual(required);
      for (const id of required) {
        expect(requiresStepSuccess(step?.if, id), `${command}: ${id}`).toBe(true);
        const prerequisite = steps.find((s) => s.id === id);
        expect(prerequisite?.uses, id).toMatch(
          id === "checkout" ? /^actions\/checkout@/ : /^actions\/setup-node@/,
        );
        expect(steps.indexOf(prerequisite!)).toBeLessThan(steps.indexOf(step!));
      }
    }
  });

  it("CONTROL: failure-only status atoms must not hide checks on success", () => {
    for (const condition of [
      "${{ !cancelled() && failure() }}",
      "${{ always() && failure() }}",
      "${{ !cancelled() && !success() }}",
      "${{ always() && !success() }}",
    ]) {
      expect(survivesFailure(condition), condition).toBe(false);
    }
  });

  it("CONTROL: positive cancelled() is outside the routine-check grammar", () => {
    for (const condition of [
      "${{ always() && cancelled() }}",
      "${{ !cancelled() && cancelled() }}",
    ]) {
      expect(guardConjuncts(condition), condition).toBeNull();
      expect(survivesFailure(condition), condition).toBe(false);
    }
  });

  it("standalone verification checks do not depend on npm ci", () => {
    const steps = jobs(CI_BODY).find(([id]) => id === "validate")?.[1].steps ?? [];
    for (const command of [
      "git diff --check HEAD",
      "npm run check:stripe-gates",
      "npm run check:migration-extensions",
    ]) {
      const step = steps.find((s) => s.run === command);
      expect(step, `standalone check must exist: ${command}`).toBeTruthy();
      expect(survivesFailure(step?.if), command).toBe(true);
      expect(referencedStepIds(step?.if), `${command} needs no installed modules`).not.toContain("deps");
    }
  });

  it("dependency-needed tests retain their actual prerequisite gates", () => {
    for (const [jobId, command, prerequisite, prerequisiteCommand] of [
      ["validate", "npm test", "deps", "npm ci"],
      ["db-integration", "npm run test:db", "db_chain", "db reset --local"],
    ]) {
      const steps = jobs(CI_BODY).find(([id]) => id === jobId)?.[1].steps ?? [];
      const step = steps.find((s) => s.run === command);
      expect(step, `${jobId}: ${command} must exist`).toBeTruthy();
      expect(requiresStepSuccess(step?.if, prerequisite), command).toBe(true);
      expect(steps.find((s) => s.id === prerequisite)?.run).toContain(prerequisiteCommand);
    }
  });

  it("CONTROL: negating failure() hides a check after an earlier failure", () => {
    expect(survivesFailure("${{ !cancelled() && !failure() }}")).toBe(false);
    expect(survivesFailure("${{ always() && !failure() }}")).toBe(false);
  });

  it("CONTROL: prerequisite success cannot be an OR alternative", () => {
    for (const cond of [
      "${{ !cancelled() && (steps.db_chain.outcome == 'success' || failure()) }}",
      "${{ steps.db_chain.outcome == 'success' || always() }}",
      "${{ !cancelled() && !steps.db_chain.outcome == 'success' }}",
    ]) {
      expect(requiresStepSuccess(cond, "db_chain"), cond).toBe(false);
    }
    expect(requiresStepSuccess("${{ always() && steps.db_chain.outcome == 'success' }}", "db_chain")).toBe(true);
    expect(requiresStepSuccess('${{ !cancelled() && steps.db_chain.conclusion == "success" }}', "db_chain")).toBe(true);
    expect(requiresStepSuccess("${{ !cancelled() && steps.db_chain.outcome == 'suc cess' }}", "db_chain")).toBe(false);
  });

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
    // AND THE COMPARISON MUST REQUIRE SUCCESS (Codex P2 4307482788). Naming the
    // step is not enough: `outcome == 'failure'` names it too, and inverts the
    // fix while leaving this fence green.
    for (const id of ids) {
      expect(
        requiresStepSuccess(drift?.if, id),
        `steps.${id} must be required to have SUCCEEDED, not merely mentioned: ${drift?.if}`,
      ).toBe(true);
    }
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

  it("MIRROR: no TEST is hidden behind a verification's failure", () => {
    // `Fresh-managed extension proof` precedes the DB/RLS suite and `Lint`
    // precedes the unit suite. Unguarded, a red check there cost every test
    // result in that lane — a far bigger loss than the drift check this PR
    // started from.
    const found = postVerificationTestSteps(CI_BODY);
    expect(found.length, "the mirror sweep must find the test steps it polices").toBeGreaterThanOrEqual(2);
    expect(found.filter((s) => !s.guarded).map((s) => `${s.job}: ${s.step}`)).toEqual([]);
  });

  it("MIRROR: and no test is gated on a verification's success either", () => {
    // Gating the tests on the check that precedes them would satisfy the
    // sweep above while preserving the defect exactly.
    const offenders: string[] = [];
    for (const [id, job] of jobs(CI_BODY)) {
      const steps = job.steps ?? [];
      const firstVerification = steps.findIndex(isVerificationStep);
      if (firstVerification < 0) continue;
      for (const s of steps.slice(firstVerification + 1)) {
        if (!isTestStep(s)) continue;
        if (gatesOnAVerificationStep(job, s.if)) offenders.push(`${id}: ${s.name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("CONTROL: an unguarded test after a verification IS detected", () => {
    // The shape db-integration had before this change: a check, then the
    // suite, with no condition — so the check's failure skipped the suite.
    const synthetic = [
      "name: synthetic",
      "on: push",
      "jobs:",
      "  demo:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Some proof",
      "        run: npm run check:fresh-managed",
      "      - name: DB tests",
      "        run: npm run test:db",
      "",
    ].join("\n");
    expect(postVerificationTestSteps(synthetic)).toEqual([
      { job: "demo", step: "DB tests", guarded: false },
    ]);
  });

  it("CONTROL: a test gated on the preceding CHECK is caught as an offender", () => {
    // Distinct from the control above: this one DOES carry `!cancelled()`, so
    // it passes the guarded sweep and must still be rejected.
    const sneaky = [
      "name: synthetic",
      "on: push",
      "jobs:",
      "  demo:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Some proof",
      "        id: proof",
      "        run: npm run check:fresh-managed",
      "      - name: DB tests",
      "        if: ${{ !cancelled() && steps.proof.outcome == 'success' }}",
      "        run: npm run test:db",
      "",
    ].join("\n");
    const job = jobs(sneaky).find(([id]) => id === "demo")![1];
    const dbTests = (job.steps ?? []).find((s) => s.name === "DB tests");
    expect(survivesFailure(dbTests?.if), "it looks guarded...").toBe(true);
    expect(gatesOnAVerificationStep(job, dbTests?.if), "...but it is not").toBe(true);
  });

  it("CONTROL: prerequisite references resolve to one earlier declaration in their own job", () => {
    // Reuse the real workflow's declarations, preserving its mandatory deps gate.
    const job = jobs(CI_BODY).find(([id]) => id === "validate")![1];
    const steps = job.steps!;
    const unit = steps.find((s) => s.run === "npm test")!;
    expect(unit).toBeTruthy();
    expect(isEarlierDeclaredStep(job, unit, "deps")).toBe(true);
    expect(isEarlierDeclaredStep(job, unit, "dep")).toBe(false);
    // A valid ID in another job is still unknown in this one.
    expect(isEarlierDeclaredStep(job, unit, "db_chain")).toBe(false);
    const identifiedUnit = { ...unit, id: "unit" };
    const selfJob = { steps: steps.map((s) => s === unit ? identifiedUnit : s) };
    expect(isEarlierDeclaredStep(selfJob, identifiedUnit, "unit")).toBe(false);
    const deps = steps.find((s) => s.id === "deps")!;
    const reordered = { steps: [...steps.filter((s) => s !== deps), deps] };
    expect(isEarlierDeclaredStep(reordered, unit, "deps")).toBe(false);
    const duplicate = { steps: [...steps, { ...deps }] };
    expect(isEarlierDeclaredStep(duplicate, unit, "deps")).toBe(false);
  });

  it("CONTROL: a success atom cannot hide contradictory or non-success comparisons", () => {
    for (const property of ["outcome", "conclusion"]) {
      for (const state of ["failure", "cancelled", "skipped"]) {
        const cond = "${{ !cancelled() && steps.db_chain.outcome == 'success' && " +
          `steps.db_chain.${property} == '${state}' }}`;
        expect(requiresStepSuccess(cond, "db_chain"), cond).toBe(false);
      }
    }
    expect(requiresStepSuccess("${{ !cancelled() && steps.db_chain.outcome == 'success' && steps.db_chain.conclusion == 'success' }}", "db_chain")).toBe(true);
  });

  it("EVERY gated step requires its prerequisite to have SUCCEEDED", () => {
    // The general form of 4307482788, so the drift check is not the only step
    // protected from an inverted comparison.
    const offenders: string[] = [];
    for (const [jobId, job] of jobs(CI_BODY)) {
      const steps = job.steps ?? [];
      const firstTest = steps.findIndex(isTestStep);
      for (const s of steps) {
        const isPostTestCheck =
          firstTest >= 0 && steps.indexOf(s) > firstTest && isVerificationStep(s);
        const isGatedTest = isTestStep(s) && s.if;
        if (!isPostTestCheck && !isGatedTest) continue;
        for (const id of referencedStepIds(s.if)) {
          if (!isEarlierDeclaredStep(job, s, id) || !requiresStepSuccess(s.if, id)) {
            offenders.push(`${jobId}: ${s.name} -> steps.${id}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("CONTROL: `success() && !cancelled()` is NOT guarded", () => {
    // Codex P2 4307482784. GitHub skips this exactly as an absent `if:` does,
    // because `success()` is false after an earlier failure — yet it contains
    // the token the old predicate matched on.
    expect(survivesFailure("${{ success() && !cancelled() }}")).toBe(false);
    expect(survivesFailure("${{ !cancelled() && success() }}")).toBe(false);
    // The forms that really do survive:
    expect(survivesFailure("${{ !cancelled() }}")).toBe(true);
    expect(survivesFailure("${{ always() }}")).toBe(true);
    expect(survivesFailure("${{ !cancelled() && steps.db_chain.outcome == 'success' }}")).toBe(true);
    // ...and `steps.<id>.outcome == 'success'` must NOT be mistaken for the
    // `success()` function, or every prerequisite gate would read as unguarded.
    expect(requiresSuccess("!cancelled()&&steps.db_chain.outcome=='success'")).toBe(false);
    expect(requiresSuccess("success()&&!cancelled()")).toBe(true);
  });

  it("CONTROL: an INVERTED prerequisite is rejected", () => {
    // Codex P2 4307482788: this names the reset step, so a mention-only check
    // passes it, while the drift check would run after a FAILED reset and skip
    // after a successful one.
    const inverted = "${{ !cancelled() && steps.db_chain.outcome == 'failure' }}";
    expect(survivesFailure(inverted), "it does survive a test failure...").toBe(true);
    expect(referencedStepIds(inverted), "...and it does name the step...").toEqual(["db_chain"]);
    expect(requiresStepSuccess(inverted, "db_chain"), "...but it is still rejected").toBe(false);
    // The real form passes.
    expect(
      requiresStepSuccess("${{ !cancelled() && steps.db_chain.outcome == 'success' }}", "db_chain"),
    ).toBe(true);
  });

  it("only the browser matrix retains retry diagnostics after a completed successful job", () => {
    // A failed attempt followed by a passing retry still has useful traces.
    // This exact matrix upload is the sole retention exception; other uploads
    // remain failure-only, and diagnostic/cleanup steps retain always().
    const conds: string[] = [];
    let matrixUploads = 0;
    let diagnostics = 0;
    let cleanups = 0;
    for (const [jobId, job] of jobs(CI_BODY)) {
      for (const s of job.steps ?? []) {
        const n = (s.name ?? "").toLowerCase();
        if (n.includes("upload")) {
          expect(typeof s.if, `${jobId}: ${s.name} needs an explicit retention condition`).toBe("string");
          if (jobId === "browser-e2e-shard" && s.with?.name === "playwright-traces-shard-${{ matrix.shard }}") {
            matrixUploads++;
            expect(s.if).toBe("${{ !cancelled() }}");
            expect(survivesFailure(s.if)).toBe(true);
            expect(s.uses).toBe("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
            expect(s.with).toEqual({ name: "playwright-traces-shard-${{ matrix.shard }}", path: "test-results/", "retention-days": 7 });
          } else {
            conds.push(s.if!.replace(/\s+/g, ""));
          }
        }
        if (n === "timing diagnostics" || n.startsWith("clean run-scoped fake ledger")) {
          expect(s.if, `${jobId}: ${s.name}`).toBe("always()");
          if (n === "timing diagnostics") diagnostics++;
          else cleanups++;
        }
      }
    }
    expect(matrixUploads).toBe(1);
    expect(conds.length).toBeGreaterThan(0);
    for (const c of conds) expect(c).toContain("failure()");
    expect(diagnostics).toBeGreaterThan(0);
    expect(cleanups).toBeGreaterThanOrEqual(3);
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
