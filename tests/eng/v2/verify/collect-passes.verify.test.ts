/* eslint-disable @typescript-eslint/no-explicit-any -- the collector's results and the fake's answers are untyped on purpose */
import { describe, expect, it } from "vitest";
import path from "node:path";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { isUnknownReason } from "../../../../scripts/eng/v2/contract/reasons.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { EVIDENCE_SCHEMA, collect } from "../../../../scripts/eng/v2/adapter/collect.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { POLICY, createReaders } from "../../../../scripts/eng/v2/adapter/internal/github/index.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { classify } from "../../../../scripts/classify-changes.mjs";
import {
  BLOB_CI,
  BLOB_CLASSIFY,
  goldenC,
  fakeTransport,
  jobRunIds,
  keyOf,
  localFrom,
  malformFor,
  normalizeKinds,
  passKinds,
  terminalC,
  type CWorld,
  type FakeOptions,
  type KeyVals,
} from "./support/collector";
import { clone, noThrow } from "./support/deep";
import { rng } from "./support/prng";
import { FAILED_CONCLUSIONS, P0, PRODUCTION_REF, RUN_810, RUN_810_CREATED, ownRun, allGreenJobs, sha40 } from "./support/world";

// ===========================================================================
// INDEPENDENT VERIFIER — SPEC-05A §5.3 (passes) and §5.4 (Evidence), f75ca255.
// The readers are the REAL createReaders over the verifier's own strict fake
// transport (support/collector.ts, written from §5.1's table). Expected outcomes
// come from §5.3/§5.4, PR-SNAPSHOT-01 §3-§4 and ARCH-01 §15 alone.
// ===========================================================================

const ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const NOW = "2026-10-07T21:00:00Z";
const LOCAL = () => localFrom(ROOT, classify);

interface Run {
  r: any;
  fake: ReturnType<typeof fakeTransport>;
}
async function run(w: CWorld, opts: FakeOptions = {}, extra: { now?: () => any; local?: any; prNumber?: any } = {}): Promise<Run> {
  const fake = fakeTransport(w, opts);
  const readers = createReaders({ request: fake.request, policy: POLICY });
  const out = noThrow(() =>
    collect({ prNumber: extra.prNumber ?? w.base.pr.number, readers, local: extra.local ?? LOCAL(), now: extra.now ?? (() => NOW), policy: POLICY }),
  );
  if (out.threw) return { r: { THREW: String(out.error) }, fake };
  const v: any = out.value;
  return { r: v && typeof v.then === "function" ? await v : v, fake };
}
/** keys from read n onward take these values (a lasting move, not a flicker) */
const fromRead = (n: number, over: Partial<KeyVals>, upTo = 12): Record<number, Partial<KeyVals>> =>
  Object.fromEntries(Array.from({ length: upTo - n + 1 }, (_, i) => [n + i, over]));
const expectFailure = (r: any, reason: string | string[], stage: "collect" | "confirm", label = "") => {
  expect(r?.ok, `${label}: ${JSON.stringify(r).slice(0, 300)}`).toBe(false);
  expect([reason].flat(), `${label}: reason ${r?.reason}`).toContain(r?.reason);
  expect(r?.stage, `${label}: stage`).toBe(stage);
  // §5.4 "never partial evidence"
  for (const k of Object.keys(r)) expect(["ok", "reason", "detail", "stage", "diagnostics"], `${label}: failure carries ${k}`).toContain(k);
};
const twoPasses = (w: CWorld) => [...passKinds(w), ...passKinds(w)];

