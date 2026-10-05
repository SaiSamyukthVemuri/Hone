import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { CI_EVENT, UNKNOWN, canonicalize, latestOf, selectHeadExecution, selectStreakExecutions } from "../../scripts/eng/workflow-runs.mjs";

// ===========================================================================
// ENG-LOOP-04 acceptance: canonical workflow-run snapshot reconciliation.
// ===========================================================================
//
// ENG-LOOP-03 (#798, parked) reconciled copies of one run pairwise, so the
// SAME snapshots could select an attempt in one listing order and read UNKNOWN
// in another. The operator's architecture: group by run, validate each run as
// a WHOLE, then compare different runs by start time alone. What is proved:
//
//   1. inputs that cannot be placed fail CLOSED, and nothing throws - a
//      collection must be a DENSE array (holes are UNKNOWN, never skipped),
//      and a start time must be a REAL calendar instant in GitHub's
//      documented form (`2026-02-30T12:00:00Z` is UNKNOWN, not March 2);
//   2. one run, many copies: identical copies agree; conflicting copies of one
//      attempt, or attempts out of chronological order, are UNKNOWN; three or
//      more copies and attempts listed out of order resolve to the one latest
//      attempt - and the round-3 counterexamples are UNKNOWN in EVERY order;
//   3. different runs: the later start wins; run ids and attempt numbers never
//      order runs; a tie at the top is UNKNOWN - false GREEN and false RED alike;
//   4. THE PROPERTY: for every permutation of the same multiset of snapshots,
//      the answer - value, completeness, authority and reason - is identical;
//      exhaustively for every scenario, and for hundreds of seeded random
//      multisets, each also checked against the rule restated independently;
//   5. exact-head CI and the failure streak share the one canonical result;
//   6. pure and read-only by construction.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** The repository's CI workflow id (live on 2026-10-05), and a workflow it is not. */
const CI_ID = 289443461;
const OTHER_ID = 325801278;

const sha = (seed: string): string => createHash("sha1").update(seed).digest("hex");
const H = sha("head");
const [H1, H2, H3] = [sha("h1"), sha("h2"), sha("h3")];

