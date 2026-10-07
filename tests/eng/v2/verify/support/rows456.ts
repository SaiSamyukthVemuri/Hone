/* eslint-disable @typescript-eslint/no-explicit-any -- raw GraphQL answers and records are untyped JSON on purpose */
// Independent verifier support: rows 4-6 (SPEC-05A §4 at 203ed1f4; ARCH-01 §17-§21, §24, §41;
// EXT-CONTEXT-01 §4-§9). Every expectation below was written by hand from those texts and
// from reading the real answers' content; nothing here imports or mirrors the implementation.
//
// Real answers (builder-recorded, copied into fixtures/builder-real/ from 203ed1f4):
//   review-800 (#800 at fe62f51f), review-809 (#809, merged at 9dbbdb80), review-776 (#776)
//   rollup-800 (fe62f51f), rollup-810 (958b9d53), rollup-776 (7d25459d)

import { clone, noThrow } from "./deep";
import { REAL } from "./world";

export const CODEX_ID = 199175422;
export const OPERATOR_ID = 26781116;
export const CLEAN_PREFIX = "Codex Review: Didn't find any major issues.";
export const H800 = "fe62f51f0fd95fc97d2e21eef71d179e2e701358";
export const H800_OLD = "390e12af8d03fbe01f47ab6f8a4fb9d24e7c71e6";
export const H809 = "9dbbdb808748023d8b835d9d3875552cd81d18e0";
export const B54 = "b54e4382847a909dbd448f7c1b175e2ba49866e0";
export const H776 = "7d25459de1fe63a7fd4ed3348ecb11ab35ab6338";
export const H810 = "958b9d536e055e746499262cdc1a740e13501bf2";
export const CLEAN_COMMENT_809 = 6044799538; // clean verdict at 9dbbdb8087
export const OLD_CLEAN_COMMENT_809 = 6044636744; // clean verdict at b54e438284
export const CODEX_REVIEW_809 = 5446917669; // findings review at b54e438284
export const HUMAN_REVIEW_809 = 5446958797; // empty-body review at 9dbbdb80

export const reviewAnswer = (n: 800 | 809 | 776) => REAL.builder(`review-${n}.json`);
export const rollupAnswer = (n: 800 | 810 | 776) => REAL.builder(`rollup-${n}.json`);

// ---------------------------------------------------------------------------
// Summaries: order-free, comparable strings for a bindReviews / bindExternal value
// ---------------------------------------------------------------------------
const who = (a: any) => (a === null ? "null" : `${a?.type}:${a?.id}`);
export const artifactSummary = (v: any): string[] =>
  (v?.reviews ?? []).map((a: any) => `${a.id}|${a.channel}|${a.verdict}|${who(a.actor)}|${a.qualifiesAtHead}`).sort();
export const threadSummary = (v: any): string[] =>
  (v?.threads ?? []).map((t: any) => `${who(t.opener)}|${t.resolved}|${who(t.resolver)}|${t.outdated}`).sort();
export const externalSummary = (v: any): string[] => (v?.external ?? []).map((e: any) => `${e.source}=${e.state}`).sort();

const A = (id: number, actor: string, qualifies: boolean, verdict = "COMMENTED") => `${id}|PR_REVIEW|${verdict}|${actor}|${qualifies}`;
const B = (id: number, actor: string, qualifies: boolean) => `${id}|CLEAN_COMMENT|CLEAN|${actor}|${qualifies}`;
const BOT = `Bot:${CODEX_ID}`;
const OP = `User:${OPERATOR_ID}`;

/** #809's real evidence at its merged head 9dbbdb80 (hand-derived). */
export const EXPECTED_809_AT_HEAD = (): Record<number, string> => ({
  [CODEX_REVIEW_809]: A(CODEX_REVIEW_809, BOT, false), // commit b54e4382, marker b54e438284
  [HUMAN_REVIEW_809]: A(HUMAN_REVIEW_809, OP, false), // commit at head, empty body: no marker
  [OLD_CLEAN_COMMENT_809]: B(OLD_CLEAN_COMMENT_809, BOT, false), // marker b54e438284
  [CLEAN_COMMENT_809]: B(CLEAN_COMMENT_809, BOT, true), // marker 9dbbdb8087
});
export const EXPECTED_809_THREADS = [`${BOT}|true|${OP}|true`];

/** #800's 21 reviews at its head fe62f51f: only Codex review 5447256178 qualifies. */
const R800: Array<[number, "B" | "U"]> = [
  [5422452425, "B"], [5422548049, "U"], [5422548330, "U"], [5422573583, "B"], [5422754914, "B"],
  [5422891727, "B"], [5442855778, "U"], [5442856316, "U"], [5442856852, "U"], [5442857296, "U"],
  [5442857753, "U"], [5442858277, "U"], [5442965267, "B"], [5444115582, "U"], [5444177513, "B"],
  [5444587887, "U"], [5444645424, "B"], [5444825646, "U"], [5444877273, "B"], [5447208888, "U"],
  [5447256178, "B"],
];
export const expected800 = (qualifying: number): string[] =>
  R800.map(([id, t]) => A(id, t === "B" ? BOT : OP, id === qualifying)).sort();
/** #800's 13 threads: every one opened by Codex; twelve resolved by the operator; one open. */
export const EXPECTED_800_THREADS = [
  ...Array.from({ length: 8 }, () => `${BOT}|true|${OP}|true`),
  `${BOT}|true|${OP}|false`,
  `${BOT}|true|${OP}|false`,
  `${BOT}|true|${OP}|true`,
  `${BOT}|true|${OP}|true`,
  `${BOT}|false|null|false`,
].sort();

// ---------------------------------------------------------------------------
// Review rows (§4.1 parse + §4.2 bind)
// ---------------------------------------------------------------------------
export type ReviewExpect =
  | { reason: string; stage?: "parse" | "bind" | "either" }
  | { artifacts: string[]; threads?: string[] };

export interface ReviewRow {
  id: string;
  title: string;
  source: string;
  clause: string;
  number: number;
  headSha: string;
  raw: () => any;
  params?: () => any;
  expect: ReviewExpect;
}

