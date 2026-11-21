/* eslint-disable @typescript-eslint/no-explicit-any -- evidence is built raw on purpose */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { parseReviewEvidence } from "../../../scripts/eng/v2/adapter/internal/github/parse-review.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { REVIEW_POLICY, bindReviews } from "../../../scripts/eng/v2/adapter/internal/bind/review.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { decide } from "../../../scripts/eng/v2/decision/decide.mjs";

// ===========================================================================
// REVIEW-RECEIPT-01. Since 25 Oct 2026 every Codex clean verdict begins with a receipt header,
// `<!-- codex-review-receipt:v1 -->` and a blank line, before the clean text (483 of 483 verdicts,
// 25 Oct-19 Nov). Channel B required the body to BEGIN with the clean text, so it dropped all of them
// and the shepherd answered REVIEW_MISSING on every clean head.
//
// Fixtures review-1612.json and review-1613.json are the shepherd's own GraphQL query, recorded
// 2026-11-19. Every Codex and operator comment is byte-exact; only the Vercel bot's deployment comment
// body is redacted, because review binding never reads it. Synthetic edits below are marked.
// Each case runs the REAL parser and binder and then the REAL decision, so trust stays 05B's.
// ===========================================================================

const F = path.join(__dirname, "fixtures/review");
const load = (n: number) => JSON.parse(readFileSync(path.join(F, `review-${n}.json`), "utf8"));
const ok = (r: any) => {
  if (!r.ok) throw new Error(`did not parse: ${r.reason} ${r.detail}`);
  return r.record ?? r.value;
};
const okv = (value: any) => ({ ok: true, value });
const HEAD_1612 = "30945a2666fb9f129270f93a6241fc9a1c209b1e"; // final head; earlier verdicts name 804702fff8 and 9980fa0ab1
const HEAD_1613 = "e514b4ffe198eabfe8d482960f1e0dc3cb9b8792";
const CODEX = { __typename: "Bot", login: "chatgpt-codex-connector", databaseId: 199175422 };
const key = (prNumber: number, headSha: string) => ({
  prNumber, state: "OPEN", isDraft: false, headSha, headRef: "feat/x", headRepoId: 1240764106,
  baseRef: "claude/build-hone-saas-hOex7", baseRepoId: 1240764106, baseSha: "b".repeat(40),
});

function bound(pr: number, headSha: string, edit?: (raw: any) => void) {
  const raw = load(pr);
  edit?.(raw);
  return ok(bindReviews({ key: key(pr, headSha), evidence: ok(parseReviewEvidence(raw, { expectedNumber: pr })), policy: REVIEW_POLICY }));
}
/** The shepherd's decision with every other row green: only the review rows can stop candidacy. */
function decision(pr: number, headSha: string, edit?: (raw: any) => void): string {
  const evidence = {
    schema: "eng-loop-v1/evidence@1", observedAt: "t", key: key(pr, headSha), terminal: false,
    rows: {
      base: okv({ drift: { behindBy: 0, aheadBy: 1 }, files: [] }),
      ci: okv({ outcome: "SUCCEEDED", applicableRunIds: [1] }),
      external: okv({ external: [] }),
      reviews: okv(bound(pr, headSha, edit)),
    },
  };
  return decide({ ok: true, evidence }).decision;
}
const codexReceipts = (raw: any) =>
  raw.data.repository.pullRequest.comments.nodes.filter((c: any) => c.author?.databaseId === 199175422 && c.body.startsWith("<!-- codex-review-receipt:v1 -->"));
/** Synthetic: replace the body of the receipt verdict at `marker10`. */
const rewrite = (marker10: string, to: (body: string) => string) => (raw: any) => {
  const c = codexReceipts(raw).find((x: any) => x.body.includes(`\`${marker10}\``));
  if (!c) throw new Error(`no receipt verdict for ${marker10}`);
  c.body = to(c.body);
};
const pushComment = (body: string, author: object, lastEditedAt: string | null = null) => (raw: any) => {
  raw.data.repository.pullRequest.comments.nodes.push({ databaseId: 1, body, lastEditedAt, author });
  raw.data.repository.pullRequest.comments.totalCount += 1;
};

