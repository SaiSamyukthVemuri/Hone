/* eslint-disable @typescript-eslint/no-explicit-any -- the fake returns raw, untyped GitHub JSON on purpose */
import { readFileSync } from "node:fs";
import path from "node:path";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { PR_KEY_QUERY } from "../../../../scripts/eng/v2/contract/pr-key.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { PR_CONTEXT_QUERY } from "../../../../scripts/eng/v2/adapter/internal/github/parse-base.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { REVIEW_EVIDENCE_QUERY } from "../../../../scripts/eng/v2/adapter/internal/github/parse-review.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { ROLLUP_QUERY } from "../../../../scripts/eng/v2/adapter/internal/github/parse-rollup.mjs";

// ---------------------------------------------------------------------------
// A STRICT fake of the transport's `request` function for the 05A collector.
//
// It answers only the exact requests it was scripted with — a REST route string,
// or a GraphQL label plus canonical variables — so a reader that builds the
// wrong route or variables gets "unexpected request" and the test fails. Every
// request is logged, and a fault hook can replace any answer by position, which
// is how interruption, permission and malformed-answer faults are injected.
// ---------------------------------------------------------------------------

const F = path.join(__dirname, "..", "fixtures");
export const load = (p: string) => JSON.parse(readFileSync(path.join(F, p), "utf8"));
export const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

export type Req = { label: string; rest?: string; graphql?: string; variables?: Record<string, unknown> };
export type Res = { ok: true; body: unknown } | { ok: false; reason: string; detail: string };

const canonical = (v: any): string =>
  v === null || typeof v !== "object"
    ? JSON.stringify(v)
    : Array.isArray(v)
      ? `[${v.map(canonical).join(",")}]`
      : `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
          .join(",")}}`;

/** The identity of one request: its REST route, or its GraphQL label and variables. */
export const requestId = (req: Req) => req.rest ?? `${req.label} ${canonical(req.variables ?? {})}`;

export type Routes = Record<string, (call: number) => unknown>;

export function fakeGitHub(routes: Routes, fault?: (req: Req, position: number) => Res | undefined) {
  const log: Req[] = [];
  const calls: Record<string, number> = {};
  const request = (req: Req): Res => {
    log.push(req);
    const position = log.length;
    const injected = fault?.(req, position);
    if (injected) return injected;
    const id = requestId(req);
    const answer = routes[id];
    if (!answer) return { ok: false, reason: "read_failed", detail: `unexpected request ${id}` };
    calls[id] = (calls[id] ?? 0) + 1;
    return { ok: true, body: clone(answer(calls[id])) };
  };
  return { request, log };
}

// ---------------------------------------------------------------------------
// #800 as recorded on 2026-10-07: open draft at fe62f51f, base production at
// 6cdd830b, one successful pull_request run, docs only. Rules are a parameter:
// production is unprotected today, so the protected answer is synthetic (the
// operator's Option A).
// ---------------------------------------------------------------------------
export const OWNER = "SaiSamyukthVemuri";
export const REPO_PATH = `repos/${OWNER}/Hone`;
export const PROD = "claude/build-hone-saas-hOex7";
export const BASE_800 = "6cdd830b0bcc5e3532016bc612bd0298db3533fb";
export const HEAD_800 = "fe62f51f0fd95fc97d2e21eef71d179e2e701358";
export const RUN_800 = 37673706298;
export const PROTECTED_RULES = [{ type: "non_fast_forward" }, { type: "deletion" }];

const vars = (extra: Record<string, unknown>) => ({ owner: OWNER, name: "Hone", ...extra });
const gql = (label: string, extra: Record<string, unknown>) => `${label} ${canonical(vars(extra))}`;
const activityRoute = (t: string) =>
  `${REPO_PATH}/activity?ref=${encodeURIComponent(`refs/heads/${PROD}`)}&activity_type=${t}&time_period=year&per_page=100`;

