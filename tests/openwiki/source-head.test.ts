import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  assessLiveness,
  committedPathExists,
  discoverSourceHead,
  readCommittedState,
  // @ts-expect-error - .mjs utility ships without type declarations
} from "../../scripts/openwiki/source-head.mjs";
// @ts-expect-error - .mjs utility ships without type declarations
import { loadOpenWikiIgnore } from "../../scripts/openwiki/paths.mjs";
import { cleanupTmp, createFixture, git, isolateGitConfig, restoreGitConfig, write } from "./helpers";

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

  it("refuses an unbounded walk instead of guessing, and says how far it looked (a count, not a SHA)", () => {
    const fx = createFixture();
    const tip = git(fx.work, ["rev-parse", "HEAD"]);
    expect(() => discoverSourceHead(fx.work, tip, loadOpenWikiIgnore(fx.work), { maxCommits: 1 })).toThrow(
      expect.objectContaining({ commitsScanned: 1, message: "no source change within the first-parent walk" }),
    );
  });
});

describe("assessLiveness", () => {
  const assess = (fx: ReturnType<typeof createFixture>, lastUpdate: unknown) => {
    const tip = git(fx.work, ["rev-parse", "HEAD"]);
    return assessLiveness(fx.work, { tip, sourceHead: head(fx).sourceHead, lastUpdate });
  };
  const valid = (value: unknown) => ({ state: "present-valid", value });

  it("live when gitHead is the source head", () => {
    const fx = createFixture();
    expect(assess(fx, valid({ status: "complete", gitHead: fx.source1 }))).toEqual({ state: "live", gitHead: fx.source1 });
  });

  it("live when gitHead was recorded after the last source change", () => {
    const fx = createFixture();
    expect(assess(fx, valid({ status: "complete", gitHead: fx.wiki1 }))).toEqual({ state: "live", gitHead: fx.wiki1, note: "recorded-after-source-change" });
  });

  it("stale once source changes after gitHead", () => {
    const fx = createFixture();
    fx.commit({ "lib/feature.ts": "export const feature = 3;\n" }, "source: change");
    expect(assess(fx, valid({ status: "complete", gitHead: fx.source1 })).state).toBe("stale");
  });

  it.each([
    ["missing metadata", { state: "absent" }, "missing"],
    ["malformed metadata, which is NOT missing metadata", { state: "present-invalid" }, "malformed"],
    ["metadata that is not an object", valid("complete"), "not-an-object"],
    ["an interrupted run", valid({ status: "interrupted", gitHead: "0".repeat(40) }), "status-not-complete"],
    ["an abbreviated sha", valid({ status: "complete", gitHead: "abc1234" }), "git-head-not-full-sha"],
    ["a sha outside production history", valid({ status: "complete", gitHead: "a".repeat(40) }), "git-head-not-in-history"],
  ])("invalid for %s, by code", (_label: string, lastUpdate: unknown, problem: string) => {
    const fx = createFixture();
    expect(assess(fx, lastUpdate)).toMatchObject({ state: "invalid", problem });
  });
});

describe("committed state: existence is read from the tree, never from parsing", () => {
  const commitForced = (fx: ReturnType<typeof createFixture>, files: Record<string, string>) => {
    for (const [file, content] of Object.entries(files)) write(fx.work, file, content);
    git(fx.work, ["add", "--force", "--", ...Object.keys(files)]);
    git(fx.work, ["commit", "--quiet", "-m", "state"]);
    return git(fx.work, ["rev-parse", "HEAD"]);
  };

  it("absent, present-valid and present-invalid are three states", () => {
    const fx = createFixture();
    const tip = commitForced(fx, { "state/valid.json": JSON.stringify({ a: 1 }), "state/broken.json": "{ not json", "state/dir.json/x": "{}" });
    expect(readCommittedState(fx.work, tip, "state/missing.json")).toEqual({ state: "absent" });
    expect(readCommittedState(fx.work, tip, "state/valid.json")).toEqual({ state: "present-valid", value: { a: 1 } });
    expect(readCommittedState(fx.work, tip, "state/broken.json")).toEqual({ state: "present-invalid" });
    expect(readCommittedState(fx.work, tip, "state/dir.json")).toEqual({ state: "present-invalid" });
  });

  it("existence ignores content entirely, and only the exact path counts", () => {
    const fx = createFixture();
    const tip = commitForced(fx, { "openwiki/.run.json": "{ not json", "openwiki/.run.json.example": "{}" });
    expect(committedPathExists(fx.work, tip, "openwiki/.run.json")).toBe(true);
    expect(committedPathExists(fx.work, tip, "openwiki/.run")).toBe(false);
    expect(committedPathExists(fx.work, fx.wiki1, "openwiki/.run.json")).toBe(false);
  });

  it("a git failure is a failure, never 'absent'", () => {
    const fx = createFixture();
    expect(() => committedPathExists(fx.work, "f".repeat(40), "openwiki/.run.json")).toThrow();
  });
});
