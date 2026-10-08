/* eslint-disable @typescript-eslint/no-explicit-any -- transport requests and raw answers are untyped on purpose */
import { describe, expect, it } from "vitest";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { PR_KEY_QUERY } from "../../../../scripts/eng/v2/contract/pr-key.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { isUnknownReason } from "../../../../scripts/eng/v2/contract/reasons.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { PR_CONTEXT_QUERY } from "../../../../scripts/eng/v2/adapter/internal/github/parse-base.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { REVIEW_EVIDENCE_QUERY } from "../../../../scripts/eng/v2/adapter/internal/github/parse-review.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { ROLLUP_QUERY } from "../../../../scripts/eng/v2/adapter/internal/github/parse-rollup.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { parseFileBlob } from "../../../../scripts/eng/v2/adapter/internal/github/parse-blob.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { POLICY, createReaders } from "../../../../scripts/eng/v2/adapter/internal/github/index.mjs";
import { BLOB_CI, BLOB_CLASSIFY, NAME, OWNER, PROD_BLOBS, SPEC_QUERIES, selection } from "./support/collector";
import { canon, clone, deepFreeze, isDeepFrozen, noThrow } from "./support/deep";
import { H810, P0, PROD_REF_FULL, PRODUCTION_REF, REAL, RUN_810, TARGET_REPO_ID, WORKFLOW_ID, golden, rawCompareFor } from "./support/world";
import { budgetGuard } from "./support/budgets";

// ===========================================================================
// INDEPENDENT VERIFIER — SPEC-05A §5.1 readers (f75ca255). Every expected route,
// query and variable set is built here from §5.1's table and §1/§2.2/§4.1/§4.3's
// query text; GraphQL documents are compared as order-insensitive selection trees.
// ===========================================================================

const PREFIX = `repos/${OWNER}/${NAME}/`;
const spy = (answer: (req: any) => any = () => ({ ok: false, reason: "read_failed", detail: "spy" })) => {
  const calls: any[] = [];
  const readers = createReaders({ request: (req: any) => (calls.push(req), answer(req)), policy: POLICY });
  return { readers, calls };
};

describe("§5.1 readers: the reader set and the policy", () => {
  it("the policy carries the spec's production ref, target repository and workflow", () => {
    expect(POLICY).toMatchObject({ owner: OWNER, name: NAME, repoId: TARGET_REPO_ID, productionRef: PRODUCTION_REF, workflowId: WORKFLOW_ID });
  });

  it("createReaders returns exactly the eleven §5.1 readers, frozen", () => {
    const { readers } = spy();
    expect(Object.keys(readers).sort()).toEqual(
      [
        "readPrKey",
        "readCompare",
        "readPrContext",
        "readHeadBranchPrs",
        "readBranchRules",
        "readActivity",
        "readCandidateRuns",
        "readRunJobs",
        "readReviewEvidence",
        "readCommitRollup",
        "readFileBlob",
      ].sort(),
    );
    expect(Object.isFrozen(readers)).toBe(true);
  });

  it("each GraphQL document asks exactly the spec's fields, connection sizes, filter and alias", () => {
    expect(selection(PR_KEY_QUERY)).toBe(SPEC_QUERIES.key);
    expect(selection(PR_CONTEXT_QUERY)).toBe(SPEC_QUERIES.context);
    expect(selection(REVIEW_EVIDENCE_QUERY)).toBe(SPEC_QUERIES.review);
    expect(selection(ROLLUP_QUERY)).toBe(SPEC_QUERIES.rollup);
  });
});

describe("§2.2 as amended at 4b0662a2 (R-AUTOBASE): the widened PR-context document", () => {
  const itemTypes = (doc: string) => {
    const m = /itemTypes\s*:\s*\[([^\]]*)\]/.exec(doc);
    return m ? m[1].split(",").map((x) => x.trim()).filter(Boolean).sort() : null;
  };
  it("asks for exactly the three base-change event types — no more, no fewer", () => {
    expect(itemTypes(PR_CONTEXT_QUERY)).toEqual(["AUTOMATIC_BASE_CHANGE_FAILED_EVENT", "AUTOMATIC_BASE_CHANGE_SUCCEEDED_EVENT", "BASE_REF_CHANGED_EVENT"]);
  });
  it("is not the pre-amendment document (BASE_REF_CHANGED_EVENT only)", () => {
    const old = selection(
      "{repository(owner:$owner,name:$name){ pullRequest(number:N){ number createdAt changedFiles baseRefChanges: timelineItems(itemTypes:[BASE_REF_CHANGED_EVENT], first:100){ pageInfo{hasNextPage} nodes{__typename} } } object(oid:H){ __typename ... on Commit { associatedPullRequests(first:100){ pageInfo{hasNextPage} nodes{number} } } } }}",
    );
    expect(selection(PR_CONTEXT_QUERY)).not.toBe(old);
    expect(selection(PR_CONTEXT_QUERY)).toBe(SPEC_QUERIES.context);
  });
  it("still requests only the typename of each node and the page flag (no totalCount: SPEC §0)", () => {
    expect(SPEC_QUERIES.context).toContain("baseRefChanges:timelineItems(");
    expect(/totalCount/.test(PR_CONTEXT_QUERY.split("associatedPullRequests")[0])).toBe(false);
  });
});