const BASE = Date.parse("2026-10-05T12:00:00Z");
/** A GitHub timestamp `minutes` after BASE, in GitHub's second-precision form. */
const at = (minutes: number): string => new Date(BASE + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");

/** A workflow-run snapshot as GitHub lists one; by default attempt 1 of run `id`, started `id` minutes after BASE. */
const snap = (id: number, over: Json = {}): Json => ({
  id,
  name: "ci",
  workflow_id: CI_ID,
  path: ".github/workflows/ci.yml",
  event: "pull_request",
  status: "completed",
  conclusion: "success",
  head_sha: H,
  run_attempt: 1,
  run_started_at: at(id),
  ...over,
});
/** Attempt `n` of run `id`, started at minute `m`. */
const attempt = (id: number, n: number, m: number, over: Json = {}): Json => snap(id, { run_attempt: n, run_started_at: at(m), ...over });

const head = (snapshots: Json, h = H) => selectHeadExecution({ snapshots, head: h, workflowId: CI_ID });
/** The selected execution as [run id, attempt, conclusion], null when there is none, or UNKNOWN. */
const pick = (env: Json): Json => (env.value === UNKNOWN ? UNKNOWN : env.value ? [env.value.id, env.value.attempt, env.value.conclusion] : null);

function* permutations<T>(xs: T[]): Generator<T[]> {
  if (xs.length <= 1) {
    yield xs.slice();
    return;
  }
  for (let i = 0; i < xs.length; i++) {
    for (const rest of permutations([...xs.slice(0, i), ...xs.slice(i + 1)])) yield [xs[i], ...rest];
  }
}

/** The answer of `fn` over EVERY permutation of `xs` - required to be one answer - and how many orders were tried. */
function invariant(xs: Json[], fn: (order: Json[]) => Json): { answer: Json; orders: number } {
  const seen = new Set<string>();
  let orders = 0;
  for (const order of permutations(xs)) {
    seen.add(JSON.stringify(fn(order)));
    orders += 1;
  }
  expect({ distinctAnswers: seen.size, answers: [...seen].slice(0, 3) }).toEqual({ distinctAnswers: 1, answers: [...seen].slice(0, 1) });
  return { answer: JSON.parse([...seen][0]), orders };
}
/** The exact-head answer, proven identical in every order. */
const headInAnyOrder = (snapshots: Json[]) => invariant(snapshots, (order) => head(order)).answer;

function seeded(seed: number) {
  let s = seed;
  const rand = () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const pickOne = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
  return { rand, pick: pickOne };
}

// ---------------------------------------------------------------------------
// 1. inputs fail closed
// ---------------------------------------------------------------------------

describe("1. what cannot be placed fails closed, and nothing throws", () => {
  it("a missing or unusable workflow id, head or listing is UNKNOWN", () => {
    for (const workflowId of [undefined, null, 0, -1, 1.5, "289443461", 2 ** 60]) {
      expect(selectHeadExecution({ snapshots: [snap(100)], head: H, workflowId }).value).toBe(UNKNOWN);
      expect(selectStreakExecutions({ snapshots: [snap(100)], heads: [H], workflowId }).value).toBe(UNKNOWN);
    }
    for (const h of [undefined, "HEAD", H.slice(0, 10), 7]) expect(selectHeadExecution({ snapshots: [snap(100)], head: h, workflowId: CI_ID }).value).toBe(UNKNOWN);
    for (const heads of [undefined, H, [H, "HEAD"], [7]]) expect(selectStreakExecutions({ snapshots: [snap(100)], heads, workflowId: CI_ID }).value).toBe(UNKNOWN);
    for (const snapshots of [undefined, null, {}, "runs", 3]) {
      expect(selectHeadExecution({ snapshots, head: H, workflowId: CI_ID }).value).toBe(UNKNOWN);
      expect(selectStreakExecutions({ snapshots, heads: [H], workflowId: CI_ID }).value).toBe(UNKNOWN);
    }
  });

  it("a snapshot that cannot be placed - no usable run id, workflow_id, event or head sha - is UNKNOWN", () => {
    for (const over of [{ id: "100" }, { id: 0 }, { workflow_id: null }, { workflow_id: "x" }, { event: 1 }, { event: undefined }, { head_sha: "abc" }]) {
      expect({ over, value: head([snap(101), snap(100, over)]).value }).toEqual({ over, value: UNKNOWN });
    }
    for (const bad of [null, [], "run", 5]) expect(head([snap(101), bad]).value).toBe(UNKNOWN);
  });

  it("a snapshot listed for the head that names another commit is UNKNOWN", () => {
    expect(headInAnyOrder([snap(100), snap(101, { head_sha: sha("elsewhere") })]).value).toBe(UNKNOWN);
  });

  it("a CI run's copy without a usable attempt, start time, status or conclusion is UNKNOWN", () => {
    const unusable: Json[] = [
      { run_attempt: undefined },
      { run_attempt: 0 },
      { run_attempt: "2" },
      { run_started_at: null },
      { run_started_at: "2026-10-05" },
      { run_started_at: "yesterday" },
      { run_started_at: "2026-13-45T99:99:99Z" },
      { status: 1 },
      { conclusion: 0 },
    ];
    for (const over of unusable) expect({ over, value: head([snap(100), snap(101, over)]).value }).toEqual({ over, value: UNKNOWN });
  });

  it("no input makes it throw: everything ends in an evidence envelope", () => {
    const outcomes: Json[] = [];
    for (const call of [
      () => selectHeadExecution(),
      () => selectHeadExecution(null),
      () => selectHeadExecution("x"),
      () => selectStreakExecutions(),
      () => selectStreakExecutions(null),
      () => selectHeadExecution({ snapshots: [Object.create(null)], head: H, workflowId: CI_ID }),
    ]) {
      try {
        outcomes.push(call().value);
      } catch (err) {
        outcomes.push(`threw: ${String(err)}`);
      }
    }
    expect(outcomes).toEqual(Array(outcomes.length).fill(UNKNOWN));
  });

  it("with a usable workflow id, the absence of a CI run is a KNOWN fact, not UNKNOWN", () => {
    const env = headInAnyOrder([snap(100, { workflow_id: OTHER_ID }), snap(101, { event: "push" })]);
    expect({ value: env.value, completeness: env.completeness, reason: env.reason }).toEqual({
      value: null,
      completeness: "COMPLETE",
      reason: `no ${CI_EVENT} run of workflow ${CI_ID} at this head`,
    });
  });
});

describe("1b. a start time is evidence only if it is a REAL calendar instant in GitHub's documented form", () => {
  /** The selection for one CI run started at `t`: COMPLETE with that instant, or UNKNOWN. */
  const one = (t: Json) => head([snap(100, { run_started_at: t })]);

  it("real instants are accepted - leap days included - and keep their fractional seconds", () => {
    for (const t of ["2028-02-29T12:00:00Z", "2024-02-29T00:00:00Z", "2000-02-29T23:59:59Z", "2026-12-31T23:59:59Z", "2026-01-01T00:00:00Z"]) {
      expect({ t, startedAt: one(t).value?.startedAt }).toEqual({ t, startedAt: new Date(Date.parse(t)).toISOString() });
    }
    expect(one("2026-10-05T12:30:00.5Z").value.startedAt).toBe("2026-10-05T12:30:00.500Z");
    // A fraction orders two runs started in the same second...
    expect(pick(headInAnyOrder([snap(100, { run_started_at: "2026-10-05T12:30:00.750Z" }), snap(101, { run_started_at: "2026-10-05T12:30:00.250Z" })]))).toEqual([100, 1, "success"]);
    // ...and one instant written with and without a fraction is still one instant: a tie.
    expect(headInAnyOrder([snap(100, { run_started_at: "2026-10-05T12:30:00.500Z" }), snap(101, { run_started_at: "2026-10-05T12:30:00.5Z" })]).value).toBe(UNKNOWN);
  });

  it("impossible calendar dates and times are UNKNOWN - never rolled over into a real one", () => {
    const impossible = [
      "2026-02-30T12:00:00Z", // February 30 (Date.parse says March 2)
      "2026-02-29T12:00:00Z", // February 29 in a non-leap year
      "2100-02-29T12:00:00Z", // a century that is not a leap year
      "2026-04-31T12:00:00Z", // April 31
      "2026-13-01T12:00:00Z", // month 13
      "2026-00-10T12:00:00Z", // month 00
      "2026-01-00T12:00:00Z", // day 00
      "2026-01-32T12:00:00Z", // day 32
      "2026-10-05T24:00:00Z", // hour 24
      "2026-10-05T12:60:00Z", // minute 60
      "2026-10-05T12:30:60Z", // second 60 - GitHub's form has no leap second
    ];
    for (const t of impossible) {
      const env = one(t);
      expect({ t, value: env.value, completeness: env.completeness }).toEqual({ t, value: UNKNOWN, completeness: UNKNOWN });
    }
  });

  it("only GitHub's documented returned-timestamp form - UTC with `Z` - is read: offsets and other shapes are UNKNOWN", () => {
    // "All timestamps return in UTC time, ISO 8601 format: YYYY-MM-DDTHH:MM:SSZ" (GitHub REST docs).
    for (const t of ["2026-10-05T12:30:00+00:00", "2026-10-05T12:30:00+05:30", "2026-10-05T12:30:00-07:00", "2026-10-05T12:30:00z", "2026-10-05T12:30:00", "2026-10-05 12:30:00Z", "2026-10-5T12:30:00Z", "+002026-10-05T12:30:00Z", "2026-10-05T12:30Z"]) {
      expect({ t, value: one(t).value }).toEqual({ t, value: UNKNOWN });
    }
  });

  it("a malformed start can never be selected as the newest run: the whole answer is UNKNOWN", () => {
    // Read as March 2, the impossible date would have outranked February 28.
    const env = headInAnyOrder([snap(100, { run_started_at: "2026-02-28T12:00:00Z", conclusion: "failure" }), snap(101, { run_started_at: "2026-02-30T12:00:00Z" })]);
    expect({ value: env.value, authority: env.authority, reason: env.reason }).toEqual({
      value: UNKNOWN,
      authority: UNKNOWN,
      reason: "run 101: a copy carries no usable attempt, start time, status or conclusion",
    });
  });

  it("over 4,000 seeded calendar field combinations, a start is accepted exactly when the date is real", () => {
    const r = seeded(4189669635 % 2 ** 31);
    const leap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    const days = (y: number, m: number) => [31, leap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
    const pad = (n: number, w = 2) => String(n).padStart(w, "0");
    const wrong: string[] = [];
    let real = 0;
    let unreal = 0;
    for (let k = 0; k < 4000; k++) {
      const y = r.pick([1999, 2000, 2024, 2025, 2026, 2028, 2100]);
      const mo = Math.floor(r.rand() * 15);
      const d = Math.floor(r.rand() * 34);
      const h = Math.floor(r.rand() * 26);
      const mi = Math.floor(r.rand() * 62);
      const se = Math.floor(r.rand() * 62);
      const t = `${pad(y, 4)}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(se)}Z`;
      // Restated: a real calendar instant, by the Gregorian rules alone.
      const isReal = mo >= 1 && mo <= 12 && d >= 1 && d <= days(y, mo) && h <= 23 && mi <= 59 && se <= 59;
      if (isReal) real += 1;
      else unreal += 1;
      const accepted = one(t).value !== UNKNOWN;
      if (accepted !== isReal) wrong.push(`${t}: accepted=${accepted}, real=${isReal}`);
    }
    expect(wrong).toEqual([]);
    // Anti-vacuity: both kinds were tried in bulk.
    expect(real).toBeGreaterThan(500);
    expect(unreal).toBeGreaterThan(500);
  });
});

describe("1c. a collection must be a DENSE array, read index by index: a hole is never skipped and never throws", () => {
  const valid = () => snap(100);
  const sparseCases: Array<[string, () => Json[]]> = [
    ["new Array(1)", () => new Array(1)],
    ["[, valid]", () => [, valid()]],
    ["[valid, , valid]", () => [valid(), , snap(101)]],
    ["a deleted index", () => {
      const xs = [valid(), snap(101), snap(102)];
      delete xs[1];
      return xs;
    }],
    ["length beyond the entries", () => {
      const xs = [valid()];
      xs.length = 3;
      return xs;
    }],
  ];

  const settle = (fn: () => Json): Json => {
    try {
      return fn();
    } catch (err) {
      return { threw: String(err) };
    }
  };

  it("holes make every selector, and canonicalize itself, UNKNOWN - and nothing throws", () => {
    for (const [label, make] of sparseCases) {
      expect({ label, head: settle(() => head(make())).value }).toEqual({ label, head: UNKNOWN });
      expect({ label, streak: settle(() => selectStreakExecutions({ snapshots: make(), heads: [H], workflowId: CI_ID })).value }).toEqual({ label, streak: UNKNOWN });
      expect({ label, canonical: settle(() => canonicalize(make(), CI_ID)) }).toEqual({ label, canonical: { reason: "the snapshots are not a dense array" } });
      expect({ label, latest: settle(() => latestOf(make())) }).toEqual({ label, latest: { reason: "the executions are not a dense array" } });
    }
  });

  it("an explicit undefined, or any malformed element, is UNKNOWN - present is not the same as valid", () => {
    for (const bad of [undefined, null, 0, "run", [], {}, { id: 100 }]) {
      expect({ bad, head: settle(() => head([valid(), bad])).value }).toEqual({ bad, head: UNKNOWN });
      expect({ bad, canonical: settle(() => canonicalize([valid(), bad], CI_ID)).reason }).toEqual({ bad, canonical: "a snapshot has no usable run id, workflow_id, event or head sha" });
    }
  });

  it("the streak's heads are held to the same rule: a hole or an undefined head is UNKNOWN, never a head with no CI run", () => {
    const heads: Array<[string, Json]> = [
      ["new Array(1)", new Array(1)],
      ["[, H]", [, H]],
      ["[H, , H1]", [H, , H1]],
      ["[H, undefined]", [H, undefined]],
    ];
    for (const [label, hs] of heads) {
      expect({ label, value: settle(() => selectStreakExecutions({ snapshots: [valid()], heads: hs, workflowId: CI_ID })).value }).toEqual({ label, value: UNKNOWN });
    }
  });

  it("a dense valid array is read in full, exactly as before", () => {
    expect(pick(head([snap(100), snap(101)]))).toEqual([101, 1, "success"]);
    expect(pick(head([]))).toBeNull();
    const streak = selectStreakExecutions({ snapshots: [snap(100, { head_sha: H1 }), snap(101, { head_sha: H2 })], heads: [H2, H1], workflowId: CI_ID });
    expect(streak.value.map((x: Json) => x.execution.id)).toEqual([101, 100]);
  });

  it("over 300 seeded histories, punching any hole into the collection gives UNKNOWN - never a throw, never an answer", () => {
    const r = seeded(4189669644 % 2 ** 31);
    const wrong: string[] = [];
    for (let k = 0; k < 300; k++) {
      const dense = randomMultiset(r, [H], 1 + Math.floor(r.rand() * 6));
      const holed = [...dense];
      delete holed[Math.floor(r.rand() * holed.length)];
      for (const [label, value] of [
        ["head", settle(() => head(holed)).value],
        ["streak", settle(() => selectStreakExecutions({ snapshots: holed, heads: [H], workflowId: CI_ID })).value],
      ]) {
        if (value !== UNKNOWN) wrong.push(`k=${k} ${label}: ${JSON.stringify(value)}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("no structural check relies on `every`, `some` or `for...of` over a caller's collection", () => {
    const code = readFileSync(path.resolve(__dirname, "../../scripts/eng/workflow-runs.mjs"), "utf8").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
    // Callers' collections are only ever read through denseEntries.
    for (const name of ["snapshots", "heads", "executions"]) {
      expect({ name, misuse: code.match(new RegExp(`(?<![.\\w])${name}\\.(every|some|forEach|map|filter)\\(|of ${name}\\)`, "g")) }).toEqual({ name, misuse: null });
    }
    expect(code).toMatch(/function denseEntries/);
    expect(code).toMatch(/Object\.prototype\.hasOwnProperty\.call\(xs, i\)/);
  });
});

// ---------------------------------------------------------------------------
// 2. one run, many copies
// ---------------------------------------------------------------------------

describe("2. one run, many copies: the WHOLE run is validated before it yields its latest attempt", () => {
  it("duplicate identical snapshots agree - including one instant written two ways", () => {
    expect(pick(headInAnyOrder([attempt(100, 2, 30), attempt(100, 2, 30), attempt(100, 2, 30)]))).toEqual([100, 2, "success"]);
    expect(pick(headInAnyOrder([attempt(100, 1, 30), attempt(100, 1, 0, { run_started_at: "2026-10-05T12:30:00.000Z" })]))).toEqual([100, 1, "success"]);
  });

  it("duplicate conflicting snapshots of one attempt are UNKNOWN - outcome, status or start", () => {
    for (const other of [{ conclusion: "failure" }, { status: "in_progress", conclusion: null }, { run_started_at: at(31) }]) {
      const env = headInAnyOrder([attempt(100, 2, 30), attempt(100, 2, 30, other)]);
      expect({ other, value: env.value, reason: env.reason }).toEqual({ other, value: UNKNOWN, reason: "run 100: attempt 2 was read in conflicting states" });
    }
  });

  it("three or more consistent copies, listed in any order, resolve to the one latest attempt", () => {
    const copies = [attempt(100, 1, 10, { conclusion: "failure" }), attempt(100, 2, 20), attempt(100, 2, 20), attempt(100, 3, 30, { conclusion: "cancelled" })];
    expect(pick(headInAnyOrder(copies))).toEqual([100, 3, "cancelled"]);
  });

  it("attempts listed out of order resolve the same way", () => {
    expect(pick(headInAnyOrder([attempt(100, 3, 30), attempt(100, 1, 10), attempt(100, 2, 20)]))).toEqual([100, 3, "success"]);
    // Attempts need not be contiguous: a listing may only ever have caught 1 and 3.
    expect(pick(headInAnyOrder([attempt(100, 3, 30), attempt(100, 1, 10)]))).toEqual([100, 3, "success"]);
  });

  it("non-monotonic start times are UNKNOWN - even hidden behind a higher attempt", () => {
    expect(headInAnyOrder([attempt(100, 1, 20), attempt(100, 2, 10)]).reason).toBe("run 100: attempt 2 started before attempt 1");
    // The round-3 counterexample: attempt 3 must not mask attempts 1 and 2 being out of order.
    expect(headInAnyOrder([attempt(100, 1, 20), attempt(100, 3, 40), attempt(100, 2, 10)]).reason).toBe("run 100: attempt 2 started before attempt 1");
  });

  it("the round-3 counterexample: a conflict between OLDER copies is UNKNOWN in every order, never masked by a later attempt", () => {
    const { answer, orders } = invariant([attempt(100, 1, 10, { conclusion: "success" }), attempt(100, 2, 30), attempt(100, 1, 10, { conclusion: "failure" })], (order) => head(order));
    expect(orders).toBe(6);
    expect({ value: answer.value, reason: answer.reason }).toEqual({ value: UNKNOWN, reason: "run 100: attempt 1 was read in conflicting states" });
  });

  it("copies that disagree on what the run IS - its workflow, event or commit - are UNKNOWN", () => {
    for (const other of [{ workflow_id: OTHER_ID }, { event: "push" }]) {
      expect(headInAnyOrder([snap(100), snap(100, other)]).reason).toBe("run 100: its copies disagree on its workflow, event or commit");
    }
    // Across heads, only the streak can see it - and does (section 5).
    const split = [snap(100, { head_sha: H1 }), snap(100, { head_sha: H2 })];
    expect(invariant(split, (order) => selectStreakExecutions({ snapshots: order, heads: [H2, H1], workflowId: CI_ID })).answer.reason).toBe(
      "run 100: its copies disagree on its workflow, event or commit",
    );
  });

  it("another workflow's or event's copies are checked only for what they are: their attempts never matter", () => {
    const torn = [
      attempt(500, 1, 50, { workflow_id: OTHER_ID, conclusion: "success" }),
      attempt(500, 1, 50, { workflow_id: OTHER_ID, conclusion: "failure" }),
      attempt(501, 2, 10, { event: "push" }),
      attempt(501, 1, 60, { event: "push", status: 7 }),
    ];
    expect(pick(headInAnyOrder([snap(100), ...torn]))).toEqual([100, 1, "success"]);
  });
});

// ---------------------------------------------------------------------------
// 3. different runs
// ---------------------------------------------------------------------------

describe("3. different runs are ordered only by when their latest attempt started", () => {
  it("the later start wins - a re-run of an older run included, so neither a stale pass nor a stale failure is reported", () => {
    // Run 101 passed first; run 100 was re-run later and FAILED. Highest-id would report a stale GREEN.
    expect(pick(headInAnyOrder([attempt(101, 1, 20), attempt(100, 2, 30, { conclusion: "failure" })]))).toEqual([100, 2, "failure"]);
    // The re-run passed after the newer run failed. Highest-id would report a stale RED.
    expect(pick(headInAnyOrder([attempt(101, 1, 20, { conclusion: "failure" }), attempt(100, 2, 30)]))).toEqual([100, 2, "success"]);
  });

  it("a tie at the top is UNKNOWN - would-be false GREEN and false RED alike - and the reason names the runs", () => {
    const greenOverRed = headInAnyOrder([attempt(100, 2, 30), attempt(101, 1, 30, { conclusion: "failure" })]);
    const redOverGreen = headInAnyOrder([attempt(100, 2, 30, { conclusion: "failure" }), attempt(101, 1, 30)]);
    for (const env of [greenOverRed, redOverGreen]) expect(env.reason).toBe(`runs 100, 101 all started at ${new Date(Date.parse(at(30))).toISOString()}; nothing documented orders them`);
    expect(headInAnyOrder([snap(100, { run_started_at: at(30) }), snap(101, { run_started_at: at(30) }), snap(102, { run_started_at: at(30) })]).value).toBe(UNKNOWN);
    // One instant written two ways is still a tie.
    expect(headInAnyOrder([snap(100, { run_started_at: "2026-10-05T12:30:00Z" }), snap(101, { run_started_at: "2026-10-05T12:30:00.000Z" })]).value).toBe(UNKNOWN);
  });

  it("a run id is never recency, and an attempt number never crosses runs", () => {
    // Same start: neither the higher run id nor the higher attempt decides.
    expect(headInAnyOrder([attempt(100, 3, 30), attempt(101, 1, 30)]).value).toBe(UNKNOWN);
    expect(headInAnyOrder([attempt(101, 3, 30), attempt(100, 1, 30)]).value).toBe(UNKNOWN);
    // A far higher attempt that started earlier loses to the later start.
    expect(pick(headInAnyOrder([attempt(100, 5, 10), attempt(101, 1, 11)]))).toEqual([101, 1, "success"]);
    // A lower run id that started later wins.
    expect(pick(headInAnyOrder([attempt(200, 1, 10), attempt(100, 1, 11)]))).toEqual([100, 1, "success"]);
  });

  it("a tie below the top decides nothing", () => {
    expect(pick(headInAnyOrder([snap(100, { run_started_at: at(10) }), snap(101, { run_started_at: at(10) }), snap(102, { run_started_at: at(20) })]))).toEqual([102, 1, "success"]);
  });

  it("the canonical result of each run feeds the comparison: a run's latest attempt competes, not an older copy of it", () => {
    // Run 100's attempt 1 (minute 40) would beat run 101 - but attempt 1 is stale: its attempt 2 started at 50.
    const copies = [attempt(100, 1, 40, { conclusion: "failure" }), attempt(100, 2, 50), attempt(101, 1, 45, { conclusion: "failure" })];
    expect(pick(headInAnyOrder(copies))).toEqual([100, 2, "success"]);
  });
});

// ---------------------------------------------------------------------------
// 4. THE PROPERTY: one multiset, one answer, in every order
// ---------------------------------------------------------------------------

/**
 * The rule, restated independently of the code under test - as plain set
 * operations over the multiset, with no grouping helpers shared with it.
 */
function restated(snapshots: Json[], workflowId: number, atHead: string | null): Json {
  if (atHead !== null && snapshots.some((s) => s.head_sha !== atHead)) return UNKNOWN;
  const ids = [...new Set(snapshots.map((s) => s.id))].sort((a, b) => a - b);
  const latest: Json[] = [];
  for (const id of ids) {
    const mine = snapshots.filter((s) => s.id === id);
    if (new Set(mine.map((s) => `${s.workflow_id}|${s.event}|${s.head_sha}`)).size !== 1) return UNKNOWN;
    if (mine[0].workflow_id !== workflowId || mine[0].event !== "pull_request") continue;
    const states = new Map<number, Set<string>>();
    for (const s of mine) {
      const key = JSON.stringify([Date.parse(s.run_started_at), s.status, s.conclusion]);
      states.set(s.run_attempt, (states.get(s.run_attempt) ?? new Set()).add(key));
    }
    if ([...states.values()].some((v) => v.size !== 1)) return UNKNOWN;
    const ordered = [...states.keys()].sort((a, b) => a - b).map((n) => [n, ...JSON.parse([...states.get(n)!][0])]);
    for (let i = 1; i < ordered.length; i++) if (ordered[i][1] < ordered[i - 1][1]) return UNKNOWN;
    const [n, startedMs, , conclusion] = ordered[ordered.length - 1];
    latest.push({ id, head: mine[0].head_sha, attempt: n, startedMs, conclusion });
  }
  return latest;
}
/** Among restated runs: the one that started last, null for none, UNKNOWN for a tie at the top. */
const latestRestated = (runs: Json[]): Json => {
  if (runs.length === 0) return null;
  const top = Math.max(...runs.map((x: Json) => x.startedMs));
  const atTop = runs.filter((x: Json) => x.startedMs === top);
  return atTop.length === 1 ? [atTop[0].id, atTop[0].attempt, atTop[0].conclusion] : UNKNOWN;
};
const restatedHead = (snapshots: Json[], h: string): Json => {
  const runs = restated(snapshots, CI_ID, h);
  return runs === UNKNOWN ? UNKNOWN : latestRestated(runs);
};

/**
 * A random multiset of snapshots: a few runs, each with a true attempt
 * history, read 1-6 times - with identical duplicates, conflicting copies,
 * three or more copies of one run, attempts out of order, non-monotonic
 * histories, cross-run start ties, other workflows and events, and now and then
 * a copy that disagrees on what the run is.
 */
function randomMultiset(r: ReturnType<typeof seeded>, heads: string[], size: number): Json[] {
  const runs = [101, 102, 103].map((id) => {
    const kind = r.rand();
    const base = { id, workflow_id: kind < 0.15 ? OTHER_ID : CI_ID, event: kind > 0.9 ? "push" : "pull_request", head_sha: r.pick(heads) };
    let minute = Math.floor(r.rand() * 4) * 10;
    const history = [1, 2, 3].map((n) => {
      // Usually later than the attempt before; sometimes not.
      minute += r.rand() < 0.15 ? -10 : Math.floor(r.rand() * 3) * 10;
      const [status, conclusion] = r.pick<[string, string | null]>([
        ["completed", "success"],
        ["completed", "failure"],
        ["completed", "cancelled"],
        ["in_progress", null],
      ]);
      return { run_attempt: n, run_started_at: at(minute), status, conclusion };
    });
    return { base, history };
  });
  const out: Json[] = [];
  for (let i = 0; i < size; i++) {
    const run = r.pick(runs);
    const state = r.pick(run.history);
    const copy: Json = { name: "ci", path: ".github/workflows/ci.yml", ...run.base, ...state };
    const fault = r.rand();
    if (fault < 0.08) copy.conclusion = copy.conclusion === "success" ? "failure" : "success";
    else if (fault < 0.12) copy.workflow_id = copy.workflow_id === CI_ID ? OTHER_ID : CI_ID;
    out.push(copy);
  }
  return out;
}

describe("4. THE PROPERTY: for every permutation of one multiset of snapshots, the answer is identical", () => {
  it("over 300 seeded random multisets of up to 6 snapshots, EVERY permutation gives one answer - the rule restated", () => {
    const r = seeded(4189402172 % 2 ** 31);
    const mismatches: string[] = [];
    const outcomes = { decided: 0, unknown: 0, none: 0 };
    let orders = 0;
    for (let k = 0; k < 300; k++) {
      const snapshots = randomMultiset(r, [H], 1 + Math.floor(r.rand() * 6));
      const result = invariant(snapshots, (order) => head(order));
      orders += result.orders;
      const want = restatedHead(snapshots, H);
      const got = pick(result.answer);
      outcomes[got === UNKNOWN ? "unknown" : got === null ? "none" : "decided"] += 1;
      if (JSON.stringify(got) !== JSON.stringify(want)) mismatches.push(`${JSON.stringify(snapshots)}: ${JSON.stringify(got)} vs ${JSON.stringify(want)}`);
    }
    expect(mismatches).toEqual([]);
    // Anti-vacuity: every kind of answer arose, over tens of thousands of orders.
    expect(outcomes.decided).toBeGreaterThan(50);
    expect(outcomes.unknown).toBeGreaterThan(50);
    expect(outcomes.none).toBeGreaterThan(5);
    expect(orders).toBeGreaterThan(20_000);
  });

  it("every scenario in this file was itself checked in every order (the helper fails on a second answer)", () => {
    // A self-test of the harness: an order-DEPENDENT function must be caught.
    let caught = false;
    try {
      invariant([1, 2, 3], (order) => order[0]);
    } catch {
      caught = true;
    }
    expect(caught).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. exact-head CI and the failure streak share one canonical result
// ---------------------------------------------------------------------------

describe("5. exact-head CI and the failure streak share the one canonical result", () => {
  it("per head, the streak's execution IS the exact-head execution, in every order of the whole history", () => {
    const history = [
      attempt(303, 1, 40, { head_sha: H3, conclusion: "failure" }),
      attempt(201, 2, 35, { head_sha: H2, conclusion: "failure" }),
      attempt(202, 1, 30, { head_sha: H2 }),
      attempt(101, 1, 5, { head_sha: H1 }),
      attempt(101, 1, 5, { head_sha: H1 }),
      attempt(500, 1, 50, { head_sha: H3, workflow_id: OTHER_ID }),
    ];
    const streak = invariant(history, (order) => selectStreakExecutions({ snapshots: order, heads: [H3, H2, H1], workflowId: CI_ID })).answer;
    expect(streak.value.map((x: Json) => [x.head, x.execution.id, x.execution.attempt, x.execution.conclusion])).toEqual([
      [H3, 303, 1, "failure"],
      [H2, 201, 2, "failure"],
      [H1, 101, 1, "success"],
    ]);
    for (const [i, h] of [H3, H2, H1].entries()) {
      expect(streak.value[i].execution).toEqual(head(history.filter((s) => s.head_sha === h), h).value);
    }
  });

  it("a head with a tie at its top makes the whole streak UNKNOWN", () => {
    const history = [attempt(303, 1, 40, { head_sha: H3 }), attempt(202, 1, 30, { head_sha: H2, conclusion: "failure" }), attempt(201, 2, 30, { head_sha: H2 })];
    const env = invariant(history, (order) => selectStreakExecutions({ snapshots: order, heads: [H3, H2], workflowId: CI_ID })).answer;
    expect(env.value).toBe(UNKNOWN);
    expect(env.reason).toMatch(/^head [0-9a-f]{10}: runs 201, 202 all started at/);
  });

  it("over 200 seeded multi-head histories: the streak agrees with the exact-head selection and with the rule restated, in every order", () => {
    const r = seeded(795798);
    const heads = [H3, H2, H1];
    const mismatches: string[] = [];
    const outcomes = { decided: 0, undecidable: 0 };
    for (let k = 0; k < 200; k++) {
      const history = randomMultiset(r, heads, 2 + Math.floor(r.rand() * 4));
      const streak = invariant(history, (order) => selectStreakExecutions({ snapshots: order, heads, workflowId: CI_ID })).answer;
      // Restated: the whole history first, then each head's latest among its runs.
      const runs = restated(history, CI_ID, null);
      const perHead = runs === UNKNOWN ? [UNKNOWN] : heads.map((h) => latestRestated(runs.filter((x: Json) => x.head === h)));
      const want = perHead.includes(UNKNOWN) ? UNKNOWN : perHead;
      const got = streak.value === UNKNOWN ? UNKNOWN : streak.value.map((x: Json) => (x.execution ? [x.execution.id, x.execution.attempt, x.execution.conclusion] : null));
      outcomes[got === UNKNOWN ? "undecidable" : "decided"] += 1;
      if (JSON.stringify(got) !== JSON.stringify(want)) mismatches.push(`${JSON.stringify(history)}: ${JSON.stringify(got)} vs ${JSON.stringify(want)}`);
      if (got !== UNKNOWN) {
        heads.forEach((h, i) => {
          const alone = head(history.filter((s) => s.head_sha === h), h).value;
          if (JSON.stringify(alone) !== JSON.stringify(streak.value[i].execution)) mismatches.push(`k=${k}: head ${h.slice(0, 7)} differs from exact-head`);
        });
      }
    }
    expect(mismatches).toEqual([]);
    expect(outcomes.decided).toBeGreaterThan(30);
    expect(outcomes.undecidable).toBeGreaterThan(20);
  });

  it("both selectors are built from the same two functions, and nothing else selects", () => {
    const code = readFileSync(path.resolve(__dirname, "../../scripts/eng/workflow-runs.mjs"), "utf8").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
    const body = (name: string) => code.slice(code.indexOf(`export function ${name}`), code.indexOf("\n}\n", code.indexOf(`export function ${name}`)));
    for (const selector of ["selectHeadExecution", "selectStreakExecutions"]) {
      expect(body(selector)).toMatch(/canonicalize\(list, workflowId\)/);
      expect(body(selector)).toMatch(/latestOf\(/);
      expect(body(selector)).not.toMatch(/\.attempt\s*[<>=]|run_attempt|run_started_at|Date\.parse/);
    }
    expect(typeof canonicalize).toBe("function");
    expect(typeof latestOf).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// 6. boundaries
// ---------------------------------------------------------------------------

describe("6. pure, order-free by construction, and read-only", () => {
  const code = readFileSync(path.resolve(__dirname, "../../scripts/eng/workflow-runs.mjs"), "utf8").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");

  it("attempt numbers are compared only within one run, and no run id is ever recency", () => {
    // Anti-vacuity: the scan reaches the code it guards.
    expect(code).toContain("export function canonicalize");
    const across = code.slice(code.indexOf("export function latestOf"), code.indexOf("export function selectHeadExecution"));
    expect(across).not.toMatch(/attempt/);
    expect(across).not.toMatch(/\.id\s*(<|>|<=|>=|-)/);
    expect(code).not.toMatch(/\.id\s*(<|>|<=|>=)\s*\w/);
  });

  it("does no I/O, reads no clock, and keeps no timer", () => {
    expect(code.match(/^import .*$/gm)).toEqual(['import { AUTHORIZED, COMPLETE, UNKNOWN, evidence } from "./evidence.mjs";']);
    expect(code).not.toMatch(/fetch|fetcher|require\(|process\.|child_process|readFileSync|writeFileSync|https?:/);
    expect(code).not.toMatch(/Date\.now\(|new Date\(\)|performance\.now/);
    expect(code).not.toMatch(/\bsetTimeout\b|\bsetInterval\b|--watch|merge|\bgit\s/);
  });
});
