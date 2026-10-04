import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  FORBIDDEN_ENV,
  REQUIRED_ENV,
  buildGeneratorInvocation,
  checkEnvironment,
  cliSummary,
  configFromEnv,
  createAppTokenSource,
  readOwnerOnlySecret,
  runOpenWikiProcess,
  isolatedChildEnv,
  runNightly,
  // @ts-expect-error - .mjs utility ships without type declarations
} from "../../scripts/openwiki/nightly.mjs";
// @ts-expect-error - .mjs utility ships without type declarations
import { renderReasons } from "../../scripts/openwiki/report.mjs";
// @ts-expect-error - .mjs utility ships without type declarations
import { MAX_TIMER_MS, parseRunLimit } from "../../scripts/openwiki/environment.mjs";
import {
  AGENTS_AUTHORED,
  AGENTS_TEMPLATE_REWRITE,
  OPENWIKI_SCAFFOLD_WORKFLOW,
  REPO_ROOT,
  cleanupTmp,
  createFixture,
  git,
  isolateGitConfig,
  read,
  restoreGitConfig,
  stampProvenance,
  write,
  writePrivate,
} from "./helpers";

// WIKI-AUTO-01 end to end, against a real git origin and a fake OpenWiki.

beforeAll(isolateGitConfig);
afterAll(restoreGitConfig);
afterEach(cleanupTmp);

type Fx = ReturnType<typeof createFixture>;
// The persisted report is plain JSON, read field by field below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Report = Record<string, any>;
type Result = { outcome: string; reasonCode: string; reason: string; report: Report };
type Gen = (args: { cwd: string }) => Promise<{ exitCode: number; output?: string }>;
type GitHubBehavior = {
  headSha?: string;
  createFails?: boolean;
  createError?: Error;
  commentFails?: boolean;
  closeFails?: boolean;
  beforeComment?: () => Promise<void>;
};

const IDENTITY = { name: "hone-wiki-runner[bot]", email: "runner@users.noreply.example.com" };

function setup(fx: Fx, overrides: Record<string, unknown> = {}) {
  const host = path.join(fx.root, "host");
  mkdirSync(path.join(host, "openwiki", "dist", "cli"), { recursive: true });
  writeFileSync(path.join(host, "openwiki", "package.json"), JSON.stringify({ name: "openwiki", version: "0.6.1" }));
  writeFileSync(path.join(host, "openwiki", "dist", "cli", "cli.js"), "// stub\n");
  const config = {
    enabled: true,
    publish: true,
    repository: "owner/repo",
    remoteUrl: fx.origin,
    baseBranch: "main",
    subjectDir: path.join(host, "subject"),
    stateDir: path.join(host, "state"),
    openwikiDir: path.join(host, "openwiki"),
    anthropicKeyFile: writePrivate(path.join(host, "anthropic-key"), "fixture-key\n"),
    denylistFile: writePrivate(path.join(host, "denylist"), "Synthetic Person\n"),
    modelId: "claude-fixture",
    identity: IDENTITY,
    minFreeBytes: 1,
    timeoutMs: 60_000,
    env: {},
    requiredEnv: [],
    // CI runs these tests on node 20; the host runs the runner on 22.x.
    nodeVersion: "22.23.2",
    ...overrides,
  };
  const prs: Array<Record<string, string>> = [];
  const comments: Array<{ number: number; body: string }> = [];
  const closes: number[] = [];
  const behavior: GitHubBehavior = {};
  const github = () => ({
    async createPullRequest(args: Record<string, string>) {
      if (behavior.createError) throw behavior.createError;
      if (behavior.createFails) throw new Error("POST /pulls failed: HTTP 422");
      prs.push(args);
      return { number: 7, url: "https://example.invalid/pull/7", headSha: behavior.headSha ?? originRef(fx, args.head) };
    },
    async comment(number: number, body: string) {
      if (behavior.beforeComment) await behavior.beforeComment();
      if (behavior.commentFails) throw new Error("POST /issues/7/comments failed: HTTP 502");
      comments.push({ number, body });
    },
    async closePullRequest(number: number) {
      if (behavior.closeFails) throw new Error("PATCH /pulls/7 failed: HTTP 500");
      closes.push(number);
    },
  });
  return { config, prs, comments, closes, behavior, github };
}

function originRef(fx: Fx, branch: string): string | undefined {
  try {
    return git(fx.origin, ["rev-parse", `refs/heads/${branch}`]);
  } catch {
    return undefined;
  }
}

function originBranches(fx: Fx): string[] {
  return git(fx.origin, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]).split("\n").filter(Boolean);
}

/** openwiki/.last-update.json exactly as openwiki@0.6.1 writes it (agent/utils.js writeLastUpdateMetadata). */
function lastUpdateJson(gitHead: string, overrides: Record<string, unknown> = {}): string {
  const metadata = { updatedAt: "2026-10-05T03:30:00.000Z", command: "update", gitHead, model: "claude-fixture", status: "complete", language: "en", ...overrides };
  return `${JSON.stringify(metadata, null, 2)}\n`;
}

/**
 * Simulates `openwiki code --update --print`, including its writes outside
 * openwiki/. `pages` runs before OpenWiki's finish step (provenance, run
 * metadata); `after` runs once the run is otherwise complete.
 */
function openWikiLike(opts: { pages?: (cwd: string) => void; after?: (cwd: string) => void } = {}): Gen {
  return async ({ cwd }) => {
    write(cwd, "openwiki/topic/kept-page.md", "# Kept page\n\nFeature is 2.\n");
    write(cwd, "openwiki/topic/new-page.md", "# New page\n\nDocumented.\n");
    const kept = JSON.parse(read(cwd, "openwiki/.claims/topic/kept-page.json"));
    kept.claims[0].statement = "Feature is 2.";
    write(cwd, "openwiki/.claims/topic/kept-page.json", JSON.stringify(kept));
    git(cwd, ["rm", "--quiet", "openwiki/topic/old-page.md"]);
    opts.pages?.(cwd);
    stampProvenance(cwd, ["openwiki/topic/kept-page.md", "openwiki/topic/new-page.md"], ["openwiki/topic/old-page.md"]);
    write(cwd, "openwiki/.last-update.json", lastUpdateJson(git(cwd, ["rev-parse", "HEAD"])));
    write(cwd, "AGENTS.md", AGENTS_TEMPLATE_REWRITE);
    write(cwd, ".github/workflows/openwiki-update.yml", OPENWIKI_SCAFFOLD_WORKFLOW);
    opts.after?.(cwd);
    return { exitCode: 0, output: "done" };
  };
}

/** A run that only refreshes run metadata, as OpenWiki's no-op path or an empty plan does. */
function metadataOnly(opts: { lastUpdate?: Record<string, unknown>; manifest?: (cwd: string) => void } = {}): Gen {
  return async ({ cwd }) => {
    write(cwd, "openwiki/.last-update.json", lastUpdateJson(git(cwd, ["rev-parse", "HEAD"]), opts.lastUpdate));
    opts.manifest?.(cwd);
    return { exitCode: 0 };
  };
}
const metadataOnlyRun = metadataOnly();

/** Commit files even where .gitignore would skip them (the fixture ignores /openwiki/.run.json, as the repository does). */
function commitForced(fx: Fx, files: Record<string, string>, message: string): void {
  for (const [file, content] of Object.entries(files)) write(fx.work, file, content);
  git(fx.work, ["add", "--force", "--", ...Object.keys(files)]);
  git(fx.work, ["commit", "--quiet", "-m", message]);
}

/** A source change after the recorded gitHead makes the wiki stale. */
function makeStale(fx: Fx): string {
  const source2 = fx.commit({ "lib/feature.ts": "export const feature = 2;\n" }, "source: feature 2");
  fx.push();
  return source2;
}

/** Every pass in this file goes through here: the sink must never have had to withhold a producer's value. */
async function pass(config: Record<string, unknown>, deps: Record<string, unknown>): Promise<Result> {
  const result: Result = await runNightly(config, deps);
  expect(result.report.withheld, `the sink withheld ${result.report.withheld} value(s) a producer handed it`).toBe(0);
  return result;
}

async function run(fx: Fx, generator: Gen, overrides: Record<string, unknown> = {}, behavior: GitHubBehavior = {}) {
  const ctx = setup(fx, overrides);
  Object.assign(ctx.behavior, behavior);
  const spy = vi.fn(generator);
  const result = await pass(ctx.config, { generator: spy, github: ctx.github, now: () => Date.UTC(2026, 9, 5) });
  return { ...ctx, result, generator: spy };
}

/** Every place a pass leaves text: last-run.json, each runs/*.json, and the CLI line. */
function sinks(stateDir: string, result: Result): Array<[string, string]> {
  const runs = path.join(stateDir, "runs");
  const files = [path.join(stateDir, "last-run.json"), ...(existsSync(runs) ? readdirSync(runs).map((n) => path.join(runs, n)) : [])];
  return [...files.map((file): [string, string] => [file, readFileSync(file, "utf8")]), ["the CLI summary", cliSummary(result)]];
}

function expectNowhere(stateDir: string, result: Result, literals: string[]) {
  const found = sinks(stateDir, result);
  expect(found.length).toBeGreaterThan(2);
  for (const [where, text] of found) {
    for (const literal of literals) expect(text.toLowerCase().includes(literal.toLowerCase()), `"${literal}" in ${where}`).toBe(false);
  }
}

