import { describe, expect, it } from "vitest";
import {
  CodedError,
  REASONS,
  nightlyBranchName,
  persistableReport,
  renderPublishText,
  renderReasons,
  renderReviewRequest,
  // @ts-expect-error - .mjs utility ships without type declarations
} from "../../scripts/openwiki/report.mjs";

// WIKI-AUTO-01, #786 architecture review of 2ba37643: report.mjs is the one
// sink. These tests treat it as an API and attack it directly. They show
// that no caller can get a raw untrusted string into a persisted report or
// into publish text, whatever field it uses.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Report = Record<string, any>;

/** Strings that must never survive into a report: names, slugs, contact details, credentials, paths, markup, shell. */
const HOSTILE = [
  "Synthetic Person",
  "synthetic-studio-one",
  "zz.unique.person@hone.example.org",
  "ghs_UniqueTokenValue0123456789abcdef",
  "docs/Synthetic-Person.md",
  "openwiki/nightly-synthetic-person",
  "`$(touch pwned)` <b>x</b>",
  "multi\nline",
];

function leaks(value: unknown): string[] {
  const text = JSON.stringify(value).toLowerCase();
  return HOSTILE.filter((h) => text.includes(h.toLowerCase()));
}

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

describe("the reporting API refuses free text", () => {
  it.each(HOSTILE)("free text as the reason (%j) becomes REPORT_REASON_REJECTED, counted, never persisted", (text: string) => {
    const report: Report = persistableReport({ reasons: text });
    expect(report).toMatchObject({ outcome: "FAILED", reasonCode: "REPORT_REASON_REJECTED", withheld: 1 });
    expect(leaks(report)).toEqual([]);
  });

  it.each([
    ["an unknown code", { code: "SYNTHETIC_PERSON" }],
    ["an inherited key posing as a code", { code: "toString" }],
    ["an Error", new Error("Synthetic Person")],
    ["a message-shaped object", { message: "Synthetic Person", code: undefined }],
    ["an empty list", []],
    ["nothing at all", undefined],
  ])("%s is rejected", (_label: string, reasons: unknown) => {
    const report: Report = persistableReport({ reasons });
    expect(report.reasonCode).toBe("REPORT_REASON_REJECTED");
    expect(report.reason).toBe("the runner tried to report a reason outside its closed catalog; withheld");
    expect(leaks(report)).toEqual([]);
  });

  it("a caller's outcome, reason text and counters are ignored: the sink derives them", () => {
    const report: Report = persistableReport({
      reasons: { code: "WIKI_LIVE", details: { gitHead: SHA_A } },
      outcome: "PUBLISHED",
      reasonCode: "PULL_REQUEST_OPENED",
      reason: "Synthetic Person",
      safeDetails: { number: 7 },
      withheld: 0,
    });
    expect(report).toMatchObject({ outcome: "NOOP", reasonCode: "WIKI_LIVE", reason: "wiki is live: no source change after its recorded gitHead", safeDetails: { gitHead: SHA_A } });
    expect(leaks(report)).toEqual([]);
  });

  it("FAMILY: every detail field of every catalog reason withholds every hostile string, alone or in a list", () => {
    let probes = 0;
    for (const [code, entry] of Object.entries(REASONS as Record<string, { details: Record<string, unknown> }>)) {
      for (const field of Object.keys(entry.details)) {
        for (const hostile of HOSTILE) {
          for (const value of [hostile, [hostile], { nested: hostile }]) {
            const report: Report = persistableReport({ reasons: { code, details: { [field]: value } } });
            expect(report.reasonCode).toBe(code);
            expect(report.withheld, `${code}.${field}`).toBe(1);
            expect(leaks(report), `${code}.${field}`).toEqual([]);
            probes += 1;
          }
        }
      }
    }
    expect(probes).toBeGreaterThan(500);
  });

  it("FAMILY: an unknown detail field is dropped, whatever it holds", () => {
    for (const code of Object.keys(REASONS)) {
      const report: Report = persistableReport({ reasons: { code, details: { note: HOSTILE[0], [HOSTILE[1]]: 1 } } });
      expect(report.withheld, code).toBe(2);
      expect(leaks(report), code).toEqual([]);
    }
  });
});

