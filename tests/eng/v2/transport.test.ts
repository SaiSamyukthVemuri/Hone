/* eslint-disable @typescript-eslint/no-explicit-any -- fake spawn results are raw on purpose */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { TOKEN_ENV, createPrimitive } from "../../../scripts/eng/v2/adapter/internal/github/primitive.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { BLOB_PATHS, POLICY, createReaders } from "../../../scripts/eng/v2/adapter/internal/github/index.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { gitBlobSha, loadLocalCi, tablePinnedTo } from "../../../scripts/eng/v2/adapter/local-ci.mjs";
import { fakeGitHub } from "./support/fake-github";

// ===========================================================================
// ENG-LOOP V1 05A: the transport (CAP-01 §4) and the dedicated credential.
//
//   * no dedicated token -> no request at all, and the operator's session is
//     never a fallback;
//   * the child environment is built from nothing: an empty config dir and
//     home, the dedicated token, and no inherited credential;
//   * the token is never an argument, a result, a detail or a statistic;
//   * every reader refuses an out-of-type parameter before any request.
// ===========================================================================

const DEDICATED = "github_pat_DEDICATEDdedicatedDEDICATED0123456789";
const OPERATOR = "gho_OPERATORsessionOPERATOR0123456789abcd";

function fakeSpawn(result: Partial<{ status: number; stdout: string; stderr: string; error: any; signal: string }>) {
  const calls: Array<{ cmd: string; args: string[]; opts: any }> = [];
  const spawn = (cmd: string, args: string[], opts: any) => {
    calls.push({ cmd, args, opts });
    return { status: 0, stdout: "{}", stderr: "", signal: null, error: undefined, ...result };
  };
  return { spawn, calls };
}

const homes: string[] = [];
const deps = (extra: any = {}) => ({
  makeHome: () => {
    const d = `/tmp/fake-home-${homes.length}`;
    homes.push(d);
    return d;
  },
  removeHome: () => undefined,
  ...extra,
});

