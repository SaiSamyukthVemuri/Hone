/* eslint-disable @typescript-eslint/no-explicit-any -- evidence is built raw on purpose */
import { describe, expect, it } from "vitest";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { DECISIONS, decide } from "../../../scripts/eng/v2/decision/decide.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { NEXT_ACTION, NEXT_ACTION_FOR_UNKNOWN } from "../../../scripts/eng/v2/decision/next-action.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { UNKNOWN_REASONS } from "../../../scripts/eng/v2/contract/reasons.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { collect } from "../../../scripts/eng/v2/adapter/collect.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { createReaders } from "../../../scripts/eng/v2/adapter/internal/github/index.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { classify } from "../../../scripts/classify-changes.mjs";
import { fakeGitHub, load, routes800 } from "./support/fake-github";

// ===========================================================================
// ENG-LOOP V1 05B: decide() over every combination of normalized evidence.
//
// The ORACLE below restates the operator's V1 precedence (ARCH-01 §7 with
// "missing required CI" at row 6) as a plain precedence list, written from the
// directive, and every one of the 21,600
// combinations must agree with it. Properties then pin what no table can:
// UNKNOWN never reaches candidacy, order never matters, nothing throws.
// ===========================================================================

const CODEX = { id: 199175422, type: "Bot" };
const HUMAN = { id: 26781116, type: "User" };
const STRANGER = { id: 5, type: "User" };
const CODEX_ID_AS_USER = { id: 199175422, type: "User" };
const HEAD = "c".repeat(40);
const BASE = "b".repeat(40);

const fail = (reason: string) => ({ ok: false, reason, detail: `synthetic ${reason}` });
const okv = (value: any) => ({ ok: true, value });

const BASES = {
  current: okv({ drift: { behindBy: 0, aheadBy: 2 }, files: [] }),
  behind: okv({ drift: { behindBy: 3, aheadBy: 2 }, files: [] }),
  unknown: fail("base_ref"),
};
const CIS = {
  SUCCEEDED: okv({ outcome: "SUCCEEDED", applicableRunIds: [1] }),
  FAILED: okv({ outcome: "FAILED", applicableRunIds: [1] }),
  PENDING: okv({ outcome: "PENDING", applicableRunIds: [1] }),
  NO_RUN: okv({ outcome: "NO_RUN", applicableRunIds: [] }),
  INCOMPLETE: okv({ outcome: "INCOMPLETE", applicableRunIds: [1], missingJob: "browser e2e (local stack)" }),
  unknown: fail("base_history_unverified"),
};
const EXTS = {
  none: okv({ external: [] }),
  success: okv({ external: [{ source: "Vercel", state: "success" }] }),
  pending: okv({ external: [{ source: "Vercel", state: "pending" }] }),
  failure: okv({ external: [{ source: "Vercel", state: "failure" }] }),
  mixed: okv({ external: [{ source: "a", state: "pending" }, { source: "b", state: "failure" }, { source: "c", state: "success" }] }),
  unknown: fail("unrecognized_context_state"),
};
const review = (over: any) => ({ id: 1, channel: "PR_REVIEW", actor: CODEX, verdict: "COMMENTED", qualifiesAtHead: true, ...over });
const REVIEWS: Record<string, any> = {
  none: [],
  trustedA: [review({})],
  trustedB: [review({ channel: "CLEAN_COMMENT", verdict: "CLEAN" })],
  changesRequested: [review({ verdict: "CHANGES_REQUESTED" })],
  stale: [review({ qualifiesAtHead: false })],
  impostor: [review({ actor: CODEX_ID_AS_USER }), review({ id: 2, channel: "CLEAN_COMMENT", verdict: "CLEAN", actor: STRANGER })],
  // Trusted actor at the head, but a verdict that never establishes a review (ARCH-01 §24).
  dismissed: [review({ verdict: "DISMISSED" })],
  pendingReview: [review({ verdict: "PENDING" })],
  crossedChannels: [review({ verdict: "CLEAN" }), review({ id: 2, channel: "CLEAN_COMMENT", verdict: "COMMENTED" })],
  unknown: "unknown",
};
const thread = (over: any) => ({ opener: CODEX, resolved: false, resolver: null, outdated: false, ...over });
const THREADS: Record<string, any[]> = {
  none: [],
  open: [thread({})],
  resolvedByHuman: [thread({ resolved: true, resolver: HUMAN })],
  resolvedByStranger: [thread({ resolved: true, resolver: STRANGER })],
  untrustedOpener: [thread({ opener: STRANGER })],
};