describe("the report schema is closed", () => {
  /** Every string-bearing position of the report, as a path into the object. */
  const POSITIONS: Array<Array<string | number>> = [
    ["runId"],
    ["startedAt"],
    ["finishedAt"],
    ["tip"],
    ["sourceHead"],
    ["skippedGeneratedCommits"],
    ["metadataOnly"],
    ["liveness", "state"],
    ["liveness", "gitHead"],
    ["liveness", "note"],
    ["liveness", "problem"],
    ["pathGate", "scanned"],
    ["pathGate", "categories", 0],
    ["generator", "exitCode"],
    ["generator", "outputSha256"],
    ["generator", "retryReason"],
    ["generated", "changed"],
    ["discarded", 0, "path"],
    ["discarded", 0, "status"],
    ["discarded", 0, "kind"],
    ["discarded", 0, "reasonCode"],
    ["discarded", 0, "workflowInspection", 0],
    ["checks", "lastUpdate", 0],
    ["checks", "manifest", 0],
    ["checks", "brokenLinkStamps", 0, "file"],
    ["checks", "conflictMarkers", 0, "line"],
    ["checks", "provenance", 0, "file"],
    ["checks", "provenance", 0, "problem"],
    ["checks", "privacyHits", 0, "file"],
    ["checks", "privacyHits", 0, "category"],
    ["publish", "branch"],
    ["publish", "head"],
    ["publish", "pr", "number"],
    ["publish", "failure"],
    ["publish", "cleanup", "pullRequest"],
    ["publish", "cleanup", "branch"],
    ["anUnknownField"],
    ["checks", "anUnknownCheck"],
    ["publish", "pr", "url"],
  ];

  function place(position: Array<string | number>, value: unknown): Report {
    const root: Report = {};
    let node: Report = root;
    position.forEach((key, index) => {
      const last = index === position.length - 1;
      const next = position[index + 1];
      node[key] = last ? value : typeof next === "number" ? [] : {};
      node = node[key];
    });
    return root;
  }

  it.each(POSITIONS.map((p) => [p.join(".")] as [string]))("FAMILY: %s withholds every hostile string", (joined: string) => {
    const position = POSITIONS.find((p) => p.join(".") === joined)!;
    for (const hostile of HOSTILE) {
      const report: Report = persistableReport({ ...place(position, hostile), reasons: { code: "KILL_SWITCH" } }, { clearedPaths: new Set(["openwiki/a.md"]) });
      expect(report.withheld, joined).toBeGreaterThan(0);
      expect(leaks(report), joined).toEqual([]);
    }
  });

  it("generator.retryReason keeps exactly the two retry reasons, and nothing else", () => {
    for (const retryReason of ["generator_exit_nonzero", "interrupted_generation"]) {
      const report: Report = persistableReport({ generator: { attempts: 2, retried: true, retryReason }, reasons: { code: "KILL_SWITCH" } });
      expect(report.withheld, retryReason).toBe(0);
      expect(report.generator.retryReason).toBe(retryReason);
    }
    const report: Report = persistableReport({ generator: { attempts: 2, retried: true, retryReason: "LAST_UPDATE_INVALID" }, reasons: { code: "KILL_SWITCH" } });
    expect(report.withheld).toBe(1);
    expect(report.generator.retryReason).toBeUndefined();
  });

  it("a pathname is kept only if this run's gate cleared it, or it is the runner's own", () => {
    const raw = {
      reasons: { code: "UNEXPECTED_GENERATOR_WRITE", details: { paths: 3 } },
      discarded: [
        { path: "lib/feature.ts", status: "M", kind: "source", reasonCode: "UNEXPECTED_WRITE" },
        { path: "docs/never-cleared.md", status: "A", kind: "source", reasonCode: "UNEXPECTED_WRITE" },
        { path: "AGENTS.md", status: "M", kind: "ignored", reasonCode: "KNOWN_SIDE_EFFECT" },
      ],
    };
    const report: Report = persistableReport(raw, { clearedPaths: new Set(["lib/feature.ts"]) });
    expect(report.discarded).toEqual([
      { path: "lib/feature.ts", status: "M", kind: "source", reasonCode: "UNEXPECTED_WRITE", reason: "unexpected generator write outside the generated scope" },
      { status: "A", kind: "source", reasonCode: "UNEXPECTED_WRITE", reason: "unexpected generator write outside the generated scope" },
      { path: "AGENTS.md", status: "M", kind: "ignored", reasonCode: "KNOWN_SIDE_EFFECT", reason: "known OpenWiki side effect outside the generated scope" },
    ]);
    expect(report.withheld).toBe(1);
  });

  it.each([
    ["publish.branch in the runner's format", { publish: { branch: "openwiki/nightly-20261005-abcdef0" } }, 0],
    ["a branch outside it", { publish: { branch: "openwiki/nightly-20261005-abcdef0-extra" } }, 1],
    ["a full SHA", { tip: SHA_A }, 0],
    ["an abbreviated SHA", { tip: "abcdef0" }, 1],
    ["an uppercase SHA", { tip: SHA_A.toUpperCase() }, 1],
    ["a PR number", { publish: { pr: { number: 7 } } }, 0],
    ["a PR number as a string", { publish: { pr: { number: "7" } } }, 1],
    ["a PR number of zero", { publish: { pr: { number: 0 } } }, 1],
    ["a fractional PR number", { publish: { pr: { number: 7.5 } } }, 1],
  ])("identifiers: %s", (_label: string, raw: Report, withheld: number) => {
    expect(persistableReport({ ...raw, reasons: { code: "KILL_SWITCH" } }).withheld).toBe(withheld);
  });

  it("is idempotent: the sink's own output passes through it unchanged", () => {
    const first: Report = persistableReport(
      {
        runId: "123e4567-e89b-42d3-a456-426614174000",
        startedAt: "2026-10-05T03:30:00.000Z",
        finishedAt: "2026-10-05T03:31:00.000Z",
        tip: SHA_A,
        sourceHead: SHA_B,
        reasons: [
          { code: "CONFLICT_MARKERS", details: { count: 1 } },
          { code: "CONTENT_PRIVACY_HITS", details: { hits: 1, categories: ["email"] } },
        ],
        checks: { conflictMarkers: [{ file: "openwiki/a.md", line: 3 }], privacyHits: [{ file: "openwiki/a.md", line: 2, category: "email" }] },
        discarded: [{ path: "AGENTS.md", status: "M", kind: "ignored", reasonCode: "KNOWN_SIDE_EFFECT" }],
      },
      { clearedPaths: new Set(["openwiki/a.md"]) },
    );
    expect(first.withheld).toBe(0);
    expect(first.additionalReasons).toEqual([{ reasonCode: "CONTENT_PRIVACY_HITS", safeDetails: { hits: 1, categories: ["email"] } }]);
    expect(persistableReport(first, { clearedPaths: new Set(["openwiki/a.md"]) })).toEqual(first);
  });
});

