/* eslint-disable @typescript-eslint/no-explicit-any -- the collector's results and the fake's answers are untyped on purpose */
// Independent verifier support: NAMED collector rows (SPEC-05A §5.3/§5.4), parametrized
// by the system under test, so a mutant of collect or of the readers is judged by the
// same rows the real collector satisfies. Each check returns null when the row holds,
// else a short reason. Expected outcomes come from §5.3/§5.4 alone.

import path from "node:path";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { POLICY } from "../../../../../scripts/eng/v2/adapter/internal/github/index.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { classify } from "../../../../../scripts/classify-changes.mjs";
import { BLOB_CI, BLOB_CLASSIFY, fakeTransport, goldenC, localFrom, malformFor, normalizeKinds, passKinds, type CWorld, type FakeOptions, type KeyVals } from "./collector";
import { clone, noThrow } from "./deep";
import { PRODUCTION_REF, RUN_810, allGreenJobs, ownRun, sha40 } from "./world";

export interface CollectSut {
  collect: (opts: any) => any;
  createReaders: (opts: any) => any;
}

const ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
export const NOW = "2026-10-07T21:00:00Z";
export const LOCAL = () => localFrom(ROOT, classify);

export async function runWith(sut: CollectSut, w: CWorld, opts: FakeOptions = {}, extra: { now?: () => any; local?: any } = {}) {
  const fake = fakeTransport(w, opts);
  const readers = sut.createReaders({ request: fake.request, policy: POLICY });
  const out = noThrow(() => sut.collect({ prNumber: w.base.pr.number, readers, local: extra.local ?? LOCAL(), now: extra.now ?? (() => NOW), policy: POLICY }));
  if (out.threw) return { r: { THREW: String(out.error) } as any, fake };
  const v: any = out.value;
  return { r: v && typeof v.then === "function" ? await v : v, fake };
}

const ALLOWED_FAILURE_KEYS = ["ok", "reason", "detail", "stage", "diagnostics"];
function failure(r: any, reason: string, stage: string): string | null {
  if (r?.ok !== false) return `expected failure ${reason}@${stage}, got ok=${r?.ok}`;
  if (r.reason !== reason) return `reason ${r.reason} (expected ${reason})`;
  if (r.stage !== stage) return `stage ${r.stage} (expected ${stage})`;
  const extra = Object.keys(r).filter((k) => !ALLOWED_FAILURE_KEYS.includes(k));
  if (extra.length) return `failure carries ${extra.join(",")} (never partial evidence)`;
  return null;
}
const fromRead = (n: number, over: Partial<KeyVals>, upTo = 12): Record<number, Partial<KeyVals>> =>
  Object.fromEntries(Array.from({ length: upTo - n + 1 }, (_, i) => [n + i, over]));

export function mixedRunsWorld(): CWorld {
  const w = goldenC();
  w.base.runs = [
    ownRun({ id: 37672136569, runNumber: 2853, event: "push", headBranch: PRODUCTION_REF, createdAt: "2026-10-07T19:07:49Z", template: "push" }),
    ownRun({ id: 37_700_000_001, runNumber: 2856, headBranch: "feat/someone-else" }),
    ownRun({ id: 37_700_000_002, runNumber: 2857, workflowId: 1 }),
    ownRun({ id: 37_700_000_003, runNumber: 2858, headRepoId: 4242 }),
    ownRun(),
    ownRun({ id: 37_700_000_005, runNumber: 2860, createdAt: "2026-10-07T20:30:00Z" }),
    ownRun({ id: 37_700_000_006, runNumber: 2861, createdAt: "2026-10-07T20:40:00Z", status: "in_progress", conclusion: null }),
  ];
  w.base.jobs = { [RUN_810]: allGreenJobs(), 37_700_000_005: allGreenJobs() };
  return w;
}

const unstable =
  (f: (w: CWorld) => void) =>
  async (sut: CollectSut): Promise<string | null> => {
    const w2 = goldenC();
    f(w2);
    const { r } = await runWith(sut, goldenC(), { passWorlds: { 1: w2 } });
    return failure(r, "unstable_snapshot", "confirm");
  };
