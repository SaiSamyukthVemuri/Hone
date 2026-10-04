import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  checkCommitAuthors,
  checkLastUpdate,
  checkManagedBlockMarkers,
  checkProvenance,
  diffTrees,
  discardChanges,
  findBrokenLinkStamps,
  findConflictMarkers,
  inspectWorkflow,
  loadTenantSlugs,
  parseDenylist,
  privacyItemsFor,
  privacyItemsForPaths,
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
  makeTmp,
  read,
  restoreGitConfig,
  stampProvenance,
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

describe("conflict markers and provenance (trusted checks on the subject as data)", () => {
  it("finds conflict markers with git's grammar, and nothing else", () => {
    const text = ["<<<<<<< HEAD", "ours", "=======", "theirs", ">>>>>>> branch", "|||||||", "========", "<<<<<<<<", "<<<<<<<x", "a ======="].join("\n");
    expect(findConflictMarkers(text)).toEqual([1, 3, 5, 6]);
  });

  const wiki = () => {
    const root = makeTmp("provenance");
    write(root, "openwiki/.page-manifest.json", JSON.stringify({ schemaVersion: 1, pages: {} }));
    write(root, "openwiki/a.md", "# A\n");
    write(root, "openwiki/b.md", "# B\n");
    stampProvenance(root, ["openwiki/a.md", "openwiki/b.md"]);
    return root;
  };

  it("accepts pages whose sidecar and manifest carry the page's sha256, with at least one Claim", () => {
    const root = wiki();
    expect(checkProvenance(root, [{ status: "M", path: "openwiki/a.md" }, { status: "M", path: "openwiki/.claims/b.json" }])).toEqual([]);
  });

  it("flags a page edited after its provenance was recorded, in both sidecar and manifest", () => {
    const root = wiki();
    write(root, "openwiki/a.md", "# A, edited\n");
    expect(checkProvenance(root, [{ status: "M", path: "openwiki/a.md" }])).toEqual([
      "openwiki/.claims/a.json: pageVersion does not match the page",
      "openwiki/a.md: page manifest pageVersion does not match the page",
    ]);
  });

  it("flags a missing sidecar, a sidecar with no Claims, and leftovers of a deleted page", () => {
    const root = wiki();
    write(root, "openwiki/c.md", "# C\n");
    const empty = JSON.parse(read(root, "openwiki/.claims/b.json"));
    empty.claims = [];
    write(root, "openwiki/.claims/b.json", JSON.stringify(empty));
    rmSync(path.join(root, "openwiki/a.md"));
    expect(
      checkProvenance(root, [
        { status: "A", path: "openwiki/c.md" },
        { status: "M", path: "openwiki/.claims/b.json" },
        { status: "D", path: "openwiki/a.md" },
      ]),
    ).toEqual([
      "openwiki/.claims/a.json: Claim sidecar of a deleted page",
      "openwiki/a.md: page manifest still lists a deleted page",
      "openwiki/.claims/b.json: no Claims",
      "openwiki/c.md: no Claim sidecar",
    ]);
  });

  it("ignores pages the run did not touch, and structural pages", () => {
    const root = wiki();
    write(root, "openwiki/b.md", "# B, drifted before this run\n");
    write(root, "openwiki/index.md", "# Index\n");
    expect(checkProvenance(root, [{ status: "M", path: "openwiki/a.md" }, { status: "A", path: "openwiki/index.md" }])).toEqual([]);
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

  it("scans added and modified generated paths, also with separators as spaces, and never returns the path", () => {
    const items = privacyItemsForPaths([
      { status: "A", path: "openwiki/people/jane-doe.md" },
      { status: "D", path: "openwiki/old/jane-doe.md" },
      { status: "M", path: "./openwiki/topics/booking.md" },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].lines).toEqual(["openwiki/people/jane-doe.md openwiki people jane doe md", "openwiki/topics/booking.md openwiki topics booking md"]);
    const hits: Hit[] = scanPrivacy(items, { denylistTerms: ["Jane Doe"] });
    expect(hits).toEqual([{ file: "(generated paths)", line: 1, category: "denylist-term" }]);
    expect(privacyItemsForPaths([{ status: "D", path: "openwiki/x.md" }])).toEqual([]);
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

    const changes: Change[] = diffTrees(fx.work, tip, snapshotWorktree(fx.work, tip));
    const sorted = sortRunChanges(changes, loadOpenWikiIgnore(fx.work));
    expect(sorted.generated.map((c: Change) => c.path)).toEqual(["openwiki/topic/kept-page.md"]);
    expect(sorted.sideEffects.map((c: Change) => c.path).sort()).toEqual([".github/workflows/openwiki-update.yml", "AGENTS.md"]);
    expect(sorted.unexpected.map((c: Change) => c.path).sort()).toEqual(["lib/feature.ts", "openwiki/INSTRUCTIONS.md"]);

    discardChanges(fx.work, tip, [...sorted.sideEffects, ...sorted.unexpected]);
    expect(existsSync(path.join(fx.work, ".github/workflows/openwiki-update.yml"))).toBe(false);
    expect(read(fx.work, "lib/feature.ts")).toBe("export const feature = 1;\n");
    expect(read(fx.work, "openwiki/INSTRUCTIONS.md")).toBe("# Instructions\n\nAuthored.\n");
    expect(diffTrees(fx.work, tip, snapshotWorktree(fx.work, tip))).toEqual([{ status: "M", path: "openwiki/topic/kept-page.md" }]);
  });

  it("does not inherit the real index's cached state (stat cache, assume-unchanged)", () => {
    // The intermittent #786 failure: a copy of the real index carried its stat
    // cache under a newer file mtime, so a same-size rewrite of
    // .last-update.json inside the same second looked unchanged. That timing
    // cannot be forced in a test; an assume-unchanged entry hides a change the
    // same way, deterministically. The snapshot must see the content.
    const fx = createFixture();
    const tip = git(fx.work, ["rev-parse", "HEAD"]);
    git(fx.work, ["update-index", "--assume-unchanged", "openwiki/.last-update.json"]);
    const file = path.join(fx.work, "openwiki/.last-update.json");
    writeFileSync(file, readFileSync(file, "utf8").replace(/"gitHead": "[0-9a-f]{40}"/u, `"gitHead": "${"b".repeat(40)}"`));
    expect(git(fx.work, ["status", "--porcelain"])).toBe(""); // invisible to the real index
    expect(diffTrees(fx.work, tip, snapshotWorktree(fx.work, tip))).toEqual([{ status: "M", path: "openwiki/.last-update.json" }]);
  });

  it("the snapshot does not disturb the real index", () => {
    const fx = createFixture();
    write(fx.work, "openwiki/new.md", "# New\n");
    snapshotWorktree(fx.work, "HEAD");
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
