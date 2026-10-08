/* eslint-disable @typescript-eslint/no-explicit-any -- raw GitHub answers and transport requests are untyped JSON on purpose */
// Independent verifier support: SPEC-05A §5 (f75ca255) — the collector.
//
// A STRICT fake transport written from §5.1's request table alone (not from the
// builder's fake-github.ts). Every request must be exactly one of the table's
// routes or queries for the pass's own K0; anything else is a recorded violation.
// Answers are cloned from real recordings (see world.ts) and edited per scenario.
//
// Transport contract (black-box probe of createReaders, 203ed1f4/f75ca255; the spec
// names the routes but not the call shape):
//   request({ label, rest: "repos/<owner>/<name>/<route>" }) or
//   request({ label, graphql: "<document>", variables: { … } })
//   -> { ok: true, body } | { ok: false, reason, detail }

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { clone, noThrow } from "./deep";
import {
  PROD_REF_FULL,
  PRODUCTION_REF,
  REAL,
  WORKFLOW_ID,
  golden,
  rawActivityFor,
  rawCompareFor,
  rawHeadBranchPrsFor,
  rawJobsFor,
  rawPrContextFor,
  rawRulesFor,
  rawRunsFor,
  type World,
} from "./world";

export const OWNER = "SaiSamyukthVemuri";
export const NAME = "Hone";
const PREFIX = `repos/${OWNER}/${NAME}/`;
export const BLOB_CI = ".github/workflows/ci.yml";
export const BLOB_CLASSIFY = "scripts/classify-changes.mjs";
export const PROD_BLOBS: Record<string, string> = {
  [BLOB_CI]: REAL.verify("blob-ci.yml-6cdd830b.json").sha, // e69cefa9…, real
  [BLOB_CLASSIFY]: REAL.verify("blob-classify-changes.mjs-6cdd830b.json").sha, // cacc8fe4…, real
};

// ---------------------------------------------------------------------------
// GraphQL selection sets, compared as trees (order-insensitive)
// ---------------------------------------------------------------------------
type Node = { key: string; children: Node[] };
function tokenize(q: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < q.length) {
    const ch = q[i];
    if (/\s|,/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "(") {
      let depth = 0;
      let j = i;
      for (; j < q.length; j++) {
        if (q[j] === "(") depth++;
        if (q[j] === ")" && --depth === 0) break;
      }
      out.push(q.slice(i, j + 1).replace(/\s+/g, ""));
      i = j + 1;
      continue;
    }
    if (ch === "{" || ch === "}" || ch === ":") {
      out.push(ch);
      i++;
      continue;
    }
    if (q.startsWith("...", i)) {
      out.push("...");
      i += 3;
      continue;
    }
    let j = i;
    while (j < q.length && /[A-Za-z0-9_$!]/.test(q[j])) j++;
    if (j === i) throw new Error(`gql tokenizer: unexpected ${JSON.stringify(ch)} in ${q.slice(i, i + 20)}`);
    out.push(q.slice(i, j));
    i = j;
  }
  return out;
}
/** Normalize an argument list: variables become "$", the spec's placeholders compare equal to them. */
const normArgs = (a: string) =>
  a
    .slice(1, -1)
    .split(",")
    .filter(Boolean)
    .map((kv) => {
      const [k, v] = kv.split(":");
      return `${k}:${v.startsWith("$") || ["N", "H"].includes(v) ? "$" : v}`;
    })
    .sort()
    .join(",");
function parseSelection(tokens: string[], pos: { i: number }): Node[] {
  const nodes: Node[] = [];
  while (pos.i < tokens.length && tokens[pos.i] !== "}") {
    let key: string;
    if (tokens[pos.i] === "...") {
      pos.i++; // "on"
      pos.i++;
      key = `...on ${tokens[pos.i++]}`;
    } else {
      key = tokens[pos.i++];
      if (tokens[pos.i] === ":") {
        pos.i++;
        key = `${key}:${tokens[pos.i++]}`;
      }
      if (tokens[pos.i]?.startsWith("(")) key = `${key}(${normArgs(tokens[pos.i++])})`;
    }
    let children: Node[] = [];
    if (tokens[pos.i] === "{") {
      pos.i++;
      children = parseSelection(tokens, pos);
      pos.i++; // "}"
    }
    nodes.push({ key, children });
  }
  return nodes;
}
const canonTree = (ns: Node[]): string =>
  ns
    .map((n) => (n.children.length ? `${n.key}{${canonTree(n.children)}}` : n.key))
    .sort()
    .join(" ");
