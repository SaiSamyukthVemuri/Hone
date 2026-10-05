import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  PATH_GATE_CATEGORIES,
  checkCommitAuthors,
  checkLastUpdate,
  checkManagedBlockMarkers,
  checkPageManifest,
  checkProvenance,
  diffTrees,
  discardChanges,
  findBrokenLinkStamps,
  findConflictMarkers,
  gateChangedPaths,
  inspectWorkflow,
  isInterruptedGeneration,
  isValidEvidenceVersion,
  loadTenantSlugs,
  metadataPrivacyItems,
  parseDenylist,
  parseTenantRegister,
  privacyItemsFor,
  readWorktreeFile,
  readWorktreeState,
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
  PRODUCTION_FILE_EVIDENCE_VERSION,
  PRODUCTION_RANGE_EVIDENCE_VERSION,
  REPO_ROOT,
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
  it("the OpenWiki init scaffold fails inspection, by code", () => {
    expect(inspectWorkflow(OPENWIKI_SCAFFOLD_WORKFLOW)).toEqual([
      "top-level-permissions-not-read-only",
      "write-permission",
      "secrets-context",
      "persisted-credentials",
    ]);
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

  it("flags an action pinned to a tag without quoting the reference (it is generator output)", () => {
    expect(inspectWorkflow("permissions:\n  contents: read\nsteps:\n  - uses: some/synthetic-person@v4\n  - uses: other/action@main\n")).toEqual([
      "unpinned-action",
    ]);
  });
});

