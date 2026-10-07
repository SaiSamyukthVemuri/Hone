import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { parseShepherdArgs } from "../../scripts/eng/cli.mjs";

// ===========================================================================
// ENG-LOOP-01: the one-shot command line.
// ===========================================================================
//
// `npm run eng -- shepherd <pr> [--json] [--tier T0|T1|T2|T3]` reads once and
// answers once. Watch mode is not part of ENG-LOOP-01 (decision record §8; it
// is ENG-LOOP-02), so its flags are refused rather than silently ignored - a
// caller relying on a watch must not get a single read that looks like one.

describe("the command line", () => {
  it("parses the documented forms", () => {
    expect(parseShepherdArgs(["793"])).toEqual({ pr: 793, json: false, tier: null });
    expect(parseShepherdArgs(["793", "--json", "--tier", "T2"])).toEqual({ pr: 793, json: true, tier: "T2" });
  });

  it("refuses anything it does not understand, rather than ignoring it", () => {
    for (const argv of [
      [],
      ["abc"],
      ["0"],
      ["793", "794"],
      ["793", "--bogus"],
      ["793", "--tier"],
      ["793", "--tier", "t1"],
      ["793", "--tier", "T4"],
      // Watch mode is not part of ENG-LOOP-01: its flags are refused, never ignored.
      ["793", "--watch"],
      ["793", "--interval", "45"],
      ["793", "--max-minutes", "30"],
      ["793", "--watch", "--interval", "45", "--max-minutes", "30"],
    ]) {
      expect(parseShepherdArgs(argv).error, JSON.stringify(argv)).toBeTruthy();
    }
  });

  it("an argument error exits 2 before anything is read, and `status` keeps its old exits", () => {
    const cli = path.resolve(__dirname, "../../scripts/eng/cli.mjs");
    const shepherd = spawnSync(process.execPath, [cli, "shepherd"], { encoding: "utf8" });
    expect(shepherd.status).toBe(2);
    expect(shepherd.stderr).toMatch(/a pull request number is required/);
    expect(shepherd.stdout).toMatch(/npm run eng -- shepherd <pr>/);
    expect(shepherd.stdout).toMatch(/Every state is advisory/);
    expect(spawnSync(process.execPath, [cli], { encoding: "utf8" }).status).toBe(0);
    expect(spawnSync(process.execPath, [cli, "statuz", "1"], { encoding: "utf8" }).status).toBe(2);
  });
});
