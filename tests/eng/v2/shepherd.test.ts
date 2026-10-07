/* eslint-disable @typescript-eslint/no-explicit-any -- reports are inspected as raw JSON on purpose */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { runShepherdCli } from "../../../scripts/eng/v2/cli-shepherd.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { EXIT, exitCodeFor } from "../../../scripts/eng/v2/shepherd.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { DECISIONS } from "../../../scripts/eng/v2/decision/decide.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { readReceipts } from "../../../scripts/eng/v2/receipts.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { classify } from "../../../scripts/classify-changes.mjs";
import { BASE_800, HEAD_800, RUN_800, fakeGhSpawn, load, routes800 } from "./support/fake-github";

// ===========================================================================
// ENG-LOOP V1 05C: the shepherd command.
//   * JSON mode writes only JSON to stdout, usage and internal errors included;
//   * every field the directive requires is present;
//   * exit codes: 0 candidate (advisory), 4 not a candidate, 3 UNKNOWN, 2 usage;
//   * no GitHub mutation: every request is a GET or a GraphQL query;
//   * the dedicated token never reaches stdout, stderr or a receipt.
// ===========================================================================

const ROOT = path.resolve(__dirname, "..", "..", "..");
const TOKEN = "github_pat_SHEPHERDtestTOKENshepherd0123456789";
const TOOL = `eng-loop-v1@${"d".repeat(40)}`;
const LOCAL = {
  classify,
  blobs: {
    ".github/workflows/ci.yml": load("blob/contents-ci.yml-6cdd830b.json").sha,
    "scripts/classify-changes.mjs": load("blob/contents-classify-changes.mjs-6cdd830b.json").sha,
  },
  tablePinned: true,
};
const REQUIRED_FIELDS = [
  "pr",
  "headSha",
  "production",
  "baseRef",
  "observedAt",
  "toolVersion",
  "evidenceHash",
  "decision",
  "reasonCodes",
  "blocking",
  "sourceReferences",
  "nextAction",
  "humanMergeRequired",
];

function sink() {
  let text = "";
  return { write: (s: string) => void (text += s), text: () => text };
}