/** The selection tree under the operation, with the operation header and variable definitions dropped. */
export function selection(document: string): string {
  const body = document.slice(document.indexOf("{"));
  const tokens = tokenize(body);
  return canonTree(parseSelection(tokens, { i: 1 }));
}

// The spec's queries, written from SPEC-05A §1 (PR-SNAPSHOT-01 §2's nine sources), §2.2, §4.1 and §4.3.
const ACTOR = "author{__typename login ... on Bot{databaseId} ... on User{databaseId}}";
export const SPEC_QUERIES = {
  key: selection(
    "{repository(owner:$owner,name:$name){pullRequest(number:$n){number state isDraft headRefOid headRefName headRepository{databaseId} baseRefName baseRepository{databaseId} baseRef{target{oid}}}}}",
  ),
  context: selection(
    "{repository(owner,name){ pullRequest(number:N){ number createdAt changedFiles baseRefChanges: timelineItems(itemTypes:[BASE_REF_CHANGED_EVENT], first:100){ pageInfo{hasNextPage} nodes{__typename} } } object(oid:H){ __typename ... on Commit { associatedPullRequests(first:100){ pageInfo{hasNextPage} nodes{number} } } } }}".replace(
      "repository(owner,name)",
      "repository(owner:$owner,name:$name)",
    ),
  ),
  review: selection(
    `{repository(owner:$owner,name:$name){ pullRequest(number:N){ number
  reviews(first:100){ totalCount pageInfo{hasNextPage} nodes{ databaseId state body commit{oid} ${ACTOR} } }
  comments(first:100){ totalCount pageInfo{hasNextPage} nodes{ databaseId body lastEditedAt ${ACTOR} } }
  reviewThreads(first:100){ totalCount pageInfo{hasNextPage}
    nodes{ isResolved isOutdated resolvedBy{__typename login databaseId}
      comments(first:100){ totalCount pageInfo{hasNextPage} nodes{ databaseId ${ACTOR} } } } } } }}`,
  ),
  rollup: selection(
    "{repository(owner:$owner,name:$name){ object(oid:H){ __typename ... on Commit{ oid statusCheckRollup{ contexts(first:100){ totalCount pageInfo{hasNextPage} nodes{ __typename ... on CheckRun{ name status conclusion checkSuite{app{slug}} } ... on StatusContext{ context state } } } } } } }}",
  ),
} as const;

// ---------------------------------------------------------------------------
// The world the fake serves, and the routes it accepts (SPEC §5.1 table)
// ---------------------------------------------------------------------------
export interface KeyVals {
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  headSha: string;
  headRef: string;
  headRepoId: number | null;
  baseRef: string;
  baseRepoId: number;
  baseSha: string | null;
}
export interface CWorld {
  base: World; // rows 1-3 (pr, compare, context, head-branch PRs, rules, activity, runs, jobs, observedAt)
  state: "OPEN" | "CLOSED" | "MERGED";
  review: any; // raw GraphQL answer for readReviewEvidence
  rollup: any; // raw GraphQL answer for readCommitRollup
  prodBlobs: Record<string, string>; // production's blob shas at K0.baseSha
}

export function keyOf(w: CWorld): KeyVals {
  const p = w.base.pr;
  return {
    number: p.number,
    state: w.state,
    isDraft: p.isDraft,
    headSha: p.headSha,
    headRef: p.headRef,
    headRepoId: p.headRepoId,
    baseRef: p.baseRef,
    baseRepoId: p.baseRepoId,
    baseSha: w.state === "OPEN" ? p.baseSha : null,
  };
}
export function rawKeyOf(k: KeyVals, liveBaseTip: string): any {
  return {
    data: {
      repository: {
        pullRequest: {
          number: k.number,
          state: k.state,
          isDraft: k.isDraft,
          headRefOid: k.headSha,
          headRefName: k.headRef,
          headRepository: k.headRepoId === null ? null : { databaseId: k.headRepoId },
          baseRefName: k.baseRef,
          baseRepository: { databaseId: k.baseRepoId },
          baseRef: { target: { oid: k.baseSha ?? liveBaseTip } },
        },
      },
    },
  };
}

