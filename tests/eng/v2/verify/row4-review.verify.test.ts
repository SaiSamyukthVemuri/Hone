/* eslint-disable @typescript-eslint/no-explicit-any -- the verifier feeds raw, untyped GraphQL answers on purpose */
import { describe, expect, it } from "vitest";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { parsePrKey } from "../../../../scripts/eng/v2/contract/pr-key.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { isUnknownReason } from "../../../../scripts/eng/v2/contract/reasons.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { parseReviewEvidence } from "../../../../scripts/eng/v2/adapter/internal/github/parse-review.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { REVIEW_POLICY, bindReviews } from "../../../../scripts/eng/v2/adapter/internal/bind/review.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { parseRollup } from "../../../../scripts/eng/v2/adapter/internal/github/parse-rollup.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { bindExternal } from "../../../../scripts/eng/v2/adapter/internal/bind/external.mjs";
import { canon, clone, deepFreeze, isDeepFrozen, noThrow, permuteKeys } from "./support/deep";
import { exactFieldMutations, purityViolations } from "./support/parser-props";
import { rng } from "./support/prng";
import {
  CLEAN_COMMENT_809,
  CLEAN_PREFIX,
  CODEX_ID,
  H809,
  OPERATOR_ID,
  REVIEW_ROWS,
  artifactSummary,
  checkReview,
  evaluateReview,
  keyAt,
  reviewAnswer,
  type Impl456,
} from "./support/rows456";
import { budgetGuard } from "./support/budgets";

// ===========================================================================
// INDEPENDENT VERIFIER — ENG-LOOP V1 05A rows 4-5: trusted review provenance and
// review threads. Oracle: SPEC-05A §0, §4.1, §4.2 (203ed1f4, amended f75ca255 and 63bd3b6e); ARCH-01 §17-§22, §24
// (05A computes qualifiesAtHead and carries identities; trust is 05B's); CAP-01 §17.
// ===========================================================================

const IMPL: Impl456 = { parsePrKey, parseReviewEvidence, bindReviews, parseRollup, bindExternal, policy: REVIEW_POLICY };
const failsWith = (r: any, reasons: string[], label = "") => {
  expect(r?.ok, `${label} should fail closed`).toBe(false);
  expect(reasons, `${label}: got ${JSON.stringify(r?.reason)}`).toContain(r?.reason);
  expect(isUnknownReason(r?.reason)).toBe(true);
};

describe("rows 4-5 verify: 05A's review policy is the spec's (§4.2, amended 63bd3b6e)", () => {
  // §4.2: "`policy` is required and is exactly `{ cleanPrefix }`, a non-empty string; the collector passes
  // `{ cleanPrefix: \"Codex Review: Didn't find any major issues.\" }` … Whom to trust — the Codex bot and the human
  // resolvers — is 05B's policy (SPEC-05B §3), never 05A's." The ids (Codex 199175422, resolver 26781116) are 05B's.
  it("REVIEW_POLICY is exactly { cleanPrefix } with the §4.2 prefix, frozen, and carries no trust ids", () => {
    expect(REVIEW_POLICY).toEqual({ cleanPrefix: CLEAN_PREFIX });
    expect(Object.keys(REVIEW_POLICY)).toEqual(["cleanPrefix"]);
    expect(Object.isFrozen(REVIEW_POLICY)).toBe(true);
    expect(JSON.stringify(REVIEW_POLICY)).not.toContain(String(CODEX_ID));
    expect(JSON.stringify(REVIEW_POLICY)).not.toContain(String(OPERATOR_ID));
  });
});

describe("rows 4-5 verify: review evidence table (real answers and synthetic edits)", () => {
  for (const row of REVIEW_ROWS) {
    it(`${row.id}: ${row.title} — ${row.source} [${row.clause}]`, () => {
      const why = checkReview(row, evaluateReview(row, IMPL));
      expect(why, why).toBe("");
    });
  }
});

