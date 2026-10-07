/* eslint-disable @typescript-eslint/no-explicit-any -- the verifier feeds raw, untyped GitHub answers to the parsers on purpose */
import { describe, expect, it } from "vitest";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { parsePrKey } from "../../../../scripts/eng/v2/contract/pr-key.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { isUnknownReason } from "../../../../scripts/eng/v2/contract/reasons.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { parseActivity, parseBranchRules, parseCompare, parseHeadBranchPrs, parsePrContext } from "../../../../scripts/eng/v2/adapter/internal/github/parse-base.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { bindBase } from "../../../../scripts/eng/v2/adapter/internal/bind/base.mjs";
import { clone, deepFreeze, isDeepFrozen, noThrow } from "./support/deep";
import { exactFieldMutations, pick, purityViolations, sprinkle } from "./support/parser-props";
import {
  H810,
  P0,
  PROD_REF_FULL,
  PRODUCTION_REF,
  REAL,
  REAL_810_FILES,
  golden,
  rawKeyFor,
  rawPrContextFor,
} from "./support/world";

// ===========================================================================
// INDEPENDENT VERIFIER — ENG-LOOP V1 05A row 2: production base, drift, PR context.
// Oracle: SPEC-05A §0 and §2 (b5f3affb). Real answers are named "real"; every
// edit of one is "synthetic". Expected values are read off the recorded answers
// and the spec text, never off the implementation.
// ===========================================================================

const C776 = "6a4cff35f050411a9e63c5a23128d862dd5a9e7c";
const C800_BASE = "c26bbdec96c3fb6cde0845e2d75ef012daa09755";

const failsWith = (r: any, reasons: string[], label = "") => {
  expect(r?.ok, `${label} should fail closed`).toBe(false);
  expect(reasons, `${label}: got ${JSON.stringify(r?.reason)}`).toContain(r?.reason);
  expect(isUnknownReason(r?.reason)).toBe(true);
};
const sorted = (xs: unknown) => [...(xs as string[])].sort();

