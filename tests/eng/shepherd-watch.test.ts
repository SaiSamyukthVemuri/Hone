import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { WATCH_DEFAULTS, WATCH_LIMITS, describeWatchEnd, stillPending, watchExitCode, watchPr } from "../../scripts/eng/watch.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { EXIT_CODE, STATE, interpret } from "../../scripts/eng/shepherd.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { collectShepherdFacts } from "../../scripts/eng/github-facts.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { parseShepherdArgs } from "../../scripts/eng/cli.mjs";
import { NOW, REPO, fetcherFor, readyWorld, type Json } from "./helpers/github-world";

// ===========================================================================
// ENG-LOOP-01: the bounded watch, and the command line around it.
// ===========================================================================
//
// CLAUDE.md §4 as behaviour: report when the state SETTLES, end a superseded
// head's watcher, and never run unbounded. Two things are worth waiting for -
// CI, and the trusted exact-head review - and the shepherd deliberately cannot
// see whether that review was asked for, so a recommendation to request it
// keeps the watch looking. The clock and the sleep are injected, so an
// hour-long watch runs here in microseconds.

const MIN = 60_000;
const CANDIDATE = STATE.CANDIDATE_READY_FOR_HUMAN_REVIEW;
const ASK = [{ code: "REQUEST_EXACT_HEAD_REVIEW", text: "" }];