describe("collector §5.3/§5.4: the golden collection", () => {
  it("collects #810 (golden) in two identical passes, in §5.3's fixed order, with every row bound", async () => {
    const w = goldenC();
    const { r, fake } = await run(w);
    expect(fake.violations).toEqual([]);
    expect(normalizeKinds(fake.kinds())).toEqual(normalizeKinds(twoPasses(w)));
    expect(r.ok, JSON.stringify(r).slice(0, 400)).toBe(true);
    expect(Object.keys(r).sort()).toEqual(["diagnostics", "evidence", "evidenceHash", "ok"]);
    expect(r.evidence.schema).toBe("eng-loop-v1/evidence@1");
    expect(EVIDENCE_SCHEMA).toBe("eng-loop-v1/evidence@1");
    expect(r.evidence.observedAt).toBe(NOW);
    expect(r.evidence.terminal).toBe(false);
    expect(r.evidence.key).toMatchObject({ prNumber: 810, state: "OPEN", headSha: w.base.pr.headSha, baseSha: P0 });
    expect(Object.keys(r.evidence.rows).sort()).toEqual(["base", "ci", "external", "reviews"]);
    expect(r.evidence.rows.base.ok).toBe(true);
    expect(r.evidence.rows.ci).toMatchObject({ ok: true, value: { outcome: "SUCCEEDED", applicableRunIds: [RUN_810] } });
    expect(r.evidence.rows.reviews.ok).toBe(true);
    expect(r.evidence.rows.external).toMatchObject({ ok: true });
    expect(r.evidence.rows.external.value.external.map((e: any) => `${e.source}=${e.state}`).sort()).toEqual(["Vercel Preview Comments=success", "Vercel=success"]);
    expect(r.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.diagnostics).toMatchObject({ observedAt: NOW, attempts: 1, confirmed: true });
  });

  it("a Date-returning clock is reported as an ISO-8601 time", async () => {
    const { r } = await run(goldenC(), {}, { now: () => new Date(NOW) });
    expect(r.ok).toBe(true);
    expect(Date.parse(r.evidence.observedAt)).toBe(Date.parse(NOW));
  });
});