type World = { terminal: boolean; draft: boolean; base: string; ci: string; ext: string; reviews: string; threads: string };

function evidenceOf(w: World): any {
  const key = { prNumber: 1, state: w.terminal ? "MERGED" : "OPEN", isDraft: w.draft, headSha: HEAD, headRef: "h", headRepoId: 1, baseRef: "p", baseRepoId: 1, baseSha: w.terminal ? null : BASE };
  if (w.terminal) return { ok: true, evidence: { schema: "eng-loop-v1/evidence@1", observedAt: "t", key, terminal: true, rows: null } };
  const reviewsRow = w.reviews === "unknown" ? fail("review_evidence_too_large") : okv({ reviews: REVIEWS[w.reviews], threads: THREADS[w.threads] });
  return {
    ok: true,
    evidence: {
      schema: "eng-loop-v1/evidence@1",
      observedAt: "t",
      key,
      terminal: false,
      rows: { base: (BASES as any)[w.base], ci: (CIS as any)[w.ci], external: (EXTS as any)[w.ext], reviews: reviewsRow },
    },
  };
}

/** ARCH-01 §7 with README differences 8-9, restated as a precedence list. Returns "DECISION" or "UNKNOWN:reason". */
function oracle(w: World): string {
  const trusted = (a: any) => a && a.id === CODEX.id && a.type === CODEX.type;
  const human = (a: any) => a && a.id === HUMAN.id && a.type === HUMAN.type;
  const rows: Array<[() => boolean, () => string]> = [
    [() => w.terminal, () => "NOT_OPEN"],
    [() => w.draft, () => "DRAFT_HOLD"],
    [() => w.base === "unknown", () => "UNKNOWN:base_ref"],
    [() => w.base === "behind", () => "NEEDS_REFRESH"],
    [() => w.ci === "unknown", () => "UNKNOWN:base_history_unverified"],
    [() => w.ci === "FAILED", () => "CI_FAILED"],
    [() => w.ext === "unknown", () => "UNKNOWN:unrecognized_context_state"],
    [() => w.ext === "failure" || w.ext === "mixed", () => "EXTERNAL_BLOCKED"],
    [() => w.ci === "NO_RUN", () => "CI_NOT_STARTED"],
    [() => w.ci === "INCOMPLETE", () => "CI_INCOMPLETE"],
    [() => w.ci === "PENDING", () => "CI_PENDING"],
    [() => w.ext === "pending", () => "EXTERNAL_PENDING"],
    [() => w.reviews === "unknown", () => "UNKNOWN:review_evidence_too_large"],
    [
      () =>
        !REVIEWS[w.reviews].some(
          (r: any) =>
            r.qualifiesAtHead &&
            trusted(r.actor) &&
            ((r.channel === "PR_REVIEW" && ["COMMENTED", "APPROVED", "CHANGES_REQUESTED"].includes(r.verdict)) ||
              (r.channel === "CLEAN_COMMENT" && r.verdict === "CLEAN")),
        ),
      () => "REVIEW_MISSING",
    ],
    [
      () =>
        REVIEWS[w.reviews].some((r: any) => r.channel === "PR_REVIEW" && r.verdict === "CHANGES_REQUESTED" && r.qualifiesAtHead && trusted(r.actor)) ||
        THREADS[w.threads].some((t: any) => trusted(t.opener) && (!t.resolved || !human(t.resolver))),
      () => "FINDINGS_OPEN",
    ],
    [() => true, () => "CANDIDATE_READY_FOR_HUMAN_REVIEW"],
  ];
  for (const [holds, decision] of rows) if (holds()) return decision();
  throw new Error("unreachable");
}