describe("page and metadata checks", () => {
  it("finds OpenWiki broken-link stamps by line", () => {
    const page = "# T\n<!-- openwiki: broken internal link [x.md] target missing. Fix the href or restore the target, then delete this comment. -->\n[x](x.md)\n";
    expect(findBrokenLinkStamps(page)).toEqual([2]);
    expect(findBrokenLinkStamps("# clean\n")).toEqual([]);
  });

  it("requires a completed update recording exactly the pinned source head, and tells missing from malformed", () => {
    const sha = "b".repeat(40);
    const base = { updatedAt: "2026-10-05T03:30:00.000Z", command: "update", gitHead: sha, model: "claude-fixture", status: "complete", language: "en" };
    const check = (overrides: Record<string, unknown>) => checkLastUpdate({ state: "present-valid", value: { ...base, ...overrides } }, sha);
    expect(check({})).toEqual([]);
    expect(check({ command: "init" })).toEqual(["command-not-update"]);
    expect(check({ status: "interrupted" })).toEqual(["status-not-complete"]);
    expect(check({ gitHead: "c".repeat(40) })).toEqual(["git-head-mismatch"]);
    expect(checkLastUpdate({ state: "present-valid", value: ["update"] }, sha)).toEqual(["not-an-object"]);
    expect(checkLastUpdate({ state: "absent" }, sha)).toEqual(["missing"]);
    expect(checkLastUpdate({ state: "present-invalid" }, sha)).toEqual(["malformed"]);
  });

  it.each([
    ["an extra key, whatever it holds", { note: "Synthetic Person" }, "unknown-key"],
    ["no updatedAt", { updatedAt: undefined }, "invalid-updated-at"],
    ["an updatedAt that is not an ISO instant", { updatedAt: "yesterday" }, "invalid-updated-at"],
    ["no model", { model: undefined }, "invalid-model"],
    ["a blank model", { model: " " }, "invalid-model"],
    ["a model with a control character", { model: "claude\nfixture" }, "invalid-model"],
    ["a language that is not a locale", { language: "Synthetic Person" }, "invalid-language"],
    ["a language in a non-canonical spelling", { language: "EN" }, "invalid-language"],
    ["a language Intl does not recognize", { language: "xx" }, "invalid-language"],
  ])(".last-update.json is held to openwiki@0.6.1's strict schema: %s", (_label: string, overrides: Record<string, unknown>, problem: string) => {
    const sha = "b".repeat(40);
    const value: Record<string, unknown> = { updatedAt: "2026-10-05T03:30:00.000Z", command: "update", gitHead: sha, model: "claude-fixture", status: "complete", language: "en", ...overrides };
    for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key];
    expect(checkLastUpdate({ state: "present-valid", value }, sha)).toEqual([problem]);
  });

  it("accepts a language without it (optional), and a canonical regional locale", () => {
    const sha = "b".repeat(40);
    const base = { updatedAt: "2026-10-05T03:30:00.000Z", command: "update", gitHead: sha, model: "claude-fixture", status: "complete" };
    expect(checkLastUpdate({ state: "present-valid", value: base }, sha)).toEqual([]);
    expect(checkLastUpdate({ state: "present-valid", value: { ...base, language: "pt-BR" } }, sha)).toEqual([]);
  });

  it("accepts no markers or one ordered pair, and refuses anything else", () => {
    expect(checkManagedBlockMarkers("AGENTS.md", "plain\n")).toEqual([]);
    expect(checkManagedBlockMarkers("AGENTS.md", AGENTS_TEMPLATE_REWRITE)).toEqual([]);
    expect(checkManagedBlockMarkers("AGENTS.md", `${AGENTS_TEMPLATE_REWRITE}${AGENTS_TEMPLATE_REWRITE}`)).toEqual([
      { code: "MANAGED_BLOCK_MARKERS_MALFORMED", details: { file: "AGENTS.md" } },
    ]);
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

  const pages = (root: string) => JSON.parse(read(root, "openwiki/.page-manifest.json")).pages;

  it("accepts pages whose sidecar and manifest carry the page's sha256, with at least one Claim", () => {
    const root = wiki();
    expect(checkProvenance(root, [{ status: "M", path: "openwiki/a.md" }, { status: "M", path: "openwiki/.claims/b.json" }], pages(root))).toEqual([]);
  });

  it("flags a page edited after its provenance was recorded, in both sidecar and manifest", () => {
    const root = wiki();
    write(root, "openwiki/a.md", "# A, edited\n");
    expect(checkProvenance(root, [{ status: "M", path: "openwiki/a.md" }], pages(root))).toEqual([
      { file: "openwiki/a.md", problem: "sidecar-page-version-mismatch" },
      { file: "openwiki/a.md", problem: "manifest-page-version-mismatch" },
    ]);
  });

  it("flags a missing sidecar, a sidecar with no Claims or bad JSON, and leftovers of a deleted page, naming the CHANGED path", () => {
    const root = wiki();
    write(root, "openwiki/c.md", "# C\n");
    write(root, "openwiki/d.md", "# D\n");
    write(root, "openwiki/.claims/d.json", "{ not json");
    const empty = JSON.parse(read(root, "openwiki/.claims/b.json"));
    empty.claims = [];
    write(root, "openwiki/.claims/b.json", JSON.stringify(empty));
    rmSync(path.join(root, "openwiki/a.md"));
    expect(
      checkProvenance(
        root,
        [
          { status: "A", path: "openwiki/c.md" },
          { status: "M", path: "openwiki/.claims/b.json" },
          { status: "D", path: "openwiki/a.md" },
          { status: "A", path: "openwiki/d.md" },
        ],
        pages(root),
      ),
    ).toEqual([
      { file: "openwiki/a.md", problem: "deleted-page-sidecar-left" },
      { file: "openwiki/a.md", problem: "deleted-page-manifest-entry-left" },
      { file: "openwiki/.claims/b.json", problem: "no-claims" },
      { file: "openwiki/c.md", problem: "no-sidecar" },
      { file: "openwiki/d.md", problem: "sidecar-not-json" },
    ]);
  });

  it("ignores pages the run did not touch, and structural pages", () => {
    const root = wiki();
    write(root, "openwiki/b.md", "# B, drifted before this run\n");
    write(root, "openwiki/index.md", "# Index\n");
    expect(checkProvenance(root, [{ status: "M", path: "openwiki/a.md" }, { status: "A", path: "openwiki/index.md" }], pages(root))).toEqual([]);
  });
});

describe("state files: existence is not parse success", () => {
  it("reads absent, present-valid and present-invalid as three different states", () => {
    const root = makeTmp("state");
    write(root, "valid.json", JSON.stringify({ a: 1 }));
    write(root, "broken.json", "{ not json");
    mkdirSync(path.join(root, "dir.json"));
    symlinkSync(path.join(root, "valid.json"), path.join(root, "link.json"));
    expect(readWorktreeState(root, "missing.json")).toEqual({ state: "absent" });
    expect(readWorktreeState(root, "valid.json/inner.json")).toEqual({ state: "absent" });
    expect(readWorktreeState(root, "valid.json")).toEqual({ state: "present-valid", value: { a: 1 } });
    expect(readWorktreeState(root, "broken.json")).toEqual({ state: "present-invalid" });
    expect(readWorktreeState(root, "dir.json")).toEqual({ state: "present-invalid" });
    expect(readWorktreeState(root, "link.json")).toEqual({ state: "present-invalid" });
    expect(readWorktreeFile(root, "broken.json")).toEqual({ state: "present-valid", text: "{ not json" });
  });
});

describe("isInterruptedGeneration: exactly openwiki@0.6.1's interrupted state (WIKI-INTERRUPTED-RETRY-01)", () => {
  const BASE = "a".repeat(40);
  const SOURCE = "b".repeat(40);
  const ENTRY = { pageVersion: `sha256:${"c".repeat(64)}`, gitHead: BASE };
  type Input = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** The state as the host left it: one skipped page whose preserved manifest entry no longer matches its bytes. */
  const interrupted = (over: Input = {}): Input => ({
    lastUpdate: { state: "present-valid", value: { updatedAt: "2026-10-05T17:54:00.000Z", command: "update", gitHead: BASE, model: "m", status: "interrupted", language: "en" } },
    baseGitHead: BASE,
    checks: {
      lastUpdate: ["status-not-complete", "git-head-mismatch"],
      manifest: [],
      brokenLinkStamps: [],
      conflictMarkers: [],
      privacyHits: [],
      provenance: [{ file: "openwiki/security/routes.md", problem: "manifest-page-version-mismatch" }],
    },
    manifestPages: { "/openwiki/security/routes.md": { gitHead: BASE, pageVersion: ENTRY.pageVersion } },
    basePages: { "/openwiki/security/routes.md": ENTRY },
    ...over,
  });
  const withChecks = (checks: Input) => interrupted({ checks: { ...interrupted().checks, ...checks } });
  const withValue = (value: Input) => interrupted({ lastUpdate: { state: "present-valid", value: { ...interrupted().lastUpdate.value, ...value } } });

  it("holds for the state the host recorded, a preserved entry in any key order", () => {
    expect(isInterruptedGeneration(interrupted())).toBe(true);
  });

  it("holds with no provenance finding at all, and through a Claim sidecar's path", () => {
    expect(isInterruptedGeneration(withChecks({ provenance: [] }))).toBe(true);
    expect(isInterruptedGeneration(withChecks({ provenance: [{ file: "openwiki/.claims/security/routes.json", problem: "manifest-page-version-mismatch" }] }))).toBe(true);
  });

  it.each<[string, Input]>([
    ["metadata absent", interrupted({ lastUpdate: { state: "absent" } })],
    ["metadata unparseable", interrupted({ lastUpdate: { state: "present-invalid" } })],
    ["a status other than interrupted", withValue({ status: "running" })],
    ["a gitHead other than the base", withValue({ gitHead: SOURCE })],
    ["no gitHead at all", withValue({ gitHead: undefined })],
    ["a base that is not a full SHA", interrupted({ baseGitHead: "a".repeat(7) })],
    ["only one of the two metadata problems", withChecks({ lastUpdate: ["status-not-complete"] })],
    ["a further metadata problem", withChecks({ lastUpdate: ["unknown-key", "status-not-complete", "git-head-mismatch"] })],
    ["a manifest outside its schema", withChecks({ manifest: ["schema-version"] })],
    ["a broken-link stamp", withChecks({ brokenLinkStamps: [{ file: "openwiki/a.md", line: 3 }] })],
    ["a conflict marker", withChecks({ conflictMarkers: [{ file: "openwiki/a.md", line: 3 }] })],
    ["a privacy hit", withChecks({ privacyHits: [{ file: "openwiki/a.md", category: "denylist" }] })],
    ["any other provenance finding", withChecks({ provenance: [{ file: "openwiki/security/routes.md", problem: "sidecar-page-version-mismatch" }] })],
    ["a manifest entry that differs from the committed one", interrupted({ manifestPages: { "/openwiki/security/routes.md": { ...ENTRY, pageVersion: `sha256:${"d".repeat(64)}` } } })],
    ["a page the committed manifest never had", interrupted({ basePages: {} })],
    ["a page missing from the attempt's manifest", interrupted({ manifestPages: {} })],
    ["no manifest to compare", interrupted({ manifestPages: undefined })],
  ])("does not hold for %s", (_label: string, input: Input) => {
    expect(isInterruptedGeneration(input)).toBe(false);
  });
});

describe("the page manifest: openwiki@0.6.1's strict schema, on every run", () => {
  const valid = (value: unknown) => checkPageManifest({ state: "present-valid", value });
  const entry = { pageVersion: `sha256:${"a".repeat(64)}` };

  it("accepts the repository's own committed manifest", () => {
    expect(checkPageManifest(readWorktreeState(REPO_ROOT, "openwiki/.page-manifest.json"))).toEqual([]);
  });

  it("accepts every optional field in its OpenWiki format", () => {
    expect(
      valid({
        schemaVersion: 1,
        pages: {
          "/openwiki/a.md": {
            ...entry,
            gitHead: "b".repeat(40),
            sourceFingerprint: `sha256:${"c".repeat(64)}`,
            completedBy: "claude-code",
            completedRunId: "123e4567-e89b-42d3-a456-426614174000",
          },
        },
      }),
    ).toEqual([]);
  });

  it.each([
    ["missing", { state: "absent" }, ["missing"]],
    ["malformed", { state: "present-invalid" }, ["malformed"]],
    ["an array", { state: "present-valid", value: [] }, ["not-an-object"]],
  ])("reports a manifest that is %s", (_label: string, state: unknown, problems: string[]) => {
    expect(checkPageManifest(state)).toEqual(problems);
  });

  it.each([
    ["an unknown top-level key", { schemaVersion: 1, pages: {}, extra: true }, "unknown-top-level-key"],
    ["schemaVersion 2", { schemaVersion: 2, pages: {} }, "schema-version"],
    ["schemaVersion as a string", { schemaVersion: "1", pages: {} }, "schema-version"],
    ["pages as an array", { schemaVersion: 1, pages: [] }, "pages-not-an-object"],
    ["a structural page", { schemaVersion: 1, pages: { "/openwiki/index.md": entry } }, "invalid-page-path"],
    ["INSTRUCTIONS.md in any case", { schemaVersion: 1, pages: { "/openwiki/Instructions.md": entry } }, "invalid-page-path"],
    ["a Claim sidecar", { schemaVersion: 1, pages: { "/openwiki/.claims/a.md": entry } }, "invalid-page-path"],
    ["a non-canonical key", { schemaVersion: 1, pages: { "openwiki/a.md": entry } }, "invalid-page-path"],
    ["a traversal", { schemaVersion: 1, pages: { "/openwiki/../openwiki/a.md": entry } }, "invalid-page-path"],
    ["a page outside openwiki/", { schemaVersion: 1, pages: { "/docs/a.md": entry } }, "invalid-page-path"],
    ["an entry that is not an object", { schemaVersion: 1, pages: { "/openwiki/a.md": "sha256:x" } }, "entry-not-an-object"],
    ["an unknown entry key", { schemaVersion: 1, pages: { "/openwiki/a.md": { ...entry, note: "x" } } }, "unknown-entry-key"],
    ["no pageVersion", { schemaVersion: 1, pages: { "/openwiki/a.md": {} } }, "invalid-page-version"],
    ["an uppercase pageVersion", { schemaVersion: 1, pages: { "/openwiki/a.md": { pageVersion: `sha256:${"A".repeat(64)}` } } }, "invalid-page-version"],
    ["an empty gitHead", { schemaVersion: 1, pages: { "/openwiki/a.md": { ...entry, gitHead: "" } } }, "invalid-git-head"],
    ["a gitHead that is not a full commit SHA", { schemaVersion: 1, pages: { "/openwiki/a.md": { ...entry, gitHead: "Synthetic Person" } } }, "invalid-git-head"],
    ["a completedBy that is no producer id", { schemaVersion: 1, pages: { "/openwiki/a.md": { ...entry, completedBy: "Synthetic Person" } } }, "invalid-completed-by"],
    ["a malformed fingerprint", { schemaVersion: 1, pages: { "/openwiki/a.md": { ...entry, sourceFingerprint: "md5:x" } } }, "invalid-source-fingerprint"],
    ["a blank completedBy", { schemaVersion: 1, pages: { "/openwiki/a.md": { ...entry, completedBy: "  " } } }, "invalid-completed-by"],
    ["a non-UUID completedRunId", { schemaVersion: 1, pages: { "/openwiki/a.md": { ...entry, completedRunId: "run-1" } } }, "invalid-completed-run-id"],
    ["a null optional field", { schemaVersion: 1, pages: { "/openwiki/a.md": { ...entry, gitHead: null } } }, "invalid-git-head"],
  ])("refuses %s", (_label: string, manifest: unknown, problem: string) => {
    expect(valid(manifest)).toEqual([problem]);
  });
});

describe("run metadata: every free-text value is privacy-scanned, and the repository's own metadata passes", () => {
  const terms = { denylistTerms: parseDenylist("Synthetic Person\n"), tenantSlugs: ["synthetic-studio-one"] };
  const lastUpdate = (value: Record<string, unknown>) => ({ state: "present-valid", value });
  const manifest = (pages: Record<string, unknown>) => ({ state: "present-valid", value: { schemaVersion: 1, pages } });
  const digest = `sha256:${"a".repeat(64)}`;

  it("scans model, language, every page key and every completedBy, as written and humanized", () => {
    const items = metadataPrivacyItems(
      lastUpdate({ model: "synthetic-person/claude", language: "en", updatedAt: "2026-10-05T03:30:00.000Z" }),
      manifest({ "/openwiki/studios/synthetic-studio-one.md": { pageVersion: digest, completedBy: "claude-code" }, "/openwiki/a.md": { pageVersion: digest, completedBy: "synthetic-person" } }),
    );
    expect(scanPrivacy(items, terms)).toEqual([
      { file: "openwiki/.last-update.json", line: 1, category: "denylist-term" },
      { file: "openwiki/.page-manifest.json", line: 1, category: "tenant-slug" },
      { file: "openwiki/.page-manifest.json", line: 4, category: "denylist-term" },
    ]);
  });

  it("never scans what a strict grammar pins down (a UUID run id would otherwise look like private data)", () => {
    const items = metadataPrivacyItems(
      lastUpdate({ model: "claude-fixture", gitHead: "b".repeat(40), updatedAt: "2026-10-05T03:30:00.000Z" }),
      manifest({ "/openwiki/a.md": { pageVersion: digest, completedRunId: "123e4567-e89b-42d3-a456-426614174000", gitHead: "b".repeat(40) } }),
    );
    expect(scanPrivacy(items, terms)).toEqual([]);
    expect(JSON.stringify(items)).not.toContain("123e4567");
  });

  it("the repository's own committed metadata holds the strict schemas and scans clean against the real tenant register", () => {
    const committed = readWorktreeState(REPO_ROOT, "openwiki/.last-update.json");
    expect(checkLastUpdate(committed, committed.value.gitHead)).toEqual([]);
    const pages = readWorktreeState(REPO_ROOT, "openwiki/.page-manifest.json");
    expect(checkPageManifest(pages)).toEqual([]);
    const tenantSlugs = parseTenantRegister(readFileSync(path.join(REPO_ROOT, "docs/production/current-state.md"), "utf8")).slugs;
    expect(tenantSlugs.length).toBeGreaterThan(0);
    expect(scanPrivacy(metadataPrivacyItems(committed, pages), { tenantSlugs })).toEqual([]);
  });

  it("scans every key and string of a Claim sidecar, humanized, except its digest fields", () => {
    const sidecar = JSON.stringify({
      schemaVersion: 1,
      pageVersion: digest,
      claims: [{ id: "claim_1", statement: "Clean.", evidence: [{ resource: "repo://lib/synthetic-person.ts#L1-L2", version: PRODUCTION_RANGE_EVIDENCE_VERSION }] }],
      verification: { by: "openwiki/0.6.1", at: "2026-10-05T03:30:00.000Z" },
      reviewer: "synthetic-studio-one",
    });
    const hits = scanPrivacy(privacyItemsFor("openwiki/.claims/a.json", sidecar), terms);
    expect(hits.map((h: Hit) => h.category).sort()).toEqual(["denylist-term", "tenant-slug"]);
    expect(hits.every((h: Hit) => h.file === "openwiki/.claims/a.json")).toBe(true);
  });

  it("scans a generated file of an unknown type whole, and leaves run metadata to the schema-aware scan", () => {
    expect(privacyItemsFor("openwiki/notes.txt", "a\nb")).toEqual([{ file: "openwiki/notes.txt", lines: ["a", "b"] }]);
    expect(privacyItemsFor("openwiki/.page-manifest.json", "{}")).toEqual([]);
    expect(privacyItemsFor("openwiki/.last-update.json", "{}")).toEqual([]);
  });
});

describe("evidence versions: exempt from the privacy scan only when the VALUE has OpenWiki's exact grammar", () => {
  const RANGE = PRODUCTION_RANGE_EVIDENCE_VERSION;
  const HASH = RANGE.split(":")[2];
  const PAYLOAD = RANGE.split(":")[3];
  const META = JSON.parse(Buffer.from(PAYLOAD, "base64url").toString("utf8"));
  const withPayload = (payload: string) => `repo-lines-v1:sha256:${HASH}:${payload}`;
  const encode = (value: unknown) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value), "utf8").toString("base64url");
  const without = (key: string) => Object.fromEntries(Object.entries(META).filter(([name]) => name !== key));

  it("accepts the evidence versions copied from production, and every evidence version this repository commits", () => {
    expect(isValidEvidenceVersion(PRODUCTION_RANGE_EVIDENCE_VERSION)).toBe(true);
    expect(isValidEvidenceVersion(PRODUCTION_FILE_EVIDENCE_VERSION)).toBe(true);
    const claimsDir = path.join(REPO_ROOT, "openwiki/.claims");
    const versions = git(REPO_ROOT, ["ls-files", "-z", "openwiki/.claims"])
      .split("\0")
      .filter((p: string) => p.endsWith(".json"))
      .flatMap((p: string) => JSON.parse(readFileSync(path.join(REPO_ROOT, p), "utf8")).claims.flatMap((c: { evidence: Array<{ version: string }> }) => c.evidence.map((e) => e.version)));
    expect(existsSync(claimsDir)).toBe(true);
    expect(versions.length).toBeGreaterThan(1000);
    expect(versions.filter((v: string) => !isValidEvidenceVersion(v))).toEqual([]);
  });

  it.each([
    ["free text (the review's example)", "private.person@corp.test"],
    ["an empty string", ""],
    ["a bare sha256 digest", `sha256:${HASH}`],
    ["a bare base64 JSON blob", PAYLOAD],
    ["another discriminator", `repo-lines-v2:sha256:${HASH}:${PAYLOAD}`],
    ["a whole-file form with a payload", `repo-file-v1:sha256:${HASH}:${PAYLOAD}`],
    ["a short sha", withPayload(PAYLOAD).replace(HASH, HASH.slice(1))],
    ["an uppercase sha", withPayload(PAYLOAD).replace(HASH, HASH.toUpperCase())],
    ["a non-hex sha", withPayload(PAYLOAD).replace(HASH, `g${HASH.slice(1)}`)],
    ["no payload", `repo-lines-v1:sha256:${HASH}:`],
    ["a payload outside base64url", withPayload("!!not-base64!!")],
    ["a padded payload", withPayload(`${PAYLOAD}==`)],
    ["a payload that is not JSON", withPayload(encode("Synthetic Person"))],
    ["a payload that is JSON but not an object", withPayload(encode([1, 2, 3]))],
    ["a count as a string", withPayload(encode({ ...META, selectedLineCount: "23" }))],
    ["a zero selected-line count", withPayload(encode({ ...META, selectedLineCount: 0 }))],
    ["a context count above three", withPayload(encode({ ...META, precedingContextLineCount: 4 }))],
    ["an uppercase line hash", withPayload(encode({ ...META, firstSelectedLineHash: META.firstSelectedLineHash.toUpperCase() }))],
    ["a missing field", withPayload(encode(without("followingContextHash")))],
    ["an extra free-text field", withPayload(encode({ ...META, note: "Synthetic Person" }))],
    ["a field swapped for free text", withPayload(encode({ ...without("followingContextHash"), note: "Synthetic Person" }))],
    ["a non-canonical encoding of valid metadata", withPayload(encode(JSON.stringify(META, null, 1)))],
    ["a truncated value", RANGE.slice(0, -6)],
    ["the prefix alone", "repo-lines-v1:sha256:"],
  ])("rejects %s", (_label: string, value: string) => {
    expect(isValidEvidenceVersion(value)).toBe(false);
  });

  it("refuses a value that is not a string", () => {
    for (const value of [undefined, null, 42, { version: RANGE }, [RANGE]]) expect(isValidEvidenceVersion(value)).toBe(false);
  });

  const sidecarWith = (version: unknown, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ schemaVersion: 1, claims: [{ id: "claim_1", statement: "Clean.", evidence: [{ resource: "repo://lib/a.ts#L1-L2", version }] }], ...extra });

  it("a valid version stays exempt, so its token-like base64 is no false positive", () => {
    expect(PAYLOAD.startsWith("eyJ")).toBe(true); // it would look like a JWT if it were scanned
    expect(scanPrivacy(privacyItemsFor("openwiki/.claims/a.json", sidecarWith(RANGE)))).toEqual([]);
    expect(scanPrivacy(privacyItemsFor("openwiki/.claims/a.json", sidecarWith(PRODUCTION_FILE_EVIDENCE_VERSION)))).toEqual([]);
  });

  it("a nonconforming version loses the exemption and is scanned like any string", () => {
    const hits: Hit[] = scanPrivacy(privacyItemsFor("openwiki/.claims/a.json", sidecarWith("private.person@corp.test")));
    expect(hits).toEqual([expect.objectContaining({ file: "openwiki/.claims/a.json", category: "email" })]);
  });

  it("a key named version anywhere but claims[i].evidence[j] is scanned, whatever it holds", () => {
    const hits: Hit[] = scanPrivacy(privacyItemsFor("openwiki/.claims/a.json", sidecarWith(RANGE, { version: "private.person@corp.test", verification: { by: "openwiki/0.6.1", version: "zz.other@corp.test" } })));
    expect(hits.map((h) => h.category)).toEqual(["email", "email"]);
  });

  it("checkProvenance rejects a nonconforming version as invalid Claim state, naming the changed path and never the value", () => {
    const root = makeTmp("evidence");
    write(root, "openwiki/.page-manifest.json", JSON.stringify({ schemaVersion: 1, pages: {} }));
    write(root, "openwiki/a.md", "# A\n");
    stampProvenance(root, ["openwiki/a.md"]);
    const sidecar = JSON.parse(read(root, "openwiki/.claims/a.json"));
    const pagesOf = () => JSON.parse(read(root, "openwiki/.page-manifest.json")).pages;
    sidecar.claims[0].evidence = [{ resource: "repo://lib/a.ts#L1-L2", version: RANGE }];
    write(root, "openwiki/.claims/a.json", JSON.stringify(sidecar));
    expect(checkProvenance(root, [{ status: "M", path: "openwiki/a.md" }], pagesOf())).toEqual([]);
    sidecar.claims[0].evidence = [{ resource: "repo://lib/a.ts#L1-L2", version: "private.person@corp.test" }];
    write(root, "openwiki/.claims/a.json", JSON.stringify(sidecar));
    const problems = checkProvenance(root, [{ status: "M", path: "openwiki/a.md" }], pagesOf());
    expect(problems).toEqual([{ file: "openwiki/a.md", problem: "evidence-version-invalid" }]);
    expect(JSON.stringify(problems)).not.toContain("private.person");
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

  it("reads tenant slugs from the register table only, and says whether the register exists at all", () => {
    expect(parseTenantRegister("# State\n\n## 1. Other\n| demo-studio | x |\n")).toEqual({ found: false, slugs: [] });
    expect(parseTenantRegister("## 0. Tenant register\n\nmoved\n")).toEqual({ found: true, slugs: [] });
  });

  it("reads tenant slugs from the register table only", () => {
    const text = "## 0. Tenant register\n\n| Studio | Class |\n|---|---|\n| **demo-studio** | x |\n| Totals | 2 |\n\n## 1. Other\n| not-a-tenant | y |\n";
    expect(loadTenantSlugs(text)).toEqual(["demo-studio"]);
  });

  it("scans Claim statements and evidence paths, not a valid OpenWiki evidence version", () => {
    const sidecar = JSON.stringify({
      claims: [{ statement: "Clean statement.", evidence: [{ resource: "repo://lib/a.ts#L1-L2", version: PRODUCTION_RANGE_EVIDENCE_VERSION }] }],
    });
    const items = privacyItemsFor("openwiki/.claims/x.json", sidecar);
    expect(scanPrivacy(items)).toEqual([]);
    expect(privacyItemsFor("openwiki/.page-manifest.json", "{}")).toEqual([]);
  });
});

