import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// ===========================================================================
// THE TARGETED BROWSER LANE IS SPLIT, AND THE SPLIT LOSES NOTHING
// ===========================================================================
//
// WHAT THIS EXISTS TO PREVENT. Re-sharding a lane to fit a time budget is a
// change that can silently REDUCE coverage: drop a shard from the matrix, get
// the divisor wrong, or shard a spec list that was assembled differently from
// the one the runner receives, and CI gets faster because it is testing less.
// The failure is invisible — every check goes green, and the tests that stopped
// running stop reporting.
//
// So this does not assert that sharding "works". It runs the real Playwright
// selection for the real worst-case targeted spec set and compares TEST
// IDENTITIES: the union of the shards must equal the unsharded run exactly, and
// the shards must not overlap.
//
// WHY THE WORST CASE IS THE RIGHT CASE. `booking` + `owner_admin` + `smoke` is
// the selection that breached the budget — 36 specs, 213 tests. Any smaller
// selection is a subset of the same mechanism.
//
// COST: three `--list` invocations, no browser launched, no webServer started.

const ROOT = path.resolve(__dirname, "../..");

/** The spec set the workflow would select for the diff that breached the cap. */
function targetedSpecs(): string[] {
  const out = execFileSync(
    "node",
    [
      "-e",
      `import("./scripts/browser-groups.mjs").then((m) => {
         const r = m.selectBrowserGroups(["lib/booking/waitlist-invitation.ts","components/waitlist/invite-composer.tsx"]);
         process.stdout.write(m.specsForGroups(r.groups).map((s) => "e2e/" + s).join("\\n"));
       });`,
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  return out.split("\n").filter(Boolean);
}

/**
 * A environment Playwright's config will agree to load.
 *
 * `playwright.config.ts` imports `e2e/helpers/local-env.ts`, which calls
 * `refuseHostedOverrides()` AT MODULE SCOPE and throws if any Supabase URL in
 * the environment looks hosted — or merely fails to look local. That guard is
 * right and is not being weakened here: this test only ever asks Playwright to
 * LIST tests, and it must not be able to reach a real database to do it.
 *
 * IT IS ALSO THE REASON THIS TEST FAILED IN CI AND PASSED LOCALLY. The `validate`
 * job sets `NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co"` at job
 * level (ci.yml), `npm test` inherits it, and the guard refused. A dev shell has
 * no such variable, so the failure was invisible until CI ran it.
 */
function localOnlyEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of [
    "SUPABASE_DB_URL",
    "HONE_LOCAL_DB_URL",
    "E2E_SUPABASE_URL",
    "STRIPE_SECRET_KEY",
    "STRIPE_ALLOW_LIVE_MODE",
  ]) {
    delete env[name];
  }
  env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
  return env;
}

/** Every test id Playwright would run for `specs`, optionally sharded. */
function listTests(specs: string[], shard?: string): string[] {
  const args = ["playwright", "test", ...specs, "--list", "--reporter=list"];
  if (shard) args.push(`--shard=${shard}`);
  const out = execFileSync("npx", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: localOnlyEnv(),
  });
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("[") && l.includes("›"))
    .sort();
}

const CI_YML = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");