const label = (d: any) => (d.decision === "UNKNOWN" ? `UNKNOWN:${d.reasonCodes[0]}` : d.decision);

function* worlds(): Generator<World> {
  for (const terminal of [false, true])
    for (const draft of [false, true])
      for (const base of Object.keys(BASES))
        for (const ci of Object.keys(CIS))
          for (const ext of Object.keys(EXTS))
            for (const reviews of Object.keys(REVIEWS))
              for (const threads of Object.keys(THREADS)) yield { terminal, draft, base, ci, ext, reviews, threads };
}

describe("decide: every combination agrees with the §7 oracle", () => {
  it("21,600 worlds, zero disagreements; every one says a human merges and carries a bounded next action", () => {
    const actions = new Set([...Object.values(NEXT_ACTION), ...Object.values(NEXT_ACTION_FOR_UNKNOWN)]);
    let n = 0;
    const disagreements: string[] = [];
    for (const w of worlds()) {
      n++;
      const d = decide(evidenceOf(w));
      const got = label(d);
      const want = oracle(w);
      if (got !== want && disagreements.length < 10) disagreements.push(`${JSON.stringify(w)}: got ${got}, want ${want}`);
      if ((d.humanMergeRequired !== true || !actions.has(d.nextAction)) && disagreements.length < 10) {
        disagreements.push(`${JSON.stringify(w)}: humanMergeRequired ${d.humanMergeRequired}, nextAction ${d.nextAction}`);
      }
    }
    expect(n).toBe(2 * 2 * 3 * 6 * 6 * 10 * 5);
    expect(disagreements).toEqual([]);
  });

  it("every decision is reachable, so no row is dead", () => {
    const seen = new Set<string>();
    for (const w of worlds()) seen.add(decide(evidenceOf(w)).decision);
    expect([...seen].sort()).toEqual([...DECISIONS].sort());
  });
});