/** The golden OPEN world (#810 as recorded, rows 1-3 golden; #809's real review evidence re-keyed to #810; #810's real rollup). */
export function goldenC(): CWorld {
  const base = golden();
  const review = REAL.builder("review-809.json");
  review.data.repository.pullRequest.number = base.pr.number;
  return { base, state: "OPEN", review, rollup: REAL.builder("rollup-810.json"), prodBlobs: { ...PROD_BLOBS } };
}
export function terminalC(state: "CLOSED" | "MERGED", headRepoId: number | null = 1240764106): CWorld {
  const w = goldenC();
  w.state = state;
  w.base.pr.headRepoId = headRepoId as number;
  return w;
}

export type Kind =
  | "key"
  | "compare"
  | "context"
  | "pulls"
  | "rules"
  | "activity:force_push"
  | "activity:branch_deletion"
  | "activity:branch_creation"
  | "runs"
  | "review"
  | "rollup"
  | `blob:${string}`
  | `jobs:${number}`;

/** The routes §5.1 allows for a pass whose K0 is k. */
function restRoutes(k: KeyVals, runIds: number[]): Record<string, Kind> {
  const r: Record<string, Kind> = {
    [`${PREFIX}rules/branches/${PRODUCTION_REF}`]: "rules",
  };
  for (const t of ["force_push", "branch_deletion", "branch_creation"])
    r[`${PREFIX}activity?ref=${encodeURIComponent(PROD_REF_FULL)}&activity_type=${t}&time_period=year&per_page=100`] = `activity:${t}` as Kind;
  if (k.state === "OPEN" && k.baseSha) {
    r[`${PREFIX}compare/${k.baseSha}...${k.headSha}`] = "compare";
    r[`${PREFIX}pulls?head=${encodeURIComponent(`${OWNER}:${k.headRef}`)}&state=all&per_page=100`] = "pulls";
    r[`${PREFIX}actions/workflows/${WORKFLOW_ID}/runs?head_sha=${k.headSha}&event=pull_request&per_page=100`] = "runs";
    for (const p of [BLOB_CI, BLOB_CLASSIFY]) r[`${PREFIX}contents/${p}?ref=${k.baseSha}`] = `blob:${p}`;
  }
  for (const id of runIds) r[`${PREFIX}actions/runs/${id}/jobs?filter=latest&per_page=100`] = `jobs:${id}`;
  return r;
}

export type Fault =
  | { kind: "fail"; reason?: string; detail?: string }
  | { kind: "body"; body: unknown }
  | { kind: "mutate"; f: (body: any) => any }
  | { kind: "throw" }
  | { kind: "raw"; value: unknown };

export interface FakeOptions {
  /** the key served at each key read (1-based read index); default: the pass world's key */
  keys?: Record<number, Partial<KeyVals>>;
  /** the world served for pass n (0-based, counted at each pass-opening key read); default: the base world */
  passWorlds?: Record<number, CWorld>;
  /** faults by 1-based global request index */
  faults?: Record<number, Fault>;
  /** faults by kind, applied to every request of that kind (e.g. jobs of a non-applicable run) */
  kindFaults?: Partial<Record<string, Fault>>;
}

export interface LogEntry {
  index: number;
  kind: Kind | "UNKNOWN";
  pass: number;
  label: unknown;
}

