import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

/** Every test id Playwright would run for `specs`, optionally sharded. */
function listTests(specs: string[], shard?: string): string[] {
  const args = ["playwright", "test", ...specs, "--list", "--reporter=list"];
  if (shard) args.push(`--shard=${shard}`);
  const out = execFileSync("npx", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
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
    const matrix = CI_YML.match(/browser_shards=\$\{r\.extended \? "\[1,2,3,4\]" : "\[([\d,]+)\]"\}/);
    expect(matrix, "targeted shard matrix not found in ci.yml").not.toBeNull();
    const matrixCount = matrix![1].split(",").length;

    const divisor = CI_YML.match(/browser_specs \}\}\s+--shard=\$\{\{ matrix\.shard \}\}\/(\d+)/);
    expect(divisor, "targeted --shard divisor not found in ci.yml").not.toBeNull();

    expect(Number(divisor![1]), "divisor must equal the number of matrix shards").toBe(
      matrixCount,
    );
  });

  it("the extended lane still runs exactly four, untouched", () => {
    expect(CI_YML).toContain('`browser_shards=${r.extended ? "[1,2,3,4]" : "[1,2]"}`');
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

describe("the split covers the same specs, once and only once", () => {
  it(
    "union of the two shards equals the unsharded run, with no overlap",
    { timeout: 120_000 },
    () => {
      const specs = targetedSpecs();
      expect(specs.length, "the worst-case targeted selection").toBeGreaterThan(30);

      const all = listTests(specs);
      const one = listTests(specs, "1/2");
      const two = listTests(specs, "2/2");

      // NON-VACUITY. A selection that listed nothing would satisfy every set
      // identity below and mean the opposite of what they claim.
      expect(all.length, "the unsharded run found no tests").toBeGreaterThan(100);
      expect(one.length).toBeGreaterThan(0);
      expect(two.length).toBeGreaterThan(0);

      // EXHAUSTIVE: nothing dropped by the split.
      expect([...one, ...two].sort()).toEqual(all);

      // DISJOINT: nothing runs twice. Stated separately from the union because
      // a duplicated test and a dropped test can cancel out in a length check.
      const overlap = one.filter((t) => two.includes(t));
      expect(overlap, "tests present in BOTH shards").toEqual([]);

      // And the counts really do add up, which is the form a human checks.
      expect(one.length + two.length).toBe(all.length);
    },
  );
});
