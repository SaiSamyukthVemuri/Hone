// 05B on real recorded evidence: the black-box 05A collector (`collect`) reads the recorded #800 bodies through
// this verifier's own fake transport (SPEC-05A §5.1), and the black-box `decide` decides. Expectations: the
// hand-derived world table (support/worlds.mjs) and the oracle.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import path from "node:path";
import { oracle } from "./oracle";
// @ts-expect-error untyped support module
import { makeFakeRequest, isReadOnlyQuery, routeRest } from "./support/fake-gh.mjs";
// @ts-expect-error untyped support module
import { WORLDS, FAILING_WORLDS, world, HEAD } from "./support/worlds.mjs";
import { cleanupTmp, redirectTmpdir } from "./support/tmp";

redirectTmpdir();
afterAll(cleanupTmp);

const V2 = path.resolve(__dirname, "../../../../scripts/eng/v2");
let collect: any, createReaders: any, POLICY: any, loadLocalCi: any, decide: any;

beforeAll(async () => {
  ({ collect } = await import(path.join(V2, "adapter/collect.mjs")));
  ({ createReaders, POLICY } = await import(path.join(V2, "adapter/internal/github/index.mjs")));
  ({ loadLocalCi } = await import(path.join(V2, "adapter/local-ci.mjs")));
  ({ decide } = await import(path.join(V2, "decision/decide.mjs")));
});

function collectWorld(w: any, log: any[] = []) {
  const readers = createReaders({ request: makeFakeRequest(w, log), policy: POLICY });
  return collect({ prNumber: 800, readers, local: loadLocalCi(), now: () => "2026-10-07T20:00:00Z" });
}
const label = (d: any) => (d.decision === "UNKNOWN" ? `UNKNOWN(${d.reasonCodes[0]})` : d.decision);

describe("REC: decide() on evidence the real collector builds from the recorded #800 bodies", () => {
  for (const w of [...WORLDS, ...FAILING_WORLDS]) {
    const want = w.decision === "UNKNOWN" ? `UNKNOWN(${w.reason})` : w.decision;
    test(`REC ${w.name} → ${want}`, () => {
      const log: any[] = [];
      const c = collectWorld(w.build ? w.build() : world(...w.steps), log);
      const d = decide(c);
      const o = oracle(c);
      expect(label(o), "oracle on the collected evidence").toBe(want);
      expect(label(d), "decide on the collected evidence").toBe(want);
      expect(JSON.stringify(d.blocking)).toBe(JSON.stringify(o.blocking ?? d.blocking));
      expect(d.humanMergeRequired).toBe(true);
      // Every request the collector made is a read SPEC-05A §5.1 lists.
      for (const r of log) expect(r.rest !== undefined ? routeRest(r.rest) !== null : isReadOnlyQuery(r.graphql), JSON.stringify(r).slice(0, 200)).toBe(true);
      if (c.ok) expect(c.evidence.key.headSha).toBe(HEAD);
    });
  }
  test("REC the recorded #800 draft reads DRAFT_HOLD with blocking {headSha} at the full head", () => {
    const d = decide(collectWorld(world()));
    expect(d).toEqual({ decision: "DRAFT_HOLD", reasonCodes: ["DRAFT_HOLD"], blocking: { headSha: HEAD }, nextAction: d.nextAction, humanMergeRequired: true });
  });
  test("REC evidence order: permuting GitHub's listing order changes neither the evidence hash nor the decision", () => {
    const base = world("ready", "protectedRules");
    const shuffledWorld = JSON.parse(JSON.stringify(base));
    const pr = shuffledWorld["review-evidence"].data.repository.pullRequest;
    pr.reviews.nodes.reverse();
    pr.comments.nodes.reverse();
    pr.reviewThreads.nodes.reverse();
    shuffledWorld["commit-rollup"].data.repository.object.statusCheckRollup.contexts.nodes.reverse();
    const a = collectWorld(base), b = collectWorld(shuffledWorld);
    expect(a.ok && b.ok).toBe(true);
    expect(b.evidenceHash).toBe(a.evidenceHash);
    expect(decide(b)).toEqual(decide(a));
  });
});

describe("REC pass 2: the 05A boundary the shepherd relies on (SPEC-05A §5.3 step 0, §5.4 at 738a4537)", () => {
  test("REC-OPTIONS: collect checks every option before any request and never throws; bad options are malformed at stage collect", () => {
    const log: any[] = [];
    const readers = createReaders({ request: makeFakeRequest(world(), log), policy: POLICY });
    const local = loadLocalCi();
    const cases: [string, any][] = [
      ["no options", {}],
      ["PR number 0", { prNumber: 0, readers, local, now: () => "2026-10-07T20:00:00Z" }],
      ["PR number as string", { prNumber: "800", readers, local, now: () => "2026-10-07T20:00:00Z" }],
      ["a reader missing", { prNumber: 800, readers: { ...readers, readRunJobs: undefined }, local, now: () => "2026-10-07T20:00:00Z" }],
      ["local without blobs", { prNumber: 800, readers, local: { classify: local.classify, tablePinned: true }, now: () => "2026-10-07T20:00:00Z" }],
      ["local blob not 40 hex", { prNumber: 800, readers, local: { ...local, blobs: { ...local.blobs, "scripts/classify-changes.mjs": "abc" } }, now: () => "2026-10-07T20:00:00Z" }],
      ["clock returns garbage", { prNumber: 800, readers, local, now: () => "yesterday" }],
      ["clock is a value", { prNumber: 800, readers, local, now: "2026-10-07T20:00:00Z" }],
      ["clock throws", { prNumber: 800, readers, local, now: () => { throw new Error("clock"); } }],
    ];
    for (const [n, opts] of cases) {
      let c: any;
      expect(() => (c = collect(opts)), n).not.toThrow();
      expect(c.ok, n).toBe(false);
      expect(c.reason, n).toBe("malformed");
      expect(c.stage, n).toBe("collect");
    }
    expect(log, "no request before the options are valid").toEqual([]);
  });

  test("REC-HASH-LOCAL: the evidence hash covers the local CI definition (two checkouts never share a hash for different rows)", () => {
    const w = world("ready", "protectedRules", "resolveOpenThread");
    const local = loadLocalCi();
    const a = collect({ prNumber: 800, readers: createReaders({ request: makeFakeRequest(w), policy: POLICY }), local, now: () => "2026-10-07T20:00:00Z" });
    const other = { ...local, blobs: { ...local.blobs, ".github/workflows/ci.yml": "0".repeat(40) } };
    const b = collect({ prNumber: 800, readers: createReaders({ request: makeFakeRequest(w), policy: POLICY }), local: other, now: () => "2026-10-07T20:00:00Z" });
    expect(a.ok && b.ok).toBe(true);
    expect(b.evidenceHash).not.toBe(a.evidenceHash);
    expect(label(decide(a))).toBe("CANDIDATE_READY_FOR_HUMAN_REVIEW");
    expect(label(decide(b))).toBe("UNKNOWN(ci_definition_mismatch)");
  });
});