describe("§5.1 readers: exactly one request, on the table's route, for the values given", () => {
  const H = H810;
  const cases: Array<[string, any[], (req: any) => string]> = [
    ["readPrKey", [810], (q) => (selection(q.graphql) === SPEC_QUERIES.key && canon(q.variables) === canon({ owner: OWNER, name: NAME, n: 810 }) ? "" : canon(q))],
    ["readCompare", [P0, H], (q) => (q.rest === `${PREFIX}compare/${P0}...${H}` ? "" : q.rest)],
    ["readPrContext", [810, H], (q) => (selection(q.graphql) === SPEC_QUERIES.context && canon(q.variables) === canon({ owner: OWNER, name: NAME, n: 810, h: H }) ? "" : canon(q.variables))],
    ["readHeadBranchPrs", ["feat/eng-loop-v1-05a"], (q) => (q.rest === `${PREFIX}pulls?head=${encodeURIComponent(`${OWNER}:feat/eng-loop-v1-05a`)}&state=all&per_page=100` ? "" : q.rest)],
    ["readHeadBranchPrs", ["feat/a&state=open#x"], (q) => (q.rest === `${PREFIX}pulls?head=${encodeURIComponent(`${OWNER}:feat/a&state=open#x`)}&state=all&per_page=100` ? "" : q.rest)],
    ["readBranchRules", [], (q) => (q.rest === `${PREFIX}rules/branches/${PRODUCTION_REF}` ? "" : q.rest)],
    ...["force_push", "branch_deletion", "branch_creation"].map((t): [string, any[], (req: any) => string] => [
      "readActivity",
      [t],
      (q) => (q.rest === `${PREFIX}activity?ref=${encodeURIComponent(PROD_REF_FULL)}&activity_type=${t}&time_period=year&per_page=100` ? "" : q.rest),
    ]),
    ["readCandidateRuns", [H], (q) => (q.rest === `${PREFIX}actions/workflows/${WORKFLOW_ID}/runs?head_sha=${H}&event=pull_request&per_page=100` ? "" : q.rest)],
    ["readRunJobs", [RUN_810], (q) => (q.rest === `${PREFIX}actions/runs/${RUN_810}/jobs?filter=latest&per_page=100` ? "" : q.rest)],
    ["readReviewEvidence", [810], (q) => (selection(q.graphql) === SPEC_QUERIES.review && canon(q.variables) === canon({ owner: OWNER, name: NAME, n: 810 }) ? "" : canon(q.variables))],
    ["readCommitRollup", [H], (q) => (selection(q.graphql) === SPEC_QUERIES.rollup && canon(q.variables) === canon({ owner: OWNER, name: NAME, h: H }) ? "" : canon(q.variables))],
    ["readFileBlob", [BLOB_CI, P0], (q) => (q.rest === `${PREFIX}contents/${BLOB_CI}?ref=${P0}` ? "" : q.rest)],
    ["readFileBlob", [BLOB_CLASSIFY, P0], (q) => (q.rest === `${PREFIX}contents/${BLOB_CLASSIFY}?ref=${P0}` ? "" : q.rest)],
  ];
  for (const [name, args, check] of cases) {
    it(`${name}(${args.map((a) => JSON.stringify(a)).join(", ")})`, () => {
      const { readers, calls } = spy();
      readers[name](...args);
      expect(calls.length).toBe(1);
      expect(typeof calls[0].label === "string" && calls[0].label.length > 0, "a label").toBe(true);
      expect(check(calls[0]), "route, query or variables").toBe("");
    });
  }
});

describe("§5.1 readers: typed scalars only — anything else is refused before any request", () => {
  const H = H810;
  const bad: Array<[string, any[]]> = [
    ...["810", 0, -1, 810.5, null, undefined, Number.NaN, {}].map((x): [string, any[]] => ["readPrKey", [x]]),
    ["readCompare", [P0.toUpperCase(), H]],
    ["readCompare", [P0, H.slice(1)]],
    ["readCompare", [P0]],
    ["readCompare", ["main", H]],
    ["readPrContext", ["810", H]],
    ["readPrContext", [810, "main"]],
    ["readPrContext", [810]],
    ...["", 5, null, undefined, {}].map((x): [string, any[]] => ["readHeadBranchPrs", [x]]),
    ...["push", "pr_merge", "FORCE_PUSH", "", undefined, 1].map((x): [string, any[]] => ["readActivity", [x]]),
    ...["main", H.toUpperCase(), H.slice(1), undefined].map((x): [string, any[]] => ["readCandidateRuns", [x]]),
    ...[0, -1, "37680787947", 1.5, null, undefined].map((x): [string, any[]] => ["readRunJobs", [x]]),
    ...["810", 0, undefined].map((x): [string, any[]] => ["readReviewEvidence", [x]]),
    ...["main", H.toUpperCase(), undefined].map((x): [string, any[]] => ["readCommitRollup", [x]]),
    ["readFileBlob", ["package.json", P0]],
    ["readFileBlob", ["scripts/browser-groups.mjs", P0]],
    ["readFileBlob", [`../${BLOB_CI}`, P0]],
    ["readFileBlob", [BLOB_CI, "main"]],
    ["readFileBlob", [BLOB_CI, P0.toUpperCase()]],
    ["readFileBlob", [BLOB_CI]],
  ];
  for (const [name, args] of bad) {
    it(`${name}(${args.map((a) => (a === undefined ? "undefined" : JSON.stringify(a))).join(", ")}) is malformed with no request`, () => {
      const { readers, calls } = spy();
      const out = noThrow(() => readers[name](...args));
      expect(out.threw).toBe(false);
      const r = (out as any).value;
      expect(r?.ok).toBe(false);
      expect(r?.reason).toBe("malformed");
      expect(String(r?.detail)).toContain("refused before any request");
      expect(calls.length).toBe(0);
    });
  }
});

describe("§5.1 readers: a transport failure passes through unchanged", () => {
  const failures = [
    { ok: false, reason: "read_failed", detail: "run-jobs: gh: Resource not accessible by personal access token (HTTP 403)" },
    { ok: false, reason: "read_failed", detail: "candidate-runs: gh slow: timed out after 300 ms" },
    { ok: false, reason: "malformed", detail: "compare: the gh output is not JSON" },
  ];
  const calls: Array<[string, any[]]> = [
    ["readPrKey", [810]],
    ["readCompare", [P0, H810]],
    ["readPrContext", [810, H810]],
    ["readHeadBranchPrs", ["feat/x"]],
    ["readBranchRules", []],
    ["readActivity", ["branch_creation"]],
    ["readCandidateRuns", [H810]],
    ["readRunJobs", [RUN_810]],
    ["readReviewEvidence", [810]],
    ["readCommitRollup", [H810]],
    ["readFileBlob", [BLOB_CI, P0]],
  ];
  for (const f of failures)
    for (const [name, args] of calls)
      it(`${name}: ${f.reason} — ${f.detail.slice(0, 40)}`, () => {
        const { readers } = spy(() => clone(f));
        expect(readers[name](...args)).toEqual(f);
      });
});

describe("§5.1 readers: each returns its parser's result for the request it made", () => {
  const ok = (body: any) => () => ({ ok: true, body });
  const W = golden();

  it("real answers parse: the key, the compare, the runs, the jobs, the blobs, reviews and rollup", () => {
    expect(spy(ok(REAL.prKey("pr-800-open-draft.json"))).readers.readPrKey(800).ok).toBe(true);
    expect(spy(ok(rawCompareFor(W))).readers.readCompare(P0, H810).ok).toBe(true);
    expect(spy(ok(REAL.verify("runs-810-pull-request.json"))).readers.readCandidateRuns(H810).ok).toBe(true);
    expect(spy(ok(REAL.verify("jobs-810-run-latest.json"))).readers.readRunJobs(RUN_810).ok).toBe(true);
    expect(spy(ok(REAL.verify("blob-ci.yml-6cdd830b.json"))).readers.readFileBlob(BLOB_CI, P0)).toEqual({ ok: true, record: { path: BLOB_CI, sha: PROD_BLOBS[BLOB_CI] } });
    expect(spy(ok(REAL.verify("blob-classify-changes.mjs-6cdd830b.json"))).readers.readFileBlob(BLOB_CLASSIFY, P0)).toEqual({ ok: true, record: { path: BLOB_CLASSIFY, sha: PROD_BLOBS[BLOB_CLASSIFY] } });
    expect(spy(ok(REAL.builder("review-809.json"))).readers.readReviewEvidence(809).ok).toBe(true);
    expect(spy(ok(REAL.builder("rollup-810.json"))).readers.readCommitRollup(H810).ok).toBe(true);
    expect(spy(ok(REAL.verify("activity-branch-creation-year.json"))).readers.readActivity("branch_creation").ok).toBe(true);
  });

  it("an answer for another request is malformed: base, number, branch, type, run, commit, path", () => {
    const cmp = rawCompareFor(W);
    cmp.base_commit.sha = "1".repeat(40);
    const wrongBlob = { ...REAL.verify("blob-ci.yml-6cdd830b.json"), path: BLOB_CLASSIFY };
    const rollup = REAL.builder("rollup-810.json");
    const cases: Array<[string, () => any]> = [
      ["compare for another base", () => spy(ok(cmp)).readers.readCompare(P0, H810)],
      ["a key for another PR", () => spy(ok(REAL.prKey("pr-800-open-draft.json"))).readers.readPrKey(801)],
      ["review evidence for another PR", () => spy(ok(REAL.builder("review-809.json"))).readers.readReviewEvidence(810)],
      ["a rollup for another commit", () => spy(ok(rollup)).readers.readCommitRollup("2".repeat(40))],
      ["jobs for another run", () => spy(ok(REAL.verify("jobs-810-run-latest.json"))).readers.readRunJobs(RUN_810 + 1)],
      ["creation events read as force pushes", () => spy(ok(REAL.verify("activity-branch-creation-year.json"))).readers.readActivity("force_push")],
      ["a blob answered for the other path", () => spy(ok(wrongBlob)).readers.readFileBlob(BLOB_CI, P0)],
      ["head-branch PRs for another branch", () => spy(ok(REAL.base("head-branch-prs-810.json"))).readers.readHeadBranchPrs("feat/other")],
    ];
    for (const [label, f] of cases) {
      const r = f();
      expect(r.ok, label).toBe(false);
      expect(r.reason, label).toBe("malformed");
    }
  });
});

describe("§5.1 parseFileBlob(raw, { path })", () => {
  const ci = () => REAL.verify("blob-ci.yml-6cdd830b.json");
  it("a real contents answer gives { path, sha }, frozen", () => {
    const r = parseFileBlob(ci(), { path: BLOB_CI });
    expect(r).toEqual({ ok: true, record: { path: BLOB_CI, sha: PROD_BLOBS[BLOB_CI] } });
    expect(isDeepFrozen(r.record)).toBe(true);
  });
  it("violations are malformed", () => {
    for (const [label, raw, params] of [
      ["a directory", { ...ci(), type: "dir" }, { path: BLOB_CI }],
      ["a symlink", { ...ci(), type: "symlink" }, { path: BLOB_CI }],
      ["another path", ci(), { path: BLOB_CLASSIFY }],
      ["an upper-case sha", { ...ci(), sha: PROD_BLOBS[BLOB_CI].toUpperCase() }, { path: BLOB_CI }],
      ["a short sha", { ...ci(), sha: PROD_BLOBS[BLOB_CI].slice(0, 10) }, { path: BLOB_CI }],
      ["no sha", (() => { const x = ci(); delete x.sha; return x; })(), { path: BLOB_CI }],
      ["an array (a directory listing)", [ci()], { path: BLOB_CI }],
      ["no parameters", ci(), undefined],
      ["null options", ci(), null],
      ["an empty path", ci(), { path: "" }],
    ] as const) {
      const out = noThrow(() => (params === undefined ? (parseFileBlob as any)(raw) : parseFileBlob(raw, params)));
      expect(out.threw, label).toBe(false);
      const r = (out as any).value;
      expect(r?.ok, label).toBe(false);
      expect(r?.reason, label).toBe("malformed");
      expect(isUnknownReason(r?.reason)).toBe(true);
    }
  });
  it("REST: unconsumed fields are ignored; the input is not mutated; a frozen input gives the same record", () => {
    const raw = ci();
    const before = canon(raw);
    const a = parseFileBlob({ ...raw, zz_new_field: { x: 1 } }, { path: BLOB_CI });
    expect(a).toEqual(parseFileBlob({ type: raw.type, path: raw.path, sha: raw.sha }, { path: BLOB_CI }));
    expect(canon(raw)).toBe(before);
    expect(parseFileBlob(deepFreeze(clone(raw)), { path: BLOB_CI })).toEqual(parseFileBlob(raw, { path: BLOB_CI }));
  });
});

describe("§5.1 readers: the policy every route is built from", () => {
  // README 'Parameters': "Each value comes from the coherent key (K0.headRef) or from fixed policy (productionRef),
  // never from a caller." §5.3 step 0 (18d541a5) pins collect's policy; §5.1 (14522609) pins the readers' too.
  const CALLS: Array<(r: any) => unknown> = [
    (r) => r.readBranchRules(),
    (r) => r.readActivity("force_push"),
    (r) => r.readActivity("branch_creation"),
    (r) => r.readCandidateRuns(H810),
    (r) => r.readCompare(P0, H810),
    (r) => r.readHeadBranchPrs("feat/eng-loop-v1-05a"),
    (r) => r.readPrKey(810),
    (r) => r.readFileBlob(BLOB_CI, P0),
  ];
  const requestsWith = (opts: any) => {
    const seen: any[] = [];
    let readers: any = null;
    const out = noThrow(() => (readers = createReaders({ ...opts, request: (q: any) => (seen.push(q), { ok: false, reason: "read_failed", detail: "spy" }) })));
    if (!out.threw && readers) for (const c of CALLS) noThrow(() => c(readers));
    return seen.map((q) => canon({ rest: q.rest, graphql: q.graphql ? selection(q.graphql) : undefined, variables: q.variables }));
  };
  const V1 = () => requestsWith({ policy: POLICY });

  it("V1's policy, or no policy, builds every route for V1's owner, repository, production ref and workflow", () => {
    expect(V1().length).toBe(CALLS.length);
    expect(requestsWith({})).toEqual(V1());
  });

  // 14522609 §5.1: "`policy` may be omitted; if given, it must equal V1's fixed policy (§2, §3) exactly, or
  // construction fails — readers are never built for another repository, production ref or workflow".
  it("an equal copy of V1's policy, fields reordered or frozen, builds the same eleven readers", () => {
    for (const policy of [Object.fromEntries(Object.entries(POLICY).reverse()), Object.freeze({ ...POLICY })]) {
      expect(Object.keys(createReaders({ request: () => ({ ok: false, reason: "read_failed", detail: "spy" }), policy })).length).toBe(11);
      expect(requestsWith({ policy })).toEqual(V1());
    }
  });

  it("the reads cannot be pointed elsewhere after construction: a policy whose production ref changes later is not re-read", () => {
    let reads = 0;
    const shifting: any = { ...POLICY };
    Object.defineProperty(shifting, "productionRef", { enumerable: true, get: () => (++reads > 3 ? "main" : POLICY.productionRef) });
    const seen = requestsWith({ policy: shifting });
    const again = requestsWith({ policy: POLICY });
    expect(seen.filter((q) => q.includes("main"))).toEqual([]);
    expect(seen).toEqual(again);
  });

  const OTHER: Array<[string, unknown]> = [
    ["another owner", { ...POLICY, owner: "someone-else" }],
    ["another repository name", { ...POLICY, name: "Other" }],
    ["another repository id", { ...POLICY, repoId: 1 }],
    ["the repository id as a string", { ...POLICY, repoId: String(POLICY.repoId) }],
    ["another production ref", { ...POLICY, productionRef: "main" }],
    ["another workflow", { ...POLICY, workflowId: 1 }],
    ["an extra field", { ...POLICY, extra: 1 }],
    [
      "a missing field",
      (() => {
        const p: any = { ...POLICY };
        delete p.workflowId;
        return p;
      })(),
    ],
    ["an empty policy", {}],
    ["a null policy", null],
    ["a Map", new Map(Object.entries(POLICY))],
  ];
  for (const [label, policy] of OTHER)
    it(`a policy with ${label}: construction fails, and nothing is ever requested for it`, () => {
      const seen: any[] = [];
      let readers: any = null;
      const out = noThrow(() => (readers = createReaders({ request: (q: any) => (seen.push(q), { ok: false, reason: "read_failed", detail: "spy" }), policy })));
      const built = !out.threw && readers && typeof readers === "object" && typeof readers.readBranchRules === "function";
      expect(built, "readers were built for a policy other than V1's").toBe(false);
      expect(seen).toEqual([]);
    });
});

budgetGuard("collect-readers.verify.test.ts");