function fakeClock() {
  let t = NOW;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

/** The parts of a shepherd result the watch reads. */
const result = (
  state: string,
  { head = "h1", running = ["lane"], unavailable = [] as unknown[], snapshot = "CONSISTENT", actions = [] as Json[] } = {},
): Json => ({
  state,
  head,
  exitCode: EXIT_CODE[state],
  unavailable,
  actions,
  signals: { snapshot },
  detail: { ci: { run: null, running, queued: [], failed: [], cancelled: [] }, headAfter: head },
});

/** An observe() that plays a script and then repeats its last step. */
function script(...steps: Array<Json | Error>) {
  let i = 0;
  return () => {
    const step = steps[Math.min(i++, steps.length - 1)];
    if (step instanceof Error) throw step;
    return step;
  };
}

describe("the watch ends when nothing is pending any more, and reports only changes", () => {
  it("settles on the first state that needs the caller", async () => {
    const seen: string[] = [];
    const ended = await watchPr({
      ...fakeClock(),
      observe: script(
        result("WAITING", { running: ["a", "b"] }),
        result("WAITING", { running: ["a", "b"] }),
        result("WAITING", { running: ["a"] }),
        result("ACTION_RECOMMENDED", { running: [], actions: [{ code: "FIX_CI", text: "" }] }),
      ),
      onChange: (r: Json) => seen.push(r.state),
    });
    expect(ended.watch.terminatedBy).toBe("SETTLED");
    expect(ended.result.state).toBe("ACTION_RECOMMENDED");
    expect(ended.watch.polls).toBe(4);
    // Poll two changed nothing, so it reported nothing.
    expect(seen).toEqual(["WAITING", "WAITING", "ACTION_RECOMMENDED"]);
  });

  it("a candidate settles on the first read", async () => {
    const ended = await watchPr({ ...fakeClock(), observe: script(result(CANDIDATE, { running: [] })) });
    expect(ended.watch).toMatchObject({ terminatedBy: "SETTLED", polls: 1, elapsedMs: 0 });
    expect(watchExitCode(ended)).toBe(EXIT_CODE[CANDIDATE]);
  });

  it("a recommendation to request the exact-head review keeps the watch looking until the verdict lands", async () => {
    const ended = await watchPr({
      ...fakeClock(),
      observe: script(
        result("ACTION_RECOMMENDED", { actions: ASK }),
        result("ACTION_RECOMMENDED", { actions: ASK, running: [] }),
        result(CANDIDATE, { running: [] }),
      ),
    });
    expect(ended.watch).toMatchObject({ terminatedBy: "SETTLED", polls: 3 });
    expect(ended.result.state).toBe(CANDIDATE);
  });

  it("any other recommendation - even alongside the review request - settles at once", async () => {
    expect(stillPending(result("ACTION_RECOMMENDED", { actions: [...ASK, { code: "RERUN_CI", text: "" }] }))).toBe(false);
    expect(stillPending(result("ACTION_RECOMMENDED", { actions: [] }))).toBe(false);
    for (const state of [CANDIDATE, "BLOCKED", "ESCALATE", "CLOSED"]) expect(stillPending(result(state, { actions: ASK }))).toBe(false);
    expect(stillPending(result("WAITING"))).toBe(true);
    expect(stillPending(result("ACTION_RECOMMENDED", { actions: ASK }))).toBe(true);
  });
});

describe("a superseded head's watcher terminates", () => {
  it("ends when the head moves (HEAD_CHANGED), naming both heads", async () => {
    const ended = await watchPr({ ...fakeClock(), observe: script(result("WAITING", { head: "h1" }), result("WAITING", { head: "h2" })) });
    expect(ended.watch).toMatchObject({ terminatedBy: "HEAD_CHANGED", polls: 2, startHead: "h1" });
    expect(describeWatchEnd(ended)).toMatch(/moved from h1 .*to h2.*Start a new watch for the new head, and cancel the superseded run/);
  });

  it("ends when a push lands in the middle of a read", async () => {
    const torn = { ...result("WAITING", { snapshot: "TORN" }), detail: { ...result("WAITING").detail, headAfter: "h9" } };
    const ended = await watchPr({ ...fakeClock(), observe: script(torn) });
    expect(ended.watch.terminatedBy).toBe("HEAD_CHANGED");
    expect(describeWatchEnd(ended)).toMatch(/to h9/);
  });
});

describe("every watch is bounded", () => {
  it("nothing changing ends it (NO_PROGRESS) - and that limit outlasts the slowest lane's hard timeout", async () => {
    // CLAUDE.md §4: the slowest lane's hard timeout is 18 minutes. A limit at
    // or under it would read a merely slow lane as a stuck one.
    expect(WATCH_DEFAULTS.noProgressMs).toBeGreaterThan(18 * MIN);
    const ended = await watchPr({ ...fakeClock(), observe: script(result("WAITING")) });
    expect(ended.watch.terminatedBy).toBe("NO_PROGRESS");
    expect(ended.watch.elapsedMs).toBe(WATCH_DEFAULTS.noProgressMs);
    expect(watchExitCode(ended)).toBe(EXIT_CODE.BLOCKED);
    expect(describeWatchEnd(ended)).toMatch(/nothing changed for 25 min/);
  });

  it("an exact-head review that never arrives ends the watch at NO_PROGRESS, not never", async () => {
    const ended = await watchPr({ ...fakeClock(), observe: script(result("ACTION_RECOMMENDED", { actions: ASK, running: [] })) });
    expect(ended.watch.terminatedBy).toBe("NO_PROGRESS");
  });

  it("progress that never settles stops at the time bound, never past it", async () => {
    let n = 0;
    const ended = await watchPr({
      ...fakeClock(),
      maxMs: 30 * MIN,
      observe: () => result("WAITING", { running: [`lane-${n++}`] }),
    });
    expect(ended.watch.terminatedBy).toBe("TIME_BOUND");
    expect(ended.watch.elapsedMs).toBe(30 * MIN);
    // Minutes 0..30: the poll AT the bound is allowed; the one after it is not.
    expect(ended.watch.polls).toBe(31);
    expect(watchExitCode(ended)).toBe(EXIT_CODE.WAITING);
  });

  it("a failed read is retried; a run of them ends the watch (READ_FAILURES)", async () => {
    const down = await watchPr({ ...fakeClock(), observe: script(new Error("gh: HTTP 502")) });
    expect(down.watch).toMatchObject({ terminatedBy: "READ_FAILURES", polls: WATCH_DEFAULTS.maxReadFailures, lastError: "gh: HTTP 502" });
    expect(down.result).toBeNull();
    expect(watchExitCode(down)).toBe(EXIT_CODE.BLOCKED);

    const partial = await watchPr({ ...fakeClock(), observe: script(result("BLOCKED", { unavailable: [{ surface: "threads" }] })) });
    expect(partial.watch.terminatedBy).toBe("READ_FAILURES");

    const recovers = await watchPr({
      ...fakeClock(),
      observe: script(new Error("x"), new Error("x"), result("WAITING"), new Error("x"), new Error("x"), result(CANDIDATE)),
    });
    expect(recovers.watch).toMatchObject({ terminatedBy: "SETTLED", polls: 6 });
  });

  it("whatever GitHub does, no watch outlives its bounds (200 seeded random histories)", async () => {
    let seed = 20261005;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
    for (let k = 0; k < 200; k++) {
      const maxMs = (1 + Math.floor(rand() * 90)) * MIN;
      const intervalMs = (30 + Math.floor(rand() * 570)) * 1000;
      const ended = await watchPr({
        ...fakeClock(),
        maxMs,
        intervalMs,
        observe: () => {
          const roll = rand();
          if (roll < 0.05) throw new Error("transient");
          if (roll < 0.08) return result("WAITING", { unavailable: [{ surface: "x" }] });
          if (roll < 0.1) return result(pick([CANDIDATE, "BLOCKED", "ESCALATE", "CLOSED"]));
          if (roll < 0.11) return result("WAITING", { head: "h2" });
          if (roll < 0.3) return result("ACTION_RECOMMENDED", { actions: ASK, running: [pick(["a", "b"])] });
          return result("WAITING", { running: [pick(["a", "b", "c"])] });
        },
      });
      expect(ended.watch.elapsedMs).toBeLessThanOrEqual(maxMs);
      expect(ended.watch.polls).toBeLessThanOrEqual(Math.floor(maxMs / intervalMs) + 1);
      expect(["SETTLED", "HEAD_CHANGED", "NO_PROGRESS", "READ_FAILURES", "TIME_BOUND"]).toContain(ended.watch.terminatedBy);
    }
  });
});

describe("a real watch, through the collector", () => {
  it("waits while the latest run is still going, says nothing while nothing changes, and settles on a candidate", async () => {
    const world = readyWorld();
    const latest = world.responses.workflowRuns[0].workflow_runs[0];
    const lastJob = world.responses.jobs[3003][0].jobs[2];
    let poll = 0;
    const seen: string[] = [];
    const ended = await watchPr({
      ...fakeClock(),
      observe: (now: number) => {
        poll += 1;
        const done = poll >= 3;
        Object.assign(latest, done ? { status: "completed", conclusion: "success" } : { status: "in_progress", conclusion: null });
        Object.assign(lastJob, done ? { status: "completed", conclusion: "success" } : { status: "in_progress", conclusion: null });
        return interpret(collectShepherdFacts({ pr: world.pr, fetcher: fetcherFor(world), repo: REPO }), { now });
      },
      onChange: (r: Json) => seen.push(r.state),
    });
    expect(seen).toEqual(["WAITING", CANDIDATE]);
    expect(ended.watch).toMatchObject({ terminatedBy: "SETTLED", polls: 3 });
  });
});

describe("the command line", () => {
  it("parses the documented forms", () => {
    expect(parseShepherdArgs(["793"])).toEqual({ pr: 793, json: false, watch: false, tier: null, intervalMs: 60_000, maxMs: 60 * MIN });
    expect(parseShepherdArgs(["793", "--json", "--watch", "--interval", "45", "--max-minutes", "30", "--tier", "T2"])).toEqual({
      pr: 793,
      json: true,
      watch: true,
      tier: "T2",
      intervalMs: 45_000,
      maxMs: 30 * MIN,
    });
  });

  it("refuses anything it does not understand, rather than ignoring it", () => {
    const [lo, hi] = WATCH_LIMITS.intervalSeconds;
    for (const argv of [
      [],
      ["abc"],
      ["0"],
      ["793", "794"],
      ["793", "--bogus"],
      ["793", "--tier"],
      ["793", "--tier", "t1"],
      ["793", "--tier", "T4"],
      ["793", "--watch", "--interval", String(lo - 1)],
      ["793", "--watch", "--interval", String(hi + 1)],
      ["793", "--watch", "--interval", "45.5"],
      ["793", "--watch", "--max-minutes", "0"],
      ["793", "--watch", "--max-minutes", "241"],
      ["793", "--interval", "45"],
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