describe("decide: properties no table can show", () => {
  const all = [...worlds()];

  it("UNKNOWN never reaches candidacy: any UNKNOWN row with an otherwise ready PR is UNKNOWN, never CANDIDATE", () => {
    const ready: World = { terminal: false, draft: false, base: "current", ci: "SUCCEEDED", ext: "success", reviews: "trustedA", threads: "resolvedByHuman" };
    expect(decide(evidenceOf(ready)).decision).toBe("CANDIDATE_READY_FOR_HUMAN_REVIEW");
    for (const row of ["base", "ci", "ext", "reviews"] as const) {
      const d = decide(evidenceOf({ ...ready, [row]: "unknown" }));
      expect(d.decision, row).toBe("UNKNOWN");
    }
    for (const w of all) {
      const anyUnknown = w.base === "unknown" || w.ci === "unknown" || w.ext === "unknown" || w.reviews === "unknown";
      if (anyUnknown) expect(decide(evidenceOf(w)).decision).not.toBe("CANDIDATE_READY_FOR_HUMAN_REVIEW");
    }
  });

  it("A9: a PR behind production is NEEDS_REFRESH even with green CI, a clean review and no findings", () => {
    const behind: World = { terminal: false, draft: false, base: "behind", ci: "SUCCEEDED", ext: "success", reviews: "trustedB", threads: "none" };
    expect(decide(evidenceOf(behind))).toMatchObject({ decision: "NEEDS_REFRESH", blocking: { behindBy: 3, baseSha: BASE } });
  });

  it("a stale review, an untrusted actor and external success are inert", () => {
    const base: World = { terminal: false, draft: false, base: "current", ci: "SUCCEEDED", ext: "none", reviews: "none", threads: "none" };
    for (const reviews of ["none", "stale", "impostor"]) {
      expect(decide(evidenceOf({ ...base, reviews })).decision, reviews).toBe("REVIEW_MISSING");
    }
    for (const ext of ["none", "success"]) {
      expect(decide(evidenceOf({ ...base, ext, reviews: "trustedA" })).decision).toBe("CANDIDATE_READY_FOR_HUMAN_REVIEW");
    }
    expect(decide(evidenceOf({ ...base, reviews: "trustedA", threads: "untrustedOpener" })).decision).toBe("CANDIDATE_READY_FOR_HUMAN_REVIEW");
  });

  it("is permutation-invariant over reviews, threads and external contexts", () => {
    const shuffle = <T>(xs: T[], seed: number) => xs.map((x, i) => [((i + 1) * seed) % 97, x] as const).sort((a, b) => a[0] - b[0]).map((p) => p[1]);
    for (const w of all.filter((_, i) => i % 37 === 0)) {
      const e = evidenceOf(w);
      if (!e.evidence.rows) continue;
      const rows = e.evidence.rows;
      const extra = { ...rows };
      if (rows.reviews.ok) {
        extra.reviews = okv({
          reviews: shuffle([...rows.reviews.value.reviews, review({ id: 9, qualifiesAtHead: false }), review({ id: 8, actor: STRANGER })], 7),
          threads: shuffle([...rows.reviews.value.threads, thread({ opener: STRANGER })], 11),
        });
      }
      if (rows.external.ok) extra.external = okv({ external: shuffle([...rows.external.value.external, { source: "z", state: "success" }], 5) });
      const permuted = { ...e, evidence: { ...e.evidence, rows: extra } };
      expect(label(decide(permuted)), JSON.stringify(w)).toBe(label(decide(e)));
    }
  });

  it("is deterministic, total, and always says a human merges, with a bounded next action", () => {
    const actions = new Set([...Object.values(NEXT_ACTION), ...Object.values(NEXT_ACTION_FOR_UNKNOWN)]);
    for (const w of all.filter((_, i) => i % 13 === 0)) {
      const a = decide(evidenceOf(w));
      expect(decide(evidenceOf(w))).toEqual(a);
      expect(a.humanMergeRequired).toBe(true);
      expect(actions.has(a.nextAction)).toBe(true);
      expect(Object.isFrozen(a)).toBe(true);
    }
  });

  it("a collection failure is UNKNOWN with its reason; an open-set reason becomes malformed", () => {
    for (const reason of UNKNOWN_REASONS) {
      const d = decide({ ok: false, reason, detail: "x" });
      expect(d).toMatchObject({ decision: "UNKNOWN", reasonCodes: [reason], blocking: { row: "collection", detail: "x" } });
      expect(d.nextAction).toBe(NEXT_ACTION_FOR_UNKNOWN[reason]);
    }
    expect(decide({ ok: false, reason: "rate_limited" })).toMatchObject({ decision: "UNKNOWN", reasonCodes: ["malformed"] });
  });

  it("an out-of-enum verdict beside a valid clean verdict is malformed — never 'establishes nothing' and a candidate", () => {
    const ready = evidenceOf({ terminal: false, draft: false, base: "current", ci: "SUCCEEDED", ext: "success", reviews: "trustedB", threads: "none" });
    expect(decide(ready).decision).toBe("CANDIDATE_READY_FOR_HUMAN_REVIEW");
    const odd = {
      ...ready,
      evidence: {
        ...ready.evidence,
        rows: {
          ...ready.evidence.rows,
          reviews: okv({ reviews: [...ready.evidence.rows.reviews.value.reviews, review({ id: 7, verdict: "changes_requested" })], threads: [] }),
        },
      },
    };
    expect(decide(odd)).toMatchObject({ decision: "UNKNOWN", reasonCodes: ["malformed"] });
  });

  it("evidence outside the contract is UNKNOWN(malformed), never an exception and never a candidate", () => {
    const ready = evidenceOf({ terminal: false, draft: false, base: "current", ci: "SUCCEEDED", ext: "success", reviews: "trustedA", threads: "none" });
    const broken: any[] = [
      null,
      undefined,
      42,
      {},
      { ok: true },
      { ok: true, evidence: null },
      { ok: true, evidence: { ...ready.evidence, terminal: true } },
      { ok: true, evidence: { ...ready.evidence, key: { ...ready.evidence.key, isDraft: "false" } } },
      { ok: true, evidence: { ...ready.evidence, rows: null } },
      { ok: true, evidence: { ...ready.evidence, rows: { ...ready.evidence.rows, base: okv({ drift: { behindBy: -1 } }) } } },
      { ok: true, evidence: { ...ready.evidence, rows: { ...ready.evidence.rows, ci: okv({ outcome: "GREEN" }) } } },
      { ok: true, evidence: { ...ready.evidence, rows: { ...ready.evidence.rows, external: okv({ external: [{ source: "a", state: "SUCCESS" }] }) } } },
      { ok: true, evidence: { ...ready.evidence, rows: { ...ready.evidence.rows, reviews: okv({ reviews: [review({ qualifiesAtHead: "yes" })], threads: [] }) } } },
      { ok: true, evidence: { ...ready.evidence, rows: { ...ready.evidence.rows, reviews: okv({ reviews: [review({})], threads: [{ opener: CODEX }] }) } } },
      new Proxy({}, { get() { throw new Error("hostile"); } }),
      // ARCH-01 §24's closed enums and the evidence schema: anything else is outside the contract.
      { ok: true, evidence: { ...ready.evidence, schema: "eng-loop-v1/evidence@9" } },
      { ok: true, evidence: { ...ready.evidence, rows: { ...ready.evidence.rows, ci: okv({ outcome: "SUCCEEDED", applicableRunIds: "1" }) } } },
      { ok: true, evidence: { ...ready.evidence, rows: { ...ready.evidence.rows, reviews: okv({ reviews: [review({ verdict: "changes_requested" })], threads: [] }) } } },
      { ok: true, evidence: { ...ready.evidence, rows: { ...ready.evidence.rows, reviews: okv({ reviews: [review({ channel: "REVIEW_THREAD" })], threads: [] }) } } },
    ];
    for (const input of broken) {
      expect(() => decide(input)).not.toThrow();
      expect(decide(input)).toMatchObject({ decision: "UNKNOWN", reasonCodes: ["malformed"] });
    }
  });
});