const pr = (raw: any) => raw.data.repository.pullRequest;
const commentOf = (raw: any, id: number) => pr(raw).comments.nodes.find((c: any) => c.databaseId === id);
const reviewOf = (raw: any, id: number) => pr(raw).reviews.nodes.find((r: any) => r.databaseId === id);
const edit809 = (f: (raw: any) => void) => () => {
  const raw = reviewAnswer(809);
  f(raw);
  return raw;
};
const withClean = (f: (c: any) => void) => edit809((raw) => f(commentOf(raw, CLEAN_COMMENT_809)));
const withReview = (f: (r: any) => void) => edit809((raw) => f(reviewOf(raw, CODEX_REVIEW_809)));
const base809 = (patch: Record<number, string | null>) => {
  const m = { ...EXPECTED_809_AT_HEAD(), ...patch };
  return Object.values(m)
    .filter((x): x is string => x !== null)
    .sort();
};
const MARK = "**Reviewed commit:**";

export const REVIEW_ROWS: ReviewRow[] = [
  // --- real answers ----------------------------------------------------------
  {
    id: "RV-real-809-at-head",
    title: "#809 at its merged head: the second clean comment qualifies; the older clean comment and the stale findings review do not",
    source: "real (builder-recorded #809)",
    clause: "SPEC §4.2 channels A/B and the marker rule; ARCH-01 §17",
    number: 809,
    headSha: H809,
    raw: () => reviewAnswer(809),
    expect: { artifacts: base809({}), threads: EXPECTED_809_THREADS },
  },
  {
    id: "RV-real-809-at-older-head",
    title: "the same evidence keyed to #809's earlier head b54e4382 flips every qualification",
    source: "real answer; synthetic key",
    clause: "SPEC §4.2: qualifiesAtHead is computed against key.headSha",
    number: 809,
    headSha: B54,
    raw: () => reviewAnswer(809),
    expect: {
      artifacts: [
        A(CODEX_REVIEW_809, BOT, true),
        A(HUMAN_REVIEW_809, OP, false),
        B(OLD_CLEAN_COMMENT_809, BOT, true),
        B(CLEAN_COMMENT_809, BOT, false),
      ].sort(),
      threads: EXPECTED_809_THREADS,
    },
  },
  {
    id: "RV-real-800-at-head",
    title: "#800 at fe62f51f: 21 channel-A artifacts, only the Codex review at that commit qualifies; 13 Codex-opened threads",
    source: "real (builder-recorded #800)",
    clause: "SPEC §4.2; ARCH-01 §17 A, §19 opener = first comment's author",
    number: 800,
    headSha: H800,
    raw: () => reviewAnswer(800),
    expect: { artifacts: expected800(5447256178), threads: EXPECTED_800_THREADS },
  },
  {
    id: "RV-real-800-at-older-head",
    title: "#800 keyed to its older head 390e12af: only the Codex review at that commit qualifies",
    source: "real answer; synthetic key",
    clause: "SPEC §4.2",
    number: 800,
    headSha: H800_OLD,
    raw: () => reviewAnswer(800),
    expect: { artifacts: expected800(5444877273), threads: EXPECTED_800_THREADS },
  },
  {
    id: "RV-real-776",
    title: "#776: a Vercel comment and Codex's summary comment are not artifacts; no reviews, no threads",
    source: "real (builder-recorded #776)",
    clause: "SPEC §4.2 'Other comments are not artifacts'; ARCH-01 §17 'Not artifacts'",
    number: 776,
    headSha: H776,
    raw: () => reviewAnswer(776),
    expect: { artifacts: [], threads: [] },
  },

  // --- channel B: the marker rule ---------------------------------------------
  ...(
    [
      ["RV-B-two-markers", "the same marker twice", (c: any) => (c.body += `\n\n${MARK} \`9dbbdb8087\``)],
      ["RV-B-two-different-markers", "a second marker for another head", (c: any) => (c.body += `\n\n${MARK} \`b54e438284\``)],
      ["RV-B-no-marker", "no marker at all", (c: any) => (c.body = c.body.replace(`${MARK} \`9dbbdb8087\``, ""))],
      ["RV-B-7hex", "a 7-hex marker", (c: any) => (c.body = c.body.replace("`9dbbdb8087`", "`9dbbdb8`"))],
      ["RV-B-40hex", "a 40-hex marker", (c: any) => (c.body = c.body.replace("`9dbbdb8087`", `\`${H809}\``))],
      ["RV-B-11hex", "an 11-hex marker", (c: any) => (c.body = c.body.replace("`9dbbdb8087`", "`9dbbdb80874`"))],
      ["RV-B-upper", "an upper-case marker", (c: any) => (c.body = c.body.replace("`9dbbdb8087`", "`9DBBDB8087`"))],
      ["RV-B-other-hex", "a marker for another head", (c: any) => (c.body = c.body.replace("`9dbbdb8087`", "`b54e438284`"))],
      ["RV-B-no-backticks", "a marker without its backticks", (c: any) => (c.body = c.body.replace("`9dbbdb8087`", "9dbbdb8087"))],
    ] as Array<[string, string, (c: any) => void]>
  ).map(([id, what, f]): ReviewRow => ({
    id,
    title: `a clean comment with ${what} is an artifact that does not qualify`,
    source: "real clean comment 6044799538, synthetic edit",
    clause: "SPEC §4.2 marker rule; ARCH-01 §17b (exactly once; 10 lowercase hex; 7/40 hex and upper case are near-misses, §22)",
    number: 809,
    headSha: H809,
    raw: withClean(f),
    expect: { artifacts: base809({ [CLEAN_COMMENT_809]: B(CLEAN_COMMENT_809, BOT, false) }) },
  })),

  // --- channel B: the clean prefix is anchored at the start --------------------
  ...(
    [
      ["RV-B-leading-space", "a leading space", (c: any) => (c.body = ` ${c.body}`)],
      ["RV-B-quoted", "a Markdown quote", (c: any) => (c.body = `> ${c.body}`)],
      ["RV-B-mid", "text before the prefix", (c: any) => (c.body = `FYI ${c.body}`)],
      ["RV-B-curly-apostrophe", "a typographic apostrophe", (c: any) => (c.body = c.body.replace("Didn't", "Didn’t"))],
      ["RV-B-lower-case", "a lower-case prefix", (c: any) => (c.body = c.body.replace("Codex Review", "codex review"))],
    ] as Array<[string, string, (c: any) => void]>
  ).map(([id, what, f]): ReviewRow => ({
    id,
    title: `a clean verdict with ${what} does not BEGIN with the prefix: not an artifact`,
    source: "real clean comment 6044799538, synthetic edit",
    clause: "SPEC §4.2 'a comment whose body begins with the clean prefix'; ARCH-01 §17b (exact text, ASCII apostrophe)",
    number: 809,
    headSha: H809,
    raw: withClean(f),
    expect: { artifacts: base809({ [CLEAN_COMMENT_809]: null }) },
  })),

  // --- channel B carries identity; trust is 05B's -----------------------------
  {
    id: "RV-B-human-author",
    title: "a human's comment beginning with the clean prefix is a channel-B artifact carrying the human's identity",
    source: "real clean comment, synthetic author",
    clause: "SPEC §4.2: 05A computes qualifiesAtHead and carries identities; trust is 05B's",
    number: 809,
    headSha: H809,
    raw: withClean((c) => (c.author = { __typename: "User", login: "someone", databaseId: 4242 })),
    expect: { artifacts: base809({ [CLEAN_COMMENT_809]: B(CLEAN_COMMENT_809, "User:4242", true) }) },
  },
  {
    id: "RV-B-deleted-author",
    title: "a clean comment whose author was deleted carries a null actor",
    source: "real clean comment, synthetic author",
    clause: "SPEC §4.1 author null when deleted",
    number: 809,
    headSha: H809,
    raw: withClean((c) => (c.author = null)),
    expect: { artifacts: base809({ [CLEAN_COMMENT_809]: `${CLEAN_COMMENT_809}|CLEAN_COMMENT|CLEAN|null|true` }) },
  },
  {
    id: "RV-B-mannequin-author",
    title: "a non-User, non-Bot author carries { id: null, type }",
    source: "real clean comment, synthetic author",
    clause: "SPEC §4.1 author { id: null } for a non-User, non-Bot actor",
    number: 809,
    headSha: H809,
    raw: withClean((c) => (c.author = { __typename: "Mannequin", login: "ghost-import" })),
    expect: { artifacts: base809({ [CLEAN_COMMENT_809]: `${CLEAN_COMMENT_809}|CLEAN_COMMENT|CLEAN|Mannequin:null|true` }) },
  },

  // --- channel A ---------------------------------------------------------------
  {
    id: "RV-A-commit-other",
    title: "a review whose marker names the head but whose commit is another does not qualify",
    source: "real Codex review 5446917669, synthetic marker",
    clause: "SPEC §4.2: qualifiesAtHead is commitOid === key.headSha AND the marker rule; ARCH-01 §17b channel A",
    number: 809,
    headSha: H809,
    raw: withReview((r) => (r.body = r.body.replace("`b54e438284`", "`9dbbdb8087`"))),
    expect: { artifacts: base809({}) },
  },
  {
    id: "RV-A-commit-null",
    title: "a review with no commit does not qualify, whatever its marker",
    source: "real Codex review, synthetic edit",
    clause: "SPEC §4.1 commit may be null; §4.2 commitOid must equal the head",
    number: 809,
    headSha: H809,
    raw: withReview((r) => {
      r.commit = null;
      r.body = r.body.replace("`b54e438284`", "`9dbbdb8087`");
    }),
    expect: { artifacts: base809({}) },
  },
  {
    id: "RV-A-at-head",
    title: "commit and marker both at the head: the review qualifies",
    source: "real Codex review, synthetic commit and marker",
    clause: "SPEC §4.2 channel A",
    number: 809,
    headSha: H809,
    raw: withReview((r) => {
      r.commit = { oid: H809 };
      r.body = r.body.replace("`b54e438284`", "`9dbbdb8087`");
    }),
    expect: { artifacts: base809({ [CODEX_REVIEW_809]: A(CODEX_REVIEW_809, BOT, true) }) },
  },
  ...(
    [
      ["RV-A-two-markers", (r: any) => (r.body += `\n${MARK} \`9dbbdb8087\``)],
      ["RV-A-7hex", (r: any) => (r.body = r.body.replace("`9dbbdb8087`", "`9dbbdb8`"))],
      ["RV-A-upper", (r: any) => (r.body = r.body.replace("`9dbbdb8087`", "`9DBBDB8087`"))],
    ] as Array<[string, (r: any) => void]>
  ).map(([id, f]): ReviewRow => ({
    id,
    title: `a review at the head with a near-miss marker (${id.slice(5)}) does not qualify`,
    source: "real Codex review, synthetic edit",
    clause: "SPEC §4.2 marker rule; ARCH-01 §22 near-misses",
    number: 809,
    headSha: H809,
    raw: withReview((r) => {
      r.commit = { oid: H809 };
      r.body = r.body.replace("`b54e438284`", "`9dbbdb8087`");
      f(r);
    }),
    expect: { artifacts: base809({}) },
  })),
  ...(["PENDING", "APPROVED", "CHANGES_REQUESTED", "DISMISSED"] as const).map(
    (state): ReviewRow => ({
      id: `RV-A-state-${state}`,
      title: `a ${state} review at the head qualifies and carries its state as the verdict (accepting the state is 05B's)`,
      source: "real Codex review, synthetic state",
      clause: "SPEC §4.2 channel A verdict: state; ARCH-01 §24",
      number: 809,
      headSha: H809,
      raw: withReview((r) => {
        r.state = state;
        r.commit = { oid: H809 };
        r.body = r.body.replace("`b54e438284`", "`9dbbdb8087`");
      }),
      expect: { artifacts: base809({ [CODEX_REVIEW_809]: A(CODEX_REVIEW_809, BOT, true, state) }) },
    }),
  ),
  ...(["REQUEST_CHANGES", "commented", "", "RESOLVED"] as const).map(
    (state): ReviewRow => ({
      id: `RV-A-state-invalid-${JSON.stringify(state)}`,
      title: `a review state ${JSON.stringify(state)} outside GitHub's five is malformed`,
      source: "real Codex review, synthetic state",
      clause: "SPEC §4.2 first bullet",
      number: 809,
      headSha: H809,
      raw: withReview((r) => (r.state = state)),
      expect: { reason: "malformed", stage: "either" },
    }),
  ),
  {
    id: "RV-A-clean-prefix-review",
    title: "a REVIEW whose body begins with the clean prefix is channel A, never CLEAN",
    source: "real Codex review, synthetic body",
    clause: "SPEC §4.2: channel B is a comment",
    number: 809,
    headSha: H809,
    raw: withReview((r) => {
      r.commit = { oid: H809 };
      r.body = `${CLEAN_PREFIX} Nice!\n\n${MARK} \`9dbbdb8087\``;
    }),
    expect: { artifacts: base809({ [CODEX_REVIEW_809]: A(CODEX_REVIEW_809, BOT, true) }) },
  },

  // --- threads -------------------------------------------------------------------
  {
    id: "RV-thread-no-comments",
    title: "a thread with no comments has a null opener",
    source: "real thread, synthetic edit",
    clause: "SPEC §4.1 opener null when the thread has no comment",
    number: 809,
    headSha: H809,
    raw: edit809((raw) => {
      const t = pr(raw).reviewThreads.nodes[0];
      t.comments = { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] };
    }),
    expect: { artifacts: base809({}), threads: [`null|true|${OP}|true`] },
  },
  {
    id: "RV-thread-first-author-deleted",
    title: "a thread whose first comment's author was deleted has a null opener (the reply's author is not promoted)",
    source: "real thread, synthetic edit",
    clause: "SPEC §4.1 opener = author of the FIRST comment; ARCH-01 §19",
    number: 809,
    headSha: H809,
    raw: edit809((raw) => (pr(raw).reviewThreads.nodes[0].comments.nodes[0].author = null)),
    expect: { artifacts: base809({}), threads: [`null|true|${OP}|true`] },
  },
  {
    id: "RV-thread-resolved-no-resolver",
    title: "a resolved thread whose resolver is gone carries a null resolver",
    source: "real thread, synthetic edit",
    clause: "SPEC §4.1 resolver null",
    number: 809,
    headSha: H809,
    raw: edit809((raw) => (pr(raw).reviewThreads.nodes[0].resolvedBy = null)),
    expect: { artifacts: base809({}), threads: [`${BOT}|true|null|true`] },
  },

  // --- parse: echo, parameters, completeness, schema, envelope --------------------
  {
    id: "RV-number-echo-mismatch",
    title: "an answer for another PR number (the echo) is malformed",
    source: "real answer, synthetic echo",
    clause: "SPEC §4.1 'number must equal expectedNumber'",
    number: 809,
    headSha: H809,
    raw: edit809((raw) => (pr(raw).number = 810)),
    expect: { reason: "malformed", stage: "parse" },
  },
  ...(
    [
      ["RV-param-missing", () => ({})],
      ["RV-param-null", () => null],
      ["RV-param-string", () => ({ expectedNumber: "809" })],
      ["RV-param-zero", () => ({ expectedNumber: 0 })],
    ] as Array<[string, () => any]>
  ).map(([id, params]): ReviewRow => ({
    id,
    title: `a missing or invalid expectedNumber is malformed (${id.slice(9)})`,
    source: "real answer",
    clause: "SPEC §0 request parameters are required; §4.1",
    number: 809,
    headSha: H809,
    raw: () => reviewAnswer(809),
    params,
    expect: { reason: "malformed", stage: "parse" },
  })),
  ...(
    [
      ["RV-reviews-hasNext", (raw: any) => (pr(raw).reviews.pageInfo.hasNextPage = true)],
      ["RV-comments-count-mismatch", (raw: any) => (pr(raw).comments.totalCount = 7)],
      ["RV-threads-over-100", (raw: any) => (pr(raw).reviewThreads.totalCount = 101)],
      ["RV-thread-comments-hasNext", (raw: any) => (pr(raw).reviewThreads.nodes[0].comments.pageInfo.hasNextPage = true)],
      ["RV-thread-comments-count-mismatch", (raw: any) => (pr(raw).reviewThreads.nodes[0].comments.totalCount = 3)],
    ] as Array<[string, (raw: any) => void]>
  ).map(([id, f]): ReviewRow => ({
    id,
    title: `an incomplete connection is review_evidence_too_large (${id.slice(3)})`,
    source: "real answer, synthetic edit",
    clause: "SPEC §4.1 completeness; CAP-01 §17 C2-C6",
    number: 809,
    headSha: H809,
    raw: edit809(f),
    expect: { reason: "review_evidence_too_large", stage: "parse" },
  })),
  {
    id: "RV-malformed-wins",
    title: "an incomplete connection that also holds a malformed node is malformed",
    source: "real answer, synthetic edit",
    clause: "SPEC §4.1 'malformed wins over incompleteness'; §0",
    number: 809,
    headSha: H809,
    raw: edit809((raw) => {
      pr(raw).reviews.pageInfo.hasNextPage = true;
      reviewOf(raw, CODEX_REVIEW_809).databaseId = "5446917669";
    }),
    expect: { reason: "malformed", stage: "parse" },
  },
  ...(
    [
      ["RV-author-bot-no-id", (raw: any) => (reviewOf(raw, CODEX_REVIEW_809).author = { __typename: "Bot", login: "x" })],
      ["RV-author-user-id-0", (raw: any) => (reviewOf(raw, CODEX_REVIEW_809).author = { __typename: "User", login: "x", databaseId: 0 })],
      ["RV-author-org-with-id", (raw: any) => (reviewOf(raw, CODEX_REVIEW_809).author = { __typename: "Organization", login: "x", databaseId: 5 })],
      ["RV-author-extra-field", (raw: any) => (reviewOf(raw, CODEX_REVIEW_809).author = { __typename: "Bot", login: "x", databaseId: 5, url: "u" })],
      ["RV-commit-upper", (raw: any) => (reviewOf(raw, CODEX_REVIEW_809).commit = { oid: B54.toUpperCase() })],
      ["RV-commit-empty", (raw: any) => (reviewOf(raw, CODEX_REVIEW_809).commit = {})],
      ["RV-commit-short", (raw: any) => (reviewOf(raw, CODEX_REVIEW_809).commit = { oid: "b54e438284" })],
      ["RV-resolver-no-id", (raw: any) => (pr(raw).reviewThreads.nodes[0].resolvedBy = { __typename: "User", login: "x" })],
      ["RV-resolver-extra", (raw: any) => (pr(raw).reviewThreads.nodes[0].resolvedBy = { __typename: "User", login: "x", databaseId: 1, name: "n" })],
      ["RV-duplicate-review-id", (raw: any) => (reviewOf(raw, HUMAN_REVIEW_809).databaseId = CODEX_REVIEW_809)],
      ["RV-duplicate-comment-id", (raw: any) => (commentOf(raw, OLD_CLEAN_COMMENT_809).databaseId = CLEAN_COMMENT_809)],
      ["RV-body-null", (raw: any) => (commentOf(raw, CLEAN_COMMENT_809).body = null)],
      ["RV-review-id-string", (raw: any) => (reviewOf(raw, CODEX_REVIEW_809).databaseId = "x")],
      ["RV-isResolved-string", (raw: any) => (pr(raw).reviewThreads.nodes[0].isResolved = "true")],
    ] as Array<[string, (raw: any) => void]>
  ).map(([id, f]): ReviewRow => ({
    id,
    title: `a schema violation is malformed (${id.slice(3)})`,
    source: "real answer, synthetic edit",
    clause: "SPEC §4.1 malformed list",
    number: 809,
    headSha: H809,
    raw: edit809(f),
    expect: { reason: "malformed", stage: "parse" },
  })),
  {
    id: "RV-commit-null-ok",
    title: "a review whose commit is null parses and does not qualify",
    source: "real answer, synthetic edit",
    clause: "SPEC §4.1 commit 'neither null nor { oid }' is malformed, so null is allowed",
    number: 809,
    headSha: H809,
    raw: edit809((raw) => (reviewOf(raw, HUMAN_REVIEW_809).commit = null)),
    expect: { artifacts: base809({}) },
  },
  ...(
    [
      ["RV-graphql-error", () => ({ errors: [{ type: "FORBIDDEN", message: "x" }] })],
      ["RV-graphql-error-with-null-data", () => ({ data: null, errors: [{ message: "x" }] })],
      ["RV-repository-null", () => ({ data: { repository: null } })],
      ["RV-pullRequest-null", () => ({ data: { repository: { pullRequest: null } } })],
    ] as Array<[string, () => any]>
  ).map(([id, raw]): ReviewRow => ({
    id,
    title: `a GitHub error, an invisible repository or a missing PR is read_failed (${id.slice(3)})`,
    source: "synthetic envelope",
    clause: "SPEC §4.1 read_failed",
    number: 809,
    headSha: H809,
    raw,
    expect: { reason: "read_failed", stage: "parse" },
  })),
];