describe("startup no-op", () => {
  it("a live wiki ends before OpenWiki runs and before any run prerequisite is checked", async () => {
    const fx = createFixture();
    const { result, generator } = await run(fx, openWikiLike(), { anthropicKeyFile: "/nonexistent" });
    expect(result.outcome, result.reason).toBe("NOOP");
    expect(result.reasonCode).toBe("WIKI_LIVE");
    expect(result.report.liveness.state).toBe("live");
    expect(result.report.sourceHead).toBe(fx.source1);
    expect(generator).not.toHaveBeenCalled();
  });

  it("a merged wiki-only commit does not make the wiki stale", async () => {
    const fx = createFixture();
    fx.commit({ "openwiki/topic/kept-page.md": "# Kept page\n\nHand fix.\n" }, "wiki-only");
    fx.push();
    const { result, generator } = await run(fx, openWikiLike());
    expect(result.outcome, result.reason).toBe("NOOP");
    expect(generator).not.toHaveBeenCalled();
  });
});

describe("a stale wiki is regenerated and published", () => {
  it("pins HEAD to the source head while the tree carries the newest wiki", async () => {
    const fx = createFixture();
    const source2 = makeStale(fx);
    fx.commit({ "openwiki/quickstart.md": "# Quickstart\n\nNewest wiki.\n" }, "wiki-only after source");
    fx.push();
    let seen: { head: string; quickstart: string } | undefined;
    const { result } = await run(fx, async (args) => {
      seen = { head: git(args.cwd, ["rev-parse", "HEAD"]), quickstart: read(args.cwd, "openwiki/quickstart.md") };
      return openWikiLike()(args);
    });
    expect(seen).toEqual({ head: source2, quickstart: "# Quickstart\n\nNewest wiki.\n" });
    expect(result.outcome, result.reason).toBe("PUBLISHED");
  });

  it("publishes exactly the generated scope, replacing it, as the runner, through one PR", async () => {
    const fx = createFixture();
    const source2 = makeStale(fx);
    const tip = git(fx.work, ["rev-parse", "HEAD"]);
    const { result, prs, comments } = await run(fx, openWikiLike());
    expect(result.outcome, result.reason).toBe("PUBLISHED");
    expect(result.reasonCode).toBe("PULL_REQUEST_OPENED");
    expect(result.reason).toBe("pull request #7");

    const branch = result.report.publish.branch;
    expect(branch).toBe(`openwiki/nightly-20261005-${source2.slice(0, 7)}`);
    const head = originRef(fx, branch)!;
    expect(head).toBe(result.report.publish.head);
    expect(git(fx.origin, ["rev-list", "--parents", "-n", "1", head]).split(" ").slice(1)).toEqual([tip]);
    expect(git(fx.origin, ["diff", "--name-status", "--no-renames", tip, head]).split("\n").sort()).toEqual([
      "A\topenwiki/.claims/topic/new-page.json",
      "A\topenwiki/topic/new-page.md",
      "D\topenwiki/.claims/topic/old-page.json",
      "D\topenwiki/topic/old-page.md",
      "M\topenwiki/.claims/topic/kept-page.json",
      "M\topenwiki/.last-update.json",
      "M\topenwiki/.page-manifest.json",
      "M\topenwiki/topic/kept-page.md",
    ]);
    const lastUpdate = JSON.parse(git(fx.origin, ["show", `${head}:openwiki/.last-update.json`]));
    expect(lastUpdate.gitHead).toBe(source2);
    expect(git(fx.origin, ["show", `${head}:AGENTS.md`])).toBe(AGENTS_AUTHORED.replace(/\n$/u, ""));
    expect(git(fx.origin, ["show", `${head}:openwiki/INSTRUCTIONS.md`])).toBe("# Instructions\n\nAuthored.");
    expect(git(fx.origin, ["log", "-1", "--format=%an <%ae> / %cn <%ce>", head])).toBe(
      `${IDENTITY.name} <${IDENTITY.email}> / ${IDENTITY.name} <${IDENTITY.email}>`,
    );

    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ head: branch, base: "main" });
    expect(prs[0].body).toContain(source2);
    expect(comments).toEqual([{ number: 7, body: `@codex review\n\nExact head \`${head}\`.` }]);
    expect(git(fx.origin, ["rev-parse", "refs/heads/main"])).toBe(tip); // never merged
    expect(result.report.pathGate).toEqual({ scanned: 10, rejected: 0, categories: [] });
  });

  it("A3: discards and records OpenWiki's writes outside the generated scope", async () => {
    const fx = createFixture();
    makeStale(fx);
    const { result } = await run(fx, openWikiLike());
    const discarded = result.report.discarded as Array<{ path: string; reasonCode: string; reason: string; workflowInspection?: string[] }>;
    expect(discarded.map((d) => d.path).sort()).toEqual([".github/workflows/openwiki-update.yml", "AGENTS.md"]);
    const workflow = discarded.find((d) => d.path === ".github/workflows/openwiki-update.yml")!;
    expect(workflow.reasonCode).toBe("WORKFLOW_SCAFFOLD_FAILS_INSPECTION");
    expect(workflow.reason).toMatch(/^A3: .*would fail CI-workflow inspection/u);
    expect(workflow.workflowInspection).toContain("write-permission");
  });

  it("a dry run checks everything and publishes nothing", async () => {
    const fx = createFixture();
    makeStale(fx);
    const { result, prs } = await run(fx, openWikiLike(), { publish: false });
    expect(result.outcome, result.reason).toBe("DRY_RUN");
    expect(prs).toEqual([]);
    expect(originBranches(fx)).toEqual(["main"]);
  });
});