describe("the path gate: every changed path is classified before any is recorded", () => {
  const terms = { denylistTerms: parseDenylist("Synthetic Person\n"), tenantSlugs: ["synthetic-studio-one"] };

  it("covers every change kind (generated, side effect, unexpected) and status (A, M, D, T)", () => {
    const gate = gateChangedPaths(
      [
        { status: "A", path: "openwiki/people/synthetic-person.md" }, // generated, added
        { status: "D", path: "openwiki/old/synthetic-studio-one.md" }, // generated, deleted
        { status: "M", path: "docs/Synthetic-Person.md" }, // unexpected, modified
        { status: "T", path: "lib/synthetic-studio-one" }, // unexpected, type change
        { status: "M", path: "AGENTS.md" }, // known side effect
        { status: "M", path: "openwiki/topics/booking.md" },
      ],
      terms,
    );
    expect(gate).toEqual({
      scanned: 6,
      rejected: 4,
      categories: ["denylist-term", "tenant-slug"],
      cleared: new Set(["AGENTS.md", "openwiki/topics/booking.md"]),
    });
  });

  it("reads a path as written and humanized, so a hyphenated or snake_case name still matches", () => {
    for (const p of ["people/synthetic-person.md", "people/synthetic_person.md", "people/Synthetic.Person.md", "people/SYNTHETIC-PERSON/x.md"]) {
      expect(gateChangedPaths([{ status: "A", path: p }], terms).categories, p).toEqual(["denylist-term"]);
    }
    expect(gateChangedPaths([{ status: "A", path: "people/syntheticperson.md" }], terms).rejected).toBe(0);
  });

  it.each([
    ["an email", "notes/zz.person@hone.example.org.md", "email"],
    ["a UUID", "data/123e4567-e89b-42d3-a456-426614174000.json", "uuid"],
    ["a credential shape", "keys/ghp_ABCDEFGHIJKLMNOPQRSTUVWX.txt", "github-token"],
    ["whitespace", "docs/two words.md", "unsafe-path-format"],
    ["a backtick", "docs/`x`.md", "unsafe-path-format"],
    ["a newline", "docs/a\nb.md", "unsafe-path-format"],
    ["a non-ASCII letter", "docs/caf\u00e9.md", "unsafe-path-format"],
    ["a non-canonical spelling", "./docs/a.md", "unsafe-path-format"],
  ])("rejects a path with %s, returning its category only", (_label: string, p: string, category: string) => {
    const gate = gateChangedPaths([{ status: "A", path: p }], terms);
    expect(gate.rejected).toBe(1);
    expect(gate.categories).toEqual([category]);
    expect(gate.cleared.size).toBe(0);
    expect(PATH_GATE_CATEGORIES).toContain(category);
  });

  it("clears the repository's own paths: every tracked path fits the reportable grammar", () => {
    const tracked = git(REPO_ROOT, ["ls-files", "-z"]).split("\0").filter(Boolean);
    const gate = gateChangedPaths(tracked.map((p: string) => ({ status: "M", path: p })), {});
    expect(gate.categories).not.toContain("unsafe-path-format");
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
    expect(checkCommitAuthors(fx.work, `${base}..HEAD`, fixtureIdentity)).toEqual({ commits: 1, mismatched: 0 });
    expect(checkCommitAuthors(fx.work, `${base}..HEAD`, { name: "hone-wiki-runner[bot]", email: "x@example.com" })).toEqual({ commits: 1, mismatched: 1 });
    expect(checkCommitAuthors(fx.work, `${base}..${base}`, fixtureIdentity)).toEqual({ commits: 0, mismatched: 0 });
  });
});