// ---------------------------------------------------------------------------
// Rollup rows (§4.3 parse + §4.4 bind)
// ---------------------------------------------------------------------------
export type RollupExpect = { reason: string; stage?: "parse" | "bind" | "either" } | { external: string[] };
export interface RollupRow {
  id: string;
  title: string;
  source: string;
  clause: string;
  headSha: string;
  raw: () => any;
  params?: () => any;
  expect: RollupExpect;
}

const VERCEL_TWO = ["Vercel Preview Comments=success", "Vercel=success"].sort();
const nodes = (raw: any) => raw.data.repository.object.statusCheckRollup.contexts.nodes;
const contexts = (raw: any) => raw.data.repository.object.statusCheckRollup.contexts;
const edit810 = (f: (raw: any) => void) => () => {
  const raw = rollupAnswer(810);
  f(raw);
  return raw;
};
const statusCtx = (raw: any) => nodes(raw).find((n: any) => n.__typename === "StatusContext");
const vercelRun = (raw: any) => nodes(raw).find((n: any) => n.__typename === "CheckRun" && n.checkSuite.app?.slug === "vercel");
const actionsRun = (raw: any) => nodes(raw).find((n: any) => n.__typename === "CheckRun" && n.checkSuite.app?.slug === "github-actions");
const addNode = (raw: any, node: any) => {
  nodes(raw).push(node);
  contexts(raw).totalCount += 1;
};

