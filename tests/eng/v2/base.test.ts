/* eslint-disable @typescript-eslint/no-explicit-any -- these tests feed raw, untyped GitHub JSON on purpose */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { parsePrKey } from "../../../scripts/eng/v2/contract/pr-key.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { parseActivity, parseBranchRules, parseCompare, parseHeadBranchPrs, parsePrContext } from "../../../scripts/eng/v2/adapter/internal/github/parse-base.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { bindBase } from "../../../scripts/eng/v2/adapter/internal/bind/base.mjs";

// ===========================================================================
// ENG-LOOP V1 05A, gap row 2: live production drift and the PR's base context
// (SPEC-05A §2). Real fixtures, recorded 2026-10-07, unless marked synthetic.
// ===========================================================================

const F = path.join(__dirname, "fixtures");
const load = (p: string) => JSON.parse(readFileSync(path.join(F, p), "utf8"));
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const PROD = "claude/build-hone-saas-hOex7";
const BASE_TIP = "6cdd830b0bcc5e3532016bc612bd0298db3533fb";
const key = (file: string, n: number) => parsePrKey(load(`pr-key/${file}`), { expectedNumber: n }).key;

describe("parseCompare (REST compare/{base}...{head})", () => {
  it("reads drift and the changed files of a real compare (#810: 0 behind, 2 ahead, 11 files)", () => {
    const r = parseCompare(load("base/compare-810.json"), { baseSha: BASE_TIP });
    expect(r.ok).toBe(true);
    expect(r.record).toMatchObject({ status: "ahead", behindBy: 0, aheadBy: 2, mergeBaseSha: BASE_TIP, filesCapped: false });
    expect(r.record.files).toHaveLength(11);
    expect(r.record.files).toContain("scripts/eng/v2/contract/pr-key.mjs");
    expect(Object.isFrozen(r.record)).toBe(true);
  });

  it("reads a diverged compare (#776 against production: 209 behind)", () => {
    const r = parseCompare(load("base/compare-776-diverged.json"), { baseSha: BASE_TIP });
    expect(r.record).toMatchObject({ status: "diverged", behindBy: 209, aheadBy: 7 });
  });

  it("a compare for another base is malformed: the answer must be the one requested", () => {
    expect(parseCompare(load("base/compare-800-behind0.json"), { baseSha: BASE_TIP })).toMatchObject({
      ok: false,
      reason: "malformed",
    });
  });

  const mutate = (edit: (r: any) => void) => {
    const raw = clone(load("base/compare-810.json"));
    edit(raw);
    return parseCompare(raw, { baseSha: BASE_TIP });
  };

  it.each([
    ["unknown status", (r: any) => (r.status = "ahead-ish")],
    ["negative behind_by", (r: any) => (r.behind_by = -1)],
    ["fractional ahead_by", (r: any) => (r.ahead_by = 1.5)],
    ["string behind_by", (r: any) => (r.behind_by = "0")],
    ["missing files", (r: any) => delete r.files],
    ["a file without a filename", (r: any) => delete r.files[0].filename],
    ["an empty filename", (r: any) => (r.files[0].filename = "")],
    ["a bad merge base sha", (r: any) => (r.merge_base_commit.sha = "xyz")],
    ["a missing base commit", (r: any) => delete r.base_commit],
  ])("%s is malformed", (_name, edit) => {
    expect(mutate(edit)).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("ignores REST fields it does not consume", () => {
    expect(mutate((r) => (r.some_new_field = { x: 1 })).ok).toBe(true);
  });

  it("a file list at GitHub's 300-file cap is reported as capped", () => {
    const r = mutate((raw) => (raw.files = Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}.ts` }))));
    expect(r.ok).toBe(true);
    expect(r.record.filesCapped).toBe(true);
  });
});

describe("parsePrContext (GraphQL, exact fields)", () => {
  it("reads a PR with no base change (#810)", () => {
    const r = parsePrContext(load("base/pr-context-810.json"), {
      expectedNumber: 810,
      headSha: "958b9d536e055e746499262cdc1a740e13501bf2",
    });
    expect(r).toEqual({
      ok: true,
      record: { createdAt: "2026-10-07T20:16:40Z", changedFiles: 11, baseRefChanges: 0, associatedPrNumbers: [810] },
    });
  });

  it("counts filtered base-change NODES (#720 was retargeted once)", () => {
    const r = parsePrContext(load("base/pr-context-720.json"), { expectedNumber: 720 });
    expect(r.ok).toBe(true);
    expect(r.record.baseRefChanges).toBe(1);
  });

  const ctx = (edit: (p: any) => void) => {
    const raw = clone(load("base/pr-context-810.json"));
    edit(raw);
    return parsePrContext(raw, { expectedNumber: 810 });
  };

  it("never trusts a filtered timelineItems totalCount: requesting it is not this query's answer", () => {
    // Live 2026-10-07: totalCount counts EVERY timeline item (#720: 36), so it is never requested.
    expect(ctx((r) => (r.data.repository.pullRequest.baseRefChanges.totalCount = 4))).toMatchObject({
      ok: false,
      reason: "malformed",
    });
  });

  it("more base changes than one response holds reads as too_many, never as a count", () => {
    const r = ctx((r) => (r.data.repository.pullRequest.baseRefChanges.pageInfo.hasNextPage = true));
    expect(r.record.baseRefChanges).toBe("too_many");
  });

  it("more associated PRs than one response holds reads as too_many", () => {
    const r = ctx((r) => (r.data.repository.object.associatedPullRequests.pageInfo.hasNextPage = true));
    expect(r.record.associatedPrNumbers).toBe("too_many");
  });

  it.each([
    ["a non-BaseRefChangedEvent node", (r: any) => r.data.repository.pullRequest.baseRefChanges.nodes.push({ __typename: "IssueComment" })],
    ["another PR's number", (r: any) => (r.data.repository.pullRequest.number = 811)],
    ["a non-ISO createdAt", (r: any) => (r.data.repository.pullRequest.createdAt = "yesterday")],
    ["a negative changedFiles", (r: any) => (r.data.repository.pullRequest.changedFiles = -1)],
    ["an object that is not a Commit", (r: any) => (r.data.repository.object.__typename = "Tree")],
    ["an associated PR without a number", (r: any) => (r.data.repository.object.associatedPullRequests.nodes = [{}])],
    ["an unrequested field", (r: any) => (r.data.repository.pullRequest.title = "x")],
  ])("%s is malformed", (_n, edit) => {
    expect(ctx(edit)).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("a GitHub error or an unreadable commit is read_failed", () => {
    expect(ctx((r) => (r.errors = [{ message: "boom" }]))).toMatchObject({ ok: false, reason: "read_failed" });
    expect(ctx((r) => (r.data.repository.object = null))).toMatchObject({ ok: false, reason: "read_failed" });
  });
});

describe("parseHeadBranchPrs (REST pulls?head=owner:ref&state=all)", () => {
  it("reads the one PR ever opened from #810's branch", () => {
    expect(parseHeadBranchPrs(load("base/head-branch-prs-810.json"), { headRef: "feat/eng-loop-v1-05a" })).toEqual({
      ok: true,
      record: { numbers: [810], capped: false },
    });
  });

  it("an element for another branch, or an unknown state, is malformed", () => {
    const raw = load("base/head-branch-prs-810.json");
    const other = clone(raw);
    other[0].head.ref = "something/else";
    expect(parseHeadBranchPrs(other, { headRef: "feat/eng-loop-v1-05a" })).toMatchObject({ reason: "malformed" });
    const state = clone(raw);
    state[0].state = "merged";
    expect(parseHeadBranchPrs(state, { headRef: "feat/eng-loop-v1-05a" })).toMatchObject({ reason: "malformed" });
    expect(parseHeadBranchPrs({}, { headRef: "x" })).toMatchObject({ reason: "malformed" });
  });

  it("a full page is capped", () => {
    const one = load("base/head-branch-prs-810.json")[0];
    const many = Array.from({ length: 100 }, (_, i) => ({ ...clone(one), number: 1000 + i }));
    expect(parseHeadBranchPrs(many, { headRef: "feat/eng-loop-v1-05a" }).record.capped).toBe(true);
  });
});

describe("parseBranchRules (REST rules/branches/{production})", () => {
  it("reads the real, currently unprotected production branch: no rules at all", () => {
    expect(parseBranchRules(load("base/rules-production-unprotected.json"))).toEqual({
      ok: true,
      record: { types: [], nonFastForward: false, deletion: false },
    });
  });

  it("recognizes the force-push and deletion rules (synthetic: the ruleset Option A will add)", () => {
    const r = parseBranchRules([{ type: "deletion" }, { type: "non_fast_forward" }, { type: "pull_request" }]);
    expect(r.record).toMatchObject({ nonFastForward: true, deletion: true });
  });

  it("a rule without a type is malformed", () => {
    expect(parseBranchRules([{ ruleset_id: 1 }])).toMatchObject({ ok: false, reason: "malformed" });
  });
});

describe("parseActivity (REST activity, filtered by ref and type)", () => {
  const ref = `refs/heads/${PROD}`;
  const event = (o: object = {}) => ({
    id: 1,
    activity_type: "force_push",
    ref,
    timestamp: "2026-10-07T10:00:00Z",
    before: "a".repeat(40),
    after: "b".repeat(40),
    ...o,
  });

  it("reads the real, empty force-push history of production", () => {
    expect(parseActivity(load("base/activity-force-push-none.json"), { activityType: "force_push", ref })).toEqual({
      ok: true,
      record: { events: [], capped: false },
    });
  });

  it("reads a force push (synthetic)", () => {
    const r = parseActivity([event()], { activityType: "force_push", ref });
    expect(r.record.events).toEqual([{ timestamp: "2026-10-07T10:00:00Z", before: "a".repeat(40), after: "b".repeat(40) }]);
  });

  it.each([
    ["another activity type", { activity_type: "push" }],
    ["another ref", { ref: "refs/heads/other" }],
    ["a bad timestamp", { timestamp: "not a time" }],
    ["a bad before sha", { before: "short" }],
  ])("%s is malformed", (_n, o) => {
    expect(parseActivity([event(o)], { activityType: "force_push", ref })).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("a full page is capped", () => {
    const many = Array.from({ length: 100 }, (_, i) => event({ id: i + 1 }));
    expect(parseActivity(many, { activityType: "force_push", ref }).record.capped).toBe(true);
  });
});

describe("bindBase", () => {
  const ok = (r: any) => {
    if (!r.ok) throw new Error(`fixture did not parse: ${r.reason} ${r.detail}`);
    return r.record;
  };

  it("binds #810's drift and context to its key", () => {
    const k = key("pr-810-open-draft.json", 810);
    const r = bindBase({
      key: k,
      productionRef: PROD,
      compare: ok(parseCompare(load("base/compare-810.json"), { baseSha: k.baseSha })),
      prContext: ok(parsePrContext(load("base/pr-context-810.json"), { expectedNumber: 810 })),
    });
    expect(r.ok).toBe(true);
    expect(r.value).toMatchObject({
      drift: { behindBy: 0, aheadBy: 2 },
      changedFiles: 11,
      baseRefChanges: 0,
      associatedPrNumbers: [810],
      filesCapped: false,
    });
    expect(r.value.files).toHaveLength(11);
  });

  it("a PR on a non-production base is base_ref (#776 targets a feature branch)", () => {
    const k = key("pr-776-open-feature-base.json", 776);
    const r = bindBase({
      key: k,
      productionRef: PROD,
      compare: ok(parseCompare(load("base/compare-776-diverged.json"), { baseSha: BASE_TIP })),
      prContext: ok(parsePrContext(load("base/pr-context-810.json"), { expectedNumber: 810 })),
    });
    expect(r).toMatchObject({ ok: false, reason: "base_ref" });
  });

  it("a compare bound to another base than the key's is malformed", () => {
    const k = key("pr-810-open-draft.json", 810);
    const compare = { ...ok(parseCompare(load("base/compare-810.json"), { baseSha: BASE_TIP })), baseSha: "1".repeat(40) };
    const r = bindBase({
      key: k,
      productionRef: PROD,
      compare,
      prContext: ok(parsePrContext(load("base/pr-context-810.json"), { expectedNumber: 810 })),
    });
    expect(r).toMatchObject({ ok: false, reason: "malformed" });
  });
});
