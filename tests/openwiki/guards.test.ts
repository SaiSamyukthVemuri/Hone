import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  checkCommitAuthors,
  checkLastUpdate,
  checkManagedBlockMarkers,
  diffTrees,
  discardChanges,
  findBrokenLinkStamps,
  inspectWorkflow,
  loadTenantSlugs,
  parseDenylist,
  privacyItemsFor,
  scanPrivacy,
  snapshotWorktree,
  sortRunChanges,
  // @ts-expect-error - .mjs utility ships without type declarations
} from "../../scripts/openwiki/guards.mjs";
// @ts-expect-error - .mjs utility ships without type declarations
import { loadOpenWikiIgnore } from "../../scripts/openwiki/paths.mjs";
import {
  AGENTS_TEMPLATE_REWRITE,
  OPENWIKI_SCAFFOLD_WORKFLOW,
  cleanupTmp,
  createFixture,
  git,
  isolateGitConfig,
  read,
  restoreGitConfig,
  write,
} from "./helpers";

beforeAll(isolateGitConfig);
afterAll(restoreGitConfig);
afterEach(cleanupTmp);

type Change = { status: string; path: string };
type Hit = { file: string; line: number; category: string };

describe("A3 — inspectWorkflow (subset of tests/ci/ci-config.test.ts)", () => {
  it("the OpenWiki init scaffold fails inspection, with reasons", () => {
    const violations = inspectWorkflow(OPENWIKI_SCAFFOLD_WORKFLOW);
    expect(violations).toEqual(
      expect.arrayContaining([
        "top-level permissions must be exactly `contents: read`",
        "requests a write permission",
        "references the secrets context",
        "a checkout keeps persisted credentials",
      ]),
    );
  });

  it("a least-privilege, SHA-pinned workflow passes", () => {
    const compliant = [
      "name: ok",
      "on: [pull_request]",
      "permissions:",
      "  contents: read",
      "jobs:",
      "  a:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5",
      "        with:",
      "          persist-credentials: false",
      "",
    ].join("\n");
    expect(inspectWorkflow(compliant)).toEqual([]);
  });

  it("flags an action pinned to a tag", () => {
    expect(inspectWorkflow("permissions:\n  contents: read\nsteps:\n  - uses: some/action@v4\n")).toEqual([
      "action not pinned to a full commit SHA: some/action@v4",
    ]);
  });
});

describe("page and metadata checks", () => {
  it("finds OpenWiki broken-link stamps by line", () => {
    const page = "# T\n<!-- openwiki: broken internal link [x.md] target missing. Fix the href or restore the target, then delete this comment. -->\n[x](x.md)\n";
    expect(findBrokenLinkStamps(page)).toEqual([2]);
    expect(findBrokenLinkStamps("# clean\n")).toEqual([]);
  });

  it("requires a completed update recording exactly the pinned source head", () => {
    const sha = "b".repeat(40);
    expect(checkLastUpdate({ command: "update", status: "complete", gitHead: sha }, sha)).toEqual([]);
    expect(checkLastUpdate({ command: "init", status: "complete", gitHead: sha }, sha)).toHaveLength(1);
    expect(checkLastUpdate({ command: "update", status: "interrupted", gitHead: sha }, sha)).toHaveLength(1);
    expect(checkLastUpdate({ command: "update", status: "complete", gitHead: "c".repeat(40) }, sha)).toEqual([
      "gitHead does not equal the source head the run was pinned to",
    ]);
    expect(checkLastUpdate(undefined, sha)).toHaveLength(1);
  });

  it("accepts no markers or one ordered pair, and refuses anything else", () => {
    expect(checkManagedBlockMarkers("AGENTS.md", "plain\n")).toEqual([]);
    expect(checkManagedBlockMarkers("AGENTS.md", AGENTS_TEMPLATE_REWRITE)).toEqual([]);
    expect(checkManagedBlockMarkers("AGENTS.md", `${AGENTS_TEMPLATE_REWRITE}${AGENTS_TEMPLATE_REWRITE}`)).toHaveLength(1);
    expect(checkManagedBlockMarkers("AGENTS.md", "<!-- OPENWIKI:END -->\n<!-- OPENWIKI:START -->\n")).toHaveLength(1);
    expect(checkManagedBlockMarkers("CLAUDE.md", undefined)).toEqual([]);
  });
});