export const ROLLUP_ROWS: RollupRow[] = [
  {
    id: "EX-real-810",
    title: "#810's real rollup: two Vercel successes; the GitHub Actions FAILURE (validate) is excluded",
    source: "real (builder-recorded rollup of 958b9d53)",
    clause: "EXT-CONTEXT-01 §4, fixture 17/22; SPEC §4.4",
    headSha: H810,
    raw: () => rollupAnswer(810),
    expect: { external: VERCEL_TWO },
  },
  {
    id: "EX-real-800",
    title: "#800's real rollup: two Vercel successes; skipped Actions runs excluded",
    source: "real (builder-recorded rollup of fe62f51f)",
    clause: "EXT-CONTEXT-01 §4",
    headSha: H800,
    raw: () => rollupAnswer(800),
    expect: { external: VERCEL_TWO },
  },
  {
    id: "EX-real-776",
    title: "#776's real rollup (12 contexts, three browser shards): two Vercel successes",
    source: "real (builder-recorded rollup of 7d25459d)",
    clause: "EXT-CONTEXT-01 §4",
    headSha: H776,
    raw: () => rollupAnswer(776),
    expect: { external: VERCEL_TWO },
  },
  ...(
    [
      ["SUCCESS", "success"],
      ["PENDING", "pending"],
      ["EXPECTED", "pending"],
      ["ERROR", "failure"],
      ["FAILURE", "failure"],
    ] as const
  ).map(
    ([state, norm]): RollupRow => ({
      id: `EX-status-context-${state}`,
      title: `StatusContext ${state} is ${norm}`,
      source: "real rollup, synthetic state",
      clause: "EXT-CONTEXT-01 §5",
      headSha: H810,
      raw: edit810((raw) => (statusCtx(raw).state = state)),
      expect: { external: ["Vercel Preview Comments=success", `Vercel=${norm}`].sort() },
    }),
  ),
  ...(["success", "UNKNOWN", "NEUTRAL"] as const).map(
    (state): RollupRow => ({
      id: `EX-status-context-unknown-${state}`,
      title: `StatusContext ${JSON.stringify(state)} is unrecognized_context_state`,
      source: "real rollup, synthetic state",
      clause: "EXT-CONTEXT-01 §5 'any other string'",
      headSha: H810,
      raw: edit810((raw) => (statusCtx(raw).state = state)),
      expect: { reason: "unrecognized_context_state", stage: "bind" },
    }),
  ),
  ...(["REQUESTED", "QUEUED", "IN_PROGRESS", "WAITING", "PENDING"] as const).map(
    (status): RollupRow => ({
      id: `EX-check-${status}`,
      title: `an external CheckRun ${status} is pending`,
      source: "real rollup, synthetic status",
      clause: "EXT-CONTEXT-01 §6",
      headSha: H810,
      raw: edit810((raw) => {
        vercelRun(raw).status = status;
        vercelRun(raw).conclusion = null;
      }),
      expect: { external: ["Vercel Preview Comments=pending", "Vercel=success"].sort() },
    }),
  ),
  ...(
    [
      ["SUCCESS", "success"],
      ["NEUTRAL", "success"],
      ["SKIPPED", "success"],
      ["FAILURE", "failure"],
      ["CANCELLED", "failure"],
      ["TIMED_OUT", "failure"],
      ["ACTION_REQUIRED", "failure"],
      ["STARTUP_FAILURE", "failure"],
      ["STALE", "failure"],
    ] as const
  ).map(
    ([c, norm]): RollupRow => ({
      id: `EX-check-completed-${c}`,
      title: `an external CheckRun COMPLETED/${c} is ${norm}`,
      source: "real rollup, synthetic conclusion",
      clause: "EXT-CONTEXT-01 §7",
      headSha: H810,
      raw: edit810((raw) => (vercelRun(raw).conclusion = c)),
      expect: { external: [`Vercel Preview Comments=${norm}`, "Vercel=success"].sort() },
    }),
  ),
  {
    id: "EX-check-completed-null",
    title: "an external CheckRun COMPLETED with a null conclusion is unrecognized_context_state",
    source: "real rollup, synthetic conclusion",
    clause: "EXT-CONTEXT-01 §7 (null), fixture 16",
    headSha: H810,
    raw: edit810((raw) => (vercelRun(raw).conclusion = null)),
    expect: { reason: "unrecognized_context_state", stage: "bind" },
  },
  ...(
    [
      ["EX-check-completed-lower", (raw: any) => (vercelRun(raw).conclusion = "success")],
      ["EX-check-status-lower", (raw: any) => (vercelRun(raw).status = "completed")],
      ["EX-check-status-unknown", (raw: any) => (vercelRun(raw).status = "DONE")],
    ] as Array<[string, (raw: any) => void]>
  ).map(([id, f]): RollupRow => ({
    id,
    title: `a validly typed value outside the tables is unrecognized_context_state (${id.slice(3)})`,
    source: "real rollup, synthetic value",
    clause: "EXT-CONTEXT-01 §6, §7",
    headSha: H810,
    raw: edit810(f),
    expect: { reason: "unrecognized_context_state", stage: "bind" },
  })),
  {
    id: "EX-check-in-progress-conclusion-unread",
    title: "an IN_PROGRESS external CheckRun is pending; its conclusion is not read",
    source: "real rollup, synthetic edit",
    clause: "EXT-CONTEXT-01 §6 'The conclusion of a check run that is not COMPLETED is not read'",
    headSha: H810,
    raw: edit810((raw) => {
      vercelRun(raw).status = "IN_PROGRESS";
      vercelRun(raw).conclusion = "SOMETHING_NEW";
    }),
    expect: { external: ["Vercel Preview Comments=pending", "Vercel=success"].sort() },
  },
  {
    id: "EX-actions-excluded-whatever-state",
    title: "a GitHub Actions CheckRun is excluded whatever its status or conclusion, unknown values included",
    source: "real rollup, synthetic edit",
    clause: "EXT-CONTEXT-01 §4, fixture 17",
    headSha: H810,
    raw: edit810((raw) => {
      actionsRun(raw).status = "SOMETHING_NEW";
      actionsRun(raw).conclusion = "BOGUS";
    }),
    expect: { external: VERCEL_TWO },
  },
  {
    id: "EX-null-app",
    title: "a CheckRun whose check suite has no app is malformed",
    source: "real rollup, synthetic edit",
    clause: "EXT-CONTEXT-01 §4, fixture 18; SPEC §4.4",
    headSha: H810,
    raw: edit810((raw) => (vercelRun(raw).checkSuite = { app: null })),
    expect: { reason: "malformed", stage: "bind" },
  },
  {
    id: "EX-malformed-wins-null-app-first",
    title: "a no-app CheckRun before an unrecognized value: malformed",
    source: "real rollup, synthetic edit",
    clause: "EXT-CONTEXT-01 §8, fixture 21",
    headSha: H810,
    raw: edit810((raw) => {
      nodes(raw).unshift({ __typename: "CheckRun", name: "orphan", status: "COMPLETED", conclusion: "SUCCESS", checkSuite: { app: null } });
      contexts(raw).totalCount += 1;
      statusCtx(raw).state = "SOMETHING_NEW";
    }),
    expect: { reason: "malformed", stage: "bind" },
  },
  {
    id: "EX-malformed-wins-null-app-last",
    title: "an unrecognized value before a no-app CheckRun: still malformed",
    source: "real rollup, synthetic edit",
    clause: "EXT-CONTEXT-01 §8, fixture 21",
    headSha: H810,
    raw: edit810((raw) => {
      statusCtx(raw).state = "SOMETHING_NEW";
      addNode(raw, { __typename: "CheckRun", name: "orphan", status: "COMPLETED", conclusion: "SUCCESS", checkSuite: { app: null } });
    }),
    expect: { reason: "malformed", stage: "bind" },
  },
  {
    id: "EX-slug-case-is-external",
    title: "only the exact slug github-actions is Actions: 'GitHub-Actions' is external, and its FAILURE counts",
    source: "real rollup, synthetic node",
    clause: "EXT-CONTEXT-01 §4 'iff checkSuite.app.slug == \"github-actions\"'",
    headSha: H810,
    raw: edit810((raw) =>
      addNode(raw, { __typename: "CheckRun", name: "lookalike", status: "COMPLETED", conclusion: "FAILURE", checkSuite: { app: { slug: "GitHub-Actions" } } }),
    ),
    expect: { external: [...VERCEL_TWO, "lookalike=failure"].sort() },
  },
  {
    id: "EX-name-is-not-a-discriminator",
    title: "names never decide: an Actions run named 'Vercel' is excluded; a vercel-app run named like a CI job is external",
    source: "real rollup, synthetic nodes",
    clause: "EXT-CONTEXT-01 §4 'No check name … is ever used'",
    headSha: H810,
    raw: edit810((raw) => {
      addNode(raw, { __typename: "CheckRun", name: "Vercel", status: "COMPLETED", conclusion: "FAILURE", checkSuite: { app: { slug: "github-actions" } } });
      addNode(raw, { __typename: "CheckRun", name: "browser e2e (local stack)", status: "COMPLETED", conclusion: "FAILURE", checkSuite: { app: { slug: "vercel" } } });
    }),
    expect: { external: [...VERCEL_TWO, "browser e2e (local stack)=failure"].sort() },
  },
  {
    id: "EX-null-rollup",
    title: "a null statusCheckRollup is a complete, empty set",
    source: "real answer, synthetic edit",
    clause: "SPEC §4.3; CAP-01 §17 C8",
    headSha: H810,
    raw: edit810((raw) => (raw.data.repository.object.statusCheckRollup = null)),
    expect: { external: [] },
  },
  {
    id: "EX-empty-contexts",
    title: "an empty complete contexts connection yields no facts",
    source: "real answer, synthetic edit",
    clause: "EXT-CONTEXT-01 §3",
    headSha: H810,
    raw: edit810((raw) => {
      contexts(raw).nodes = [];
      contexts(raw).totalCount = 0;
    }),
    expect: { external: [] },
  },
  {
    id: "EX-oid-echo-mismatch",
    title: "a rollup answered for another commit (the oid echo) is malformed",
    source: "real answer, synthetic echo",
    clause: "SPEC §4.3 'oid must equal headSha'",
    headSha: H810,
    raw: edit810((raw) => (raw.data.repository.object.oid = H800)),
    expect: { reason: "malformed", stage: "parse" },
  },
  ...(
    [
      ["EX-param-missing", () => ({})],
      ["EX-param-null", () => null],
      ["EX-param-upper", () => ({ headSha: H810.toUpperCase() })],
      ["EX-param-short", () => ({ headSha: H810.slice(0, 10) })],
    ] as Array<[string, () => any]>
  ).map(([id, params]): RollupRow => ({
    id,
    title: `a missing or invalid headSha is malformed (${id.slice(9)})`,
    source: "real answer",
    clause: "SPEC §0 request parameters are required; §4.3",
    headSha: H810,
    raw: () => rollupAnswer(810),
    params,
    expect: { reason: "malformed", stage: "parse" },
  })),
  {
    id: "EX-object-null",
    title: "a null object is read_failed",
    source: "synthetic envelope",
    clause: "SPEC §4.3",
    headSha: H810,
    raw: edit810((raw) => (raw.data.repository.object = null)),
    expect: { reason: "read_failed", stage: "parse" },
  },
  {
    id: "EX-object-not-commit",
    title: "an object that is not a Commit is malformed",
    source: "synthetic envelope",
    clause: "SPEC §4.3 query shape (… on Commit)",
    headSha: H810,
    raw: () => ({ data: { repository: { object: { __typename: "Tree" } } } }),
    expect: { reason: "malformed", stage: "parse" },
  },
  ...(
    [
      ["EX-hasNext", (raw: any) => (contexts(raw).pageInfo.hasNextPage = true)],
      ["EX-total-over-100", (raw: any) => (contexts(raw).totalCount = 101)],
      ["EX-total-mismatch", (raw: any) => (contexts(raw).totalCount = 11)],
    ] as Array<[string, (raw: any) => void]>
  ).map(([id, f]): RollupRow => ({
    id,
    title: `an incomplete contexts connection is external_contexts_too_large (${id.slice(3)})`,
    source: "real rollup, synthetic edit",
    clause: "SPEC §4.3; CAP-01 §17 C9-C10",
    headSha: H810,
    raw: edit810(f),
    expect: { reason: "external_contexts_too_large", stage: "parse" },
  })),
  {
    id: "EX-malformed-wins-incomplete",
    title: "an incomplete connection holding a malformed node is malformed",
    source: "real rollup, synthetic edit",
    clause: "SPEC §0 'malformed wins'; §4.3",
    headSha: H810,
    raw: edit810((raw) => {
      contexts(raw).pageInfo.hasNextPage = true;
      vercelRun(raw).status = "";
    }),
    expect: { reason: "malformed", stage: "parse" },
  },
  ...(
    [
      ["EX-check-status-empty", (raw: any) => (vercelRun(raw).status = "")],
      ["EX-check-status-null", (raw: any) => (vercelRun(raw).status = null)],
      ["EX-status-state-empty", (raw: any) => (statusCtx(raw).state = "")],
      ["EX-app-slug-empty", (raw: any) => (vercelRun(raw).checkSuite = { app: { slug: "" } })],
      ["EX-app-empty-object", (raw: any) => (vercelRun(raw).checkSuite = { app: {} })],
      ["EX-check-suite-missing", (raw: any) => delete vercelRun(raw).checkSuite],
      ["EX-name-number", (raw: any) => (vercelRun(raw).name = 5)],
      ["EX-conclusion-number", (raw: any) => (vercelRun(raw).conclusion = 5)],
      ["EX-context-number", (raw: any) => (statusCtx(raw).context = 5)],
      ["EX-unknown-typename", (raw: any) => addNode(raw, { __typename: "Commit" })],
      ["EX-status-context-extra-field", (raw: any) => (statusCtx(raw).name = "x")],
    ] as Array<[string, (raw: any) => void]>
  ).map(([id, f]): RollupRow => ({
    id,
    title: `a schema violation is malformed (${id.slice(3)})`,
    source: "real rollup, synthetic edit",
    clause: "SPEC §4.3 schema list",
    headSha: H810,
    raw: edit810(f),
    expect: { reason: "malformed", stage: "parse" },
  })),
];