const interrupt =
  (p: number, stage: "collect" | "confirm") =>
  async (sut: CollectSut): Promise<string | null> => {
    const { r, fake } = await runWith(sut, goldenC(), { faults: { [p]: { kind: "fail", reason: "read_failed", detail: `gh: interrupted at ${p}` } } });
    return failure(r, "read_failed", stage) ?? (fake.log.length === p ? null : `${fake.log.length} reads, the failure was read ${p}`);
  };
const mismatch =
  (path_: string) =>
  async (sut: CollectSut): Promise<string | null> => {
    const w = goldenC();
    w.prodBlobs[path_] = sha40(0x1c1);
    const { r } = await runWith(sut, w);
    if (r?.ok !== true) return `collection failed: ${r?.reason}`;
    return r.evidence?.rows?.ci?.ok === false && r.evidence.rows.ci.reason === "ci_definition_mismatch" ? null : `ci row ${JSON.stringify(r.evidence?.rows?.ci).slice(0, 120)}`;
  };

export const COLLECT_ROWS: Record<string, { clause: string; check: (sut: CollectSut) => Promise<string | null> }> = {
  golden: {
    clause: "§5.3 1-2, §5.4: two passes in the fixed order, every row bound",
    check: async (sut) => {
      const w = goldenC();
      const { r, fake } = await runWith(sut, w);
      if (fake.violations.length) return fake.violations[0];
      if (JSON.stringify(normalizeKinds(fake.kinds())) !== JSON.stringify(normalizeKinds([...passKinds(w), ...passKinds(w)]))) return `reads ${fake.kinds().join(",")}`;
      if (r?.ok !== true) return `not ok: ${r?.reason}`;
      return r.evidence?.rows?.ci?.value?.outcome === "SUCCEEDED" ? null : "ci not SUCCEEDED";
    },
  },
  "unstable-compare": { clause: "§5.3 3 unstable_snapshot", check: unstable((w) => ((w.base.compare.behindBy = 1), (w.base.compare.status = "diverged"))) },
  "unstable-run": { clause: "§5.3 3 unstable_snapshot", check: unstable((w) => (w.base.runs[0] = ownRun({ status: "in_progress", conclusion: null, runAttempt: 2 }))) },
  "unstable-review": {
    clause: "§5.3 3 unstable_snapshot",
    check: unstable((w) => {
      const p = w.review.data.repository.pullRequest;
      p.comments.nodes.push({ ...clone(p.comments.nodes[1]), databaseId: 7000000001, body: "@codex review" });
      p.comments.totalCount += 1;
    }),
  },
  "unstable-rollup": {
    clause: "§5.3 3 unstable_snapshot",
    check: unstable((w) => {
      w.rollup.data.repository.object.statusCheckRollup.contexts.nodes.find((x: any) => x.__typename === "StatusContext").state = "PENDING";
    }),
  },
  "unstable-blob": { clause: "§5.3 3 unstable_snapshot", check: unstable((w) => (w.prodBlobs[BLOB_CI] = sha40(0xb10b))) },
  "key-between-head": {
    clause: "§5.3 3 pr_key_moved (confirming pass)",
    check: async (sut) => failure((await runWith(sut, goldenC(), { keys: fromRead(3, { headSha: sha40(0x4ead) }) })).r, "pr_key_moved", "confirm"),
  },
  "key-between-draft": {
    clause: "§5.3 3 pr_key_moved (confirming pass)",
    check: async (sut) => failure((await runWith(sut, goldenC(), { keys: fromRead(3, { isDraft: true }) })).r, "pr_key_moved", "confirm"),
  },
  "key-inside-confirm": {
    clause: "§5.3 3 the confirming pass runs once, with no retry",
    check: async (sut) => failure((await runWith(sut, goldenC(), { keys: { 4: { headSha: sha40(0x4ead) } } })).r, "pr_key_moved", "confirm"),
  },
  "interrupt-collect-2": { clause: "§5.3 2 first failure ends the pass", check: interrupt(2, "collect") },
  "interrupt-collect-9": { clause: "§5.3 2 first failure ends the pass", check: interrupt(9, "collect") },
  "interrupt-confirm-16": { clause: "§5.3 3 confirming pass failures", check: interrupt(16, "confirm") },
  "interrupt-confirm-20": { clause: "§5.3 3 confirming pass failures", check: interrupt(20, "confirm") },
  "interrupt-confirm-24": { clause: "§5.3 3 confirming pass failures", check: interrupt(24, "confirm") },
  "interrupt-confirm-29": { clause: "§5.3 3 confirming pass failures (jobs)", check: interrupt(29, "confirm") },
  "interrupt-confirm-30": { clause: "§5.3 3 confirming pass failures (K1')", check: interrupt(30, "confirm") },
  "jobs-scope-mixed": {
    clause: "§5.3 2 jobs for exactly the applicable completed/success runs",
    check: async (sut) => {
      const w = mixedRunsWorld();
      const { r, fake } = await runWith(sut, w);
      const want = JSON.stringify(normalizeKinds([...passKinds(w), ...passKinds(w)]));
      if (JSON.stringify(normalizeKinds(fake.kinds())) !== want) return `reads ${normalizeKinds(fake.kinds()).filter((k) => k.startsWith("jobs")).join(",")}`;
      return r?.ok === true && r.evidence.rows.ci?.value?.outcome === "PENDING" ? null : `result ${JSON.stringify(r).slice(0, 120)}`;
    },
  },
  "jobs-too-large": {
    clause: "§5.3 2 first failure ends the pass (a jobs listing)",
    check: async (sut) => {
      const w = goldenC();
      w.base.jobs[RUN_810] = { tooLarge: true };
      return failure((await runWith(sut, w)).r, "ci_candidate_listing_too_large", "collect");
    },
  },
  "blob-mismatch-ci": { clause: "§5.2 ci_definition_mismatch (ci.yml)", check: mismatch(BLOB_CI) },
  "blob-mismatch-classify": { clause: "§5.2 ci_definition_mismatch (classifier)", check: mismatch(BLOB_CLASSIFY) },
  "hash-ignores-now": {
    clause: "§5.4 the observation time is reported, never hashed",
    check: async (sut) => {
      const a = (await runWith(sut, goldenC())).r;
      const b = (await runWith(sut, goldenC(), {}, { now: () => "2026-12-25T00:00:00Z" })).r;
      if (a?.ok !== true || b?.ok !== true) return "collection failed";
      return a.evidenceHash === b.evidenceHash ? null : "the hash moved with the clock";
    },
  },
  "hash-deterministic": {
    clause: "§5.4 SHA-256 of canonical JSON",
    check: async (sut) => {
      const a = (await runWith(sut, goldenC())).r;
      const b = (await runWith(sut, goldenC())).r;
      return a?.ok && b?.ok && /^[0-9a-f]{64}$/.test(a.evidenceHash) && a.evidenceHash === b.evidenceHash ? null : "not a stable 64-hex hash";
    },
  },
  "failure-contract-collect": {
    clause: "§5.4 Failure: { ok, reason, detail, stage, diagnostics }, never partial evidence",
    check: async (sut) => failure((await runWith(sut, goldenC(), { faults: { 3: { kind: "mutate", f: malformFor("context") } } })).r, "malformed", "collect"),
  },
  "failure-contract-confirm": {
    clause: "§5.4 Failure: never partial evidence",
    check: unstable((w) => (w.base.compare.aheadBy += 1)),
  },
  "precedence-review-before-rollup": {
    clause: "§5.3 2 the fixed order is the precedence",
    check: async (sut) => {
      const incomplete = (b: any) => ((b.data.repository.pullRequest.reviews.pageInfo.hasNextPage = true), b);
      const { r } = await runWith(sut, goldenC(), { kindFaults: { review: { kind: "mutate", f: incomplete }, rollup: { kind: "mutate", f: malformFor("rollup") } } });
      return failure(r, "review_evidence_too_large", "collect");
    },
  },
};