function inProcess(argv: string[], routes = routes800(), env: any = { PATH: process.env.PATH, HONE_ENG_READ_TOKEN: TOKEN }) {
  const dir = mkdtempSync(path.join(tmpdir(), "hone-shepherd-test-"));
  const out = sink();
  const err = sink();
  const gh = fakeGhSpawn(routes);
  try {
    const code = runShepherdCli({
      argv,
      env,
      out,
      err,
      now: () => Date.parse("2026-10-07T21:00:00Z"),
      spawn: gh.spawn,
      local: LOCAL,
      toolVersion: TOOL,
      receiptsDir: dir,
    });
    return { code, stdout: out.text(), stderr: err.text(), calls: gh.calls, receipts: readReceipts(dir) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("shepherd: #800 end to end through the real primitive (recorded answers, fake gh)", () => {
  it("JSON mode prints one JSON report with every required field, and exits 4 for DRAFT_HOLD", () => {
    const r = inProcess(["shepherd", "800", "--json"]);
    expect(r.code).toBe(EXIT.NOT_CANDIDATE);
    const report = JSON.parse(r.stdout);
    for (const f of REQUIRED_FIELDS) expect(report, f).toHaveProperty(f);
    expect(report).toMatchObject({
      pr: 800,
      headSha: HEAD_800,
      baseRef: "claude/build-hone-saas-hOex7",
      production: { ref: "claude/build-hone-saas-hOex7", tip: BASE_800 },
      observedAt: "2026-10-07T21:00:00Z",
      toolVersion: TOOL,
      decision: "DRAFT_HOLD",
      reasonCodes: ["DRAFT_HOLD"],
      humanMergeRequired: true,
      receipt: "written",
      instrumentation: { requests: 30, failedRequests: 0, attempts: 1, confirmed: true, stage: "decided" },
    });
    expect(report.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(report.sourceReferences).toEqual([
      "https://github.com/SaiSamyukthVemuri/Hone/pull/800",
      `https://github.com/SaiSamyukthVemuri/Hone/commit/${HEAD_800}`,
      `https://github.com/SaiSamyukthVemuri/Hone/compare/${BASE_800}...${HEAD_800}`,
      `https://github.com/SaiSamyukthVemuri/Hone/actions/runs/${RUN_800}`,
    ]);
    expect(r.stderr).toBe("");
  });

  it("performs no GitHub mutation: every request is a REST GET or a GraphQL query", () => {
    const r = inProcess(["shepherd", "800", "--json"]);
    expect(r.calls).toHaveLength(30);
    for (const { args } of r.calls) {
      if (args[1] === "graphql") {
        expect(args[3]).toMatch(/^query=query\(/);
        expect(args.join(" ")).not.toMatch(/mutation/i);
      } else {
        expect(args.slice(0, 3)).toEqual(["api", "--method", "GET"]);
      }
    }
  });

  it("the dedicated token reaches only the child's environment — never stdout, stderr or a receipt", () => {
    const r = inProcess(["shepherd", "800", "--json"]);
    expect(r.stdout).not.toContain(TOKEN);
    expect(r.stderr).not.toContain(TOKEN);
    expect(JSON.stringify(r.receipts)).not.toContain(TOKEN);
    expect(r.calls.every((c: any) => !c.args.join(" ").includes(TOKEN) && c.env.GH_TOKEN === TOKEN)).toBe(true);
  });

  it("writes one valid diagnostic receipt with exactly the closed fields", () => {
    const r = inProcess(["shepherd", "800", "--json"]);
    expect(r.receipts.complete).toBe(true);
    expect(r.receipts.receipts).toHaveLength(1);
    const report = JSON.parse(r.stdout);
    expect(r.receipts.receipts[0]).toMatchObject({
      pr: 800,
      head: HEAD_800,
      evidenceHash: report.evidenceHash,
      decision: "DRAFT_HOLD",
      reasons: ["DRAFT_HOLD"],
      observed_at: "2026-10-07T21:00:00Z",
      tool_version: TOOL,
    });
    expect(Object.keys(r.receipts.receipts[0]).sort()).toEqual(
      ["checksum", "decision", "evidenceHash", "head", "observed_at", "pr", "reasons", "schema", "tool_version"],
    );
    expect(inProcess(["shepherd", "800", "--json", "--no-receipt"]).receipts.receipts).toHaveLength(0);
  });

  it("text mode prints the same facts for a person, and says a human merges", () => {
    const r = inProcess(["shepherd", "800"]);
    expect(r.code).toBe(EXIT.NOT_CANDIDATE);
    expect(r.stdout).toContain("DRAFT_HOLD");
    expect(r.stdout).toContain(HEAD_800);
    expect(r.stdout).toContain("a human authorizes it");
    expect(() => JSON.parse(r.stdout)).toThrow();
  });

  it("synthetic clean #800 — marked ready, its one open thread resolved by the human resolver — is a candidate: exit 0, still a human's merge", () => {
    const routes = routes800();
    const keyRoute = `pr-key {"n":800,"name":"Hone","owner":"SaiSamyukthVemuri"}`;
    const reviewRoute = `review-evidence {"n":800,"name":"Hone","owner":"SaiSamyukthVemuri"}`;
    routes[keyRoute] = () => {
      const raw = load("pr-key/pr-800-open-draft.json");
      raw.data.repository.pullRequest.isDraft = false;
      return raw;
    };
    routes[reviewRoute] = () => {
      const raw = load("review/review-800.json");
      for (const t of raw.data.repository.pullRequest.reviewThreads.nodes) {
        if (!t.isResolved) Object.assign(t, { isResolved: true, resolvedBy: { __typename: "User", login: "operator", databaseId: 26781116 } });
      }
      return raw;
    };
    const r = inProcess(["shepherd", "800", "--json"], routes);
    expect(r.code).toBe(EXIT.CANDIDATE);
    expect(JSON.parse(r.stdout)).toMatchObject({
      decision: "CANDIDATE_READY_FOR_HUMAN_REVIEW",
      humanMergeRequired: true,
      advisory: expect.stringContaining("not merge permission"),
    });
    expect(r.receipts.receipts[0]).toMatchObject({ decision: "CANDIDATE_READY_FOR_HUMAN_REVIEW" });
  });

  it("a read failure is UNKNOWN (exit 3), names the endpoint, and is never green", () => {
    const routes = routes800();
    delete routes[`repos/SaiSamyukthVemuri/Hone/actions/workflows/289443461/runs?head_sha=${HEAD_800}&event=pull_request&per_page=100`];
    const r = inProcess(["shepherd", "800", "--json"], routes);
    expect(r.code).toBe(EXIT.UNKNOWN);
    const report = JSON.parse(r.stdout);
    expect(report).toMatchObject({ decision: "UNKNOWN", reasonCodes: ["read_failed"], headSha: null, evidenceHash: null });
    expect(report.blocking.detail).toBe("candidate-runs: gh: Not Found (HTTP 404)");
    expect(report.instrumentation.failedRequests).toBe(1);
  });
});

describe("shepherd: exit codes and usage", () => {
  it("only CANDIDATE_READY_FOR_HUMAN_REVIEW exits 0; UNKNOWN exits 3; every other decision exits 4", () => {
    for (const d of DECISIONS) {
      expect(exitCodeFor(d), d).toBe(d === "CANDIDATE_READY_FOR_HUMAN_REVIEW" ? 0 : d === "UNKNOWN" ? 3 : 4);
    }
  });

  it("a usage error exits 2; in JSON mode stdout is still exactly one JSON document", () => {
    for (const argv of [["shepherd"], ["shepherd", "abc"], ["shepherd", "0"], ["shepherd", "810", "extra"], ["shepherd", "810", "--bogus"]]) {
      const json = inProcess([...argv, "--json"]);
      expect(json.code, argv.join(" ")).toBe(EXIT.USAGE);
      expect(JSON.parse(json.stdout)).toMatchObject({ error: "usage" });
      expect(json.calls).toHaveLength(0);
      const text = inProcess(argv);
      expect(text.code).toBe(EXIT.USAGE);
      expect(text.stdout).toBe("");
      expect(text.stderr).toContain("usage:");
    }
  });

  it("a receipt that cannot be written is reported on stderr and changes neither the decision nor the exit code", () => {
    const blocked = mkdtempSync(path.join(tmpdir(), "hone-shepherd-blocked-"));
    try {
      const file = path.join(blocked, "not-a-dir");
      writeFileSync(file, "x");
      const out = sink();
      const err = sink();
      const code = runShepherdCli({
        argv: ["shepherd", "800", "--json"],
        env: { PATH: process.env.PATH, HONE_ENG_READ_TOKEN: TOKEN },
        out,
        err,
        now: () => Date.parse("2026-10-07T21:00:00Z"),
        spawn: fakeGhSpawn(routes800()).spawn,
        local: LOCAL,
        toolVersion: TOOL,
        receiptsDir: path.join(file, "receipts"),
      });
      expect(code).toBe(EXIT.NOT_CANDIDATE);
      expect(JSON.parse(out.text())).toMatchObject({ decision: "DRAFT_HOLD", receipt: "failed" });
      expect(err.text()).toContain("diagnostic receipt not written");
    } finally {
      rmSync(blocked, { recursive: true, force: true });
    }
  });
});

describe("shepherd: the real CLI, as Claude Code runs it", () => {
  it("without the dedicated token: exit 3, pure JSON on stdout, UNKNOWN(read_failed), no request, a receipt", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hone-shepherd-cli-"));
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, HONE_ENG_RECEIPTS_DIR: dir };
      delete env.HONE_ENG_READ_TOKEN;
      const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/eng/cli.mjs"), "shepherd", "810", "--json"], {
        cwd: ROOT,
        env,
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(r.status).toBe(EXIT.UNKNOWN);
      const report = JSON.parse(r.stdout);
      for (const f of REQUIRED_FIELDS) expect(report, f).toHaveProperty(f);
      expect(report).toMatchObject({
        pr: 810,
        decision: "UNKNOWN",
        reasonCodes: ["read_failed"],
        humanMergeRequired: true,
        receipt: "written",
        instrumentation: { requests: 0, stage: "transport" },
      });
      expect(report.blocking.detail).toContain("HONE_ENG_READ_TOKEN");
      expect(report.toolVersion).toMatch(/^eng-loop-v1@([0-9a-f]{40}(\+dirty)?|unknown)$/);
      expect(readdirSync(dir).filter((f) => f.endsWith(".json"))).toHaveLength(1);
      expect(readReceipts(dir)).toMatchObject({ complete: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