// ---------------------------------------------------------------------------
// Pipelines over the REAL functions (any of them may be replaced by a mutant)
// ---------------------------------------------------------------------------
export interface Impl456 {
  parsePrKey: (raw: unknown, p: any) => any;
  parseReviewEvidence: (raw: unknown, p: any) => any;
  bindReviews: (a: any) => any;
  parseRollup: (raw: unknown, p: any) => any;
  bindExternal: (r: any) => any;
  policy: any;
}

export type Outcome456 = { ok: true; artifacts?: string[]; threads?: string[]; external?: string[]; value: any } | { ok: false; reason: string; stage: string };

export function keyAt(impl: Impl456, number: number, headSha: string): any {
  const raw = {
    data: {
      repository: {
        pullRequest: {
          number,
          state: "OPEN",
          isDraft: false,
          headRefOid: headSha,
          headRefName: `pr-${number}`,
          headRepository: { databaseId: 1240764106 },
          baseRefName: "claude/build-hone-saas-hOex7",
          baseRepository: { databaseId: 1240764106 },
          baseRef: { target: { oid: "6cdd830b0bcc5e3532016bc612bd0298db3533fb" } },
        },
      },
    },
  };
  const r = impl.parsePrKey(raw, { expectedNumber: number });
  if (!r?.ok) throw new Error(`test setup: key for #${number} did not parse`);
  return r.key;
}