describe("decide on the collector's real evidence (#800, recorded)", () => {
  const LOCAL = {
    classify,
    blobs: {
      ".github/workflows/ci.yml": load("blob/contents-ci.yml-6cdd830b.json").sha,
      "scripts/classify-changes.mjs": load("blob/contents-classify-changes.mjs-6cdd830b.json").sha,
    },
    tablePinned: true,
  };
  const collected = (routes = routes800()) =>
    collect({ prNumber: 800, readers: createReaders({ request: fakeGitHub(routes).request }), local: LOCAL, now: () => Date.parse("2026-10-07T21:00:00Z") });

  it("#800 is a draft: DRAFT_HOLD, whatever else holds", () => {
    expect(decide(collected())).toMatchObject({ decision: "DRAFT_HOLD", humanMergeRequired: true });
  });

  it("#800 marked ready: current with its base, CI green under Option A, Codex reviewed the head, one P2 thread open -> FINDINGS_OPEN", () => {
    const routes = routes800();
    const keyRoute = `pr-key {"n":800,"name":"Hone","owner":"SaiSamyukthVemuri"}`;
    routes[keyRoute] = () => {
      const raw = load("pr-key/pr-800-open-draft.json");
      raw.data.repository.pullRequest.isDraft = false;
      return raw;
    };
    const c = collected(routes);
    expect(c.evidence.rows.base.value.drift.behindBy).toBe(0);
    expect(decide(c)).toMatchObject({
      decision: "FINDINGS_OPEN",
      reasonCodes: ["FINDINGS_OPEN"],
      blocking: { changesRequested: false, openThreads: 1 },
      humanMergeRequired: true,
    });
  });
});