export function fakeTransport(w: CWorld, opts: FakeOptions = {}) {
  const log: LogEntry[] = [];
  const violations: string[] = [];
  let keyReads = 0;
  let pass = -1;
  let k0: KeyVals | null = null;
  const worldFor = (p: number) => opts.passWorlds?.[p] ?? w;

  const answer = (kind: Kind, cw: CWorld, k: KeyVals): any => {
    const bw: World = cw.base;
    switch (true) {
      case kind === "compare": {
        // the answer reports the base it was asked for (the pass's K0), unless the scenario overrides it
        const b = rawCompareFor(bw);
        b.base_commit.sha = bw.compare.baseSha ?? k.baseSha;
        return b;
      }
      case kind === "context":
        return rawPrContextFor(bw);
      case kind === "pulls":
        return rawHeadBranchPrsFor(bw);
      case kind === "rules":
        return rawRulesFor(bw.rules);
      case kind.startsWith("activity:"): {
        const t = kind.slice("activity:".length);
        const field = t === "force_push" ? "forcePush" : t === "branch_deletion" ? "branchDeletion" : "branchCreation";
        return rawActivityFor(t, bw.activity[field]);
      }
      case kind === "runs":
        return rawRunsFor(bw);
      case kind.startsWith("jobs:"): {
        const id = Number(kind.slice(5));
        const spec = bw.jobs[id];
        if (spec === undefined) throw new Error(`no jobs listing for run ${id} in this world`);
        return rawJobsFor(id, spec);
      }
      case kind === "review":
        return clone(cw.review);
      case kind === "rollup": {
        // the answer echoes the commit it was asked for (the pass's K0.headSha)
        const r = clone(cw.rollup);
        if (r?.data?.repository?.object && k.headSha) r.data.repository.object.oid = k.headSha;
        return r;
      }
      case kind.startsWith("blob:"): {
        const p = kind.slice(5);
        const real = REAL.verify(p === BLOB_CI ? "blob-ci.yml-6cdd830b.json" : "blob-classify-changes.mjs-6cdd830b.json");
        return { ...real, sha: cw.prodBlobs[p] };
      }
    }
    throw new Error(`no answer for ${kind}`);
  };

  const request = (req: any) => {
    const index = log.length + 1;
    let kind: Kind | "UNKNOWN" = "UNKNOWN";
    const current = () => worldFor(Math.max(pass, 0));
    try {
      if (req && typeof req.graphql === "string") {
        const sel = noThrow(() => selection(req.graphql));
        const which = sel.threw ? null : (Object.entries(SPEC_QUERIES).find(([, s]) => s === sel.value)?.[0] as keyof typeof SPEC_QUERIES | undefined);
        const v = req.variables ?? {};
        if (!which) violations.push(`#${index}: a GraphQL document that is none of the spec's four queries`);
        else if (which === "key") {
          kind = "key";
          keyReads++;
          if (keyReads % 2 === 1) pass++;
          if (canon(v) !== canon({ owner: OWNER, name: NAME, n: w.base.pr.number }))
            violations.push(`#${index}: key variables ${JSON.stringify(v)}`);
        } else {
          kind = which as Kind;
          const kk = k0;
          const want =
            which === "context"
              ? { owner: OWNER, name: NAME, n: w.base.pr.number, h: kk?.headSha }
              : which === "review"
                ? { owner: OWNER, name: NAME, n: w.base.pr.number }
                : { owner: OWNER, name: NAME, h: kk?.headSha };
          if (canon(v) !== canon(want)) violations.push(`#${index}: ${which} variables ${JSON.stringify(v)} for K0 ${kk?.headSha}`);
        }
      } else if (req && typeof req.rest === "string") {
        const runIds = (worldFor(Math.max(pass, 0)).base.runs ?? []).map((r) => r.id);
        const routes = k0 ? restRoutes(k0, runIds) : {};
        const hit: Kind | undefined = routes[req.rest];
        kind = hit ?? "UNKNOWN";
        if (hit === undefined) violations.push(`#${index}: REST route outside §5.1 for this pass's K0: ${req.rest}`);
      } else violations.push(`#${index}: a request that is neither REST nor GraphQL: ${JSON.stringify(req)}`);
      if (typeof req?.label !== "string" || req.label.length === 0) violations.push(`#${index}: a request without a label`);
    } catch (e) {
      violations.push(`#${index}: fake crashed: ${String(e)}`);
    }
    log.push({ index, kind, pass, label: req?.label });

    // the key served at this read, and the K0 that later reads of the pass must use
    let body: any;
    if (kind === "key") {
      const base = keyOf(current());
      const k: KeyVals = { ...base, ...(opts.keys?.[keyReads] ?? {}) };
      if (keyReads % 2 === 1) k0 = k;
      body = rawKeyOf(k, current().base.pr.baseSha);
    } else if (kind !== "UNKNOWN") {
      try {
        body = answer(kind, current(), k0!);
      } catch (e) {
        violations.push(`#${index}: ${String(e)}`);
        return { ok: false, reason: "read_failed", detail: `fake: ${String(e)}` };
      }
    } else return { ok: false, reason: "read_failed", detail: "fake: unknown request" };

    const fault = opts.faults?.[index] ?? opts.kindFaults?.[kind];
    if (fault) {
      if (fault.kind === "throw") throw new Error(`fake transport exploded at request ${index}`);
      if (fault.kind === "fail") return { ok: false, reason: fault.reason ?? "read_failed", detail: fault.detail ?? `fake: request ${index} interrupted` };
      if (fault.kind === "body") return { ok: true, body: fault.body };
      if (fault.kind === "mutate") return { ok: true, body: fault.f(body) };
      if (fault.kind === "raw") return fault.value;
    }
    return { ok: true, body };
  };
  return { request, log, violations, kinds: () => log.map((e) => e.kind) };
}

