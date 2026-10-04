import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  FORBIDDEN_ENV,
  REQUIRED_ENV,
  buildGeneratorInvocation,
  checkEnvironment,
  redactSecrets,
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
    prepushCommand: [process.execPath, "-e", ""],
    env: {},
    requiredEnv: [],
    ...overrides,
  };
  const prs: Array<Record<string, string>> = [];
  const comments: Array<{ number: number; body: string }> = [];
  const github = () => ({
    async createPullRequest(args: Record<string, string>) {
      prs.push(args);
      return { number: 7, url: "https://example.invalid/pull/7", headSha: originRef(fx, args.head) };
    },
    async comment(number: number, body: string) {
      comments.push({ number, body });
    },
  });
  return { config, prs, comments, github };
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

/** Simulates `openwiki code --update --print`, including its writes outside openwiki/. */
function openWikiLike(extra?: (cwd: string) => void): Gen {
  return async ({ cwd }) => {
    write(cwd, "openwiki/topic/kept-page.md", "# Kept page\n\nFeature is 2.\n");
    write(cwd, "openwiki/topic/new-page.md", "# New page\n\nDocumented.\n");
    write(cwd, "openwiki/.claims/topic/kept-page.json", JSON.stringify({ claims: [{ id: "claim_1", statement: "Feature is 2.", evidence: [{ resource: "repo://lib/feature.ts#L1-L1" }] }] }));
    git(cwd, ["rm", "--quiet", "openwiki/topic/old-page.md"]);
    const head = git(cwd, ["rev-parse", "HEAD"]);
    write(cwd, "openwiki/.last-update.json", `${JSON.stringify({ command: "update", gitHead: head, status: "complete", language: "en" }, null, 2)}\n`);
    write(cwd, "AGENTS.md", AGENTS_TEMPLATE_REWRITE);
    write(cwd, ".github/workflows/openwiki-update.yml", OPENWIKI_SCAFFOLD_WORKFLOW);
    extra?.(cwd);
    return { exitCode: 0, output: "done" };
  };
}

/** A source change after the recorded gitHead makes the wiki stale. */
function makeStale(fx: Fx): string {
  const source2 = fx.commit({ "lib/feature.ts": "export const feature = 2;\n" }, "source: feature 2");
  fx.push();
  return source2;
}

async function run(fx: Fx, generator: Gen, overrides: Record<string, unknown> = {}) {
  const ctx = setup(fx, overrides);
  const spy = vi.fn(generator);
  const result: Result = await runNightly(ctx.config, { generator: spy, github: ctx.github, now: () => Date.UTC(2026, 9, 5) });
  return { ...ctx, result, generator: spy };
}

