import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error - .mjs utility ships without type declarations
import { assessLiveness, discoverSourceHead } from "../../scripts/openwiki/source-head.mjs";
// @ts-expect-error - .mjs utility ships without type declarations
import { loadOpenWikiIgnore } from "../../scripts/openwiki/paths.mjs";
import { cleanupTmp, createFixture, git, isolateGitConfig, restoreGitConfig } from "./helpers";

// WIKI-AUTO-01. The wiki documents the SOURCE HEAD: the newest first-parent
// production commit whose own change touched a source path. Wiki-only and
// .openwikiignore'd commits after it must never move it.

beforeAll(isolateGitConfig);
afterAll(restoreGitConfig);
afterEach(cleanupTmp);

const head = (fx: ReturnType<typeof createFixture>) =>
  discoverSourceHead(fx.work, git(fx.work, ["rev-parse", "HEAD"]), loadOpenWikiIgnore(fx.work));

describe("discoverSourceHead", () => {
  it("skips a generated-only commit", () => {
    const fx = createFixture();
    const found = head(fx);
    expect(found.sourceHead).toBe(fx.source1);
    expect(found.skippedCommits).toEqual([fx.wiki1]);
  });

  it("skips .openwikiignore'd and authored-wiki commits, and stops at a real source change", () => {
    const fx = createFixture();
    const source2 = fx.commit({ "lib/feature.ts": "export const feature = 2;\n" }, "source: change");
    fx.commit({ "AGENTS.md": "<!-- OPENWIKI:START -->\nx\n<!-- OPENWIKI:END -->\n" }, "ignored: agents");
    fx.commit({ "docs/audits/run.md": "audit\n" }, "ignored: audit");
    fx.commit({ "openwiki/INSTRUCTIONS.md": "# Instructions\n\nRevised.\n" }, "authored wiki input");
    expect(head(fx).sourceHead).toBe(source2);
  });

  it("follows the first parent: a merged wiki-only branch is not a source change", () => {
    const fx = createFixture();
    git(fx.work, ["switch", "--quiet", "-c", "openwiki/nightly-x"]);
    fx.commit({ "openwiki/topic/kept-page.md": "# Kept page\n\nRegenerated.\n" }, "wiki update");
    git(fx.work, ["switch", "--quiet", "main"]);
    git(fx.work, ["merge", "--quiet", "--no-ff", "-m", "Merge wiki", "openwiki/nightly-x"]);
    expect(head(fx).sourceHead).toBe(fx.source1);
  });

  it("a merge whose first-parent diff touches source IS the source head", () => {
    const fx = createFixture();
    git(fx.work, ["switch", "--quiet", "-c", "feature"]);
    fx.commit({ "lib/other.ts": "export const other = 1;\n" }, "feature work");
    git(fx.work, ["switch", "--quiet", "main"]);
    git(fx.work, ["merge", "--quiet", "--no-ff", "-m", "Merge feature", "feature"]);
    expect(head(fx).sourceHead).toBe(git(fx.work, ["rev-parse", "HEAD"]));
  });

  it("a move from source into openwiki/ still counts its source side", () => {
    const fx = createFixture();
    git(fx.work, ["mv", "lib/feature.ts", "openwiki/feature.ts"]);
    git(fx.work, ["commit", "--quiet", "-m", "move"]);
    expect(head(fx).sourceHead).toBe(git(fx.work, ["rev-parse", "HEAD"]));
  });

  it("refuses an unbounded walk instead of guessing", () => {
    const fx = createFixture();
    const tip = git(fx.work, ["rev-parse", "HEAD"]);
    expect(() => discoverSourceHead(fx.work, tip, loadOpenWikiIgnore(fx.work), { maxCommits: 1 })).toThrow(/no source change/u);
  });
});

describe("assessLiveness", () => {
  const assess = (fx: ReturnType<typeof createFixture>, lastUpdate: unknown) => {
    const tip = git(fx.work, ["rev-parse", "HEAD"]);
    return assessLiveness(fx.work, { tip, sourceHead: head(fx).sourceHead, lastUpdate });
  };

  it("live when gitHead is the source head", () => {
    const fx = createFixture();
    expect(assess(fx, { status: "complete", gitHead: fx.source1 }).state).toBe("live");
  });

  it("live when gitHead was recorded after the last source change", () => {
    const fx = createFixture();
    expect(assess(fx, { status: "complete", gitHead: fx.wiki1 })).toMatchObject({ state: "live", note: expect.any(String) });
  });

  it("stale once source changes after gitHead", () => {
    const fx = createFixture();
    fx.commit({ "lib/feature.ts": "export const feature = 3;\n" }, "source: change");
    expect(assess(fx, { status: "complete", gitHead: fx.source1 }).state).toBe("stale");
  });

  it.each([
    ["missing metadata", undefined],
    ["an interrupted run", { status: "interrupted", gitHead: "0".repeat(40) }],
    ["an abbreviated sha", { status: "complete", gitHead: "abc1234" }],
    ["a sha outside production history", { status: "complete", gitHead: "a".repeat(40) }],
  ])("invalid for %s", (_label: string, lastUpdate: unknown) => {
    const fx = createFixture();
    expect(assess(fx, lastUpdate).state).toBe("invalid");
  });
});