// ---------------------------------------------------------------------------
// §2.1 parseCompare
// ---------------------------------------------------------------------------
describe("row 2 verify: parseCompare (§2.1)", () => {
  const COMPARE_CONSUMED = {
    status: true,
    behind_by: true,
    ahead_by: true,
    base_commit: { sha: true },
    merge_base_commit: { sha: true },
    files: [{ filename: true }],
  };

  it("real answers: #810 ahead 2 / behind 0, #776 diverged 7 / 209, #800 ahead 15 at its own recorded base", () => {
    const r810 = parseCompare(REAL.base("compare-810.json"), { baseSha: P0 });
    expect(r810.ok).toBe(true);
    expect(r810.record).toMatchObject({ status: "ahead", behindBy: 0, aheadBy: 2, mergeBaseSha: P0, filesCapped: false });
    expect(sorted(r810.record.files)).toEqual(sorted(REAL_810_FILES));
    const r776 = parseCompare(REAL.base("compare-776-diverged.json"), { baseSha: P0 });
    expect(r776.record).toMatchObject({
      status: "diverged",
      behindBy: 209,
      aheadBy: 7,
      mergeBaseSha: "a5e179f2e29789c3a1bfc93041d65ed1b4820eac",
      filesCapped: false,
    });
    expect(r776.record.files).toHaveLength(11);
    const r800 = parseCompare(REAL.base("compare-800-behind0.json"), { baseSha: C800_BASE });
    expect(r800.record).toMatchObject({ status: "ahead", behindBy: 0, aheadBy: 15, mergeBaseSha: C800_BASE });
  });

  it("a compare requested for another base is malformed (#800's recorded compare vs its live tip)", () => {
    failsWith(parseCompare(REAL.base("compare-800-behind0.json"), { baseSha: P0 }), ["malformed"]);
  });

  it("is pure and returns a deeply frozen record", () => {
    expect(purityViolations(parseCompare, REAL.base("compare-810.json"), { baseSha: P0 })).toEqual([]);
  });

  it("REST: unconsumed fields are ignored — stripped to the consumed fields, or with new fields everywhere, the record is the same", () => {
    const raw = REAL.base("compare-810.json");
    const full = parseCompare(raw, { baseSha: P0 });
    const minimal = parseCompare(pick(raw, COMPARE_CONSUMED), { baseSha: P0 });
    const noisy = parseCompare(sprinkle(raw), { baseSha: P0 });
    expect(minimal).toEqual(full);
    expect(noisy).toEqual(full);
  });

  it("REST: each consumed field missing or of the wrong type is malformed", () => {
    const base = () => REAL.base("compare-810.json");
    const cases: Array<[string, (r: any) => void]> = [
      ["status missing", (r) => delete r.status],
      ["status 'Ahead'", (r) => (r.status = "Ahead")],
      ["status 'unknown'", (r) => (r.status = "unknown")],
      ["status ''", (r) => (r.status = "")],
      ["status null", (r) => (r.status = null)],
      ["behind_by -1", (r) => (r.behind_by = -1)],
      ["behind_by 1.5", (r) => (r.behind_by = 1.5)],
      ["behind_by '0'", (r) => (r.behind_by = "0")],
      ["behind_by null", (r) => (r.behind_by = null)],
      ["behind_by 2^53 (not safe)", (r) => (r.behind_by = 2 ** 53)],
      ["ahead_by missing", (r) => delete r.ahead_by],
      ["ahead_by -3", (r) => (r.ahead_by = -3)],
      ["base_commit missing", (r) => delete r.base_commit],
      ["base_commit null", (r) => (r.base_commit = null)],
      ["base_commit.sha uppercase", (r) => (r.base_commit.sha = P0.toUpperCase())],
      ["base_commit.sha 39 chars", (r) => (r.base_commit.sha = P0.slice(1))],
      ["merge_base_commit missing", (r) => delete r.merge_base_commit],
      ["merge_base_commit.sha uppercase", (r) => (r.merge_base_commit.sha = P0.toUpperCase())],
      ["merge_base_commit.sha null", (r) => (r.merge_base_commit.sha = null)],
      ["files absent", (r) => delete r.files],
      ["files null", (r) => (r.files = null)],
      ["files an object", (r) => (r.files = { 0: r.files[0] })],
      ["a file without filename", (r) => delete r.files[3].filename],
      ["a file with filename ''", (r) => (r.files[3].filename = "")],
      ["a file with filename 5", (r) => (r.files[3].filename = 5)],
      ["a null file", (r) => (r.files[3] = null)],
      ["an array answer", (r) => Object.assign(r, { __replace: [r] })],
    ];
    for (const [label, edit] of cases) {
      const raw = base();
      edit(raw);
      const input = raw.__replace ?? raw;
      const out = noThrow(() => parseCompare(input, { baseSha: P0 }));
      expect(out.threw, `${label}: threw`).toBe(false);
      failsWith((out as any).value, ["malformed"], label);
    }
  });

  it("Number.MAX_SAFE_INTEGER is still a safe integer", () => {
    const raw = REAL.base("compare-810.json");
    raw.ahead_by = Number.MAX_SAFE_INTEGER;
    expect(parseCompare(raw, { baseSha: P0 }).ok).toBe(true);
  });

  it("files cap: 299 files is complete, 300 is capped (GitHub truncates at 300); an empty diff is complete", () => {
    for (const [n, capped] of [
      [0, false],
      [1, false],
      [299, false],
      [300, true],
      [301, true],
    ] as const) {
      const raw = REAL.base("compare-810.json");
      raw.files = Array.from({ length: n }, (_, i) => ({ ...clone(raw.files[0]), filename: `app/f${i}.ts` }));
      const r = parseCompare(raw, { baseSha: P0 });
      expect(r.ok, `${n} files`).toBe(true);
      expect(r.record.filesCapped, `${n} files`).toBe(capped);
      expect(r.record.files).toHaveLength(n);
    }
  });

  it("a renamed file is reported under its NEW filename (rule 3 cannot see previous_filename)", () => {
    const raw = REAL.base("compare-810.json");
    raw.files[0] = { ...raw.files[0], filename: ".github/workflows/ci-old.yml", previous_filename: ".github/workflows/ci.yml", status: "renamed" };
    const r = parseCompare(raw, { baseSha: P0 });
    expect(r.ok).toBe(true);
    expect(r.record.files).toContain(".github/workflows/ci-old.yml");
  });
});