describe("primitive: the dedicated credential", () => {
  it("without the dedicated token it makes no request at all, even when the operator's session is present", () => {
    const { spawn, calls } = fakeSpawn({});
    const p = createPrimitive(deps({ env: { PATH: "/usr/bin", GH_TOKEN: OPERATOR, GITHUB_TOKEN: OPERATOR }, spawn }));
    expect(p).toMatchObject({ ok: false, reason: "read_failed" });
    expect(p.detail).toContain(TOKEN_ENV);
    expect(calls).toHaveLength(0);
    expect(createPrimitive(deps({ env: { [TOKEN_ENV]: "   " }, spawn }))).toMatchObject({ ok: false });
    expect(createPrimitive(deps({ env: undefined, spawn }))).toMatchObject({ ok: false });
  });

  it("the child environment is built from nothing: fresh empty config and home, the dedicated token, no inherited credential", () => {
    const { spawn, calls } = fakeSpawn({ stdout: "[]" });
    const env = {
      PATH: "/usr/bin:/bin",
      HOME: "/home/operator",
      GH_CONFIG_DIR: "/home/operator/.config/gh",
      GH_TOKEN: OPERATOR,
      GITHUB_TOKEN: OPERATOR,
      GH_ENTERPRISE_TOKEN: OPERATOR,
      [TOKEN_ENV]: DEDICATED,
    };
    const p = createPrimitive(deps({ env, spawn }));
    expect(p.ok).toBe(true);
    p.request({ label: "branch-rules", rest: "repos/o/r/rules/branches/main" });
    const childEnv = calls[0].opts.env;
    expect(Object.keys(childEnv).sort()).toEqual(
      ["GH_CONFIG_DIR", "GH_HOST", "GH_NO_UPDATE_NOTIFIER", "GH_PAGER", "GH_PROMPT_DISABLED", "GH_TOKEN", "HOME", "NO_COLOR", "PATH"],
    );
    expect(childEnv.GH_TOKEN).toBe(DEDICATED);
    expect(childEnv.HOME).toBe(childEnv.GH_CONFIG_DIR);
    expect(childEnv.HOME).not.toBe(env.HOME);
    expect(childEnv.GH_CONFIG_DIR).not.toBe(env.GH_CONFIG_DIR);
    expect(JSON.stringify(childEnv)).not.toContain(OPERATOR);
    expect(childEnv.PATH).toBe(env.PATH);
  });

  it.skipIf(spawnSync("gh", ["--version"]).status !== 0)(
    "live gh: the child environment without its token sees no stored session (gh auth status fails)",
    () => {
      const home = mkdtempSync(path.join(tmpdir(), "hone-eng-test-"));
      try {
        const { spawn, calls } = fakeSpawn({ stdout: "{}" });
        const p = createPrimitive({ env: { PATH: process.env.PATH, [TOKEN_ENV]: DEDICATED }, spawn, makeHome: () => home, removeHome: () => undefined });
        p.request({ label: "probe", rest: "repos/o/r" });
        const { GH_TOKEN: _token, ...withoutToken } = calls[0].opts.env;
        expect(_token).toBe(DEDICATED);
        const status = spawnSync("gh", ["auth", "status"], { env: withoutToken, encoding: "utf8" });
        expect(status.status).not.toBe(0);
        expect(`${status.stdout}${status.stderr}`).not.toMatch(/Logged in to github\.com account/);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it("the token is never an argument, a result, a detail or a statistic — an echo of it is redacted", () => {
    const { spawn, calls } = fakeSpawn({ status: 1, stdout: "", stderr: `gh: token ${DEDICATED} and ghp_abcdefghijklmnopqrstuvwxyz0123 rejected (HTTP 401)\nmore` });
    const p = createPrimitive(deps({ env: { PATH: "/usr/bin", [TOKEN_ENV]: DEDICATED }, spawn }));
    const r = p.request({ label: "pr-key", graphql: "query{viewer{login}}", variables: { owner: "o", name: "r", n: 1 } });
    expect(r).toMatchObject({ ok: false, reason: "read_failed" });
    expect(r.detail).toBe("pr-key: gh: token [redacted] and [redacted] rejected (HTTP 401)");
    expect(JSON.stringify(calls[0].args)).not.toContain(DEDICATED);
    expect(JSON.stringify(p.stats())).not.toContain(DEDICATED);
  });
});

describe("primitive: the token never leaves, even when GitHub echoes it", () => {
  const make = (result: any) => {
    const f = fakeSpawn(result);
    const p = createPrimitive(deps({ env: { PATH: "/usr/bin", [TOKEN_ENV]: DEDICATED }, spawn: f.spawn }));
    return { p, calls: f.calls };
  };

  it("a successful answer that echoes the token — a token pasted into a comment, say — comes back redacted", () => {
    const body = { comments: [{ body: `oops ${DEDICATED} pasted`, other: "ghp_abcdefghijklmnopqrstuvwxyz0123" }] };
    const r = make({ stdout: JSON.stringify(body) }).p.request({ label: "review-evidence", rest: "r" });
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain(DEDICATED);
    expect(r.body.comments[0].body).toBe("oops [redacted] pasted");
    expect(r.body.comments[0].other).toBe("[redacted]");
  });

  it("a token-shaped label is redacted in the statistics as well as in the detail", () => {
    const { p } = make({ status: 1, stderr: "gh: boom\n" });
    p.request({ label: `x-${DEDICATED}`, rest: "r" });
    expect(JSON.stringify(p.stats())).not.toContain(DEDICATED);
  });

  it("a request that is neither exactly REST nor exactly GraphQL is refused before anything is spawned", () => {
    const { p, calls } = make({ stdout: "{}" });
    const bad: any[] = [
      undefined,
      null,
      {},
      { label: "x" },
      { label: "x", rest: "" },
      { label: "x", graphql: "" },
      { label: "x", rest: "r", graphql: "query{x}" },
      { label: "", rest: "r" },
      { rest: "r" },
      { label: "x", graphql: "query{x}", variables: [] },
      { label: "x", graphql: "query{x}", variables: { n: 1.5 } },
      { label: "x", graphql: "query{x}", variables: { o: { a: 1 } } },
      { label: "x", graphql: "query{x}" },
      { label: "x", rest: "r", method: "POST" },
      { label: "x", graphql: "query{x}", variables: {}, extra: 1 },
      { label: "x", graphql: "query{x}", variables: new Map([["n", 1]]) },
      { label: "x", graphql: "query{x}", variables: new Date() },
      { label: "x", graphql: "query{x}", variables: new (class Vars { n = 1; })() },
    ];
    for (const req of bad) expect(p.request(req), JSON.stringify(req) ?? "undefined").toMatchObject({ ok: false, reason: "malformed" });
    expect(calls).toHaveLength(0);
  });
});

describe("primitive: one request, one closed result", () => {
  const make = (result: any) => {
    const f = fakeSpawn(result);
    let t = 1000;
    const p = createPrimitive(deps({ env: { PATH: "/usr/bin", [TOKEN_ENV]: DEDICATED }, spawn: f.spawn, now: () => (t += 7) }));
    return { p, calls: f.calls };
  };

  it("REST is a GET with fixed headers; GraphQL sends numbers typed and strings as strings", () => {
    const { p, calls } = make({ stdout: "{}" });
    p.request({ label: "compare", rest: "repos/o/r/compare/a...b" });
    expect(calls[0].cmd).toBe("gh");
    expect(calls[0].args).toEqual([
      "api",
      "--method",
      "GET",
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      "X-GitHub-Api-Version: 2022-11-28",
      "repos/o/r/compare/a...b",
    ]);
    p.request({ label: "pr-key", graphql: "query($n:Int!){x}", variables: { owner: "o", name: "r", n: 810, h: "abc" } });
    expect(calls[1].args).toEqual(["api", "graphql", "-f", "query=query($n:Int!){x}", "-f", "owner=o", "-f", "name=r", "-F", "n=810", "-f", "h=abc"]);
    expect(calls[1].opts).toMatchObject({ timeout: 30000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"] });
  });

  it("exit 0 with JSON is the body; non-zero is read_failed with gh's first stderr line; non-JSON is malformed; a timeout is read_failed", () => {
    expect(make({ stdout: '{"a":1}' }).p.request({ label: "x", rest: "r" })).toEqual({ ok: true, body: { a: 1 } });
    expect(make({ status: 1, stdout: '{"message":"Not Found"}', stderr: "gh: Not Found (HTTP 404)\n" }).p.request({ label: "run-jobs", rest: "r" })).toEqual({
      ok: false,
      reason: "read_failed",
      detail: "run-jobs: gh: Not Found (HTTP 404)",
    });
    expect(make({ stdout: "<html>" }).p.request({ label: "x", rest: "r" })).toMatchObject({ ok: false, reason: "malformed" });
    expect(make({ status: null, error: Object.assign(new Error("t"), { code: "ETIMEDOUT" }) }).p.request({ label: "x", rest: "r" })).toMatchObject({
      ok: false,
      reason: "read_failed",
      detail: "gh x: timed out after 30000 ms",
    });
    expect(make({ status: null, error: Object.assign(new Error("n"), { code: "ENOENT" }) }).p.request({ label: "x", rest: "r" })).toMatchObject({
      ok: false,
      reason: "read_failed",
    });
  });

  it("every request is counted and timed; a closed transport refuses; close removes the temporary home", () => {
    const removed: string[] = [];
    const f = fakeSpawn({ stdout: "{}" });
    let t = 0;
    const p = createPrimitive({ env: { PATH: "/usr/bin", [TOKEN_ENV]: DEDICATED }, spawn: f.spawn, now: () => (t += 5), makeHome: () => "/tmp/h1", removeHome: (d: string) => removed.push(d) });
    p.request({ label: "a", rest: "r" });
    p.request({ label: "b", rest: "r" });
    expect(p.stats()).toEqual([
      { label: "a", ms: 5, ok: true },
      { label: "b", ms: 5, ok: true },
    ]);
    p.close();
    p.close();
    expect(removed).toEqual(["/tmp/h1"]);
    expect(p.request({ label: "c", rest: "r" })).toMatchObject({ ok: false, reason: "read_failed" });
    expect(f.calls).toHaveLength(2);
  });
});

describe("readers: typed scalars only, refused before any request", () => {
  const H = "a".repeat(40);
  const readersWithLog = () => {
    const gh = fakeGitHub({});
    return { r: createReaders({ request: gh.request }), log: gh.log };
  };

  it("every reader refuses an out-of-type parameter without making a request", () => {
    const { r, log } = readersWithLog();
    const refusals = [
      r.readPrKey(0),
      r.readPrKey("800"),
      r.readCompare(H, "main"),
      r.readCompare("A".repeat(40), H),
      r.readPrContext(800, H.slice(1)),
      r.readHeadBranchPrs(""),
      r.readActivity("push"),
      r.readCandidateRuns(H.toUpperCase()),
      r.readRunJobs(-1),
      r.readRunJobs(1.5),
      r.readReviewEvidence(null),
      r.readCommitRollup(undefined),
      r.readFileBlob("package.json", H),
      r.readFileBlob("../.github/workflows/ci.yml", H),
      r.readFileBlob(BLOB_PATHS[0], "main"),
    ];
    for (const res of refusals) expect(res).toMatchObject({ ok: false, reason: "malformed" });
    expect(log).toHaveLength(0);
  });

  it("a head branch is URL-encoded into the pulls query, so '&' or '#' cannot add a parameter", () => {
    const { r, log } = readersWithLog();
    r.readHeadBranchPrs("feat/a&state=open#x");
    expect(log[0].rest).toBe(
      "repos/SaiSamyukthVemuri/Hone/pulls?head=SaiSamyukthVemuri%3Afeat%2Fa%26state%3Dopen%23x&state=all&per_page=100",
    );
  });

  it("a transport failure passes through unchanged; a non-result is read_failed", () => {
    const failing = createReaders({ request: () => ({ ok: false, reason: "read_failed", detail: "pr-key: gh: Bad credentials (HTTP 401)" }) });
    expect(failing.readPrKey(800)).toEqual({ ok: false, reason: "read_failed", detail: "pr-key: gh: Bad credentials (HTTP 401)" });
    const odd = createReaders({ request: () => undefined as any });
    expect(odd.readPrKey(800)).toMatchObject({ ok: false, reason: "read_failed" });
  });

  it("any policy but V1's fixed one is refused at construction; V1's own, or none, is accepted", () => {
    const request = () => ({ ok: true as const, body: [] });
    expect(() => createReaders({ request })).not.toThrow();
    expect(() => createReaders({ request, policy: { ...POLICY } })).not.toThrow();
    for (const over of [{ owner: "x" }, { name: "x" }, { repoId: 1 }, { productionRef: "main" }, { workflowId: 1 }, { extra: 1 }]) {
      expect(() => createReaders({ request, policy: { ...POLICY, ...over } }), JSON.stringify(over)).toThrow(/V1's fixed policy/);
    }
  });

  it("an unsafe production ref in the policy is refused at construction", () => {
    const request = () => ({ ok: true as const, body: [] });
    for (const productionRef of ["main?x=1", "a/../b", "", "main#frag"]) {
      expect(() => createReaders({ request, policy: { owner: "o", name: "r", repoId: 1, productionRef, workflowId: 1 } })).toThrow();
    }
  });
});

describe("local CI definition: the classifier the shepherd executes is hashed as git hashes it", () => {
  it("gitBlobSha matches git's own blob ids", () => {
    expect(gitBlobSha(Buffer.from(""))).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    expect(gitBlobSha(Buffer.from("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });

  it("this checkout's ci.yml pins the required-job table; one missing job name unpins it", () => {
    const local = loadLocalCi();
    expect(local.tablePinned).toBe(true);
    for (const p of BLOB_PATHS) expect(local.blobs[p]).toMatch(/^[0-9a-f]{40}$/);
    expect(tablePinnedTo("jobs:\n  a:\n    name: changed-path detection\n")).toBe(false);
  });

  it("the blobs come from the bytes on disk", () => {
    const reads: string[] = [];
    const local = loadLocalCi({
      root: "/r",
      read: (p: string) => {
        reads.push(p);
        return Buffer.from(p.endsWith("ci.yml") ? "" : "hello\n");
      },
    });
    expect(local.blobs).toEqual({
      ".github/workflows/ci.yml": "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
      "scripts/classify-changes.mjs": "ce013625030ba8dba906f756967f9e9ca394464a",
    });
    expect(local.tablePinned).toBe(false);
    expect(reads).toContain(path.join("/r", ".github/workflows/ci.yml"));
  });
});