const canon = (x: unknown) => JSON.stringify(x, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));

/** Applicable (§3.4 step 7) and completed/success runs: the only runs whose jobs §5.3 reads. */
export function jobRunIds(w: CWorld, k: KeyVals = keyOf(w)): number[] {
  return w.base.runs
    .filter(
      (r) =>
        r.workflowId === WORKFLOW_ID &&
        r.event === "pull_request" &&
        r.headSha === k.headSha &&
        r.headRepoId === k.headRepoId &&
        r.headBranch === k.headRef &&
        r.status === "completed" &&
        r.conclusion === "success",
    )
    .map((r) => r.id)
    .sort((a, b) => a - b);
}

/** One pass's reads in §5.3's fixed order (the two blobs, and the job listings, as unordered groups). */
export function passKinds(w: CWorld, k: KeyVals = keyOf(w)): Kind[] {
  if (k.state !== "OPEN") return ["key", "key"];
  return [
    "key",
    "compare",
    "context",
    "pulls",
    "rules",
    "activity:force_push",
    "activity:branch_deletion",
    "activity:branch_creation",
    "runs",
    "review",
    "rollup",
    `blob:${BLOB_CI}`,
    `blob:${BLOB_CLASSIFY}`,
    ...jobRunIds(w, k).map((id) => `jobs:${id}` as Kind),
    "key",
  ];
}
/** Order-normalize: the two blobs may come in either order, and so may the job listings. */
export function normalizeKinds(ks: (Kind | "UNKNOWN")[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < ks.length) {
    if (String(ks[i]).startsWith("blob:") || String(ks[i]).startsWith("jobs:")) {
      const group: string[] = [];
      const prefix = String(ks[i]).slice(0, 5);
      while (i < ks.length && String(ks[i]).startsWith(prefix)) group.push(String(ks[i++]));
      out.push(...group.sort());
    } else out.push(String(ks[i++]));
  }
  return out;
}

// ---------------------------------------------------------------------------
// The local CI definition (§5.2), built here, not by local-ci.mjs
// ---------------------------------------------------------------------------
export const gitBlob = (bytes: Buffer | string) => {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest("hex");
};
export function localFrom(root: string, classify: (files: string[]) => any, over: Partial<{ blobs: Record<string, string>; tablePinned: boolean; classify: any }> = {}) {
  const blobs = {
    [BLOB_CI]: gitBlob(readFileSync(path.join(root, BLOB_CI))),
    [BLOB_CLASSIFY]: gitBlob(readFileSync(path.join(root, BLOB_CLASSIFY))),
  };
  return { classify: over.classify ?? classify, blobs: over.blobs ?? blobs, tablePinned: over.tablePinned ?? true };
}

/** A malformed edit per read kind, each violating its parser's rule (SPEC §1-§5.1). */
export const MALFORM: Record<string, (b: any) => any> = {
  key: (b) => ((b.data.repository.pullRequest.headRefOid = String(b.data.repository.pullRequest.headRefOid).toUpperCase()), b),
  compare: (b) => ((b.status = "Ahead"), b),
  context: (b) => ((b.data.repository.pullRequest.changedFiles = -1), b),
  pulls: (b) => (Array.isArray(b) && b.length ? ((b[0].state = "merged"), b) : [{ number: 0 }]),
  rules: () => [{ type: "" }],
  activity: () => [{ activity_type: "force_push", ref: PROD_REF_FULL, timestamp: "yesterday", before: "0".repeat(40), after: "0".repeat(40) }],
  runs: (b) => ((b.workflow_runs[0].id = 0), b),
  jobs: (b) => ((b.jobs[0].name = ""), b),
  review: (b) => ((b.data.repository.pullRequest.reviews.nodes[0].databaseId = "x"), b),
  rollup: (b) => ((b.data.repository.object.statusCheckRollup.contexts.nodes[0].status = ""), b),
  blob: (b) => ({ ...b, type: "dir" }),
};
export const malformFor = (kind: string) => MALFORM[kind.split(":")[0]];