describe("REVIEW-RECEIPT-01: the recorded receipts are what this fix assumes", () => {
  it("every Codex clean verdict in both fixtures begins with the receipt header and a blank line, unedited", () => {
    const all = [...codexReceipts(load(1612)), ...codexReceipts(load(1613))];
    expect(all).toHaveLength(4);
    for (const c of all) {
      expect(c.body.startsWith("<!-- codex-review-receipt:v1 -->\n\nCodex Review: Didn't find any major issues.")).toBe(true);
      expect(c.lastEditedAt).toBeNull();
    }
  });
});

describe("REVIEW-RECEIPT-01: accepted", () => {
  it("#1613: the clean receipt from Codex at the exact head is a qualifying CLEAN_COMMENT, and the PR is a candidate", () => {
    const v = bound(1613, HEAD_1613);
    const clean = v.reviews.filter((r: any) => r.channel === "CLEAN_COMMENT");
    expect(clean).toHaveLength(1);
    expect(clean[0]).toMatchObject({ actor: { id: 199175422, type: "Bot" }, verdict: "CLEAN", qualifiesAtHead: true });
    expect(decision(1613, HEAD_1613)).toBe("CANDIDATE_READY_FOR_HUMAN_REVIEW");
  });

  it("#1612: of three receipt verdicts, only the one naming the final head qualifies", () => {
    const v = bound(1612, HEAD_1612);
    const clean = v.reviews.filter((r: any) => r.channel === "CLEAN_COMMENT");
    expect(clean).toHaveLength(3);
    expect(clean.filter((r: any) => r.qualifiesAtHead)).toHaveLength(1);
    expect(decision(1612, HEAD_1612)).toBe("CANDIDATE_READY_FOR_HUMAN_REVIEW");
  });

  it("a verdict without the receipt header still works exactly as before", () => {
    const d = decision(1613, HEAD_1613, rewrite("e514b4ffe1", (b) => b.replace("<!-- codex-review-receipt:v1 -->\n\n", "")));
    expect(d).toBe("CANDIDATE_READY_FOR_HUMAN_REVIEW");
  });
});