describe("rows 4-5 verify: parseReviewEvidence properties (§0, §4.1)", () => {
  it("logins never enter the record: every author, resolver and opener is exactly { id, type } or null", () => {
    // Bodies are kept verbatim and may mention a user (the real Vercel comment links ?owner=<login>);
    // the rule is about actor identity fields, which must never carry a login.
    for (const n of [800, 809, 776] as const) {
      const r = parseReviewEvidence(reviewAnswer(n), { expectedNumber: n });
      expect(r.ok, `#${n}`).toBe(true);
      const actors = [
        ...r.record.reviews.map((x: any) => x.author),
        ...r.record.comments.map((x: any) => x.author),
        ...r.record.threads.flatMap((t: any) => [t.opener, t.resolver]),
      ];
      for (const a of actors) if (a !== null) expect(Object.keys(a).sort(), `#${n}`).toEqual(["id", "type"]);
      expect(canon(r.record).includes('"login"'), `#${n}: a login key`).toBe(false);
    }
  });

  it("canonical order: reviews, comments and threads in any order give the identical record (SPEC §0, CAP-01 L7)", () => {
    const r = rng(0x4e1);
    for (const n of [800, 809] as const) {
      const want = canon(parseReviewEvidence(reviewAnswer(n), { expectedNumber: n }));
      for (let k = 0; k < 8; k++) {
        const raw = reviewAnswer(n);
        const p = raw.data.repository.pullRequest;
        p.reviews.nodes = r.shuffle(p.reviews.nodes);
        p.comments.nodes = r.shuffle(p.comments.nodes);
        p.reviewThreads.nodes = r.shuffle(p.reviewThreads.nodes);
        expect(canon(parseReviewEvidence(permuteKeys(raw, r), { expectedNumber: n })), `#${n} shuffle ${k}`).toBe(want);
      }
    }
  });

  it("reviews and comments come out sorted by id", () => {
    const rec = parseReviewEvidence(reviewAnswer(800), { expectedNumber: 800 }).record;
    const ids = (xs: any[]) => xs.map((x) => x.id);
    expect(ids(rec.reviews)).toEqual([...ids(rec.reviews)].sort((a, b) => a - b));
    expect(ids(rec.comments)).toEqual([...ids(rec.comments)].sort((a, b) => a - b));
  });

  it("GraphQL exact fields at every level of a real answer: a missing or an extra field is malformed", () => {
    const muts = exactFieldMutations(reviewAnswer(809));
    expect(muts.length).toBeGreaterThan(40);
    for (const m of muts) {
      const out = noThrow(() => parseReviewEvidence(m.raw, { expectedNumber: 809 }));
      expect(out.threw, `${m.label}: threw`).toBe(false);
      // a missing `author` / `resolvedBy` / `commit` key is still a missing field, never a deleted actor
      const envelope = ["repository", "pullRequest"].includes(m.deletedKey ?? "");
      failsWith((out as any).value, envelope ? ["malformed", "read_failed"] : ["malformed"], m.label);
    }
  });

  it("is pure and returns a deeply frozen record", () => {
    expect(purityViolations(parseReviewEvidence, reviewAnswer(809), { expectedNumber: 809 })).toEqual([]);
  });

  it("exotic input is malformed and never throws (§0)", () => {
    const hostile = new Proxy({}, { get: () => { throw new Error("get"); }, ownKeys: () => { throw new Error("keys"); } });
    const getter = Object.defineProperty({}, "data", { enumerable: true, get: () => { throw new Error("getter"); } });
    for (const [label, raw, params] of [
      ["proxy", hostile, { expectedNumber: 809 }],
      ["throwing getter", getter, { expectedNumber: 809 }],
      ["null options", reviewAnswer(809), null],
      ["a string", "x", { expectedNumber: 809 }],
    ] as const) {
      const out = noThrow(() => parseReviewEvidence(raw, params));
      expect(out.threw, label).toBe(false);
      failsWith((out as any).value, ["malformed"], label);
    }
  });
});

