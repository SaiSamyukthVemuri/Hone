import { describe, expect, it } from "vitest";
import path from "node:path";
// @ts-expect-error - .mjs utility ships without type declarations
import { classifyPath, loadOpenWikiIgnore, normalizePath, parseOpenWikiIgnore } from "../../scripts/openwiki/paths.mjs";

// WIKI-AUTO-01. One classifier decides ownership for every runner decision, and
// its .openwikiignore matcher must agree with openwiki@0.6.1's.

const ROOT = path.resolve(__dirname, "../..");

describe("classifyPath — who owns a path", () => {
  it.each([
    ["openwiki/INSTRUCTIONS.md", "authored"],
    ["openwiki/.run.json", "transient"],
    ["openwiki/quickstart.md", "generated"],
    ["openwiki/index.md", "generated"],
    ["openwiki/.claims/payments/stripe-payments-and-settlement.json", "generated"],
    ["openwiki/.last-update.json", "generated"],
    ["openwiki/.page-manifest.json", "generated"],
    ["lib/booking/slots.ts", "source"],
    ["CLAUDE.md", "source"],
    [".openwikiignore", "source"],
  ])("%s is %s", (file: string, kind: string) => {
    expect(classifyPath(file)).toBe(kind);
  });

  it("normalizes spellings that could dodge a rule", () => {
    expect(normalizePath("./openwiki/x.md")).toBe("openwiki/x.md");
    expect(normalizePath("/openwiki/../openwiki/x.md")).toBe("openwiki/x.md");
    expect(normalizePath("openwiki\\x.md")).toBe("openwiki/x.md");
    expect(classifyPath("./openwiki/INSTRUCTIONS.md")).toBe("authored");
    expect(classifyPath("lib/../openwiki/a.md")).toBe("generated");
  });

  it(".openwikiignore itself is always source, even when a rule matches it", () => {
    expect(classifyPath(".openwikiignore", parseOpenWikiIgnore(".openwikiignore\n"))).toBe("source");
  });
});

describe("parseOpenWikiIgnore — openwiki@0.6.1 semantics", () => {
  const rules = parseOpenWikiIgnore(
    ["# comment", "", "node_modules/", "*.log", "/AGENTS.md", "docs/audits/", "build/**/out", "!keep.log", "Secret?.txt"].join("\n"),
  );

  it.each([
    ["node_modules/a/b.js", true],
    ["pkg/node_modules/a.js", true],
    ["node_modules", false], // directory-only rule, top-level file named like it
    ["x/debug.log", true],
    ["keep.log", false], // later negation wins
    ["AGENTS.md", true],
    ["nested/AGENTS.md", false], // leading slash anchors to the root
    ["docs/audits/2026/report.md", true],
    ["other/docs/audits/report.md", false], // embedded slash anchors too
    ["build/a/b/out", true],
    ["build/out", true],
    ["SECRETS.txt", true], // case-insensitive, ? is one character
    ["lib/feature.ts", false],
  ])("%s ignored = %s", (file: string, expected: boolean) => {
    expect(rules.ignores(file)).toBe(expected);
  });

  it("a directory-only rule matches the directory entry itself when told it is one", () => {
    expect(rules.ignores("node_modules", true)).toBe(true);
  });
});

describe("the repository .openwikiignore (WIKI-AUTO-01 contract)", () => {
  const ignore = loadOpenWikiIgnore(ROOT);

  it("ignores AGENTS.md, whose managed block OpenWiki rewrites on every run", () => {
    expect(classifyPath("AGENTS.md", ignore)).toBe("ignored");
  });

  it("A3: ignores the workflow scaffold openwiki init writes", () => {
    expect(classifyPath(".github/workflows/openwiki-update.yml", ignore)).toBe("ignored");
  });

  it("keeps CLAUDE.md and the real CI workflow visible: pages cite them as evidence", () => {
    expect(classifyPath("CLAUDE.md", ignore)).toBe("source");
    expect(classifyPath(".github/workflows/ci.yml", ignore)).toBe("source");
  });
});