export function evaluateReview(row: ReviewRow, impl: Impl456): Outcome456 {
  const out = noThrow(() => {
    const params = row.params ? row.params() : { expectedNumber: row.number };
    const parsed = impl.parseReviewEvidence(clone(row.raw()), params);
    if (!parsed?.ok) return { ok: false as const, reason: String(parsed?.reason), stage: "parse" };
    const bound = impl.bindReviews({ key: keyAt(impl, row.number, row.headSha), evidence: parsed.record, policy: impl.policy });
    if (!bound?.ok) return { ok: false as const, reason: String(bound?.reason), stage: "bind" };
    return { ok: true as const, artifacts: artifactSummary(bound.value), threads: threadSummary(bound.value), value: bound.value };
  });
  return out.threw ? { ok: false, reason: `THREW: ${String(out.error)}`, stage: "exception" } : out.value;
}

export function evaluateRollup(row: RollupRow, impl: Impl456): Outcome456 {
  const out = noThrow(() => {
    const params = row.params ? row.params() : { headSha: row.headSha };
    const parsed = impl.parseRollup(clone(row.raw()), params);
    if (!parsed?.ok) return { ok: false as const, reason: String(parsed?.reason), stage: "parse" };
    const bound = impl.bindExternal(parsed.record);
    if (!bound?.ok) return { ok: false as const, reason: String(bound?.reason), stage: "bind" };
    return { ok: true as const, external: externalSummary(bound.value), value: bound.value };
  });
  return out.threw ? { ok: false, reason: `THREW: ${String(out.error)}`, stage: "exception" } : out.value;
}

