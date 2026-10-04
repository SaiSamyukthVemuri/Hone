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
  createAppTokenSource,
  readOwnerOnlySecret,
  redactSecrets,
  runOpenWikiProcess,
  isolatedChildEnv,
  runNightly,
  // @ts-expect-error - .mjs utility ships without type declarations
} from "../../scripts/openwiki/nightly.mjs";
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
type Report = Record<string, any>;
type Result = { outcome: string; reason: string; report: Report };
type Gen = (args: { cwd: string }) => Promise<{ exitCode: number; output?: string }>;
type GitHubBehavior = { headSha?: string; commentFails?: boolean; closeFails?: boolean; beforeComment?: () => Promise<void> };

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
    minFreeBytes: 0,
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
    const head = git(cwd, ["rev-parse", "HEAD"]);
    write(cwd, "openwiki/.last-update.json", `${JSON.stringify({ command: "update", gitHead: head, status: "complete", language: "en" }, null, 2)}\n`);
    write(cwd, "AGENTS.md", AGENTS_TEMPLATE_REWRITE);
    write(cwd, ".github/workflows/openwiki-update.yml", OPENWIKI_SCAFFOLD_WORKFLOW);
    opts.after?.(cwd);
    return { exitCode: 0, output: "done" };
  };
}

/** A run that only refreshes run metadata, as OpenWiki's no-op path or an empty plan does. */
const metadataOnlyRun: Gen = async ({ cwd }) => {
  const head = git(cwd, ["rev-parse", "HEAD"]);
  write(cwd, "openwiki/.last-update.json", `${JSON.stringify({ command: "update", gitHead: head, status: "complete", language: "en" }, null, 2)}\n`);
  return { exitCode: 0 };
};

/** A source change after the recorded gitHead makes the wiki stale. */
function makeStale(fx: Fx): string {
  const source2 = fx.commit({ "lib/feature.ts": "export const feature = 2;\n" }, "source: feature 2");
  fx.push();
  return source2;
}

async function run(fx: Fx, generator: Gen, overrides: Record<string, unknown> = {}, behavior: GitHubBehavior = {}) {
  const ctx = setup(fx, overrides);
  Object.assign(ctx.behavior, behavior);
  const spy = vi.fn(generator);
  const result: Result = await runNightly(ctx.config, { generator: spy, github: ctx.github, now: () => Date.UTC(2026, 9, 5) });
  return { ...ctx, result, generator: spy };
}