describe("privacy / secret denylist", () => {
  const SAMPLES: Array<[string, string]> = [
    ["jwt", "token eyJhbGciOiJIUzI1NiJ9abcdef"],
    ["stripe-key", "key sk_live_abcdef123456"],
    ["webhook-secret", "whsec_abcdef123456"],
    ["provider-id", "customer cus_ABCDEFGHIJ12"],
    ["supabase-ref", "abcdefghijklmnopqrst.supabase.co"],
    ["uuid", "row 123e4567-e89b-12d3-a456-426614174000"],
    ["deployment", "preview hone-abc.vercel.app"],
    ["email", "mail someone@hone.example.org"],
    ["phone", "call +1 415 555 0100"],
    ["github-token", "ghs_ABCDEFGHIJKLMNOPQRSTUVWX"],
    ["anthropic-key", "sk-ant-ABCDEFGHIJKL"],
    ["private-key", "-----BEGIN RSA PRIVATE KEY-----"],
  ];

  it.each(SAMPLES)("detects %s", (category: string, text: string) => {
    const hits: Hit[] = scanPrivacy([{ file: "openwiki/a.md", lines: ["clean", text] }]);
    expect(hits).toContainEqual({ file: "openwiki/a.md", line: 2, category });
  });

  it("allows example.com addresses and ordinary prose", () => {
    expect(scanPrivacy([{ file: "f", lines: ["write to someone@example.com", "booking is atomic"] }])).toEqual([]);
  });

  it("matches denylisted terms and tenant slugs as words, and never returns the matched text", () => {
    const terms = parseDenylist("# names\nSynthetic Person\n\n");
    const slugs = ["synthetic-studio-one"];
    const hits: Hit[] = scanPrivacy(
      [{ file: "openwiki/p.md", lines: ["Seen by synthetic person today", "At Synthetic Studio One", "unsynthetic personnel"] }],
      { denylistTerms: terms, tenantSlugs: slugs },
    );
    expect(hits).toEqual([
      { file: "openwiki/p.md", line: 1, category: "denylist-term" },
      { file: "openwiki/p.md", line: 2, category: "tenant-slug" },
    ]);
    expect(JSON.stringify(hits).toLowerCase()).not.toContain("synthetic");
  });

  it("reads tenant slugs from the register table only", () => {
    const text = "## 0. Tenant register\n\n| Studio | Class |\n|---|---|\n| **demo-studio** | x |\n| Totals | 2 |\n\n## 1. Other\n| not-a-tenant | y |\n";
    expect(loadTenantSlugs(text)).toEqual(["demo-studio"]);
  });

  it("scans Claim statements and evidence paths, not OpenWiki's base64 evidence versions", () => {
    const sidecar = JSON.stringify({
      claims: [{ statement: "Clean statement.", evidence: [{ resource: "repo://lib/a.ts#L1-L2", version: "eyJzZWxlY3RlZExpbmVDb3VudCI6NjB9" }] }],
    });
    const items = privacyItemsFor("openwiki/.claims/x.json", sidecar);
    expect(scanPrivacy(items)).toEqual([]);
    expect(privacyItemsFor("openwiki/.page-manifest.json", "{}")).toEqual([]);
  });
});

describe("run scope on a real repository", () => {
  it("sorts generated, known side effects and unexpected writes, then discards the last two", () => {
    const fx = createFixture();
    const tip = git(fx.work, ["rev-parse", "HEAD"]);
    write(fx.work, "openwiki/topic/kept-page.md", "# Kept page\n\nRegenerated.\n");
    write(fx.work, "AGENTS.md", AGENTS_TEMPLATE_REWRITE);
    write(fx.work, ".github/workflows/openwiki-update.yml", OPENWIKI_SCAFFOLD_WORKFLOW);
    write(fx.work, "lib/feature.ts", "export const feature = 99;\n");
    write(fx.work, "openwiki/INSTRUCTIONS.md", "# Instructions\n\nRewritten by the generator.\n");

    const changes: Change[] = diffTrees(fx.work, tip, snapshotWorktree(fx.work));
    const sorted = sortRunChanges(changes, loadOpenWikiIgnore(fx.work));
    expect(sorted.generated.map((c: Change) => c.path)).toEqual(["openwiki/topic/kept-page.md"]);
    expect(sorted.sideEffects.map((c: Change) => c.path).sort()).toEqual([".github/workflows/openwiki-update.yml", "AGENTS.md"]);
    expect(sorted.unexpected.map((c: Change) => c.path).sort()).toEqual(["lib/feature.ts", "openwiki/INSTRUCTIONS.md"]);

    discardChanges(fx.work, tip, [...sorted.sideEffects, ...sorted.unexpected]);
    expect(existsSync(path.join(fx.work, ".github/workflows/openwiki-update.yml"))).toBe(false);
    expect(read(fx.work, "lib/feature.ts")).toBe("export const feature = 1;\n");
    expect(read(fx.work, "openwiki/INSTRUCTIONS.md")).toBe("# Instructions\n\nAuthored.\n");
    expect(diffTrees(fx.work, tip, snapshotWorktree(fx.work))).toEqual([{ status: "M", path: "openwiki/topic/kept-page.md" }]);
  });

  it("the snapshot does not disturb the real index", () => {
    const fx = createFixture();
    write(fx.work, "openwiki/new.md", "# New\n");
    snapshotWorktree(fx.work);
    expect(git(fx.work, ["status", "--porcelain"])).toBe("?? openwiki/new.md");
  });

  it("runner authorship: every commit in range must be the runner identity", () => {
    const fx = createFixture();
    const base = git(fx.work, ["rev-parse", "HEAD"]);
    fx.commit({ "openwiki/a.md": "# A\n" }, "wiki");
    const fixtureIdentity = { name: "Fixture Author", email: "fixture@example.com" };
    expect(checkCommitAuthors(fx.work, `${base}..HEAD`, fixtureIdentity)).toEqual([]);
    expect(checkCommitAuthors(fx.work, `${base}..HEAD`, { name: "hone-wiki-runner[bot]", email: "x@example.com" })).toHaveLength(1);
    expect(checkCommitAuthors(fx.work, `${base}..${base}`, fixtureIdentity)).toEqual([`no commits in ${base}..${base}`]);
  });
});