describe("the targeted browser lane's shard count is stated consistently", () => {
  // The matrix and the divisor are two statements of one number, three hundred
  // lines apart. The extended lane already carries that risk with its `4`; this
  // pins BOTH lanes rather than adding a second unpinned pair.
  it("the targeted matrix and the --shard divisor agree", () => {
    const matrix = CI_YML.match(/browser_shards=\$\{extended \? "\[1,2,3,4\]" : "\[([\d,]+)\]"\}/);
    expect(matrix, "targeted shard matrix not found in ci.yml").not.toBeNull();
    const matrixCount = matrix![1].split(",").length;

    const divisor = CI_YML.match(/browser_specs \}\}\s+--shard=\$\{\{ matrix\.shard \}\}\/(\d+)/);
    expect(divisor, "targeted --shard divisor not found in ci.yml").not.toBeNull();

    expect(Number(divisor![1]), "divisor must equal the number of matrix shards").toBe(
      matrixCount,
    );
  });

  it("the extended lane still runs exactly four, untouched", () => {
    expect(CI_YML).toContain('`browser_shards=${extended ? "[1,2,3,4]" : "[1,2,3]"}`');
    expect(CI_YML).toMatch(/--shard=\$\{\{ matrix\.shard \}\}\/4/);
  });

  it("NEITHER timeout budget moved", () => {
    // The repair was to split the work, not to buy every PR more time. If this
    // line changes, the fix stopped being capacity engineering.
    expect(CI_YML).toContain(
      "timeout-minutes: ${{ needs.changes.outputs.browser_extended == 'true' && 18 || 15 }}",
    );
  });
});