describe("REVIEW-RECEIPT-01: rejected", () => {
  it("stale: a head pushed after every verdict has no review (#1612's three real verdicts all name older heads)", () => {
    const newer = "d".repeat(40);
    expect(bound(1612, newer).reviews.filter((r: any) => r.qualifiesAtHead)).toHaveLength(0);
    expect(decision(1612, newer)).toBe("REVIEW_MISSING");
  });

  it("stale: without the verdict for the final head, the two earlier real verdicts do not stand in for it", () => {
    const dropFinal = (raw: any) => {
      const nodes = raw.data.repository.pullRequest.comments.nodes;
      const i = nodes.findIndex((c: any) => c.body.includes("`30945a2666`") && c.body.startsWith("<!-- codex-review-receipt"));
      nodes.splice(i, 1);
      raw.data.repository.pullRequest.comments.totalCount -= 1;
    };
    expect(decision(1612, HEAD_1612, dropFinal)).toBe("REVIEW_MISSING");
  });

  it("untrusted: the same receipt body from the operator, from a stranger, or from Codex's id as a User establishes nothing", () => {
    const body = codexReceipts(load(1613))[0].body;
    for (const author of [
      { __typename: "User", login: "SaiSamyukthVemuri", databaseId: 26781116 },
      { __typename: "User", login: "someone", databaseId: 5 },
      { __typename: "User", login: "chatgpt-codex-connector", databaseId: 199175422 },
    ]) {
      const drop = (raw: any) => {
        const nodes = raw.data.repository.pullRequest.comments.nodes;
        raw.data.repository.pullRequest.comments.nodes = nodes.filter((c: any) => !c.body.startsWith("<!-- codex-review-receipt"));
        raw.data.repository.pullRequest.comments.totalCount = raw.data.repository.pullRequest.comments.nodes.length;
        pushComment(body, author)(raw);
      };
      expect(decision(1613, HEAD_1613, drop), author.login).toBe("REVIEW_MISSING");
    }
  });

  it("edited: a receipt verdict someone edited never qualifies (R4-EDIT), whatever it says", () => {
    const edited = (raw: any) => { codexReceipts(raw)[0].lastEditedAt = "2026-11-19T00:00:00Z"; };
    expect(bound(1613, HEAD_1613, edited).reviews.find((r: any) => r.channel === "CLEAN_COMMENT")?.qualifiesAtHead).toBe(false);
    expect(decision(1613, HEAD_1613, edited)).toBe("REVIEW_MISSING");
  });

  it("malformed header: only the exact v1 header, once, at the very start, followed by one blank line", () => {
    const H = "<!-- codex-review-receipt:v1 -->\n\n";
    const variants: Array<[string, (b: string) => string]> = [
      ["another version", (b) => b.replace(H, "<!-- codex-review-receipt:v2 -->\n\n")],
      ["the header twice", (b) => H + b],
      ["no blank line", (b) => b.replace(H, "<!-- codex-review-receipt:v1 -->\n")],
      ["CRLF line ends", (b) => b.replace(H, "<!-- codex-review-receipt:v1 -->\r\n\r\n")],
      ["text before the header", (b) => `note\n${b}`],
      ["leading whitespace", (b) => ` ${b}`],
      ["any other HTML comment", (b) => b.replace(H, "<!-- codex-pull-request-review-summary -->\n\n")],
    ];
    for (const [name, to] of variants) {
      const v = bound(1613, HEAD_1613, rewrite("e514b4ffe1", to));
      expect(v.reviews.filter((r: any) => r.channel === "CLEAN_COMMENT"), name).toHaveLength(0);
      expect(decision(1613, HEAD_1613, rewrite("e514b4ffe1", to)), name).toBe("REVIEW_MISSING");
    }
  });

  it("malformed marker: after a valid header, two markers, a 7-hex or an upper-case marker never qualify", () => {
    const m = "**Reviewed commit:** `e514b4ffe1`";
    for (const [name, to] of [
      ["two markers", (b: string) => b.replace(m, `${m} ${m}`)],
      ["7-hex", (b: string) => b.replace(m, "**Reviewed commit:** `e514b4f`")],
      ["upper case", (b: string) => b.replace(m, "**Reviewed commit:** `E514B4FFE1`")],
    ] as Array<[string, (b: string) => string]>) {
      expect(decision(1613, HEAD_1613, rewrite("e514b4ffe1", to)), name).toBe("REVIEW_MISSING");
    }
  });

  it("non-clean: a receipt header over any other text is not a clean verdict, and Codex's running summary never is", () => {
    const notClean = rewrite("e514b4ffe1", (b) => b.replace("Codex Review: Didn't find any major issues.", "Codex Review: Here are some automated review suggestions for this pull request."));
    expect(bound(1613, HEAD_1613, notClean).reviews.filter((r: any) => r.channel === "CLEAN_COMMENT")).toHaveLength(0);
    expect(decision(1613, HEAD_1613, notClean)).toBe("REVIEW_MISSING");
    // The real summary comment names the head in its state JSON and says "Completed", and stays inert.
    const summary = load(1613).data.repository.pullRequest.comments.nodes.find((c: any) => c.body.startsWith("<!-- codex-pull-request-review-summary -->"));
    expect(summary.body).toContain(HEAD_1613);
    expect(bound(1613, HEAD_1613).reviews.map((r: any) => r.id)).not.toContain(summary.databaseId);
  });

  it("a clean receipt pushed as a NEW comment by Codex for an older head stays stale", () => {
    const body = codexReceipts(load(1612)).find((c: any) => c.body.includes("`804702fff8`")).body;
    expect(decision(1613, HEAD_1613, (raw: any) => {
      raw.data.repository.pullRequest.comments.nodes = raw.data.repository.pullRequest.comments.nodes.filter((c: any) => !c.body.startsWith("<!-- codex-review-receipt"));
      raw.data.repository.pullRequest.comments.totalCount = raw.data.repository.pullRequest.comments.nodes.length;
      pushComment(body, CODEX)(raw);
    })).toBe("REVIEW_MISSING");
  });
});