describe("startup no-op", () => {
  it("a live wiki ends before OpenWiki runs and before any run prerequisite is checked", async () => {
    const fx = createFixture();
    const { result, generator } = await run(fx, openWikiLike(), { anthropicKeyFile: "/nonexistent" });
    expect(result.outcome, result.reason).toBe("NOOP");
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
  });

  it("A3: discards and records OpenWiki's writes outside the generated scope", async () => {
    const fx = createFixture();
    makeStale(fx);
    const { result } = await run(fx, openWikiLike());
    const discarded = result.report.discarded as Array<{ path: string; reason: string; workflowInspection?: string[] }>;
    expect(discarded.map((d) => d.path).sort()).toEqual([".github/workflows/openwiki-update.yml", "AGENTS.md"]);
    const workflow = discarded.find((d) => d.path === ".github/workflows/openwiki-update.yml")!;
    expect(workflow.reason).toMatch(/^A3: .*would fail CI-workflow inspection/u);
    expect(workflow.workflowInspection).toContain("requests a write permission");
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
  const failsWith = async (fx: Fx, generator: Gen, reason: RegExp) => {
    const { result, prs } = await run(fx, generator);
    expect(result.outcome, result.reason).toBe("FAILED");
    expect(result.reason).toMatch(reason);
    expect(prs).toEqual([]);
    expect(originBranches(fx)).toEqual(["main"]);
    const subject = path.join(fx.root, "host", "subject");
    expect(git(subject, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
    return result;
  };

  it("an unexpected write outside the generated scope", async () => {
    const fx = createFixture();
    makeStale(fx);
    const result = await failsWith(fx, openWikiLike({ pages: (cwd) => write(cwd, "lib/feature.ts", "export const feature = 99;\n") }), /outside the generated scope: lib\/feature\.ts/u);
    expect(result.report.discarded.map((d: { path: string }) => d.path)).toContain("lib/feature.ts");
  });

  it("a write to the authored openwiki/INSTRUCTIONS.md", async () => {
    const fx = createFixture();
    makeStale(fx);
    await failsWith(fx, openWikiLike({ pages: (cwd) => write(cwd, "openwiki/INSTRUCTIONS.md", "# changed\n") }), /openwiki\/INSTRUCTIONS\.md/u);
  });

  it("OpenWiki exits non-zero", async () => {
    const fx = createFixture();
    makeStale(fx);
    await failsWith(fx, async () => ({ exitCode: 1, output: "provider error" }), /OpenWiki exited 1/u);
  });

  it("OpenWiki leaves its run state behind", async () => {
    const fx = createFixture();
    makeStale(fx);
    await failsWith(fx, openWikiLike({ after: (cwd) => write(cwd, "openwiki/.run.json", "{}") }), /did not complete/u);
  });

  it("gitHead that is not the pinned source head", async () => {
    const fx = createFixture();
    makeStale(fx);
    await failsWith(
      fx,
      openWikiLike({
        after: (cwd) => write(cwd, "openwiki/.last-update.json", JSON.stringify({ command: "update", status: "complete", gitHead: fx.source1 })),
      }),
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
      /broken-link stamp/u,
    );
  });

  it("a denylisted name or tenant slug, reported without its text", async () => {
    const fx = createFixture();
    makeStale(fx);
    const result = await failsWith(
      fx,
      openWikiLike({ pages: (cwd) => write(cwd, "openwiki/topic/new-page.md", "# New\n\nSynthetic Person booked at synthetic-studio-one.\n") }),
      /privacy\/secret denylist/u,
    );
    expect(result.report.checks.privacyHits).toEqual([
      { file: "openwiki/topic/new-page.md", line: 3, category: "denylist-term" },
      { file: "openwiki/topic/new-page.md", line: 3, category: "tenant-slug" },
    ]);
    const persisted = readFileSync(path.join(fx.root, "host", "state", "last-run.json"), "utf8").toLowerCase();
    expect(persisted).not.toContain("synthetic person");
    expect(persisted).not.toContain("synthetic-studio-one");
  });

  it("a conflict marker in generated output", async () => {
    const fx = createFixture();
    makeStale(fx);
    await failsWith(
      fx,
      openWikiLike({ pages: (cwd) => write(cwd, "openwiki/topic/new-page.md", "# New\n\n<<<<<<< ours\nA\n=======\nB\n>>>>>>> theirs\n") }),
      /conflict marker/u,
    );
  });

  it("provenance: a page whose sidecar and manifest describe other bytes", async () => {
    const fx = createFixture();
    makeStale(fx);
    await failsWith(
      fx,
      openWikiLike({ after: (cwd) => write(cwd, "openwiki/topic/kept-page.md", "# Kept page\n\nEdited after the run.\n") }),
      /pageVersion does not match the page/u,
    );
  });

  it("provenance: a deleted page that leaves its Claim sidecar behind", async () => {
    const fx = createFixture();
    makeStale(fx);
    await failsWith(
      fx,
      openWikiLike({ after: (cwd) => git(cwd, ["checkout", "HEAD", "--", "openwiki/.claims/topic/old-page.json"]) }),
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
    const pending = runNightly(ctx.config, { generator: openWikiLike(), github: ctx.github, now: () => Date.UTC(2026, 9, 5) }).then(
      (r: Result) => {
        settled = true;
        return r;
      },
    );
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
    const result: Result = await runNightly(ctx.config, {
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
    const runs = path.join(ctx.config.stateDir, "runs");
    const persisted = [path.join(ctx.config.stateDir, "last-run.json"), ...readdirSync(runs).map((name) => path.join(runs, name))];
    expect(persisted.length).toBeGreaterThan(1);
    for (const file of persisted) {
      const text = readFileSync(file, "utf8");
      for (const value of LITERALS) expect(text.includes(value), `${value} persisted in ${file}`).toBe(false);
    }
    const printed = cliSummary(result);
    for (const value of LITERALS) expect(printed.includes(value), `${value} printed`).toBe(false);
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
    const result: Result = await runNightly(ctx.config, { generator: vi.fn(), github: ctx.github });
    expect(result.outcome, result.reason).toBe("SKIP");
  });

  it("a lock held by a live process", async () => {
    const fx = createFixture();
    makeStale(fx);
    const ctx = setup(fx);
    mkdirSync(ctx.config.stateDir, { recursive: true });
    writeFileSync(path.join(ctx.config.stateDir, "run.lock"), String(process.pid));
    const result: Result = await runNightly(ctx.config, { generator: vi.fn(), github: ctx.github });
    expect(result.outcome, result.reason).toBe("SKIP");
    expect(result.reason).toMatch(/lock/u);
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
    const result: Result = await runNightly(
      { ...ctx.config, runnerDir: path.join(ctx.config.subjectDir, "scripts", "openwiki") },
      { generator, github: ctx.github },
    );
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
    const result: Result = await runNightly(ctx.config, { generator, github: ctx.github });
    expect(result.outcome, result.reason).toBe("PRECONDITION");
    expect(result.reason).toContain("openwiki@0.6.1");
    expect(result.reason).toContain("readable by its owner only");
    expect(result.reason).toContain("node >= 22.22.0");
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
    let result: Result = { outcome: "", reason: "", report: {} };
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
    const result: Result = await runNightly(ctx.config, {
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
    const result: Result = await runNightly(ctx.config, {
      getGitToken: async () => {
        calls += 1;
        if (calls > 1) throw new Error("installation token request failed: HTTP 401");
        return "token-1";
      },
      generator: openWikiLike(),
      github: ctx.github,
    });
    expect(result.outcome, result.reason).toBe("PRECONDITION");
    expect(result.reason).toContain("before publishing");
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
    const result: Result = await runNightly(ctx.config, { getGitToken: source, generator, github: ctx.github });
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
  it("names problems without values", () => {
    const problems: string[] = checkEnvironment({ GH_TOKEN: "secret-value", STRIPE_SECRET_KEY: "x", OPENWIKI_PROVIDER: "openai" });
    expect(problems).toEqual(expect.arrayContaining(["forbidden GH_TOKEN is set", "forbidden STRIPE_SECRET_KEY is set", "OPENWIKI_PROVIDER must be anthropic"]));
    expect(problems.join(" ")).not.toContain("secret-value");
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

  it("redacts credential shapes from captured output", () => {
    expect(redactSecrets("key sk-ant-ABCDEFGHIJKLMN and ghs_ABCDEFGHIJKLMNOPQRSTUVWX")).toBe("key [redacted] and [redacted]");
  });

  it("the runbook names every required environment variable", () => {
    const runbook = readFileSync(path.join(REPO_ROOT, "docs/runbooks/openwiki-nightly.md"), "utf8");
    for (const name of REQUIRED_ENV) expect(runbook, name).toContain(`\`${name}\``);
  });

  it("no OpenWiki workflow scaffold is committed (A3)", () => {
    expect(existsSync(path.join(REPO_ROOT, ".github/workflows/openwiki-update.yml"))).toBe(false);
  });
});