describe("the step that emits the matrix actually RUNS", () => {
  // THIS TEST EXISTS BECAUSE EVERY OTHER ASSERTION ABOUT ci.yml IS A REGEX.
  //
  // Text matching proves the file SAYS the right thing. It cannot prove the
  // file WORKS, and the gap between those is not academic: the step below is a
  // `node -e '…'` inside a SINGLE-QUOTED shell string, so one apostrophe in a
  // comment ends the quote and the script dies with `SyntaxError: Unexpected
  // end of input`. That happened — a comment containing "lane's" was added in
  // this very change, every text assertion stayed green, and CI failed at the
  // first job with browser coverage unprovable and the required check failing
  // closed behind it.
  //
  // So this extracts the step's real `run:` body and executes it through bash,
  // with the same quoting the runner uses. A shell-quoting break now fails here
  // rather than on a runner ten minutes later.

  /** The literal shell body of a named step in the `changes` job. */
  function stepScript(name: string): string {
    const start = CI_YML.indexOf(`- name: ${name}`);
    expect(start, `step "${name}" not found in ci.yml`).toBeGreaterThan(-1);
    const body = CI_YML.slice(start);
    const runAt = body.indexOf("run: |");
    const after = body.slice(runAt + "run: |".length);
    // The block scalar ends at the first line indented less than its contents.
    const lines = after.split("\n");
    const kept: string[] = [];
    for (const line of lines.slice(1)) {
      if (line.trim() !== "" && !line.startsWith(" ".repeat(10))) break;
      kept.push(line.startsWith(" ".repeat(10)) ? line.slice(10) : line);
    }
    return kept.join("\n");
  }

  it("a selection with NO groups is treated as EXTENDED, not as targeted", () => {
    // THE STATE, AND IT IS REACHABLE. This job is gated on
    // `browser_run || full_matrix_required`, so it can be reached with an EMPTY
    // selection — a diff touching only `vitest.config.ts` classifies as
    // full-matrix with no browser groups. An empty `browser_specs` makes the
    // command `npx playwright test --shard=N/M`, which runs THE WHOLE SUITE.
    //
    // Before this was fixed the whole suite ran under the TARGETED shard count
    // and the TARGETED 15 min ceiling, while the identical workload gets 4
    // shards and 18 min when it is named extended: fewer runners and less time
    // for strictly more work. Both shards would be cut at the cap and the
    // required check fails closed behind them.
    const script = stepScript("Select browser groups");
    const dir = mkdtempSync(path.join(tmpdir(), "hone-ci-step-"));
    const outFile = path.join(dir, "github_output");
    try {
      writeFileSync(outFile, "");
      symlinkSync(path.join(ROOT, "scripts"), path.join(dir, "scripts"));
      symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"));
      writeFileSync(path.join(dir, "changed.txt"), "vitest.config.ts\n");
      execFileSync("bash", ["-c", script], {
        cwd: dir,
        env: { ...localOnlyEnv(), GITHUB_OUTPUT: outFile },
        encoding: "utf8",
      });
      const emitted = readFileSync(outFile, "utf8");
      // Non-vacuity: this really is the empty-selection state.
      expect(emitted, "an empty selection means run everything").toMatch(
        /browser_specs=\s*$/m,
      );
      expect(emitted).toContain("browser_extended=true");
      expect(emitted).toContain("browser_shards=[1,2,3,4]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits a well-formed matrix for a targeted diff", () => {
    const script = stepScript("Select browser groups");
    expect(script).toContain("browser_shards=");

    // RUNS IN A TEMP DIRECTORY, NOT THE REPOSITORY.
    //
    // The step reads `changed.txt` from its working directory, and an earlier
    // revision supplied that by writing the file into the repo root and deleting
    // it in a `finally`. A `finally` does not run when the worker is SIGKILLed —
    // a CI job timeout, a cancel, an OOM — and vitest runs files in PARALLEL, so
    // for the duration of this test an untracked `changed.txt` sat in a working
    // tree other tests and tools can observe. It is not in `.gitignore` either.
    //
    // A temp cwd with `scripts/` and `node_modules/` symlinked in gives the
    // script everything it resolves relative to cwd and touches nothing shared.
    // Node resolves symlinks, so `browser-groups.mjs` still loads its own
    // imports from the real `scripts/` directory.
    const dir = mkdtempSync(path.join(tmpdir(), "hone-ci-step-"));
    const outFile = path.join(dir, "github_output");

    try {
      writeFileSync(outFile, "");
      symlinkSync(path.join(ROOT, "scripts"), path.join(dir, "scripts"));
      symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"));
      writeFileSync(
        path.join(dir, "changed.txt"),
        "lib/booking/waitlist-invitation.ts\ncomponents/waitlist/invite-composer.tsx\n",
      );
      // Runs, or throws with the shell's own diagnostic.
      execFileSync("bash", ["-c", script], {
        cwd: dir,
        env: { ...localOnlyEnv(), GITHUB_OUTPUT: outFile },
        encoding: "utf8",
      });

      const emitted = readFileSync(outFile, "utf8");
      expect(emitted, "browser_run").toContain("browser_run=true");
      expect(emitted, "targeted, not extended").toContain("browser_extended=false");
      // THE MATRIX THIS CHANGE IS ABOUT, read from what the step actually
      // produced rather than from what the file says it would produce.
      expect(emitted).toContain("browser_shards=[1,2,3]");
      expect(emitted).toMatch(/browser_specs=e2e\/\S+/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the split covers the same specs, once and only once", () => {
  it(
    "union of the shards equals the unsharded run, with no overlap",
    { timeout: 120_000 },
    () => {
      const specs = targetedSpecs();
      expect(specs.length, "the worst-case targeted selection").toBeGreaterThan(30);

      const all = listTests(specs);
      const shards = ["1/3", "2/3", "3/3"].map((s) => listTests(specs, s));

      // NON-VACUITY. A selection that listed nothing would satisfy every set
      // identity below and mean the opposite of what they claim.
      expect(all.length, "the unsharded run found no tests").toBeGreaterThan(100);
      for (const [i, sh] of shards.entries()) {
        expect(sh.length, `shard ${i + 1} is empty`).toBeGreaterThan(0);
      }

      // EXHAUSTIVE: nothing dropped by the split.
      expect(shards.flat().sort()).toEqual(all);

      // DISJOINT: nothing runs twice. Stated separately from the union because
      // a duplicated test and a dropped test cancel out in a length check.
      for (let i = 0; i < shards.length; i += 1) {
        for (let j = i + 1; j < shards.length; j += 1) {
          const overlap = shards[i].filter((t) => shards[j].includes(t));
          expect(overlap, `tests in BOTH shard ${i + 1} and shard ${j + 1}`).toEqual([]);
        }
      }

      // And the counts really do add up, which is the form a human checks.
      expect(shards.reduce((n, sh) => n + sh.length, 0)).toBe(all.length);
    },
  );
});