describe("startup no-op", () => {
  it("a live wiki ends before OpenWiki runs and before any run prerequisite is checked", async () => {
    const fx = createFixture();
    const { result, generator } = await run(fx, openWikiLike(), { anthropicKeyFile: "/nonexistent" });
    expect(result.outcome).toBe("NOOP");
    expect(result.report.liveness.state).toBe("live");
    expect(result.report.sourceHead).toBe(fx.source1);
    expect(generator).not.toHaveBeenCalled();
  });

  it("a merged wiki-only commit does not make the wiki stale", async () => {
    const fx = createFixture();
    fx.commit({ "openwiki/topic/kept-page.md": "# Kept page\n\nHand fix.\n" }, "wiki-only");
    fx.push();
    const { result, generator } = await run(fx, openWikiLike());
    expect(result.outcome).toBe("NOOP");
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
    expect(result.outcome).toBe("PUBLISHED");
  });

  it("publishes exactly the generated scope, replacing it, as the runner, through one PR", async () => {
    const fx = createFixture();
    const source2 = makeStale(fx);
    const tip = git(fx.work, ["rev-parse", "HEAD"]);
    const { result, prs, comments } = await run(fx, openWikiLike());
    expect(result.outcome).toBe("PUBLISHED");

    const branch = result.report.publish.branch;
    expect(branch).toBe(`openwiki/nightly-20261005-${source2.slice(0, 7)}`);
    const head = originRef(fx, branch)!;
    expect(head).toBe(result.report.publish.head);
    expect(git(fx.origin, ["rev-list", "--parents", "-n", "1", head]).split(" ").slice(1)).toEqual([tip]);
    expect(git(fx.origin, ["diff", "--name-status", "--no-renames", tip, head]).split("\n").sort()).toEqual([
      "A\topenwiki/topic/new-page.md",
      "D\topenwiki/topic/old-page.md",
      "M\topenwiki/.claims/topic/kept-page.json",
      "M\topenwiki/.last-update.json",
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
    expect(result.outcome).toBe("DRY_RUN");
    expect(prs).toEqual([]);
    expect(originBranches(fx)).toEqual(["main"]);
  });
});

describe("fail closed", () => {
  const failsWith = async (fx: Fx, generator: Gen, reason: RegExp) => {
    const { result, prs } = await run(fx, generator);
    expect(result.outcome).toBe("FAILED");
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
    const result = await failsWith(fx, openWikiLike((cwd) => write(cwd, "lib/feature.ts", "export const feature = 99;\n")), /outside the generated scope: lib\/feature\.ts/u);
    expect(result.report.discarded.map((d: { path: string }) => d.path)).toContain("lib/feature.ts");
  });

  it("a write to the authored openwiki/INSTRUCTIONS.md", async () => {
    const fx = createFixture();
    makeStale(fx);
    await failsWith(fx, openWikiLike((cwd) => write(cwd, "openwiki/INSTRUCTIONS.md", "# changed\n")), /openwiki\/INSTRUCTIONS\.md/u);
  });

  it("OpenWiki exits non-zero", async () => {
    const fx = createFixture();
    makeStale(fx);
    await failsWith(fx, async () => ({ exitCode: 1, output: "provider error" }), /OpenWiki exited 1/u);
  });

  it("OpenWiki leaves its run state behind", async () => {
    const fx = createFixture();
    makeStale(fx);
    await failsWith(fx, openWikiLike((cwd) => write(cwd, "openwiki/.run.json", "{}")), /did not complete/u);
  });

  it("gitHead that is not the pinned source head", async () => {
    const fx = createFixture();
    makeStale(fx);
    await failsWith(
      fx,
      openWikiLike((cwd) =>
        write(cwd, "openwiki/.last-update.json", JSON.stringify({ command: "update", status: "complete", gitHead: fx.source1 })),
      ),
      /gitHead does not equal the source head/u,
    );
  });

  it("a broken-link stamp", async () => {
    const fx = createFixture();
    makeStale(fx);
    await failsWith(
      fx,
      openWikiLike((cwd) => write(cwd, "openwiki/topic/new-page.md", "# New\n<!-- openwiki: broken internal link [x.md] missing. Fix the href or restore the target, then delete this comment. -->\n[x](x.md)\n")),
      /broken-link stamp/u,
    );
  });

  it("a denylisted name or tenant slug, reported without its text", async () => {
    const fx = createFixture();
    makeStale(fx);
    const result = await failsWith(
      fx,
      openWikiLike((cwd) => write(cwd, "openwiki/topic/new-page.md", "# New\n\nSynthetic Person booked at synthetic-studio-one.\n")),
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

  it("only run metadata changed: a no-op, not a publish", async () => {
    const fx = createFixture();
    makeStale(fx);
    const { result, prs } = await run(fx, async ({ cwd }) => {
      write(cwd, "openwiki/.last-update.json", JSON.stringify({ command: "update", status: "complete", gitHead: git(cwd, ["rev-parse", "HEAD"]) }));
      return { exitCode: 0 };
    });
    expect(result.outcome).toBe("NOOP");
    expect(prs).toEqual([]);
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
    expect(result.outcome).toBe(outcome);
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
    expect(result.outcome).toBe("SKIP");
  });

  it("a lock held by a live process", async () => {
    const fx = createFixture();
    makeStale(fx);
    const ctx = setup(fx);
    mkdirSync(ctx.config.stateDir, { recursive: true });
    writeFileSync(path.join(ctx.config.stateDir, "run.lock"), String(process.pid));
    const result: Result = await runNightly(ctx.config, { generator: vi.fn(), github: ctx.github });
    expect(result.outcome).toBe("SKIP");
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
    expect(result.outcome).toBe("SKIP");
    expect(result.reason).toContain("openwiki/nightly-20261004-aaaaaaa");
    expect(generator).not.toHaveBeenCalled();
  });

  it("a merged nightly branch does not block", async () => {
    const fx = createFixture();
    fx.push("openwiki/nightly-20261001-bbbbbbb");
    makeStale(fx);
    const { result } = await run(fx, openWikiLike());
    expect(result.outcome).toBe("PUBLISHED");
  });

  it("malformed managed-block markers", async () => {
    const fx = createFixture();
    fx.commit({ "AGENTS.md": `${AGENTS_AUTHORED}${AGENTS_AUTHORED}` }, "duplicated markers");
    makeStale(fx);
    const { result } = await run(fx, openWikiLike());
    expect(result.outcome).toBe("PRECONDITION");
    expect(result.reason).toMatch(/AGENTS\.md has malformed/u);
  });

  it("recorded gitHead outside production history", async () => {
    const fx = createFixture();
    fx.commit({ "openwiki/.last-update.json": JSON.stringify({ command: "update", status: "complete", gitHead: "a".repeat(40) }) }, "bad metadata");
    fx.push();
    const { result } = await run(fx, openWikiLike());
    expect(result.outcome).toBe("PRECONDITION");
    expect(result.reason).toMatch(/not in production history/u);
  });

  it("an OpenWiki pin other than 0.6.1, or a key file others can read", async () => {
    const fx = createFixture();
    makeStale(fx);
    const ctx = setup(fx);
    writeFileSync(path.join(ctx.config.openwikiDir, "package.json"), JSON.stringify({ name: "openwiki", version: "0.6.2" }));
    chmodSync(ctx.config.anthropicKeyFile, 0o644);
    const generator = vi.fn();
    const result: Result = await runNightly(ctx.config, { generator, github: ctx.github });
    expect(result.outcome).toBe("PRECONDITION");
    expect(result.reason).toContain("openwiki@0.6.1");
    expect(result.reason).toContain("readable by its owner only");
    expect(generator).not.toHaveBeenCalled();
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