describe("the catalog renders every reason from its codes alone", () => {
  it("every reason has an outcome the CLI knows, and renders with no details at all", () => {
    for (const [code, entry] of Object.entries(REASONS as Record<string, { outcome: string }>)) {
      expect(["SKIP", "NOOP", "DRY_RUN", "PUBLISHED", "FAILED", "PRECONDITION"], code).toContain(entry.outcome);
      const text = renderReasons({ code });
      expect(text.length, code).toBeGreaterThan(10);
      expect(text, code).not.toMatch(/undefined|\[object|NaN/u);
    }
  });

  it("several reasons render in order, joined", () => {
    expect(
      renderReasons([
        { code: "REQUIRED_ENV_MISSING", details: { name: "HONE_WIKI_STATE_DIR" } },
        { code: "FORBIDDEN_ENV_PRESENT", details: { name: "GH_TOKEN" } },
      ]),
    ).toBe("required HONE_WIKI_STATE_DIR is not set; forbidden GH_TOKEN is set");
  });
});

describe("publish text is built from validated values only", () => {
  const base = {
    sourceHead: SHA_A,
    tip: SHA_B,
    previousGitHead: SHA_C,
    generated: { changed: 2, added: 1, modified: 1, deleted: 0 },
    metadataOnly: false,
    discarded: [{ path: "AGENTS.md", status: "M", kind: "ignored", reasonCode: "KNOWN_SIDE_EFFECT" }],
  };

  it("renders the title, body and commit message", () => {
    const text = renderPublishText(base);
    expect(text.title).toBe(`docs(openwiki): nightly update at source ${SHA_A.slice(0, 7)}`);
    expect(text.body).toContain(`- Source head documented: \`${SHA_A}\``);
    expect(text.body).toContain("- Discarded generator writes: `AGENTS.md` (known OpenWiki side effect outside the generated scope)");
    expect(text.commitBody).toBe(`Generated by the WIKI-AUTO-01 runner from production source ${SHA_A} (production tip ${SHA_B}). Only generated openwiki/ files change.`);
    expect(renderPublishText({ ...base, metadataOnly: true }).title).toBe(`docs(openwiki): record source ${SHA_A.slice(0, 7)} (metadata only)`);
  });

  it.each([
    ["a source head that is not a SHA", { sourceHead: "Synthetic Person" }],
    ["a previous gitHead that is not a SHA", { previousGitHead: "docs/Synthetic-Person.md" }],
    ["a count that is text", { generated: { ...base.generated, changed: "Synthetic Person" } }],
    ["an extra summary field", { generated: { ...base.generated, note: "Synthetic Person" } }],
    ["a discarded path the gate never cleared", { discarded: [{ path: "docs/Synthetic-Person.md", status: "A", kind: "source", reasonCode: "UNEXPECTED_WRITE" }] }],
    ["a discarded entry with an unknown reason", { discarded: [{ path: "AGENTS.md", status: "M", kind: "ignored", reasonCode: "Synthetic Person" }] }],
  ])("refuses %s: the publish stops, nothing is interpolated", (_label: string, override: Report) => {
    const attempt = () => renderPublishText({ ...base, ...override });
    expect(attempt).toThrow(CodedError);
    expect(attempt).toThrow(expect.objectContaining({ reasonCode: "PUBLISH_CHECK_FAILED", safeDetails: { check: "publish-text-invalid" }, message: "PUBLISH_CHECK_FAILED" }));
  });

  it("the review request quotes a validated head only", () => {
    expect(renderReviewRequest(SHA_A)).toBe(`@codex review\n\nExact head \`${SHA_A}\`.`);
    expect(() => renderReviewRequest("Synthetic Person")).toThrow(expect.objectContaining({ reasonCode: "PUBLISH_CHECK_FAILED" }));
  });

  it("the nightly branch name is the runner's own format or nothing", () => {
    expect(nightlyBranchName(Date.UTC(2026, 9, 5), SHA_A)).toBe(`openwiki/nightly-20261005-${SHA_A.slice(0, 7)}`);
    expect(() => nightlyBranchName(Date.UTC(2026, 9, 5), "synthetic-person")).toThrow(expect.objectContaining({ safeDetails: { check: "branch-name-invalid" } }));
  });
});