/** Returns "" when the outcome satisfies the row, else a reason string. */
export function checkReview(row: ReviewRow, got: Outcome456): string {
  const e = row.expect;
  if ("reason" in e) {
    if (got.ok) return `required UNKNOWN(${e.reason}), got a value`;
    if (got.reason !== e.reason) return `required ${e.reason}, got ${got.reason} at ${got.stage}`;
    if (e.stage && e.stage !== "either" && got.stage !== e.stage) return `required at ${e.stage}, got at ${got.stage}`;
    return "";
  }
  if (!got.ok) return `required a value, got UNKNOWN(${got.reason}) at ${got.stage}`;
  if (JSON.stringify(got.artifacts) !== JSON.stringify(e.artifacts))
    return `artifacts differ:\n  required ${JSON.stringify(e.artifacts)}\n  got      ${JSON.stringify(got.artifacts)}`;
  if (e.threads && JSON.stringify(got.threads) !== JSON.stringify(e.threads))
    return `threads differ:\n  required ${JSON.stringify(e.threads)}\n  got      ${JSON.stringify(got.threads)}`;
  return "";
}

export function checkRollup(row: RollupRow, got: Outcome456): string {
  const e = row.expect;
  if ("reason" in e) {
    if (got.ok) return `required UNKNOWN(${e.reason}), got ${JSON.stringify(got.external)}`;
    if (got.reason !== e.reason) return `required ${e.reason}, got ${got.reason} at ${got.stage}`;
    if (e.stage && e.stage !== "either" && got.stage !== e.stage) return `required at ${e.stage}, got at ${got.stage}`;
    return "";
  }
  if (!got.ok) return `required ${JSON.stringify(e.external)}, got UNKNOWN(${got.reason}) at ${got.stage}`;
  if (JSON.stringify(got.external) !== JSON.stringify(e.external))
    return `external facts differ: required ${JSON.stringify(e.external)}, got ${JSON.stringify(got.external)}`;
  return "";
}