describe("rows 4-5 verify: bindReviews properties (§4.2; ARCH-01 §24)", () => {
  const evidence = (n: 800 | 809) => parseReviewEvidence(reviewAnswer(n), { expectedNumber: n }).record;

  it("trust is 05B's: 05A takes no trust input — a policy extended with a Codex id, resolvers or review states is malformed", () => {
    for (const [n, head] of [
      [809, H809],
      [800, "fe62f51f0fd95fc97d2e21eef71d179e2e701358"],
    ] as const) {
      const key = keyAt(IMPL, n, head);
      expect(bindReviews({ key, evidence: evidence(n), policy: REVIEW_POLICY }).ok, `#${n}`).toBe(true);
      for (const extra of [{ codex: { id: CODEX_ID, type: "Bot" } }, { humanResolvers: [{ id: OPERATOR_ID, type: "User" }] }, { acceptedReviewStates: ["COMMENTED"] }]) {
        const v = bindReviews({ key, evidence: evidence(n), policy: { ...REVIEW_POLICY, ...extra } });
        expect(v, `#${n} ${Object.keys(extra)[0]}`).toMatchObject({ ok: false, reason: "malformed" });
      }
    }
  });

  it("trust is 05B's: every actor's artifact is emitted with its identity, whoever it is (05A never filters by actor)", () => {
    const v = bindReviews({ key: keyAt(IMPL, 809, H809), evidence: evidence(809), policy: REVIEW_POLICY });
    const actors = new Set(artifactSummary(v.value).map((s: string) => s.split("|")[3]));
    expect([...actors].sort()).toEqual([`Bot:${CODEX_ID}`, `User:${OPERATOR_ID}`].sort());
  });

  it("the clean prefix is the POLICY's value, never a hard-coded string (ARCH-01 §21)", () => {
    const key = keyAt(IMPL, 809, H809);
    const other = { ...REVIEW_POLICY, cleanPrefix: "Codex says all clear." };
    const v = bindReviews({ key, evidence: evidence(809), policy: other });
    expect(v.ok).toBe(true);
    expect(artifactSummary(v.value).some((s) => s.includes("CLEAN_COMMENT"))).toBe(false);
    const raw = reviewAnswer(809);
    const c = raw.data.repository.pullRequest.comments.nodes.find((x: any) => x.databaseId === CLEAN_COMMENT_809);
    c.body = c.body.replace(CLEAN_PREFIX, "Codex says all clear.");
    const v2 = bindReviews({ key, evidence: parseReviewEvidence(raw, { expectedNumber: 809 }).record, policy: other });
    expect(artifactSummary(v2.value)).toContain(`${CLEAN_COMMENT_809}|CLEAN_COMMENT|CLEAN|Bot:${CODEX_ID}|true`);
  });

  // §0 "Binders check their inputs first … An input outside them — null, a partial key, a Map where a plain
  // object is specified, a missing flag — is malformed, never a pass"; §4.2 (63bd3b6e): "A missing, empty or
  // extended policy is malformed".
  const key809 = () => keyAt(IMPL, 809, H809);
  for (const [label, args] of [
    ["null arguments", () => null],
    ["undefined arguments", () => undefined],
    ["no policy", () => ({ key: key809(), evidence: evidence(809) })],
    ["policy undefined", () => ({ key: key809(), evidence: evidence(809), policy: undefined })],
    ["policy null", () => ({ key: key809(), evidence: evidence(809), policy: null })],
    ["an empty policy {}", () => ({ key: key809(), evidence: evidence(809), policy: {} })],
    ["an empty clean prefix", () => ({ key: key809(), evidence: evidence(809), policy: { cleanPrefix: "" } })],
    ["a clean prefix that is not a string", () => ({ key: key809(), evidence: evidence(809), policy: { cleanPrefix: 5 } })],
    ["a clean prefix in an array", () => ({ key: key809(), evidence: evidence(809), policy: { cleanPrefix: [CLEAN_PREFIX] } })],
    ["a policy that is a Map", () => ({ key: key809(), evidence: evidence(809), policy: new Map([["cleanPrefix", CLEAN_PREFIX]]) })],
    ["an extended policy (an unknown field)", () => ({ key: key809(), evidence: evidence(809), policy: { cleanPrefix: CLEAN_PREFIX, zz: 1 } })],
    ["no evidence", () => ({ key: key809(), policy: REVIEW_POLICY })],
    ["no key", () => ({ evidence: evidence(809), policy: REVIEW_POLICY })],
    ["a partial key", () => ({ key: { headSha: H809 }, evidence: evidence(809), policy: REVIEW_POLICY })],
    ["evidence of the wrong shape", () => ({ key: key809(), evidence: { reviews: "x" }, policy: REVIEW_POLICY })],
    ["evidence comments without the edited flag (the pre-f75ca255 record)", () => {
      const e = clone(evidence(809));
      for (const c of e.comments) delete c.edited;
      return { key: key809(), evidence: e, policy: REVIEW_POLICY };
    }],
  ] as const) {
    it(`${label}: fails closed (malformed) and never throws`, () => {
      const out = noThrow(() => bindReviews((args as () => any)()));
      expect(out.threw, label).toBe(false);
      const v = (out as any).value;
      expect(v?.ok, label).toBe(false);
      expect(v?.reason, label).toBe("malformed");
    });
  }

  it("is pure over deep-frozen arguments and returns a deeply frozen value", () => {
    const key = keyAt(IMPL, 800, "fe62f51f0fd95fc97d2e21eef71d179e2e701358");
    const args = { key, evidence: evidence(800), policy: REVIEW_POLICY };
    const a = bindReviews(args);
    const b = bindReviews(deepFreeze(clone(args)));
    expect(canon(b)).toBe(canon(a));
    expect(isDeepFrozen(a.value)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// f75ca255 §4.1/§4.2: a comment's lastEditedAt, the record's `edited`, and R4-EDIT
// ---------------------------------------------------------------------------
describe("rows 4-5 verify: comment edits (§4.1 lastEditedAt, §4.2 channel B requires edited: false)", () => {
  const commentNode = (raw: any, id: number) => raw.data.repository.pullRequest.comments.nodes.find((x: any) => x.databaseId === id);

  it("REAL: for every comment of #776, #800 and #809, edited === (lastEditedAt !== null); edited Vercel and summary comments exist", () => {
    let editedSeen = 0;
    for (const n of [776, 800, 809] as const) {
      const raw = reviewAnswer(n);
      const r = parseReviewEvidence(raw, { expectedNumber: n });
      expect(r.ok, `#${n}`).toBe(true);
      for (const c of r.record.comments) {
        const node = commentNode(raw, c.id);
        expect(c.edited, `#${n} comment ${c.id}`).toBe(node.lastEditedAt !== null);
        if (c.edited) editedSeen++;
      }
    }
    expect(editedSeen).toBeGreaterThanOrEqual(5);
  });

  it("a record comment is exactly { id, body, edited, author }: lastEditedAt itself never enters the record", () => {
    const r = parseReviewEvidence(reviewAnswer(809), { expectedNumber: 809 });
    for (const c of r.record.comments) {
      expect(Object.keys(c).sort()).toEqual(["author", "body", "edited", "id"]);
      expect(typeof c.edited).toBe("boolean");
    }
  });

  for (const [label, value] of [
    ["a date without a time", "2026-10-07"],
    ["a non-UTC offset", "2026-10-07T20:00:00+01:00"],
    ["a space instead of T", "2026-10-07 20:00:00Z"],
    ["prose", "yesterday"],
    ["the empty string", ""],
    ["an epoch number", 1759867200],
    ["a boolean", true],
    ["an object", { at: "2026-10-07T20:00:00Z" }],
    ["an impossible date", "2026-13-07T20:00:00Z"],
  ] as const) {
    it(`a comment whose lastEditedAt is ${label} is malformed`, () => {
      const raw = reviewAnswer(809);
      commentNode(raw, CLEAN_COMMENT_809).lastEditedAt = value;
      failsWith(parseReviewEvidence(raw, { expectedNumber: 809 }), ["malformed"], label);
    });
  }

  it("a comment without the lastEditedAt field is malformed (GraphQL exact fields)", () => {
    const raw = reviewAnswer(809);
    delete commentNode(raw, CLEAN_COMMENT_809).lastEditedAt;
    failsWith(parseReviewEvidence(raw, { expectedNumber: 809 }), ["malformed"], "missing lastEditedAt");
  });

  it("an ISO-8601 UTC lastEditedAt marks the comment edited; null marks it unedited", () => {
    for (const [value, edited] of [
      ["2026-10-07T20:00:00Z", true],
      [null, false],
    ] as const) {
      const raw = reviewAnswer(809);
      commentNode(raw, CLEAN_COMMENT_809).lastEditedAt = value;
      const r = parseReviewEvidence(raw, { expectedNumber: 809 });
      expect(r.ok, String(value)).toBe(true);
      expect(r.record.comments.find((c: any) => c.id === CLEAN_COMMENT_809).edited).toBe(edited);
    }
  });

  it("R4-EDIT closed: Codex's clean comment at the head no longer qualifies once it carries an edit, whoever edited it", () => {
    const at = (lastEditedAt: string | null) => {
      const raw = reviewAnswer(809);
      commentNode(raw, CLEAN_COMMENT_809).lastEditedAt = lastEditedAt;
      const v = bindReviews({ key: keyAt(IMPL, 809, H809), evidence: parseReviewEvidence(raw, { expectedNumber: 809 }).record, policy: REVIEW_POLICY });
      expect(v.ok).toBe(true);
      return artifactSummary(v.value).find((x: string) => x.startsWith(`${CLEAN_COMMENT_809}|`));
    };
    expect(at(null)).toBe(`${CLEAN_COMMENT_809}|CLEAN_COMMENT|CLEAN|Bot:${CODEX_ID}|true`);
    expect(at("2026-10-07T21:30:00Z")).toBe(`${CLEAN_COMMENT_809}|CLEAN_COMMENT|CLEAN|Bot:${CODEX_ID}|false`);
  });

  it("an edit does not touch channel A: a review's qualification is commit and marker only", () => {
    // reviews carry no lastEditedAt in §4.1's query; an edited review body is still bound by its immutable commit
    const raw = reviewAnswer(809);
    const r = parseReviewEvidence(raw, { expectedNumber: 809 });
    for (const rev of r.record.reviews) expect(Object.keys(rev).sort()).toEqual(["author", "body", "commitOid", "id", "state"]);
  });
});

budgetGuard("row4-review.verify.test.ts");