describe("fail closed", () => {
  const failsWith = async (fx: Fx, generator: Gen, reasonCode: string, reason?: RegExp) => {
    const { result, prs } = await run(fx, generator);
    expect(result.outcome, result.reason).toBe("FAILED");
    expect(result.reasonCode, result.reason).toBe(reasonCode);
    if (reason) expect(result.reason).toMatch(reason);
    expect(prs).toEqual([]);
    expect(originBranches(fx)).toEqual(["main"]);
    const subject = path.join(fx.root, "host", "subject");
    expect(git(subject, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
    return result;
  };

  it("an unexpected write outside the generated scope", async () => {
    const fx = createFixture();
    makeStale(fx);
    const result = await failsWith(
      fx,
      openWikiLike({ pages: (cwd) => write(cwd, "lib/feature.ts", "export const feature = 99;\n") }),
      "UNEXPECTED_GENERATOR_WRITE",
      /outside the generated scope: 1 path/u,
    );
    expect(result.report.discarded).toContainEqual(expect.objectContaining({ path: "lib/feature.ts", reasonCode: "UNEXPECTED_WRITE", kind: "source" }));
  });

  it("a write to the authored openwiki/INSTRUCTIONS.md", async () => {
    const fx = createFixture();
    makeStale(fx);
    const result = await failsWith(fx, openWikiLike({ pages: (cwd) => write(cwd, "openwiki/INSTRUCTIONS.md", "# changed\n") }), "UNEXPECTED_GENERATOR_WRITE");
    expect(result.report.discarded).toContainEqual(expect.objectContaining({ path: "openwiki/INSTRUCTIONS.md", kind: "authored" }));
  });

  it("OpenWiki exits non-zero", async () => {
    const fx = createFixture();
    makeStale(fx);
    await failsWith(fx, async () => ({ exitCode: 1, output: "provider error" }), "GENERATOR_EXIT_NONZERO", /OpenWiki exited 1/u);
  });

  it("OpenWiki leaves its run state behind", async () => {
    const fx = createFixture();
    makeStale(fx);
    await failsWith(fx, openWikiLike({ after: (cwd) => write(cwd, "openwiki/.run.json", "{}") }), "RUN_STATE_LEFT_BEHIND", /did not complete/u);
  });

  it("gitHead that is not the pinned source head", async () => {
    const fx = createFixture();
    makeStale(fx);
    await failsWith(
      fx,
      openWikiLike({
        after: (cwd) => write(cwd, "openwiki/.last-update.json", JSON.stringify({ command: "update", status: "complete", gitHead: fx.source1 })),
      }),
      "LAST_UPDATE_INVALID",
      /gitHead does not equal the source head/u,
    );
  });

  it("a broken-link stamp", async () => {
    const fx = createFixture();
    makeStale(fx);
    await failsWith(
      fx,
      openWikiLike({
        pages: (cwd) => write(cwd, "openwiki/topic/new-page.md", "# New\n<!-- openwiki: broken internal link [x.md] missing. Fix the href or restore the target, then delete this comment. -->\n[x](x.md)\n"),
      }),
      "BROKEN_LINK_STAMPS",
      /broken-link stamp/u,
    );
  });

  it("a denylisted name or tenant slug, reported without its text", async () => {
    const fx = createFixture();
    makeStale(fx);
    const result = await failsWith(
      fx,
      openWikiLike({ pages: (cwd) => write(cwd, "openwiki/topic/new-page.md", "# New\n\nSynthetic Person booked at synthetic-studio-one.\n") }),
      "CONTENT_PRIVACY_HITS",
      /privacy\/secret denylist/u,
    );
    expect(result.report.checks.privacyHits).toEqual([
      { file: "openwiki/topic/new-page.md", line: 3, category: "denylist-term" },
      { file: "openwiki/topic/new-page.md", line: 3, category: "tenant-slug" },
    ]);
    expectNowhere(path.join(fx.root, "host", "state"), result, ["synthetic person", "synthetic-studio-one"]);
  });

  it("a conflict marker in generated output", async () => {
    const fx = createFixture();
    makeStale(fx);
    await failsWith(
      fx,
      openWikiLike({ pages: (cwd) => write(cwd, "openwiki/topic/new-page.md", "# New\n\n<<<<<<< ours\nA\n=======\nB\n>>>>>>> theirs\n") }),
      "CONFLICT_MARKERS",
      /conflict marker/u,
    );
  });

  it("provenance: a page whose sidecar and manifest describe other bytes", async () => {
    const fx = createFixture();
    makeStale(fx);
    await failsWith(
      fx,
      openWikiLike({ after: (cwd) => write(cwd, "openwiki/topic/kept-page.md", "# Kept page\n\nEdited after the run.\n") }),
      "PROVENANCE_INVALID",
      /pageVersion does not match the page/u,
    );
  });

  it("provenance: a deleted page that leaves its Claim sidecar behind", async () => {
    const fx = createFixture();
    makeStale(fx);
    await failsWith(
      fx,
      openWikiLike({ after: (cwd) => git(cwd, ["checkout", "HEAD", "--", "openwiki/.claims/topic/old-page.json"]) }),
      "PROVENANCE_INVALID",
      /Claim sidecar of a deleted page/u,
    );
  });
});

describe("metadata-only source advance (repository state is the cursor)", () => {
  it("publishing off: a successful metadata-only advance is a DRY_RUN, not a NOOP", async () => {
    const fx = createFixture();
    makeStale(fx);
    const { result, prs } = await run(fx, metadataOnlyRun, { publish: false });
    expect(result.outcome, result.reason).toBe("DRY_RUN");
    expect(result.reason).toContain("metadata-only source advance");
    expect(result.report.metadataOnly).toBe(true);
    expect(prs).toEqual([]);
  });

  it("publishing on: the refreshed gitHead is published, and once merged the next pass is a true startup NOOP", async () => {
    const fx = createFixture();
    const source2 = makeStale(fx);
    const first = await run(fx, metadataOnlyRun);
    expect(first.result.outcome, first.result.reason).toBe("PUBLISHED");
    expect(first.prs[0].title).toContain("(metadata only)");
    const branch = first.result.report.publish.branch;
    const head = originRef(fx, branch)!;
    const tip = git(fx.work, ["rev-parse", "HEAD"]);
    expect(git(fx.origin, ["diff", "--name-only", tip, head])).toBe("openwiki/.last-update.json");
    expect(JSON.parse(git(fx.origin, ["show", `${head}:openwiki/.last-update.json`])).gitHead).toBe(source2);

    // A human merges the PR (the runner never does).
    git(fx.work, ["fetch", "--quiet", "origin", branch]);
    git(fx.work, ["merge", "--quiet", "--no-ff", "-m", "Merge nightly metadata", "FETCH_HEAD"]);
    fx.push();

    const second = await run(fx, metadataOnlyRun);
    expect(second.result.outcome, second.result.reason).toBe("NOOP");
    expect(second.result.report.liveness).toMatchObject({ state: "live", gitHead: source2 });
    expect(second.generator).not.toHaveBeenCalled();
  });
});

describe("production moved during generation", () => {
  it("publishes nothing from a run whose pinned production tip is no longer the remote base", async () => {
    const fx = createFixture();
    makeStale(fx);
    const generate = openWikiLike();
    const { result, prs } = await run(fx, async (args) => {
      // The race, deterministically: production advances while OpenWiki runs.
      fx.commit({ "lib/feature.ts": "export const feature = 3;\n" }, "source: feature 3 lands mid-run");
      fx.push();
      return generate(args);
    });
    expect(result.outcome, result.reason).toBe("FAILED");
    expect(result.reasonCode).toBe("BASE_MOVED");
    expect(result.reason).toMatch(/^production advanced during the run \([0-9a-f]{7} -> [0-9a-f]{7}\); nothing published/u);
    expect(prs).toEqual([]);
    expect(originBranches(fx)).toEqual(["main"]);
    expect(result.report.publish).toBeUndefined();
  });
});

describe("after the pull request is created (#786 review of 3644d2fb)", () => {
  it("1: a head that is not the verified commit closes the PR and deletes the branch", async () => {
    const fx = createFixture();
    makeStale(fx);
    const { result, closes, comments } = await run(fx, openWikiLike(), {}, { headSha: "0".repeat(40) });
    expect(result.outcome, result.reason).toBe("FAILED");
    expect(result.reasonCode).toBe("PULL_REQUEST_HEAD_MISMATCH");
    expect(result.reason).toBe("pull request #7 was not completed (head-mismatch); pull request closed and branch deleted");
    expect(closes).toEqual([7]);
    expect(comments).toEqual([]);
    expect(originBranches(fx)).toEqual(["main"]);
    expect(result.report.publish).toMatchObject({ failure: "head-mismatch", cleanup: { pullRequest: "closed", branch: "deleted" }, pr: { number: 7 } });
  });

  it("2: a failed review-request comment closes the PR and deletes the branch, reporting a category only", async () => {
    const fx = createFixture();
    makeStale(fx);
    const { result, closes } = await run(fx, openWikiLike(), {}, { commentFails: true });
    expect(result.outcome, result.reason).toBe("FAILED");
    expect(result.reasonCode).toBe("REVIEW_REQUEST_FAILED");
    expect(result.reason).toBe("pull request #7 was not completed (review-request-failed); pull request closed and branch deleted");
    expect(result.reason).not.toContain("HTTP");
    expect(closes).toEqual([7]);
    expect(originBranches(fx)).toEqual(["main"]);
  });

  it("3: a failed branch delete does not stop the PR close, keeps the identity, and the next pass does not claim success", async () => {
    const fx = createFixture();
    makeStale(fx);
    git(fx.origin, ["config", "receive.denyDeletes", "true"]);
    const { result, closes } = await run(fx, openWikiLike(), {}, { commentFails: true });
    const branch = result.report.publish.branch;
    expect(result.outcome, result.reason).toBe("FAILED");
    expect(closes).toEqual([7]);
    expect(result.report.publish).toMatchObject({ cleanup: { pullRequest: "closed", branch: "delete-failed" }, head: originRef(fx, branch) });
    expect(result.reason).toBe(`pull request #7 was not completed (review-request-failed); cleanup incomplete (pull request #7: closed; branch ${branch}: delete-failed); recover by hand`);
    expect(originBranches(fx)).toContain(branch);

    const next = await run(fx, openWikiLike());
    expect(next.result.outcome, next.result.reason).toBe("SKIP");
    expect(next.result.reason).toContain(branch);
    expect(next.generator).not.toHaveBeenCalled();
  });

  it("4: a failed PR close does not stop the branch delete", async () => {
    const fx = createFixture();
    makeStale(fx);
    const { result, closes } = await run(fx, openWikiLike(), {}, { commentFails: true, closeFails: true });
    expect(result.outcome, result.reason).toBe("FAILED");
    expect(closes).toEqual([]);
    expect(result.report.publish).toMatchObject({ cleanup: { pullRequest: "close-failed", branch: "deleted" } });
    expect(result.reason).toContain("pull request #7: close-failed");
    expect(originBranches(fx)).toEqual(["main"]);
  });

  it("5: a created PR at the verified head with its review request is PUBLISHED, with no cleanup", async () => {
    const fx = createFixture();
    makeStale(fx);
    const { result, closes, comments } = await run(fx, openWikiLike());
    const branch = result.report.publish.branch;
    expect(result.outcome, result.reason).toBe("PUBLISHED");
    expect(closes).toEqual([]);
    expect(comments).toEqual([{ number: 7, body: `@codex review\n\nExact head \`${originRef(fx, branch)}\`.` }]);
    expect(result.report.publish.cleanup).toBeUndefined();
    expect(originBranches(fx)).toContain(branch);
  });

  it("6: nothing is PUBLISHED, or recorded, until the review request has succeeded", async () => {
    const fx = createFixture();
    makeStale(fx);
    const ctx = setup(fx);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    ctx.behavior.beforeComment = () => gate;
    let settled = false;
    const pending = pass(ctx.config, { generator: openWikiLike(), github: ctx.github, now: () => Date.UTC(2026, 9, 5) }).then((r: Result) => {
      settled = true;
      return r;
    });
    await vi.waitFor(() => expect(ctx.prs).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    expect(existsSync(path.join(ctx.config.stateDir, "last-run.json"))).toBe(false);
    release();
    const result: Result = await pending;
    expect(result.outcome, result.reason).toBe("PUBLISHED");
    expect(ctx.comments).toHaveLength(1);
  });
});

describe("cleanup deletes only the branch it pushed (#786 review of 61c9496a)", () => {
  it("leaves a nightly branch that moved after the runner pushed it, while still closing the PR", async () => {
    const fx = createFixture();
    makeStale(fx);
    const ctx = setup(fx);
    let movedTo = "";
    ctx.behavior.commentFails = true;
    ctx.behavior.beforeComment = async () => {
      // Someone else pushes to the nightly branch between PR creation and the failed comment.
      const branch = ctx.prs[0].head;
      git(fx.work, ["fetch", "--quiet", "origin", branch]);
      git(fx.work, ["switch", "--quiet", "--detach", "FETCH_HEAD"]);
      write(fx.work, "openwiki/topic/extra.md", "# Someone else's commit\n");
      git(fx.work, ["add", "-A"]);
      git(fx.work, ["commit", "--quiet", "-m", "someone else"]);
      git(fx.work, ["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`]);
      movedTo = git(fx.work, ["rev-parse", "HEAD"]);
      git(fx.work, ["switch", "--quiet", "main"]);
    };
    const result = await pass(ctx.config, { generator: openWikiLike(), github: ctx.github, now: () => Date.UTC(2026, 9, 5) });
    const branch = result.report.publish.branch;
    expect(result.outcome, result.reason).toBe("FAILED");
    expect(ctx.closes).toEqual([7]);
    expect(result.report.publish.cleanup).toEqual({ pullRequest: "closed", branch: "delete-failed" });
    expect(originRef(fx, branch)).toBe(movedTo);
  });

  it("a failed PR creation still deletes the branch it pushed", async () => {
    const fx = createFixture();
    makeStale(fx);
    const { result, prs } = await run(fx, openWikiLike(), {}, { createFails: true });
    expect(result.outcome, result.reason).toBe("FAILED");
    expect(result.reasonCode).toBe("PULL_REQUEST_CREATE_FAILED");
    expect(result.reason).toContain("the pushed branch was deleted");
    expect(prs).toEqual([]);
    expect(originBranches(fx)).toEqual(["main"]);
  });
});

// ---------------------------------------------------------------------------
// The #786 architecture review of 2ba37643: ONE safe reporting boundary. The
// tests below are per defect FAMILY: each runs every member it names through
// the real runner and checks every sink (last-run.json, each runs/*.json and
// the CLI line), not one string in one place.
// ---------------------------------------------------------------------------

describe("G1/G2: the path gate runs before any changed path is recorded", () => {
  const SENSITIVE_PATHS: Array<[string, string, string, string]> = [
    // [label, path the run writes, literal that must appear nowhere, gate category]
    ["unexpected: a hyphenated denylisted name", "docs/Synthetic-Person.md", "synthetic-person", "denylist-term"],
    ["unexpected: a tenant slug", "lib/synthetic-studio-one/config.ts", "synthetic-studio-one", "tenant-slug"],
    ["unexpected: an email address", "notes/zz.unique.person@hone.example.org.md", "zz.unique.person@hone.example.org", "email"],
    ["unexpected: a UUID", "data/123e4567-e89b-42d3-a456-426614174000.json", "123e4567-e89b-42d3-a456-426614174000", "uuid"],
    ["unexpected: a path that cannot be recorded safely", "docs/Quillon `Vantablack`.md", "quillon", "unsafe-path-format"],
    ["unexpected: OpenWiki's ignored scope is no exception", "docs/audits/synthetic-person-audit.md", "synthetic-person-audit", "denylist-term"],
    ["generated: a hyphenated denylisted name", "openwiki/people/synthetic-person.md", "synthetic-person", "denylist-term"],
    ["generated: a tenant slug", "openwiki/studios/synthetic-studio-one.md", "synthetic-studio-one", "tenant-slug"],
    ["generated: a Claim sidecar named for a tenant", "openwiki/.claims/studios/synthetic-studio-one.json", "synthetic-studio-one", "tenant-slug"],
  ];

  it.each(SENSITIVE_PATHS)("%s fails the run and no sink holds the path", async (_label: string, file: string, literal: string, category: string) => {
    const fx = createFixture();
    makeStale(fx);
    const { result, prs, config } = await run(fx, openWikiLike({ pages: (cwd) => write(cwd, file, "# Page\n\nNothing sensitive in the text.\n") }));
    expect(result.outcome, result.reason).toBe("FAILED");
    expect(result.reasonCode).toBe("PATH_PRIVACY_REJECTED");
    expect(result.report.safeDetails).toEqual({ paths: 1, categories: [category] });
    expect(result.report.pathGate).toMatchObject({ rejected: 1, categories: [category] });
    expect(result.report.discarded).toEqual([]);
    expect(result.report.checks).toBeUndefined();
    expect(prs).toEqual([]);
    expect(originBranches(fx)).toEqual(["main"]);
    expectNowhere(config.stateDir, result, [literal]);
  });

  it.each([
    ["a deleted source file", "docs/synthetic-person-notes.md", "synthetic-person-notes"],
    ["a deleted generated page", "openwiki/people/synthetic-person.md", "synthetic-person"],
  ])("%s whose name is denylisted fails the run too: deletions are changed paths", async (_label: string, file: string, literal: string) => {
    const fx = createFixture();
    fx.commit({ [file]: "# Committed before the name was denylisted\n" }, "a file that is already in production");
    makeStale(fx);
    const { result, config } = await run(fx, openWikiLike({ pages: (cwd) => git(cwd, ["rm", "--quiet", file]) }));
    expect(result.reasonCode, result.reason).toBe("PATH_PRIVACY_REJECTED");
    expect(result.report.safeDetails).toEqual({ paths: 1, categories: ["denylist-term"] });
    expectNowhere(config.stateDir, result, [literal]);
  });

  it("several hostile paths at once are counted, never listed", async () => {
    const fx = createFixture();
    makeStale(fx);
    const { result, config } = await run(
      fx,
      openWikiLike({
        pages: (cwd) => {
          write(cwd, "docs/Synthetic-Person.md", "x\n");
          write(cwd, "openwiki/studios/synthetic-studio-one.md", "x\n");
          write(cwd, "lib/feature.ts", "export const feature = 99;\n"); // a clean unexpected write in the same run
        },
      }),
    );
    expect(result.reasonCode).toBe("PATH_PRIVACY_REJECTED");
    expect(result.report.safeDetails).toEqual({ paths: 2, categories: ["denylist-term", "tenant-slug"] });
    expect(result.report.discarded).toEqual([]); // not even the clean path: nothing is recorded once the gate fails
    expectNowhere(config.stateDir, result, ["synthetic-person", "synthetic-studio-one"]);
  });
});

describe("G3: privacy hits are represented in report.checks without what they matched", () => {
  it("a hit in a Claim statement names the sidecar the gate cleared, and a line, never the text", async () => {
    const fx = createFixture();
    makeStale(fx);
    const { result, config } = await run(
      fx,
      openWikiLike({
        pages: (cwd) => {
          const sidecar = JSON.parse(read(cwd, "openwiki/.claims/topic/kept-page.json"));
          sidecar.claims[0].statement = "Synthetic Person owns zz.unique.person@hone.example.org.";
          write(cwd, "openwiki/.claims/topic/kept-page.json", JSON.stringify(sidecar));
        },
      }),
    );
    expect(result.reasonCode).toBe("CONTENT_PRIVACY_HITS");
    // Sidecar lines count every scanned key and string: schemaVersion, claims, id, "claim_1", statement, <the statement>.
    expect(result.report.checks.privacyHits).toEqual([
      { file: "openwiki/.claims/topic/kept-page.json", line: 6, category: "email" },
      { file: "openwiki/.claims/topic/kept-page.json", line: 6, category: "denylist-term" },
    ]);
    expectNowhere(config.stateDir, result, ["synthetic person", "zz.unique.person@hone.example.org"]);
  });

  it("several checks fail together: each names only a path this run changed, which the sink accepted as cleared", async () => {
    const fx = createFixture();
    makeStale(fx);
    const { result, config } = await run(
      fx,
      openWikiLike({
        pages: (cwd) => write(cwd, "openwiki/topic/new-page.md", "# New\n\nSynthetic Person.\n<<<<<<< ours\n"),
        after: (cwd) => write(cwd, "openwiki/topic/kept-page.md", "# Kept page\n\nEdited after the run.\n"),
      }),
    );
    expect(result.outcome, result.reason).toBe("FAILED");
    expect([result.reasonCode, ...result.report.additionalReasons.map((r: { reasonCode: string }) => r.reasonCode)]).toEqual([
      "CONFLICT_MARKERS",
      "PROVENANCE_INVALID",
      "CONTENT_PRIVACY_HITS",
    ]);
    // run() asserted the sink withheld nothing, so every path below was one the gate cleared.
    expect(result.report.checks).toEqual({
      lastUpdate: [],
      manifest: [],
      brokenLinkStamps: [],
      conflictMarkers: [{ file: "openwiki/topic/new-page.md", line: 4 }],
      provenance: [
        { file: "openwiki/topic/kept-page.md", problem: "sidecar-page-version-mismatch" },
        { file: "openwiki/topic/kept-page.md", problem: "manifest-page-version-mismatch" },
      ],
      privacyHits: [{ file: "openwiki/topic/new-page.md", line: 3, category: "denylist-term" }],
    });
    expectNowhere(config.stateDir, result, ["synthetic person"]);
  });
});

describe("G4-G6: committed run state is detected by existence, never by parsing", () => {
  it.each([
    ["malformed JSON", { "openwiki/.run.json": "{ this is not json" }],
    ["valid JSON", { "openwiki/.run.json": JSON.stringify({ phase: "pages", runId: "x" }) }],
    ["a directory, not a file", { "openwiki/.run.json/state.json": "{}" }],
  ])("committed openwiki/.run.json as %s is PRECONDITION, and OpenWiki never runs", async (_label: string, files: Record<string, string>) => {
    const fx = createFixture();
    commitForced(fx, files, "run state committed by mistake");
    makeStale(fx);
    const { result, generator } = await run(fx, openWikiLike());
    expect(result.outcome, result.reason).toBe("PRECONDITION");
    expect(result.reasonCode).toBe("COMMITTED_RUN_STATE_PRESENT");
    expect(generator).not.toHaveBeenCalled();
  });

  it("no committed openwiki/.run.json (a sibling with a longer name does not count): the pass continues", async () => {
    const fx = createFixture();
    commitForced(fx, { "openwiki/.run.json.example": "{}" }, "a sibling, not the run state");
    makeStale(fx);
    const { result, generator } = await run(fx, openWikiLike());
    expect(result.outcome, result.reason).toBe("PUBLISHED");
    expect(generator).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing", null, "missing"],
    ["malformed", "{ not json", "malformed"],
    ["not an object", "[]", "not-an-object"],
    ["unfinished, with repository text in its status", JSON.stringify({ status: "Synthetic Person interrupted", gitHead: "a".repeat(40) }), "status-not-complete"],
  ])("a committed .last-update.json that is %s is PRECONDITION, by code, never echoing its content", async (_label: string, content: string | null, problem: string) => {
    const fx = createFixture();
    fx.commit({ "openwiki/.last-update.json": content }, "metadata in a bad state");
    makeStale(fx);
    const { result, generator, config } = await run(fx, openWikiLike());
    expect(result.outcome, result.reason).toBe("PRECONDITION");
    expect(result.report.safeDetails).toEqual({ problem });
    expect(generator).not.toHaveBeenCalled();
    expectNowhere(config.stateDir, result, ["synthetic person"]);
  });
});

describe("G7/G8: the page manifest is a state invariant, metadata-only runs included", () => {
  it.each([
    ["malformed JSON", (cwd: string) => write(cwd, "openwiki/.page-manifest.json", "{ not json"), "malformed"],
    ["deleted", (cwd: string) => git(cwd, ["rm", "--quiet", "openwiki/.page-manifest.json"]), "missing"],
    ["the wrong schema version", (cwd: string) => write(cwd, "openwiki/.page-manifest.json", JSON.stringify({ schemaVersion: 2, pages: {} })), "schema-version"],
    [
      "an entry without a pageVersion",
      (cwd: string) => write(cwd, "openwiki/.page-manifest.json", JSON.stringify({ schemaVersion: 1, pages: { "/openwiki/quickstart.md": {} } })),
      "invalid-page-version",
    ],
    [
      "an unknown key OpenWiki's strict schema refuses",
      (cwd: string) => {
        const manifest = JSON.parse(read(cwd, "openwiki/.page-manifest.json"));
        manifest.note = "added";
        write(cwd, "openwiki/.page-manifest.json", JSON.stringify(manifest));
      },
      "unknown-top-level-key",
    ],
  ])("a metadata-only run whose manifest is %s FAILS and publishes nothing", async (_label: string, breakIt: (cwd: string) => void, problem: string) => {
    const fx = createFixture();
    makeStale(fx);
    const { result, prs } = await run(fx, metadataOnly({ manifest: breakIt }));
    expect(result.outcome, result.reason).toBe("FAILED");
    expect(result.reasonCode).toBe("MANIFEST_INVALID");
    expect(result.report.checks.manifest).toEqual([problem]);
    expect(result.report.metadataOnly).toBe(true);
    expect(prs).toEqual([]);
    expect(originBranches(fx)).toEqual(["main"]);
  });

  it("a metadata-only run that rewrites a VALID manifest publishes both files, and the next pass is a NOOP", async () => {
    const fx = createFixture();
    const source2 = makeStale(fx);
    const reorder = (cwd: string) => {
      const manifest = JSON.parse(read(cwd, "openwiki/.page-manifest.json"));
      for (const entry of Object.values(manifest.pages) as Array<Record<string, string>>) entry.gitHead = source2;
      write(cwd, "openwiki/.page-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
    };
    const first = await run(fx, metadataOnly({ manifest: reorder }));
    expect(first.result.outcome, first.result.reason).toBe("PUBLISHED");
    expect(first.result.report.metadataOnly).toBe(true);
    const branch = first.result.report.publish.branch;
    const tip = git(fx.work, ["rev-parse", "HEAD"]);
    expect(git(fx.origin, ["diff", "--name-only", tip, originRef(fx, branch)!]).split("\n").sort()).toEqual([
      "openwiki/.last-update.json",
      "openwiki/.page-manifest.json",
    ]);
    git(fx.work, ["fetch", "--quiet", "origin", branch]);
    git(fx.work, ["merge", "--quiet", "--no-ff", "-m", "Merge nightly metadata", "FETCH_HEAD"]);
    fx.push();
    const second = await run(fx, metadataOnlyRun);
    expect(second.result.outcome, second.result.reason).toBe("NOOP");
  });
});

describe("G9: remote nightly refs reach a report only in the runner's own format", () => {
  it("an unmerged branch with privacy text in its name blocks the pass, counted, never named", async () => {
    const fx = createFixture();
    const sideBranch = (name: string) => {
      git(fx.work, ["switch", "--quiet", "-c", name]);
      fx.commit({ [`openwiki/pending-${originBranches(fx).length}.md`]: "# pending\n" }, `pending ${name.length}`);
      fx.push(name);
      git(fx.work, ["switch", "--quiet", "main"]);
    };
    sideBranch("openwiki/nightly-synthetic-person-notes");
    sideBranch("openwiki/nightly-20261004-synthetic-studio-one");
    sideBranch("openwiki/nightly-20261003-abcdef0");
    makeStale(fx);
    const { result, generator, config } = await run(fx, openWikiLike());
    expect(result.outcome, result.reason).toBe("SKIP");
    expect(result.reasonCode).toBe("IN_FLIGHT_RUN_EXISTS");
    expect(result.report.safeDetails).toEqual({ branches: ["openwiki/nightly-20261003-abcdef0"], unrecognized: 2 });
    expect(result.reason).toContain("openwiki/nightly-20261003-abcdef0");
    expect(generator).not.toHaveBeenCalled();
    expectNowhere(config.stateDir, result, ["synthetic-person", "synthetic-studio-one"]);
  });
});

describe("G10: no error text, API text or repository text reaches a sink", () => {
  const HOSTILE = "Synthetic Person at synthetic-studio-one, zz.unique.person@hone.example.org, ghs_UniqueTokenValue0123456789abcdef";
  const LITERALS = ["synthetic person", "synthetic-studio-one", "zz.unique.person@hone.example.org", "ghs_UniqueTokenValue0123456789abcdef"];

  it("an exception thrown inside the run is reported by step, never by message", async () => {
    const fx = createFixture();
    makeStale(fx);
    const { result, config } = await run(fx, async () => {
      throw new Error(HOSTILE);
    });
    expect(result.outcome, result.reason).toBe("FAILED");
    expect(result.reasonCode).toBe("UNEXPECTED_ERROR");
    expect(result.report.safeDetails).toEqual({ step: "generate" });
    expectNowhere(config.stateDir, result, LITERALS);
  });

  it("a git failure (its message quotes a path) is reported by step, never by message", async () => {
    const fx = createFixture();
    makeStale(fx);
    const { result, config } = await run(fx, openWikiLike(), { remoteUrl: path.join(fx.root, "Synthetic-Person-missing.git") });
    expect(result.outcome, result.reason).toBe("FAILED");
    expect(result.reasonCode).toBe("UNEXPECTED_ERROR");
    expect(result.report.safeDetails).toMatchObject({ step: "sync" });
    expectNowhere(config.stateDir, result, ["synthetic-person"]);
  });

  it("a GitHub API error keeps its HTTP status and nothing else", async () => {
    const fx = createFixture();
    makeStale(fx);
    const { result, config } = await run(fx, openWikiLike(), {}, { createError: Object.assign(new Error(HOSTILE), { httpStatus: 422 }) });
    expect(result.reasonCode).toBe("PULL_REQUEST_CREATE_FAILED");
    expect(result.report.safeDetails).toEqual({ httpStatus: 422, branchState: "deleted" });
    expect(result.reason).toBe("opening the pull request failed (HTTP 422); the pushed branch was deleted");
    expectNowhere(config.stateDir, result, LITERALS);
  });

  it("a token failure is reported by cause, never by message", async () => {
    const fx = createFixture();
    makeStale(fx);
    const ctx = setup(fx);
    const result = await pass(ctx.config, {
      getGitToken: async () => {
        throw new Error(HOSTILE);
      },
      generator: vi.fn(),
      github: ctx.github,
    });
    expect(result.outcome, result.reason).toBe("PRECONDITION");
    expect(result.report.safeDetails).toEqual({ phase: "start", cause: "unknown" });
    expectNowhere(ctx.config.stateDir, result, LITERALS);
  });
});

// ---------------------------------------------------------------------------
// #786 review of 826eea45: generated run metadata is published, so it is held
// to OpenWiki's own strict schemas and every free-text value in it goes
// through the same privacy scan. The optional run limits are validated by one
// parser before they are converted.
// ---------------------------------------------------------------------------

describe("run metadata: strict schemas, and the same privacy scan for every free-text value", () => {
  const setCompletedBy = (value: string) => (cwd: string) => {
    const manifest = JSON.parse(read(cwd, "openwiki/.page-manifest.json"));
    for (const entry of Object.values(manifest.pages) as Array<Record<string, string>>) entry.completedBy = value;
    write(cwd, "openwiki/.page-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  };
  const addEntryKey = (cwd: string) => {
    const manifest = JSON.parse(read(cwd, "openwiki/.page-manifest.json"));
    (Object.values(manifest.pages)[0] as Record<string, string>).reviewer = "Synthetic Person";
    write(cwd, "openwiki/.page-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  };

  it.each([
    ["a denylisted name as completedBy, in a valid host-id form", { manifest: setCompletedBy("synthetic-person") }, "CONTENT_PRIVACY_HITS", ["synthetic-person"]],
    ["a tenant slug as completedBy", { manifest: setCompletedBy("synthetic-studio-one") }, "CONTENT_PRIVACY_HITS", ["synthetic-studio-one"]],
    ["a completedBy that is not an OpenWiki producer id at all", { manifest: setCompletedBy("Synthetic Person") }, "MANIFEST_INVALID", ["synthetic person"]],
    ["an unknown textual key in a manifest entry", { manifest: addEntryKey }, "MANIFEST_INVALID", ["synthetic person"]],
    ["a denylisted name in .last-update.json's model", { lastUpdate: { model: "synthetic-person/claude" } }, "CONTENT_PRIVACY_HITS", ["synthetic-person"]],
    ["an email address as the model", { lastUpdate: { model: "zz.unique.person@hone.example.org" } }, "CONTENT_PRIVACY_HITS", ["zz.unique.person@hone.example.org"]],
    ["an unknown textual key in .last-update.json", { lastUpdate: { note: "Synthetic Person" } }, "LAST_UPDATE_INVALID", ["synthetic person"]],
    ["a language that is not a locale OpenWiki resolves", { lastUpdate: { language: "Synthetic Person" } }, "LAST_UPDATE_INVALID", ["synthetic person"]],
    ["a model that is blank", { lastUpdate: { model: "  " } }, "LAST_UPDATE_INVALID", []],
    ["an updatedAt that is not an ISO instant", { lastUpdate: { updatedAt: "Synthetic Person" } }, "LAST_UPDATE_INVALID", ["synthetic person"]],
  ])("a metadata-only run with %s FAILS, publishes nothing, and no sink holds the value", async (_label: string, opts: Record<string, unknown>, reasonCode: string, literals: string[]) => {
    const fx = createFixture();
    makeStale(fx);
    const { result, prs, config } = await run(fx, metadataOnly(opts));
    expect(result.outcome, result.reason).toBe("FAILED");
    expect(result.reasonCode, result.reason).toBe(reasonCode);
    expect(result.report.metadataOnly).toBe(true);
    expect(prs).toEqual([]);
    expect(originBranches(fx)).toEqual(["main"]);
    expectNowhere(config.stateDir, result, literals);
  });

  it("a denylisted word in a language variant subtag is a valid locale, so the scan is what catches it", async () => {
    const fx = createFixture();
    makeStale(fx);
    const { result, config } = await run(fx, metadataOnly({ lastUpdate: { language: "en-quillon" } }), {
      denylistFile: writePrivate(path.join(fx.root, "denylist-variant"), "Synthetic Person\nQuillon\n"),
    });
    expect(result.reasonCode, result.reason).toBe("CONTENT_PRIVACY_HITS");
    expect(result.report.checks.lastUpdate).toEqual([]);
    expect(result.report.checks.privacyHits).toEqual([{ file: "openwiki/.last-update.json", line: 2, category: "denylist-term" }]);
    expectNowhere(config.stateDir, result, ["quillon"]);
  });

  it("a hyphenated name in a Claim sidecar's verification producer is caught (every sidecar string is scanned)", async () => {
    const fx = createFixture();
    makeStale(fx);
    const { result, config } = await run(
      fx,
      openWikiLike({
        pages: (cwd) => {
          const sidecar = JSON.parse(read(cwd, "openwiki/.claims/topic/kept-page.json"));
          sidecar.verification = { by: "synthetic-person", at: "2026-10-05T03:30:00.000Z" };
          write(cwd, "openwiki/.claims/topic/kept-page.json", JSON.stringify(sidecar));
        },
      }),
    );
    expect(result.reasonCode, result.reason).toBe("CONTENT_PRIVACY_HITS");
    expect(result.report.checks.privacyHits).toEqual([expect.objectContaining({ file: "openwiki/.claims/topic/kept-page.json", category: "denylist-term" })]);
    expectNowhere(config.stateDir, result, ["synthetic-person"]);
  });

  it("an evidence version that is not OpenWiki's grammar is rejected AND scanned, and no sink holds it (#786 review of 663f86a3)", async () => {
    const fx = createFixture();
    makeStale(fx);
    const { result, prs, config } = await run(
      fx,
      openWikiLike({
        pages: (cwd) => {
          const sidecar = JSON.parse(read(cwd, "openwiki/.claims/topic/kept-page.json"));
          sidecar.claims[0].evidence[0].version = "private.person@corp.test";
          write(cwd, "openwiki/.claims/topic/kept-page.json", JSON.stringify(sidecar));
        },
      }),
    );
    expect(result.outcome, result.reason).toBe("FAILED");
    expect([result.reasonCode, ...result.report.additionalReasons.map((r: { reasonCode: string }) => r.reasonCode)]).toEqual([
      "PROVENANCE_INVALID",
      "CONTENT_PRIVACY_HITS",
    ]);
    expect(result.report.checks.provenance).toEqual([{ file: "openwiki/topic/kept-page.md", problem: "evidence-version-invalid" }]);
    expect(result.report.checks.privacyHits).toEqual([expect.objectContaining({ file: "openwiki/.claims/topic/kept-page.json", category: "email" })]);
    expect(prs).toEqual([]);
    expect(originBranches(fx)).toEqual(["main"]);
    expectNowhere(config.stateDir, result, ["private.person@corp.test", "private.person"]);
  });

  it("a generated file of an unknown type is scanned whole", async () => {
    const fx = createFixture();
    makeStale(fx);
    const { result, config } = await run(fx, openWikiLike({ pages: (cwd) => write(cwd, "openwiki/notes.txt", "Owner: Synthetic Person\n") }));
    expect(result.reasonCode, result.reason).toBe("CONTENT_PRIVACY_HITS");
    expect(result.report.checks.privacyHits).toEqual([{ file: "openwiki/notes.txt", line: 1, category: "denylist-term" }]);
    expectNowhere(config.stateDir, result, ["synthetic person"]);
  });

  it("metadata in OpenWiki's real shape still publishes, including a completedBy from the pinned CLI", async () => {
    const fx = createFixture();
    makeStale(fx);
    const { result } = await run(fx, metadataOnly({ manifest: setCompletedBy("openwiki/0.6.1") }));
    expect(result.outcome, result.reason).toBe("PUBLISHED");
    expect(result.report.checks.lastUpdate).toEqual([]);
    expect(result.report.checks.manifest).toEqual([]);
    expect(result.report.checks.privacyHits).toEqual([]);
  });
});

describe("optional run limits: one parser, validated before conversion", () => {
  const GB = 2 ** 30;
  const VARIABLES: Array<[string, "minFreeBytes" | "timeoutMs", number, number]> = [
    // [variable, config field, its unit in the field, documented default]
    ["HONE_WIKI_MIN_FREE_GB", "minFreeBytes", GB, 10],
    ["HONE_WIKI_RUN_TIMEOUT_MIN", "timeoutMs", 60_000, 90],
  ];

  describe.each(VARIABLES)("%s", (name: string, field: "minFreeBytes" | "timeoutMs", unit: number, fallback: number) => {
    it.each([
      ["unset", undefined, fallback],
      ["blank", "", fallback],
      ["whitespace only", "   ", fallback],
      ["a valid integer", "25", 25],
      ["a valid positive decimal", "1.5", 1.5],
      ["a number with surrounding whitespace", " 7 ", 7],
    ])("%s gives a finite positive value", (_label: string, raw: string | undefined, expected: number) => {
      const env = raw === undefined ? {} : { [name]: raw };
      const config = configFromEnv(env);
      expect(config[field]).toBe(Math.ceil(expected * unit));
      expect(Number.isFinite(config[field]) && config[field] > 0).toBe(true);
      expect(checkEnvironment(env, [])).toEqual([]);
    });

    it.each([["0"], ["0.0"], ["-1"], ["-0.5"], ["ten"], ["Infinity"], ["-Infinity"], ["NaN"], ["1e3"], ["0x10"], ["12 parsecs"]])(
      "%j is PRECONDITION by name, never coerced",
      (raw: string) => {
        expect(configFromEnv({ [name]: raw })[field]).toBeNull();
        const reasons = checkEnvironment({ [name]: raw }, []);
        expect(reasons).toEqual([{ code: "RUN_LIMIT_INVALID", details: { name } }]);
        const text = renderReasons(reasons);
        expect(text).toContain(name);
        expect(text.includes(raw), text).toBe(false);
      },
    );
  });

  it("a timeout too long for a Node timer (it would fire at once) is refused too", () => {
    expect(parseRunLimit("40000", 90)).toBe(40000);
    expect(configFromEnv({ HONE_WIKI_RUN_TIMEOUT_MIN: "40000" }).timeoutMs).toBeNull();
    expect(configFromEnv({ HONE_WIKI_RUN_TIMEOUT_MIN: "35791" }).timeoutMs).toBeLessThanOrEqual(MAX_TIMER_MS);
  });

  it.each([
    ["HONE_WIKI_MIN_FREE_GB", "Infinity"],
    ["HONE_WIKI_RUN_TIMEOUT_MIN", "12 parsecs"],
  ])("an invalid %s in the environment stops the pass before OpenWiki runs, naming only the variable", async (name: string, raw: string) => {
    const fx = createFixture();
    makeStale(fx);
    const { result, generator, config } = await run(fx, openWikiLike(), { env: { [name]: raw } });
    expect(result.outcome, result.reason).toBe("PRECONDITION");
    expect(result.reasonCode).toBe("RUN_LIMIT_INVALID");
    expect(result.report.safeDetails).toEqual({ name });
    expect(generator).not.toHaveBeenCalled();
    expectNowhere(config.stateDir, result, [raw]);
  });

  it.each([
    ["a NaN disk floor", { minFreeBytes: Number.NaN }, "HONE_WIKI_MIN_FREE_GB"],
    ["a zero timeout", { timeoutMs: 0 }, "HONE_WIKI_RUN_TIMEOUT_MIN"],
    ["a timeout longer than a timer holds", { timeoutMs: MAX_TIMER_MS + 1 }, "HONE_WIKI_RUN_TIMEOUT_MIN"],
  ])("a config carrying %s is refused before OpenWiki runs, whatever built it", async (_label: string, overrides: Record<string, unknown>, name: string) => {
    const fx = createFixture();
    makeStale(fx);
    const { result, generator } = await run(fx, openWikiLike(), overrides);
    expect(result.outcome, result.reason).toBe("PRECONDITION");
    expect(result.reasonCode).toBe("RUN_LIMIT_INVALID");
    expect(result.report.safeDetails).toEqual({ name });
    expect(generator).not.toHaveBeenCalled();
  });
});

describe("generator output is never persisted or printed (#786 review of 3644d2fb)", () => {
  const LITERALS = [
    "Quillon Vantablack",
    "synthetic-studio-one",
    "zz.unique.person@hone.example.org",
    "+1 415 555 0199",
    "ghs_UniqueTokenValue0123456789abcdefghijkl",
    "sk-ant-uniquekeyvalue0123456789",
  ];
  const noisy = LITERALS.map((value) => `openwiki: ${value}`).join("\n");

  it.each([
    ["a passing run (dry run)", 0, "DRY_RUN"],
    ["a failing run", 1, "FAILED"],
  ])("%s keeps only safe diagnostics", async (_label: string, exitCode: number, outcome: string) => {
    const fx = createFixture();
    makeStale(fx);
    const ctx = setup(fx, { publish: false, denylistFile: writePrivate(path.join(fx.root, "denylist-unique"), "Quillon Vantablack\n") });
    const generate = openWikiLike();
    const result = await pass(ctx.config, {
      generator: async (args: { cwd: string }) => ({ ...(await generate(args)), exitCode, output: noisy }),
      github: ctx.github,
    });
    expect(result.outcome, result.reason).toBe(outcome);
    expect(result.report.generator).toEqual({
      exitCode,
      timedOut: false,
      outputBytes: Buffer.byteLength(noisy),
      outputSha256: createHash("sha256").update(noisy).digest("hex"),
    });
    expectNowhere(ctx.config.stateDir, result, LITERALS);
  });

  it("the real process runner drains output into a size and a hash, and returns no text", async () => {
    const fx = createFixture();
    const result = await runOpenWikiProcess({
      cwd: fx.root,
      invocation: { command: process.execPath, args: ["-e", "process.stdout.write('Quillon Vantablack')"], env: { PATH: "/usr/bin:/bin" } },
      timeoutMs: 30_000,
    });
    expect(result).toEqual({
      exitCode: 0,
      timedOut: false,
      outputBytes: Buffer.byteLength("Quillon Vantablack"),
      outputSha256: createHash("sha256").update("Quillon Vantablack").digest("hex"),
    });
  });
});

describe("fail-closed preflight", () => {
  it.each([
    ["the runner is not enabled", { enabled: false }, "SKIP"],
    ["a forbidden credential is in the environment", { env: { GH_TOKEN: "operator-token-value" } }, "PRECONDITION"],
  ])("%s", async (_label: string, overrides: Record<string, unknown>, outcome: string) => {
    const fx = createFixture();
    makeStale(fx);
    const { result, generator } = await run(fx, openWikiLike(), overrides);
    expect(result.outcome, result.reason).toBe(outcome);
    expect(generator).not.toHaveBeenCalled();
    expect(JSON.stringify(result.report)).not.toContain("operator-token-value");
  });

  it("the kill-switch file", async () => {
    const fx = createFixture();
    makeStale(fx);
    const ctx = setup(fx);
    mkdirSync(ctx.config.stateDir, { recursive: true });
    writeFileSync(path.join(ctx.config.stateDir, "DISABLED"), "");
    const result = await pass(ctx.config, { generator: vi.fn(), github: ctx.github });
    expect(result.outcome, result.reason).toBe("SKIP");
  });

  it("a lock held by a live process", async () => {
    const fx = createFixture();
    makeStale(fx);
    const ctx = setup(fx);
    mkdirSync(ctx.config.stateDir, { recursive: true });
    writeFileSync(path.join(ctx.config.stateDir, "run.lock"), String(process.pid));
    const result = await pass(ctx.config, { generator: vi.fn(), github: ctx.github });
    expect(result.outcome, result.reason).toBe("SKIP");
    expect(result.reason).toMatch(/lock/u);
  });

  it.each([
    ["empty", ""],
    ["not a process id", "Synthetic Person"],
  ])("a lock file that is %s is not treated as absent: PRECONDITION, and the lock stays", async (_label: string, content: string) => {
    const fx = createFixture();
    makeStale(fx);
    const ctx = setup(fx);
    mkdirSync(ctx.config.stateDir, { recursive: true });
    writeFileSync(path.join(ctx.config.stateDir, "run.lock"), content);
    const generator = vi.fn();
    const result = await pass(ctx.config, { generator, github: ctx.github });
    expect(result.outcome, result.reason).toBe("PRECONDITION");
    expect(result.reasonCode).toBe("LOCK_UNREADABLE");
    expect(generator).not.toHaveBeenCalled();
    expect(readFileSync(path.join(ctx.config.stateDir, "run.lock"), "utf8")).toBe(content);
    expectNowhere(ctx.config.stateDir, result, ["synthetic person"]);
  });

  it("an unmerged nightly branch already in flight", async () => {
    const fx = createFixture();
    git(fx.work, ["switch", "--quiet", "-c", "openwiki/nightly-20261004-aaaaaaa"]);
    fx.commit({ "openwiki/topic/kept-page.md": "# pending\n" }, "pending wiki");
    fx.push("openwiki/nightly-20261004-aaaaaaa");
    git(fx.work, ["switch", "--quiet", "main"]);
    makeStale(fx);
    const { result, generator } = await run(fx, openWikiLike());
    expect(result.outcome, result.reason).toBe("SKIP");
    expect(result.reason).toContain("openwiki/nightly-20261004-aaaaaaa");
    expect(generator).not.toHaveBeenCalled();
  });

  it("a merged nightly branch does not block", async () => {
    const fx = createFixture();
    fx.push("openwiki/nightly-20261001-bbbbbbb");
    makeStale(fx);
    const { result } = await run(fx, openWikiLike());
    expect(result.outcome, result.reason).toBe("PUBLISHED");
  });

  it("the runner's own code inside the subject clone", async () => {
    const fx = createFixture();
    makeStale(fx);
    const ctx = setup(fx);
    const generator = vi.fn();
    const result = await pass({ ...ctx.config, runnerDir: path.join(ctx.config.subjectDir, "scripts", "openwiki") }, { generator, github: ctx.github });
    expect(result.outcome, result.reason).toBe("PRECONDITION");
    expect(result.reason).toContain("outside HONE_WIKI_SUBJECT_DIR");
    expect(generator).not.toHaveBeenCalled();
    expect(existsSync(ctx.config.subjectDir)).toBe(false);
  });

  it("malformed managed-block markers", async () => {
    const fx = createFixture();
    fx.commit({ "AGENTS.md": `${AGENTS_AUTHORED}${AGENTS_AUTHORED}` }, "duplicated markers");
    makeStale(fx);
    const { result } = await run(fx, openWikiLike());
    expect(result.outcome, result.reason).toBe("PRECONDITION");
    expect(result.reason).toMatch(/AGENTS\.md has malformed/u);
  });

  it("recorded gitHead outside production history", async () => {
    const fx = createFixture();
    fx.commit({ "openwiki/.last-update.json": JSON.stringify({ command: "update", status: "complete", gitHead: "a".repeat(40) }) }, "bad metadata");
    fx.push();
    const { result } = await run(fx, openWikiLike());
    expect(result.outcome, result.reason).toBe("PRECONDITION");
    expect(result.reason).toMatch(/not in production history/u);
  });

  it("an OpenWiki pin other than 0.6.1, a key file others can read, or a node below 22.22", async () => {
    const fx = createFixture();
    makeStale(fx);
    const ctx = setup(fx, { nodeVersion: "20.20.2" });
    writeFileSync(path.join(ctx.config.openwikiDir, "package.json"), JSON.stringify({ name: "openwiki", version: "0.6.2" }));
    chmodSync(ctx.config.anthropicKeyFile, 0o644);
    const generator = vi.fn();
    const result = await pass(ctx.config, { generator, github: ctx.github });
    expect(result.outcome, result.reason).toBe("PRECONDITION");
    expect(result.reason).toContain("openwiki@0.6.1");
    expect(result.reason).toContain("readable by its owner only");
    expect(result.reason).toContain("node >= 22.22.0");
    expect([result.reasonCode, ...result.report.additionalReasons.map((r: { reasonCode: string }) => r.reasonCode)]).toEqual([
      "OPENWIKI_VERSION_MISMATCH",
      "NODE_TOO_OLD",
      "MODEL_KEY_FILE_NOT_OWNER_ONLY",
    ]);
    expect(generator).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty denylist", (fx: Fx, ctx: ReturnType<typeof setup>) => writeFileSync(ctx.config.denylistFile, "# no terms yet\n\n"), "DENYLIST_EMPTY"],
    [
      "no tenant register in the production state document",
      (fx: Fx) => {
        fx.commit({ "docs/production/current-state.md": "# State\n\nThe register moved.\n" }, "register moved");
        fx.push();
      },
      "TENANT_REGISTER_UNREADABLE",
    ],
  ])("%s would turn a privacy scan into a no-op: PRECONDITION before OpenWiki runs", async (_label: string, breakIt: (fx: Fx, ctx: ReturnType<typeof setup>) => void, code: string) => {
    const fx = createFixture();
    makeStale(fx);
    const ctx = setup(fx);
    breakIt(fx, ctx);
    const generator = vi.fn();
    const result = await pass(ctx.config, { generator, github: ctx.github });
    expect(result.outcome, result.reason).toBe("PRECONDITION");
    expect(result.reasonCode).toBe(code);
    expect(generator).not.toHaveBeenCalled();
  });
});

describe("#786 review: credentials stay out of repository code, tokens stay fresh, keys stay private", () => {
  const HOST_CREDENTIAL_ENV = {
    HONE_WIKI_APP_ID: "4242",
    HONE_WIKI_APP_INSTALLATION_ID: "4343",
    HONE_WIKI_APP_PRIVATE_KEY_FILE: "/host/secrets/github-app.pem",
    HONE_WIKI_ANTHROPIC_API_KEY_FILE: "/host/secrets/anthropic-key",
  };

  it("P1: no code from the subject repository runs while the runner holds credentials", async () => {
    const fx = createFixture();
    const sentinel = path.join(fx.root, "EXFILTRATED");
    const exfiltrate = `require("fs").writeFileSync(${JSON.stringify(sentinel)}, require("fs").readFileSync("/proc/" + process.ppid + "/environ"));\n`;
    const pkg = JSON.stringify({
      name: "malicious-subject",
      scripts: { "verify:prepush": "node scripts/steal.cjs", prepush: "node scripts/steal.cjs", postinstall: "node scripts/steal.cjs", test: "node scripts/steal.cjs" },
    });
    fx.commit({ "package.json": pkg, "scripts/steal.cjs": exfiltrate, "scripts/verify-prepush.mjs": exfiltrate }, "subject: a hostile package");
    makeStale(fx);
    const saved = Object.fromEntries(Object.keys(HOST_CREDENTIAL_ENV).map((k) => [k, process.env[k]]));
    Object.assign(process.env, HOST_CREDENTIAL_ENV);
    let result: Result = { outcome: "", reasonCode: "", reason: "", report: {} };
    try {
      ({ result } = await run(fx, openWikiLike()));
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    expect(result.outcome, result.reason).toBe("PUBLISHED");
    expect(existsSync(sentinel)).toBe(false);
    const head = originRef(fx, result.report.publish.branch)!;
    expect(git(fx.origin, ["show", `${head}:scripts/steal.cjs`])).toBe(exfiltrate.replace(/\n$/u, ""));
  });

  it("P1: the generator gets the model key and nothing else credential-shaped", () => {
    const fx = createFixture();
    const { config } = setup(fx);
    const names = Object.keys(buildGeneratorInvocation(config).env);
    expect(names.filter((n) => n.startsWith("HONE_WIKI_"))).toEqual([]);
    expect(Object.keys(isolatedChildEnv(config)).sort()).toEqual(["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "HOME", "LANG", "PATH", "TZ"]);
  });

  it("P2: a fresh installation token is minted after OpenWiki runs, and publishing uses it", async () => {
    const fx = createFixture();
    makeStale(fx);
    const ctx = setup(fx);
    const events: string[] = [];
    let minted = 0;
    const tokensUsed: string[] = [];
    const generate = openWikiLike();
    const result = await pass(ctx.config, {
      getGitToken: async () => {
        minted += 1;
        events.push(`token-${minted}`);
        return `token-${minted}`;
      },
      generator: async (args: { cwd: string }) => {
        events.push("generate");
        return generate(args);
      },
      github: (token: string) => {
        tokensUsed.push(token);
        return ctx.github();
      },
      now: () => Date.UTC(2026, 9, 5),
    });
    expect(result.outcome, result.reason).toBe("PUBLISHED");
    expect(events).toEqual(["token-1", "generate", "token-2"]);
    expect(tokensUsed).toEqual(["token-2"]);
  });

  it("P2: if the publish-time token cannot be minted, nothing is published", async () => {
    const fx = createFixture();
    makeStale(fx);
    const ctx = setup(fx);
    let calls = 0;
    const result = await pass(ctx.config, {
      getGitToken: async () => {
        calls += 1;
        if (calls > 1) throw Object.assign(new Error("installation token request failed: HTTP 401"), { tokenCause: "http-status", httpStatus: 401 });
        return "token-1";
      },
      generator: openWikiLike(),
      github: ctx.github,
    });
    expect(result.outcome, result.reason).toBe("PRECONDITION");
    expect(result.reason).toBe("GitHub App token before publishing: installation token request failed: HTTP 401");
    expect(ctx.prs).toEqual([]);
    expect(originBranches(fx)).toEqual(["main"]);
  });

  it("P2: a GitHub App key other accounts can read is refused before any network call", async () => {
    const fx = createFixture();
    const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const keyFile = writePrivate(path.join(fx.root, "github-app.pem"), pem);
    chmodSync(keyFile, 0o644);
    const fetchImpl = vi.fn();
    const source = createAppTokenSource(
      { HONE_WIKI_APP_ID: "1", HONE_WIKI_APP_INSTALLATION_ID: "2", HONE_WIKI_APP_PRIVATE_KEY_FILE: keyFile, HONE_WIKI_REPOSITORY: "owner/repo" },
      fetchImpl,
    );
    await expect(source()).rejects.toThrow("HONE_WIKI_APP_PRIVATE_KEY_FILE must exist and be readable by its owner only");
    expect(fetchImpl).not.toHaveBeenCalled();

    makeStale(fx);
    const ctx = setup(fx);
    const generator = vi.fn();
    const result = await pass(ctx.config, { getGitToken: source, generator, github: ctx.github });
    expect(result.outcome, result.reason).toBe("PRECONDITION");
    expect(result.reason).toBe("GitHub App token: HONE_WIKI_APP_PRIVATE_KEY_FILE must exist and be readable by its owner only");
    expect(generator).not.toHaveBeenCalled();
  });

  it("P2: an owner-only App key mints a token scoped to the configured repository", async () => {
    const fx = createFixture();
    const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const keyFile = writePrivate(path.join(fx.root, "github-app.pem"), pem);
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({
        token: "minted",
        expires_at: "2026-10-05T00:00:00Z",
        permissions: { metadata: "read", contents: "write", pull_requests: "write", checks: "read", statuses: "read" },
        repositories: [{ full_name: "owner/repo" }],
      }),
    }));
    const source = createAppTokenSource(
      { HONE_WIKI_APP_ID: "1", HONE_WIKI_APP_INSTALLATION_ID: "2", HONE_WIKI_APP_PRIVATE_KEY_FILE: keyFile, HONE_WIKI_REPOSITORY: "owner/repo" },
      fetchImpl,
    );
    await expect(source()).resolves.toBe("minted");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(readOwnerOnlySecret(keyFile, "key")).toBe(pem);
  });
});

describe("environment and generator contract", () => {
  it("names problems without values; a prefix-forbidden name is reported by its prefix only", () => {
    const problems = checkEnvironment({ GH_TOKEN: "secret-value", STRIPE_SECRET_KEY: "x", STRIPE_SYNTHETIC_PERSON: "y", OPENWIKI_PROVIDER: "openai" });
    expect(problems).toEqual([
      ...REQUIRED_ENV.filter((n: string) => n !== "OPENWIKI_PROVIDER").map((name: string) => ({ code: "REQUIRED_ENV_MISSING", details: { name } })),
      { code: "FORBIDDEN_ENV_PRESENT", details: { name: "GH_TOKEN" } },
      { code: "FORBIDDEN_ENV_PREFIX_PRESENT", details: { prefix: "STRIPE_", count: 2 } },
      { code: "ENV_VALUE_INVALID", details: { name: "OPENWIKI_PROVIDER" } },
    ]);
    const text = renderReasons(problems);
    expect(text).toContain("forbidden GH_TOKEN is set");
    expect(text).toContain("forbidden STRIPE_* variable is set (2 of them)");
    expect(text).toContain("OPENWIKI_PROVIDER must be anthropic");
    for (const literal of ["secret-value", "STRIPE_SECRET_KEY", "SYNTHETIC_PERSON"]) expect(text).not.toContain(literal);
    expect(checkEnvironment(Object.fromEntries(REQUIRED_ENV.map((n: string) => [n, n === "OPENWIKI_PROVIDER" ? "anthropic" : "1"])))).toEqual([]);
  });

  it("invokes only `openwiki code --update --print`, with an allowlisted environment", () => {
    const fx = createFixture();
    const { config } = setup(fx);
    const invocation = buildGeneratorInvocation(config);
    expect(invocation.args.slice(1)).toEqual(["code", "--update", "--print"]);
    expect(invocation.args).not.toContain("--init");
    expect(Object.keys(invocation.env).sort()).toEqual(
      [
        "ANTHROPIC_API_KEY",
        "DO_NOT_TRACK",
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_NOSYSTEM",
        "HOME",
        "LANG",
        "OPENWIKI_CONFIG_DIR",
        "OPENWIKI_MODEL_ID",
        "OPENWIKI_PROVIDER",
        "OPENWIKI_TELEMETRY_DISABLED",
        "PATH",
        "TZ",
      ].sort(),
    );
    expect(invocation.env).toMatchObject({ ANTHROPIC_API_KEY: "fixture-key", OPENWIKI_PROVIDER: "anthropic", OPENWIKI_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1" });
    for (const name of FORBIDDEN_ENV.filter((n: string) => n !== "ANTHROPIC_API_KEY")) expect(invocation.env).not.toHaveProperty(name);
  });

  it("the runbook names every required environment variable", () => {
    const runbook = readFileSync(path.join(REPO_ROOT, "docs/runbooks/openwiki-nightly.md"), "utf8");
    for (const name of REQUIRED_ENV) expect(runbook, name).toContain(`\`${name}\``);
  });

  it("no OpenWiki workflow scaffold is committed (A3)", () => {
    expect(existsSync(path.join(REPO_ROOT, ".github/workflows/openwiki-update.yml"))).toBe(false);
  });
});