// ---------------------------------------------------------------------------
// §2.2 parsePrContext — GraphQL, exact fields; the totalCount trap
// ---------------------------------------------------------------------------
describe("row 2 verify: parsePrContext (§2.2)", () => {
  const params = { expectedNumber: 810, headSha: H810 };
  const spec810 = () => rawPrContextFor(golden());
  const withEvents = (n: number, hasNext = false) => {
    const raw = spec810();
    raw.data.repository.pullRequest.baseRefChanges = {
      pageInfo: { hasNextPage: hasNext },
      nodes: Array.from({ length: n }, () => ({ __typename: "BaseRefChangedEvent" })),
    };
    return raw;
  };

  it("a spec-shaped #810 answer (real values) gives createdAt, changedFiles, zero base changes and [810]", () => {
    const r = parsePrContext(spec810(), params);
    expect(r.ok).toBe(true);
    expect(r.record).toMatchObject({
      createdAt: "2026-10-07T20:16:40Z",
      changedFiles: 11,
      baseRefChanges: 0,
      associatedPrNumbers: [810],
    });
  });

  it("base changes are counted from the filtered NODES (0, 1, 3, 100) with hasNextPage false", () => {
    for (const n of [0, 1, 3, 100]) expect(parsePrContext(withEvents(n), params).record.baseRefChanges, `${n}`).toBe(n);
  });

  it("hasNextPage true is 'too_many', whatever the nodes say (even none)", () => {
    for (const n of [0, 1, 100]) expect(parsePrContext(withEvents(n, true), params).record.baseRefChanges).toBe("too_many");
  });

  it("TRAP: the real recorded #810 context answer carries an unfiltered totalCount 4 and no nodes — malformed, never 4", () => {
    // tests/eng/v2/fixtures/base/pr-context-810.json as recorded at b5f3affb: baseRefChanges { totalCount: 4 },
    // no number, no pageInfo, no nodes, no __typename. It is not the §2.2 shape.
    const r = parsePrContext(REAL.base("pr-context-810.json"), params);
    expect(r.ok && r.record.baseRefChanges === 4).toBe(false);
    failsWith(r, ["malformed"], "recorded #810 answer");
  });

  it("TRAP: a spec-shaped answer that ALSO carries totalCount 36 with zero nodes is malformed (exact fields), never 36", () => {
    const raw = withEvents(0);
    raw.data.repository.pullRequest.baseRefChanges.totalCount = 36;
    const r = parsePrContext(raw, params);
    expect(r.ok && r.record.baseRefChanges === 36).toBe(false);
    failsWith(r, ["malformed"], "totalCount present");
  });

  it("GraphQL exact fields: every requested field deleted, and an unrequested field added, at every object inside data", () => {
    const muts = exactFieldMutations(spec810());
    expect(muts.length).toBeGreaterThan(20);
    for (const m of muts) {
      const out = noThrow(() => parsePrContext(m.raw, params));
      expect(out.threw, `${m.label}: threw`).toBe(false);
      const envelope = ["repository", "pullRequest", "object"].includes(m.deletedKey ?? "");
      failsWith((out as any).value, envelope ? ["malformed", "read_failed"] : ["malformed"], m.label);
    }
  });

  it("node and value violations are malformed", () => {
    const cases: Array<[string, (r: any) => void]> = [
      ["a HeadRefForcePushedEvent node", (r) => r.data.repository.pullRequest.baseRefChanges.nodes.push({ __typename: "HeadRefForcePushedEvent" })],
      ["an empty node", (r) => r.data.repository.pullRequest.baseRefChanges.nodes.push({})],
      ["a null node", (r) => r.data.repository.pullRequest.baseRefChanges.nodes.push(null)],
      ["hasNextPage 'false'", (r) => (r.data.repository.pullRequest.baseRefChanges.pageInfo.hasNextPage = "false")],
      ["number 811", (r) => (r.data.repository.pullRequest.number = 811)],
      ["createdAt without a T", (r) => (r.data.repository.pullRequest.createdAt = "2026-10-07 20:16:40")],
      ["createdAt with +02:00 (not UTC)", (r) => (r.data.repository.pullRequest.createdAt = "2026-10-07T22:16:40+02:00")],
      ["createdAt month 13", (r) => (r.data.repository.pullRequest.createdAt = "2026-13-07T20:16:40Z")],
      ["createdAt a number", (r) => (r.data.repository.pullRequest.createdAt = 1791404200)],
      ["changedFiles -1", (r) => (r.data.repository.pullRequest.changedFiles = -1)],
      ["changedFiles 1.5", (r) => (r.data.repository.pullRequest.changedFiles = 1.5)],
      ["changedFiles '11'", (r) => (r.data.repository.pullRequest.changedFiles = "11")],
      ["object a Tree", (r) => (r.data.repository.object = { __typename: "Tree" })],
      ["associated number 0", (r) => (r.data.repository.object.associatedPullRequests.nodes = [{ number: 0 }])],
      ["associated number '810'", (r) => (r.data.repository.object.associatedPullRequests.nodes = [{ number: "810" }])],
      ["associated number 810.5", (r) => (r.data.repository.object.associatedPullRequests.nodes = [{ number: 810.5 }])],
    ];
    for (const [label, edit] of cases) {
      const raw = spec810();
      edit(raw);
      failsWith(parsePrContext(raw, params), ["malformed"], label);
    }
  });

  it("associated PRs beyond one page are 'too_many'", () => {
    const raw = spec810();
    raw.data.repository.object.associatedPullRequests.pageInfo.hasNextPage = true;
    expect(parsePrContext(raw, params).record.associatedPrNumbers).toBe("too_many");
  });

  it("object null is read_failed; a GraphQL error is read_failed; any other envelope is malformed", () => {
    const nullObject = spec810();
    nullObject.data.repository.object = null;
    failsWith(parsePrContext(nullObject, params), ["read_failed"], "object null");
    failsWith(parsePrContext({ errors: [{ type: "NOT_FOUND", message: "x" }] }, params), ["read_failed"], "errors only");
    failsWith(parsePrContext({ data: null, errors: [{ message: "x" }] }, params), ["read_failed"], "errors with null data");
    for (const [label, raw] of [
      ["{}", {}],
      ["null", null],
      ["an array", []],
      ["a string", "x"],
    ] as const)
      failsWith(parsePrContext(raw, params), ["malformed"], label);
  });

  it("is pure and returns a deeply frozen record", () => {
    expect(purityViolations(parsePrContext, withEvents(2), params)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §2.3 parseHeadBranchPrs
// ---------------------------------------------------------------------------
describe("row 2 verify: parseHeadBranchPrs (§2.3)", () => {
  const ref = "feat/eng-loop-v1-05a";
  const real = () => REAL.base("head-branch-prs-810.json");
  const element = (over: any = {}) => ({ ...clone(real()[0]), ...over });

  it("real answer: [810], not capped", () => {
    const r = parseHeadBranchPrs(real(), { headRef: ref });
    expect(r.ok).toBe(true);
    expect(r.record).toMatchObject({ numbers: [810], capped: false });
  });

  it("closed and merged PRs (state closed) count; a deleted head repository (null) is allowed", () => {
    const raw = [element(), element({ number: 702, state: "closed", head: { ...element().head, repo: null } })];
    expect(parseHeadBranchPrs(raw, { headRef: ref }).record.numbers).toEqual([810, 702]);
  });

  it("100 entries are capped, 99 are not; an empty list is valid", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => element({ number: 1000 + i }));
    expect(parseHeadBranchPrs(many(100), { headRef: ref }).record.capped).toBe(true);
    expect(parseHeadBranchPrs(many(99), { headRef: ref }).record.capped).toBe(false);
    expect(parseHeadBranchPrs([], { headRef: ref }).record).toMatchObject({ numbers: [], capped: false });
  });

  it("violations are malformed", () => {
    const cases: Array<[string, unknown]> = [
      ["another head ref", [element({ head: { ...element().head, ref: "feat/other" } })]],
      ["state merged", [element({ state: "merged" })]],
      ["state OPEN", [element({ state: "OPEN" })]],
      ["state null", [element({ state: null })]],
      ["number 0", [element({ number: 0 })]],
      ["number '810'", [element({ number: "810" })]],
      ["head missing", [element({ head: undefined })]],
      ["head.repo {}", [element({ head: { ...element().head, repo: {} } })]],
      ["head.repo { id: 0 }", [element({ head: { ...element().head, repo: { id: 0 } } })]],
      ["head.repo { id: '1240764106' }", [element({ head: { ...element().head, repo: { id: "1240764106" } } })]],
      ["a null element", [null]],
      ["an object answer", { 0: element() }],
      ["null", null],
    ];
    for (const [label, raw] of cases) failsWith(parseHeadBranchPrs(raw, { headRef: ref }), ["malformed"], label);
  });

  it("REST: stripped to consumed fields or sprinkled with new ones, the record is the same", () => {
    const full = parseHeadBranchPrs(real(), { headRef: ref });
    expect(parseHeadBranchPrs(pick(real(), [{ number: true, state: true, head: { ref: true, repo: { id: true } } }]), { headRef: ref })).toEqual(full);
    expect(parseHeadBranchPrs(sprinkle(real()), { headRef: ref })).toEqual(full);
  });

  it("is pure and returns a deeply frozen record", () => {
    expect(purityViolations(parseHeadBranchPrs, real(), { headRef: ref })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §2.4 parseBranchRules
// ---------------------------------------------------------------------------
describe("row 2 verify: parseBranchRules (§2.4)", () => {
  it("real answer: production has no rules today", () => {
    const r = parseBranchRules(REAL.base("rules-production-unprotected.json"));
    expect(r.ok).toBe(true);
    expect(r.record).toMatchObject({ types: [], nonFastForward: false, deletion: false });
  });

  it("both prevention rules, among others and with extra ruleset fields", () => {
    const raw = [
      { type: "pull_request", ruleset_id: 1, parameters: { required_approving_review_count: 1 } },
      { type: "non_fast_forward", ruleset_source_type: "Repository", ruleset_source: "o/r", ruleset_id: 2 },
      { type: "deletion", ruleset_id: 2 },
    ];
    expect(parseBranchRules(raw).record).toMatchObject({ nonFastForward: true, deletion: true });
    expect(sorted(parseBranchRules(raw).record.types)).toEqual(["deletion", "non_fast_forward", "pull_request"]);
  });

  it("rule types are matched exactly", () => {
    expect(parseBranchRules([{ type: "Non_Fast_Forward" }, { type: "DELETION" }]).record).toMatchObject({ nonFastForward: false, deletion: false });
  });

  it("violations are malformed", () => {
    for (const [label, raw] of [
      ["type ''", [{ type: "" }]],
      ["type missing", [{}]],
      ["type 5", [{ type: 5 }]],
      ["a null rule", [null]],
      ["an object answer", { type: "deletion" }],
      ["null", null],
    ] as const)
      failsWith(parseBranchRules(raw), ["malformed"], label);
  });

  it("is pure and returns a deeply frozen record", () => {
    expect(purityViolations(parseBranchRules, [{ type: "deletion" }, { type: "non_fast_forward" }])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §2.5 parseActivity
// ---------------------------------------------------------------------------
describe("row 2 verify: parseActivity (§2.5)", () => {
  const p = (activityType: string) => ({ activityType, ref: PROD_REF_FULL });
  const realMerges = () => REAL.verify("activity-pr-merge-week.json");

  it("real answers: no force push and no deletion on production this year", () => {
    for (const [file, t] of [
      ["activity-force-push-none.json", "force_push"],
      ["activity-branch-deletion-none.json", "branch_deletion"],
    ] as const) {
      const r = parseActivity(REAL.base(file), p(t));
      expect(r.ok).toBe(true);
      expect(r.record).toMatchObject({ events: [], capped: false });
    }
  });

  it("real non-empty answer: production's three pr_merge events of the week, as recorded (verifier fixture)", () => {
    const r = parseActivity(realMerges(), p("pr_merge"));
    expect(r.ok).toBe(true);
    expect(r.record.capped).toBe(false);
    expect(r.record.events.map((e: any) => [e.timestamp, e.before.slice(0, 8), e.after.slice(0, 8)])).toEqual([
      ["2026-10-07T19:07:46Z", "c26bbdec", "6cdd830b"],
      ["2026-10-07T15:24:34Z", "5fb25c8c", "c26bbdec"],
      ["2026-10-07T12:30:53Z", "583f9334", "5fb25c8c"],
    ]);
  });

  it("an event of another activity type than requested is malformed (the real merges read as force pushes)", () => {
    failsWith(parseActivity(realMerges(), p("force_push")), ["malformed"]);
  });

  it("violations are malformed", () => {
    const one = (over: any) => [{ ...clone(realMerges()[0]), activity_type: "force_push", ...over }];
    for (const [label, raw] of [
      ["another ref", one({ ref: "refs/heads/main" })],
      ["a bare branch name as ref", one({ ref: PRODUCTION_REF })],
      ["timestamp 'yesterday'", one({ timestamp: "yesterday" })],
      ["timestamp ''", one({ timestamp: "" })],
      ["timestamp null", one({ timestamp: null })],
      ["timestamp a number", one({ timestamp: 1791404200 })],
      ["timestamp month 13", one({ timestamp: "2026-13-07T20:16:44Z" })],
      ["timestamp 23:59:60 (NaN to Date.parse)", one({ timestamp: "2026-10-07T23:59:60Z" })],
      ["before 39 hex", one({ before: "a".repeat(39) })],
      ["after null", one({ after: null })],
      ["after 'main'", one({ after: "main" })],
      ["activity_type missing", one({ activity_type: undefined })],
      ["an object answer", { 0: one({})[0] }],
      ["null", null],
    ] as const)
      failsWith(parseActivity(raw, p("force_push")), ["malformed"], label);
  });

  it("an all-zero before/after (branch creation or deletion) is 40 hex", () => {
    const raw = [{ ...clone(realMerges()[0]), activity_type: "branch_deletion", after: "0".repeat(40) }];
    expect(parseActivity(raw, p("branch_deletion")).ok).toBe(true);
  });

  it("100 events are capped, 99 are not", () => {
    const n = (k: number) => Array.from({ length: k }, (_, i) => ({ ...clone(realMerges()[0]), id: i, activity_type: "force_push" }));
    expect(parseActivity(n(100), p("force_push")).record.capped).toBe(true);
    expect(parseActivity(n(99), p("force_push")).record.capped).toBe(false);
  });

  it("REST: stripped to consumed fields or sprinkled with new ones, the record is the same", () => {
    const full = parseActivity(realMerges(), p("pr_merge"));
    const shape = [{ activity_type: true, ref: true, timestamp: true, before: true, after: true }];
    expect(parseActivity(pick(realMerges(), shape), p("pr_merge"))).toEqual(full);
    expect(parseActivity(sprinkle(realMerges()), p("pr_merge"))).toEqual(full);
  });

  it("is pure and returns a deeply frozen record", () => {
    expect(purityViolations(parseActivity, realMerges(), p("pr_merge"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §2.6 bindBase
// ---------------------------------------------------------------------------
describe("row 2 verify: bindBase (§2.6)", () => {
  const key810 = () => parsePrKey(rawKeyFor(golden()), { expectedNumber: 810 }).key;
  const ctx = (raw = rawPrContextFor(golden())) => parsePrContext(raw, { expectedNumber: 810, headSha: H810 }).record;
  /** a spec-shaped context answer for another PR (same values otherwise) */
  const ctxFor = (key: any) => {
    const w = golden();
    w.pr.number = key.prNumber;
    w.prContext.associated = [key.prNumber];
    return parsePrContext(rawPrContextFor(w), { expectedNumber: key.prNumber, headSha: key.headSha }).record;
  };
  const cmp = (file: string, baseSha: string) => parseCompare(REAL.base(file), { baseSha }).record;

  it("#810 on production: the value carries drift, merge base, files and the context, unchanged", () => {
    const r = bindBase({ key: key810(), productionRef: PRODUCTION_REF, compare: cmp("compare-810.json", P0), prContext: ctx() });
    expect(r.ok).toBe(true);
    expect(r.value).toMatchObject({
      drift: { behindBy: 0, aheadBy: 2 },
      mergeBaseSha: P0,
      filesCapped: false,
      changedFiles: 11,
      baseRefChanges: 0,
      associatedPrNumbers: [810],
    });
    expect(sorted(r.value.files)).toEqual(sorted(REAL_810_FILES));
    expect(isDeepFrozen(r.value)).toBe(true);
  });

  it("REAL #776 targets a feature branch: base_ref", () => {
    const key776 = parsePrKey(REAL.prKey("pr-776-open-feature-base.json"), { expectedNumber: 776 }).key;
    expect(key776.baseSha).toBe(C776);
    const r = bindBase({ key: key776, productionRef: PRODUCTION_REF, compare: cmp("compare-776-diverged.json", P0), prContext: ctxFor(key776) });
    failsWith(r, ["base_ref"], "#776");
  });

  it("REAL #800: a compare record taken at another base than the key's live tip is malformed (step 2)", () => {
    // #800's key reads the live production tip 6cdd830b; its recorded compare was taken at c26bbdec.
    const key800 = parsePrKey(REAL.prKey("pr-800-open-draft.json"), { expectedNumber: 800 }).key;
    expect(key800.baseSha).toBe(P0);
    const stale = cmp("compare-800-behind0.json", C800_BASE);
    expect(stale).toBeTruthy();
    const r = bindBase({ key: key800, productionRef: PRODUCTION_REF, compare: stale, prContext: ctxFor(key800) });
    failsWith(r, ["malformed"], "#800 stale compare");
  });

  it("base_ref is decided before the compare-base check", () => {
    const key = { ...key810(), baseRef: "release/x" };
    const r = bindBase({ key, productionRef: PRODUCTION_REF, compare: cmp("compare-800-behind0.json", C800_BASE), prContext: ctx() });
    failsWith(r, ["base_ref"]);
  });

  it("the production ref is a parameter: the same key against another production ref is base_ref", () => {
    failsWith(bindBase({ key: key810(), productionRef: "main", compare: cmp("compare-810.json", P0), prContext: ctx() }), ["base_ref"]);
  });

  it("'too_many' base changes and associated PRs pass through unchanged", () => {
    const raw = rawPrContextFor(golden());
    raw.data.repository.pullRequest.baseRefChanges.pageInfo.hasNextPage = true;
    raw.data.repository.object.associatedPullRequests.pageInfo.hasNextPage = true;
    const r = bindBase({ key: key810(), productionRef: PRODUCTION_REF, compare: cmp("compare-810.json", P0), prContext: ctx(raw) });
    expect(r.value).toMatchObject({ baseRefChanges: "too_many", associatedPrNumbers: "too_many" });
  });

  it("is pure over deep-frozen inputs and never throws on missing inputs", () => {
    const args = deepFreeze({ key: key810(), productionRef: PRODUCTION_REF, compare: cmp("compare-810.json", P0), prContext: ctx() });
    const a = noThrow(() => bindBase(args));
    expect(a.threw).toBe(false);
    expect((a as any).value.ok).toBe(true);
    for (const [label, bad] of [
      ["no compare", { ...args, compare: undefined }],
      ["no prContext", { ...args, prContext: undefined }],
      ["no key", { ...args, key: undefined }],
    ] as const) {
      const out = noThrow(() => bindBase(bad));
      expect(out.threw, label).toBe(false);
      expect((out as any).value?.ok, label).toBe(false);
    }
  });
});