export function routes800({ rules = PROTECTED_RULES as unknown }: { rules?: unknown } = {}): Routes {
  const headRef = load("pr-key/pr-800-open-draft.json").data.repository.pullRequest.headRefName;
  return {
    [gql("pr-key", { n: 800 })]: () => load("pr-key/pr-800-open-draft.json"),
    [`${REPO_PATH}/compare/${BASE_800}...${HEAD_800}`]: () => load("base/compare-800.json"),
    [gql("pr-context", { n: 800, h: HEAD_800 })]: () => load("base/pr-context-800.json"),
    [`${REPO_PATH}/pulls?head=${encodeURIComponent(`${OWNER}:${headRef}`)}&state=all&per_page=100`]: () =>
      load("base/head-branch-prs-800.json"),
    [`${REPO_PATH}/rules/branches/${PROD}`]: () => rules,
    [activityRoute("force_push")]: () => load("base/activity-force-push-none.json"),
    [activityRoute("branch_deletion")]: () => load("base/activity-branch-deletion-none.json"),
    [activityRoute("branch_creation")]: () => load("base/activity-branch-creation-initial.json"),
    [`${REPO_PATH}/actions/workflows/289443461/runs?head_sha=${HEAD_800}&event=pull_request&per_page=100`]: () =>
      load("ci/runs-800.json"),
    [`${REPO_PATH}/actions/runs/${RUN_800}/jobs?filter=latest&per_page=100`]: () => load("ci/jobs-800.json"),
    [gql("review-evidence", { n: 800 })]: () => load("review/review-800.json"),
    [gql("commit-rollup", { h: HEAD_800 })]: () => load("rollup/rollup-800.json"),
    [`${REPO_PATH}/contents/.github/workflows/ci.yml?ref=${BASE_800}`]: () => load("blob/contents-ci.yml-6cdd830b.json"),
    [`${REPO_PATH}/contents/scripts/classify-changes.mjs?ref=${BASE_800}`]: () =>
      load("blob/contents-classify-changes.mjs-6cdd830b.json"),
  };
}

/** #809, merged: a terminal key reads nothing else. */
export function routes809(): Routes {
  return { [gql("pr-key", { n: 809 })]: () => load("pr-key/pr-809-merged.json") };
}

const LABEL_BY_QUERY: Record<string, string> = {
  [PR_KEY_QUERY]: "pr-key",
  [PR_CONTEXT_QUERY]: "pr-context",
  [REVIEW_EVIDENCE_QUERY]: "review-evidence",
  [ROLLUP_QUERY]: "commit-rollup",
};

/**
 * A fake `gh` at the PROCESS level, for the real primitive: it decodes the exact
 * argument vector `gh api` would receive back into a request identity and
 * answers from the same routes. An unscripted request is gh's 404.
 */
export function fakeGhSpawn(routes: Routes) {
  const calls: Array<{ args: string[]; env: Record<string, string> }> = [];
  const counts: Record<string, number> = {};
  const spawn = (_cmd: string, args: string[], opts: any) => {
    calls.push({ args, env: opts.env });
    let id: string;
    if (args[1] === "graphql") {
      const label = LABEL_BY_QUERY[args[3].slice("query=".length)] ?? "unknown-query";
      const vars: Record<string, unknown> = {};
      for (let i = 4; i < args.length; i += 2) {
        const [name, ...rest] = args[i + 1].split("=");
        vars[name] = args[i] === "-F" ? Number(rest.join("=")) : rest.join("=");
      }
      id = `${label} ${canonical(vars)}`;
    } else {
      id = args[args.length - 1];
    }
    const answer = routes[id];
    if (!answer) return { status: 1, stdout: '{"message":"Not Found"}', stderr: "gh: Not Found (HTTP 404)\n", signal: null };
    counts[id] = (counts[id] ?? 0) + 1;
    return { status: 0, stdout: JSON.stringify(answer(counts[id])), stderr: "", signal: null };
  };
  return { spawn, calls };
}