describe("collector §5.3: a terminal key reads nothing but the key (PR-SNAPSHOT-01 §7)", () => {
  for (const [label, w] of [
    ["MERGED", terminalC("MERGED")],
    ["CLOSED with a deleted head repository", terminalC("CLOSED", null)],
  ] as const) {
    it(`${label}: four key reads in two passes, rows null, a valid terminal key`, async () => {
      const { r, fake } = await run(w);
      expect(fake.violations).toEqual([]);
      expect(fake.kinds()).toEqual(["key", "key", "key", "key"]);
      expect(r.ok).toBe(true);
      expect(r.evidence).toMatchObject({ terminal: true, rows: null, key: { baseSha: null, state: w.state } });
      expect(r.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
    });
  }
});

describe("collector §5.3: key movement — one retry in the first collection, none in the confirming pass", () => {
  const moves: Array<[string, Partial<KeyVals>]> = [
    ["the draft flag", { isDraft: true }],
    ["the head", { headSha: sha40(0x4ead) }],
    ["the live base tip", { baseSha: sha40(0xba5e) }],
    ["the state", { state: "CLOSED", baseSha: null }],
  ];
  for (const [what, over] of moves) {
    it(`${what} moves at K1 of the first pass and stays: the retry's coherent pass is used (attempts 2)`, async () => {
      const w = goldenC();
      const { r, fake } = await run(w, { keys: fromRead(2, over) });
      expect(fake.violations).toEqual([]);
      if (over.state === "CLOSED") {
        expect(r.ok).toBe(true);
        expect(r.evidence.terminal).toBe(true);
        return;
      }
      expect(r.ok, JSON.stringify(r).slice(0, 300)).toBe(true);
      expect(r.diagnostics.attempts).toBe(2);
      for (const [k, v] of Object.entries(over)) expect(r.evidence.key[k === "headSha" ? "headSha" : k]).toBe(v);
    });

    it(`${what} moves inside BOTH collection passes: pr_key_moved at stage collect, no confirming pass`, async () => {
      const w = goldenC();
      const { r, fake } = await run(w, { keys: { 2: over, 4: over } });
      expectFailure(r, "pr_key_moved", "collect", what);
      expect(fake.violations).toEqual([]);
      expect(fake.kinds().filter((k) => k === "key").length).toBe(4);
    });

    it(`${what} differs between the coherent pass and the confirming pass: pr_key_moved at stage confirm`, async () => {
      const { r, fake } = await run(goldenC(), { keys: fromRead(3, over) });
      expectFailure(r, "pr_key_moved", "confirm", what);
      expect(fake.violations).toEqual([]);
    });

    it(`${what} moves inside the confirming pass (K1'): pr_key_moved at stage confirm, never a retry`, async () => {
      const w = goldenC();
      const { r, fake } = await run(w, { keys: { 4: over } });
      expectFailure(r, "pr_key_moved", "confirm", what);
      expect(fake.kinds().filter((k) => k === "key").length).toBe(4);
    });
  }
});

describe("collector §5.3: unstable evidence between the two passes is unstable_snapshot", () => {
  const changes: Array<[string, (w: CWorld) => void]> = [
    ["the compare (production advanced; behind 1)", (w) => ((w.base.compare.behindBy = 1), (w.base.compare.status = "diverged"))],
    ["the associated PRs", (w) => (w.base.prContext.associated = [810, 811])],
    ["the head-branch PR list", (w) => w.base.headBranchPrs.push({ number: 702, state: "closed" })],
    ["the branch rules", (w) => (w.base.rules = ["non_fast_forward"])],
    ["the activity (a force push appeared)", (w) => w.base.activity.forcePush.push({ timestamp: NOW, before: sha40(1), after: P0 })],
    ["the run's state (a re-run started)", (w) => (w.base.runs[0] = ownRun({ status: "in_progress", conclusion: null, runAttempt: 2 }))],
    ["the run's jobs", (w) => (w.base.jobs[RUN_810] = allGreenJobs().map((j) => (j.name === "changed-path detection" ? { ...j, conclusion: "failure" } : j)))],
    ["the review evidence (a new comment)", (w) => {
      const p = w.review.data.repository.pullRequest;
      p.comments.nodes.push({ ...clone(p.comments.nodes[1]), databaseId: 7000000001, body: "@codex review" });
      p.comments.totalCount += 1;
    }],
    ["the rollup (Vercel went pending)", (w) => {
      const n = w.rollup.data.repository.object.statusCheckRollup.contexts.nodes.find((x: any) => x.__typename === "StatusContext");
      n.state = "PENDING";
    }],
    ["production's ci.yml blob", (w) => (w.prodBlobs[BLOB_CI] = sha40(0xb10b))],
  ];
  const diags: Record<string, string> = {};
  for (const [what, f] of changes) {
    it(`${what}: unstable_snapshot at stage confirm, and the diagnostics name what changed`, async () => {
      const w = goldenC();
      const w2 = goldenC();
      f(w2);
      const { r, fake } = await run(w, { passWorlds: { 1: w2 } });
      expectFailure(r, "unstable_snapshot", "confirm", what);
      expect(fake.violations).toEqual([]);
      expect(typeof r.diagnostics).toBe("object");
      diags[what] = JSON.stringify(r.diagnostics);
    });
  }
  it("a merely REORDERED answer in the confirming pass is not unstable: the body is compared canonically (§0, §5.4)", async () => {
    const r0 = rng(0x0de5);
    for (let k = 0; k < 3; k++) {
      const w2 = goldenC();
      w2.base.compare.files = r0.shuffle(w2.base.compare.files);
      w2.base.rules = r0.shuffle(w2.base.rules);
      w2.base.activity.branchCreation = r0.shuffle([...w2.base.activity.branchCreation, { timestamp: "2026-05-16T14:46:37Z", before: "0".repeat(40), after: P0 }]);
      w2.base.jobs[RUN_810] = r0.shuffle(w2.base.jobs[RUN_810] as any[]);
      const p = w2.review.data.repository.pullRequest;
      p.reviews.nodes = r0.shuffle(p.reviews.nodes);
      p.comments.nodes = r0.shuffle(p.comments.nodes);
      p.reviewThreads.nodes = r0.shuffle(p.reviewThreads.nodes);
      const c = w2.rollup.data.repository.object.statusCheckRollup.contexts;
      c.nodes = r0.shuffle(c.nodes);
      const w1 = goldenC();
      w1.base.activity.branchCreation = [...w1.base.activity.branchCreation, { timestamp: "2026-05-16T14:46:37Z", before: "0".repeat(40), after: P0 }];
      const { r, fake } = await run(w1, { passWorlds: { 1: w2 } });
      expect(fake.violations).toEqual([]);
      expect(r.ok, `shuffle ${k}: ${JSON.stringify(r).slice(0, 300)}`).toBe(true);
    }
  });

  it("the diagnostics depend on WHICH body field changed (§5.3 'name the body fields that changed')", () => {
    const vals = Object.values(diags);
    expect(vals.length).toBe(changes.length);
    expect(new Set(vals).size, JSON.stringify(diags, null, 1)).toBeGreaterThan(changes.length / 2);
  });
});

describe("collector §5.3: the first failure ends the pass with its reason — at EVERY request position of both passes", () => {
  const w0 = goldenC();
  const seq = twoPasses(w0);
  const firstPassLength = passKinds(w0).length;

  it("the golden sequence is 2 x 15 requests (13 reads, 1 job listing, 2 key reads per pass)", () => {
    expect(seq.length).toBe(30);
    expect(firstPassLength).toBe(15);
  });

  for (let p = 1; p <= seq.length; p++) {
    const stage = p <= firstPassLength ? "collect" : "confirm";
    it(`position ${p} (${seq[p - 1]}): an interruption is read_failed at ${stage}, and nothing is read after it`, async () => {
      const { r, fake } = await run(goldenC(), { faults: { [p]: { kind: "fail", reason: "read_failed", detail: `gh: interrupted at ${p}` } } });
      expectFailure(r, "read_failed", stage, `p${p}`);
      expect(fake.log.length, `p${p}: reads after the failure`).toBe(p);
      expect(fake.violations).toEqual([]);
    });
    it(`position ${p} (${seq[p - 1]}): a malformed answer is malformed at ${stage}`, async () => {
      const { r, fake } = await run(goldenC(), { faults: { [p]: { kind: "mutate", f: malformFor(String(seq[p - 1])) } } });
      expectFailure(r, "malformed", stage, `p${p}`);
      expect(fake.log.length).toBe(p);
    });
    it(`position ${p} (${seq[p - 1]}): a refusal (HTTP 403) is read_failed at ${stage}`, async () => {
      const { r } = await run(goldenC(), { faults: { [p]: { kind: "fail", reason: "read_failed", detail: "run-jobs: gh: Resource not accessible by personal access token (HTTP 403)" } } });
      expectFailure(r, "read_failed", stage, `p${p}`);
    });
  }

  for (const p of [1, 2, 9, 14, 16, 24, 30]) {
    it(`position ${p}: a transport that throws never makes collect throw, and fails closed`, async () => {
      const { r } = await run(goldenC(), { faults: { [p]: { kind: "throw" } } });
      expect(r.THREW, String(r.THREW)).toBeUndefined();
      expect(r.ok).toBe(false);
      expect(isUnknownReason(r.reason)).toBe(true);
    });
  }

  // §0 "reason is always a member of contract/reasons.mjs": a transport bug must not leak an open reason
  for (const [what, fault] of [
    ["a failure whose reason is outside the closed set", { kind: "fail", reason: "teapot", detail: "x" }],
    ["an answer that is undefined", { kind: "raw", value: undefined }],
    ["ok without a body", { kind: "raw", value: { ok: true } }],
    ["a promise instead of a result", { kind: "raw", value: Promise.resolve({ ok: true, body: {} }) }],
  ] as const) {
    for (const p of [1, 2, 16]) {
      it(`position ${p}: ${what} fails closed with a closed reason`, async () => {
        const { r } = await run(goldenC(), { faults: { [p]: fault as any } });
        expect(r.THREW, String(r.THREW)).toBeUndefined();
        expect(r.ok).toBe(false);
        expect(isUnknownReason(r.reason), `reason ${r.reason}`).toBe(true);
      });
    }
  }

  it("precedence is the fixed read order: with two failures, the earlier read's reason wins", async () => {
    // runs (position 9) too large, review (position 10) incomplete, rollup (position 11) malformed
    const tooLarge = (b: any) => ({ ...b, total_count: 101 });
    const incomplete = (b: any) => ((b.data.repository.pullRequest.reviews.pageInfo.hasNextPage = true), b);
    const { r } = await run(goldenC(), {
      faults: { 9: { kind: "mutate", f: tooLarge }, 10: { kind: "mutate", f: incomplete }, 11: { kind: "mutate", f: malformFor("rollup") } },
    });
    expectFailure(r, "ci_candidate_listing_too_large", "collect", "9<10<11");
    const { r: r2 } = await run(goldenC(), { faults: { 10: { kind: "mutate", f: incomplete }, 11: { kind: "mutate", f: malformFor("rollup") } } });
    expectFailure(r2, "review_evidence_too_large", "collect", "10<11");
    const { r: r3 } = await run(goldenC(), { faults: { 2: { kind: "fail" }, 11: { kind: "mutate", f: malformFor("rollup") } } });
    expectFailure(r3, "read_failed", "collect", "2<11");
  });
});

describe("collector §5.1/§5.3: answers for another request are refused by the reader's echo check", () => {
  const wrong: Array<[string, number, (b: any) => any]> = [
    ["a compare for another base", 2, (b) => ((b.base_commit.sha = sha40(0xbad)), b)],
    ["a PR context for another PR number", 3, (b) => ((b.data.repository.pullRequest.number = 811), b)],
    ["a head-branch listing for another branch", 4, (b) => ((b[0].head.ref = "feat/other"), b)],
    ["an activity listing for another ref", 6, () => [{ activity_type: "force_push", ref: "refs/heads/main", timestamp: NOW, before: sha40(1), after: sha40(2) }]],
    ["review evidence for another PR number", 10, (b) => ((b.data.repository.pullRequest.number = 811), b)],
    ["a rollup for another commit", 11, (b) => ((b.data.repository.object.oid = sha40(0xc0)), b)],
    ["a file blob for another path", 12, (b) => ({ ...b, path: "package.json" })],
    ["a job listing for another run", 14, (b) => ((b.jobs = b.jobs.map((j: any) => ({ ...j, run_id: 1 }))), b)],
  ];
  for (const [what, p, f] of wrong) {
    it(`${what} (request ${p}) is malformed at stage collect`, async () => {
      const { r } = await run(goldenC(), { faults: { [p]: { kind: "mutate", f } } });
      expectFailure(r, "malformed", "collect", what);
    });
  }
  it("a runs listing for another head is not echo-checked (§3.1: the request's filters are never trusted): its runs are ignored, the CI row is NO_RUN", async () => {
    const { r, fake } = await run(goldenC(), { kindFaults: { runs: { kind: "mutate", f: (b: any) => ((b.workflow_runs = b.workflow_runs.map((x: any) => ({ ...x, head_sha: sha40(0x0e) }))), b) } } });
    expect(r.ok, JSON.stringify(r).slice(0, 300)).toBe(true);
    expect(r.evidence.rows.ci).toMatchObject({ ok: true, value: { outcome: "NO_RUN", applicableRunIds: [] } });
    expect(fake.kinds().some((k) => String(k).startsWith("jobs:")), "no jobs read for runs that are not applicable").toBe(false);
  });
});

describe("collector §5.3: jobs are read for exactly the applicable, completed/success runs", () => {
  const mixed = () => {
    const w = goldenC();
    w.base.runs = [
      ownRun({ id: 37672136569, runNumber: 2853, event: "push", headBranch: PRODUCTION_REF, createdAt: "2026-10-07T19:07:49Z", template: "push" }),
      ownRun({ id: 37_700_000_001, runNumber: 2856, headBranch: "feat/someone-else" }),
      ownRun({ id: 37_700_000_002, runNumber: 2857, workflowId: 1 }),
      ownRun({ id: 37_700_000_003, runNumber: 2858, headRepoId: 4242 }),
      ownRun(), // applicable, completed/success
      ownRun({ id: 37_700_000_005, runNumber: 2860, createdAt: "2026-10-07T20:30:00Z" }), // applicable, completed/success
      ownRun({ id: 37_700_000_006, runNumber: 2861, createdAt: "2026-10-07T20:40:00Z", status: "in_progress", conclusion: null }), // applicable, pending
    ];
    w.base.jobs = { [RUN_810]: allGreenJobs(), 37_700_000_005: allGreenJobs() };
    return w;
  };

  it("two applicable green runs out of seven: exactly their two job listings, in both passes", async () => {
    const w = mixed();
    expect(jobRunIds(w)).toEqual([RUN_810, 37_700_000_005].sort((a, b) => a - b));
    const { r, fake } = await run(w);
    expect(fake.violations, "a jobs read for a run that is not applicable and green").toEqual([]);
    expect(normalizeKinds(fake.kinds())).toEqual(normalizeKinds(twoPasses(w)));
    expect(r.ok).toBe(true);
    expect(r.evidence.rows.ci).toMatchObject({ ok: true, value: { outcome: "PENDING" } });
  });

  it("an applicable FAILED run gets no job listing; the CI row is FAILED", async () => {
    const w = goldenC();
    w.base.runs = [ownRun({ conclusion: "failure" })];
    w.base.jobs = {};
    const { r, fake } = await run(w);
    expect(fake.violations).toEqual([]);
    expect(fake.kinds().some((k) => String(k).startsWith("jobs:"))).toBe(false);
    expect(r.evidence.rows.ci).toMatchObject({ ok: true, value: { outcome: "FAILED" } });
  });

  it("a green run's job listing that cannot be complete fails the collection (first failure), not just the row", async () => {
    const w = goldenC();
    w.base.jobs[RUN_810] = { tooLarge: true };
    const { r } = await run(w);
    expectFailure(r, "ci_candidate_listing_too_large", "collect", "jobs too large");
  });

  it("every failed conclusion: no jobs read", async () => {
    for (const c of FAILED_CONCLUSIONS) {
      const w = goldenC();
      w.base.runs = [ownRun({ conclusion: c })];
      w.base.jobs = {};
      const { fake } = await run(w);
      expect(fake.violations, c).toEqual([]);
    }
  });
});

describe("collector §5.2: the CI definition the shepherd executes (ci_definition_mismatch is a CI row result)", () => {
  const cases: Array<[string, (w: CWorld) => void, (l: any) => any]> = [
    ["production's ci.yml blob at K0.baseSha differs from the local one", (w) => (w.prodBlobs[BLOB_CI] = sha40(0x1c1)), (l) => l],
    ["production's classifier blob differs from the local one", (w) => (w.prodBlobs[BLOB_CLASSIFY] = sha40(0x1c2)), (l) => l],
    ["the local table is not pinned to the local ci.yml", () => {}, (l) => ({ ...l, tablePinned: false })],
    ["the local classifier throws", () => {}, (l) => ({ ...l, classify: () => { throw new Error("classifier exploded"); } })],
  ];
  for (const [what, editWorld, editLocal] of cases) {
    it(`${what}: the collection succeeds and the CI row is ci_definition_mismatch`, async () => {
      const w = goldenC();
      editWorld(w);
      const { r, fake } = await run(w, {}, { local: editLocal(LOCAL()) });
      expect(fake.violations).toEqual([]);
      expect(r.ok, JSON.stringify(r).slice(0, 300)).toBe(true);
      expect(r.evidence.rows.ci).toMatchObject({ ok: false, reason: "ci_definition_mismatch" });
      expect(r.evidence.rows.base.ok).toBe(true);
    });
  }
});

describe("collector §5.3 step 4: a binder's closed failure is a row result, not a collection failure", () => {
  const cases: Array<[string, (w: CWorld) => void, string, string]> = [
    ["a non-production base", (w) => (w.base.pr.baseRef = "release/x"), "base", "base_ref"],
    ["a fork head", (w) => (w.base.pr.headRepoId = 4242), "ci", "fork_head"],
    ["a base change", (w) => (w.base.prContext.baseRefEvents = 1), "ci", "base_ref_changed"],
    ["a production with no rules", (w) => (w.base.rules = []), "ci", "base_history_unverified"],
    ["a review state outside GitHub's five", (w) => (w.review.data.repository.pullRequest.reviews.nodes[0].state = "REQUEST_CHANGES"), "reviews", "malformed"],
    ["a CheckRun with no app", (w) => (w.rollup.data.repository.object.statusCheckRollup.contexts.nodes.find((n: any) => n.__typename === "CheckRun").checkSuite = { app: null }), "external", "malformed"],
    ["an unrecognized external state", (w) => (w.rollup.data.repository.object.statusCheckRollup.contexts.nodes.find((n: any) => n.__typename === "StatusContext").state = "SOMETHING_NEW"), "external", "unrecognized_context_state"],
  ];
  for (const [what, f, row, reason] of cases) {
    it(`${what}: ok collection, rows.${row} = ${reason}`, async () => {
      const w = goldenC();
      f(w);
      const { r, fake } = await run(w);
      expect(fake.violations).toEqual([]);
      expect(r.ok, JSON.stringify(r).slice(0, 300)).toBe(true);
      expect(r.evidence.rows[row]).toMatchObject({ ok: false, reason });
      if (row === "base") expect(r.evidence.rows.ci.ok, "the CI row cannot pass without a base").toBe(false);
    });
  }
});

describe("collector §5.4: evidenceHash", () => {
  const hashOf = async (w: CWorld, opts: FakeOptions = {}, now = NOW) => {
    const { r } = await run(w, opts, { now: () => now });
    expect(r.ok, JSON.stringify(r).slice(0, 200)).toBe(true);
    return r.evidenceHash as string;
  };

  it("is deterministic, and the observation time is reported, never hashed", async () => {
    const a = await hashOf(goldenC());
    expect(await hashOf(goldenC())).toBe(a);
    expect(await hashOf(goldenC(), {}, "2026-12-25T00:00:00Z")).toBe(a);
  });

  it("GitHub's listing order cannot change it: every list answer shuffled, in both passes", async () => {
    const a = await hashOf(goldenC());
    const r = rng(0x5a5);
    for (let k = 0; k < 4; k++) {
      const w = goldenC();
      w.base.compare.files = r.shuffle(w.base.compare.files);
      w.base.prContext.associated = [810];
      w.base.rules = r.shuffle(w.base.rules);
      w.base.activity.branchCreation = r.shuffle(w.base.activity.branchCreation);
      w.base.jobs[RUN_810] = r.shuffle(w.base.jobs[RUN_810] as any[]);
      const p = w.review.data.repository.pullRequest;
      p.reviews.nodes = r.shuffle(p.reviews.nodes);
      p.comments.nodes = r.shuffle(p.comments.nodes);
      p.reviewThreads.nodes = r.shuffle(p.reviewThreads.nodes);
      const c = w.rollup.data.repository.object.statusCheckRollup.contexts;
      c.nodes = r.shuffle(c.nodes);
      expect(await hashOf(w, { passWorlds: { 1: w } }), `shuffle ${k}`).toBe(a);
    }
  });

  it("any material change in the evidence changes it", async () => {
    const a = await hashOf(goldenC());
    const edits: Array<[string, (w: CWorld) => void]> = [
      ["the run's conclusion", (w) => (w.base.runs[0] = ownRun({ conclusion: "failure" }))],
      ["the draft flag", (w) => (w.base.pr.isDraft = true)],
      ["a review body", (w) => (w.review.data.repository.pullRequest.comments.nodes[1].body = "@codex review please")],
      ["an external state", (w) => (w.rollup.data.repository.object.statusCheckRollup.contexts.nodes.find((n: any) => n.__typename === "StatusContext").state = "FAILURE")],
      ["a creation event", (w) => w.base.activity.branchCreation.push({ timestamp: "2026-06-01T00:00:00Z", before: "0".repeat(40), after: P0 })],
      ["the drift", (w) => ((w.base.compare.behindBy = 2), (w.base.compare.status = "diverged"))],
      ["production's classifier blob", (w) => (w.prodBlobs[BLOB_CLASSIFY] = sha40(0xc1a))],
    ];
    const seen = new Set([a]);
    for (const [what, f] of edits) {
      const w = goldenC();
      f(w);
      const h = await hashOf(w);
      expect(seen.has(h), `${what} left the hash unchanged`).toBe(false);
      seen.add(h);
    }
  });

  // A consequence §5.4 mandates, pinned so 05B/05C cannot miss it: the hash identifies GitHub's answers only.
  it("equal hashes do NOT imply equal rows: observedAt (step 8's 360-day window) and the local CI definition are outside the hash", async () => {
    const w = goldenC();
    w.base.activity.branchCreation = []; // production older than the recorded year
    w.base.runs = [ownRun({ createdAt: "2025-10-13T09:00:00Z" })];
    const a = (await run(w, {}, { now: () => "2026-10-07T21:00:00Z" })).r;
    const b = (await run(w, {}, { now: () => "2026-10-08T21:00:00Z" })).r;
    expect(a.evidence.rows.ci).toMatchObject({ ok: true, value: { outcome: "SUCCEEDED" } });
    expect(b.evidence.rows.ci).toMatchObject({ ok: false, reason: "base_history_unverified" });
    expect(b.evidenceHash).toBe(a.evidenceHash);
    const c = (await run(goldenC(), {}, { local: { ...LOCAL(), tablePinned: false } })).r;
    const d = (await run(goldenC())).r;
    expect(c.evidence.rows.ci).toMatchObject({ ok: false, reason: "ci_definition_mismatch" });
    expect(d.evidence.rows.ci).toMatchObject({ ok: true, value: { outcome: "SUCCEEDED" } });
    expect(c.evidenceHash).toBe(d.evidenceHash);
  });

  it("terminal: equal keys hash equal; a different draft flag hashes differently", async () => {
    const a = await hashOf(terminalC("MERGED"));
    expect(await hashOf(terminalC("MERGED"), {}, "2027-01-01T00:00:00Z")).toBe(a);
    const w = terminalC("MERGED");
    w.base.pr.isDraft = true;
    expect(await hashOf(w)).not.toBe(a);
  });
});

describe("collector: inputs outside the contract fail closed before any request, and collect never throws", () => {
  for (const [label, prNumber] of [
    ["a string PR number", "810"],
    ["zero", 0],
    ["a fraction", 810.5],
  ] as const) {
    it(`${label}: refused before any request`, async () => {
      const { r, fake } = await run(goldenC(), {}, { prNumber });
      expect(r.THREW, String(r.THREW)).toBeUndefined();
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("malformed");
      expect(fake.log.length).toBe(0);
    });
  }

  it("missing or empty readers fail closed (read_failed) without throwing", async () => {
    for (const [label, readers] of [
      ["no readers", undefined],
      ["empty readers", {}],
      ["null readers", null],
    ] as const) {
      const out = noThrow(() => collect({ prNumber: 810, readers, local: LOCAL(), now: () => NOW, policy: POLICY }));
      expect(out.threw, `${label}: ${(out as any).error}`).toBe(false);
      const v = (out as any).value;
      const res = v && typeof v.then === "function" ? await v : v;
      expect(res?.ok, label).toBe(false);
      expect(isUnknownReason(res?.reason), `${label}: ${res?.reason}`).toBe(true);
    }
  });

  // §5.4 defines failure as a result ({ ok: false, reason, detail, stage, diagnostics }) and §0 says nothing
  // throws. A clock that is not a function, a clock that returns no time, and null options are caller misuse,
  // but each must still fail closed rather than throw.
  const fresh = () => createReaders({ request: fakeTransport(goldenC()).request, policy: POLICY });
  for (const [label, args] of [
    ["a clock that is a string, not a function", () => ({ prNumber: 810, readers: fresh(), local: LOCAL(), now: NOW, policy: POLICY })],
    ["a clock that returns no time", () => ({ prNumber: 810, readers: fresh(), local: LOCAL(), now: () => "not a time", policy: POLICY })],
    ["null options", () => null],
    ["no local CI definition", () => ({ prNumber: 810, readers: fresh(), local: undefined, now: () => NOW, policy: POLICY })],
    ["a local CI definition without blobs", () => ({ prNumber: 810, readers: fresh(), local: { classify, tablePinned: true }, now: () => NOW, policy: POLICY })],
  ] as const) {
    it(`${label}: collect fails closed and never throws`, async () => {
      const out = noThrow(() => collect(args()));
      expect(out.threw, `${label}: ${(out as any).error}`).toBe(false);
      const v = (out as any).value;
      const res = v && typeof v.then === "function" ? await v : v;
      expect(res?.ok, label).toBe(false);
      expect(isUnknownReason(res?.reason), `${label}: ${res?.reason}`).toBe(true);
    });
  }
});

void keyOf;
void RUN_810_CREATED;
void BLOB_CLASSIFY;
