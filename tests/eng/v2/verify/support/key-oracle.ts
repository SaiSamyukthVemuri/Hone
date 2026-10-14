/* eslint-disable @typescript-eslint/no-explicit-any -- the oracle classifies arbitrary, untyped GraphQL answers on purpose */
// Independent verifier support: an oracle for PrSnapshotKey, written ONLY from
// PR-SNAPSHOT-01 §2 (nine fields, §15 isDraft) and SPEC-05A §0 (GraphQL answers
// carry exactly the requested fields). It does not import or mirror the parser.
//
// Envelope failures (GraphQL errors, a missing data/repository/pullRequest) and
// a number that differs from the requested one are allowed to be either
// `malformed` or `read_failed`: the records do not pin which. Every field-level
// violation inside a present pullRequest object is exactly `malformed` (§2 "Strict").

import { permuteKeys } from "./deep";
import type { Rng } from "./prng";

export const NINE = [
  "prNumber",
  "state",
  "isDraft",
  "headSha",
  "headRef",
  "headRepoId",
  "baseRef",
  "baseRepoId",
  "baseSha",
] as const;

/** The GraphQL fields of the one `repository.pullRequest(number:)` request (§2 "GraphQL source"). */
export const GQL_FIELDS = [
  "number",
  "state",
  "isDraft",
  "headRefOid",
  "headRefName",
  "headRepository",
  "baseRefName",
  "baseRepository",
  "baseRef",
] as const;

type Reason = "malformed" | "read_failed";
export type Verdict =
  | { valid: true; key: Record<(typeof NINE)[number], unknown> }
  | { valid: false; reasons: Reason[]; why: string[] };

const HEX40 = /^[0-9a-f]{40}$/;
const isPosInt = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v > 0;
const isNonEmptyString = (v: unknown) => typeof v === "string" && v.length > 0;
const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const exact = (o: unknown, keys: readonly string[]) =>
  isObj(o) &&
  Object.keys(o).length === keys.length &&
  keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));

export function oracleKey(raw: any, expectedNumber: number): Verdict {
  const either = (why: string): Verdict => ({ valid: false, reasons: ["malformed", "read_failed"], why: [why] });
  if (!isObj(raw)) return either("answer is not an object");
  if (Object.prototype.hasOwnProperty.call(raw, "errors")) return either("GraphQL errors");
  if (!exact(raw, ["data"])) return either("envelope is not exactly { data }");
  const data: any = raw.data;
  if (!exact(data, ["repository"])) return either("data is not exactly { repository }");
  if (!exact(data.repository, ["pullRequest"])) return either("repository is not exactly { pullRequest }");
  const pr = data.repository.pullRequest;
  if (pr === null) return either("pullRequest is null");

  const why: string[] = [];
  let allowReadFailed = false;
  if (!exact(pr, GQL_FIELDS)) why.push("pullRequest does not carry exactly the nine requested fields");
  if (!isPosInt(pr?.number)) why.push("number is not a positive integer");
  else if (pr.number !== expectedNumber) {
    why.push("number differs from the requested number");
    allowReadFailed = true;
  }
  const states = ["OPEN", "CLOSED", "MERGED"];
  if (!states.includes(pr?.state)) why.push("state outside OPEN/CLOSED/MERGED");
  const open = pr?.state === "OPEN";
  if (typeof pr?.isDraft !== "boolean") why.push("isDraft is not a boolean");
  if (typeof pr?.headRefOid !== "string" || !HEX40.test(pr.headRefOid)) why.push("headRefOid is not 40 lowercase hex");
  if (!isNonEmptyString(pr?.headRefName)) why.push("headRefName is not a non-empty string");
  let headRepoId: unknown = undefined;
  if (pr?.headRepository === null) {
    if (open || !states.includes(pr?.state)) why.push("headRepository is null on an OPEN (or unknown-state) PR");
    headRepoId = null;
  } else if (exact(pr?.headRepository, ["databaseId"]) && isPosInt(pr.headRepository.databaseId)) {
    headRepoId = pr.headRepository.databaseId;
  } else why.push("headRepository is not null or exactly { databaseId: positive integer }");
  if (!isNonEmptyString(pr?.baseRefName)) why.push("baseRefName is not a non-empty string");
  let baseRepoId: unknown = undefined;
  if (exact(pr?.baseRepository, ["databaseId"]) && isPosInt(pr.baseRepository.databaseId)) {
    baseRepoId = pr.baseRepository.databaseId;
  } else why.push("baseRepository is not exactly { databaseId: positive integer }");
  let baseSha: unknown = null;
  if (open) {
    const ok =
      exact(pr.baseRef, ["target"]) &&
      exact(pr.baseRef.target, ["oid"]) &&
      typeof pr.baseRef.target.oid === "string" &&
      HEX40.test(pr.baseRef.target.oid);
    if (!ok) why.push("OPEN baseRef is not exactly { target: { oid: 40 lowercase hex } }");
    else baseSha = pr.baseRef.target.oid;
  }
  if (why.length > 0) return { valid: false, reasons: allowReadFailed ? ["malformed", "read_failed"] : ["malformed"], why };
  return {
    valid: true,
    key: {
      prNumber: pr.number,
      state: pr.state,
      isDraft: pr.isDraft,
      headSha: pr.headRefOid,
      headRef: pr.headRefName,
      headRepoId,
      baseRef: pr.baseRefName,
      baseRepoId,
      baseSha,
    },
  };
}

// ---------------------------------------------------------------------------
// A generative corpus, built from scratch (not by mutating a recorded fixture):
// every field is drawn independently from a valid pool or a lookalike-invalid
// pool, structure is perturbed (extra/missing fields, envelopes), and object key
// order is shuffled. The oracle above gives the required outcome.
// ---------------------------------------------------------------------------

const VALID_NUMBERS = [1, 7, 623, 776, 800, 809, 810, 99999];
const BAD_NUMBERS: unknown[] = [0, -810, 810.5, "810", null, true, Number.NaN, Number.POSITIVE_INFINITY, [810], {}];
const BAD_STATES: unknown[] = ["open", "Open", "OPEN ", " CLOSED", "DRAFT", "", null, 1, true];
const BAD_BOOLS: unknown[] = ["false", "true", 0, 1, null, []];
const VALID_REFS = ["feat/x", "docs/arch-01-eng-loop-v2", "a", "claude/build-hone-saas-hOex7", "feat/ü-unicode", "x y"];
const BAD_REFS: unknown[] = ["", null, 5, ["feat"], {}];
const VALID_IDS = [1, 1240764106, 2 ** 31];
const BAD_IDS: unknown[] = [0, -1, 1.5, "1240764106", null, true];
const EXTRA_FIELDS = ["title", "baseRefOid", "id", "url", "mergeable"];

function sha(r: Rng): string {
  // Always contains a letter, so its upper-case twin is a genuine lookalike.
  return "a" + r.hex(39);
}
function badSha(r: Rng): unknown {
  const h = sha(r);
  return r.pick<unknown>([h.toUpperCase(), h.slice(1), h + "0", "g" + h.slice(1), " " + h.slice(1), "", null, 123, h + h.slice(0, 24)]);
}

export interface Generated {
  raw: unknown;
  expectedNumber: number;
  note: string[];
}

export function genRaw(r: Rng): Generated {
  const note: string[] = [];
  const bad = (p: number, field: string) => {
    const b = r.bool(p);
    if (b) note.push(`bad ${field}`);
    return b;
  };
  const P = 0.08;
  const number = bad(P, "number") ? r.pick(BAD_NUMBERS) : r.pick(VALID_NUMBERS);
  const state = bad(P, "state") ? r.pick(BAD_STATES) : r.pick(["OPEN", "OPEN", "CLOSED", "MERGED"]);
  const terminal = state === "CLOSED" || state === "MERGED";
  const pr: Record<string, unknown> = {
    number,
    state,
    isDraft: bad(P, "isDraft") ? r.pick(BAD_BOOLS) : r.bool(),
    headRefOid: bad(P, "headRefOid") ? badSha(r) : sha(r),
    headRefName: bad(P, "headRefName") ? r.pick(BAD_REFS) : r.pick(VALID_REFS),
    headRepository: (() => {
      if (bad(P, "headRepository"))
        return r.pick<unknown>([
          null, // illegal only when OPEN; the oracle decides
          { databaseId: r.pick(BAD_IDS) },
          {},
          { databaseId: 1240764106, name: "Hone" },
          1240764106,
          "1240764106",
        ]);
      if (terminal && r.bool(0.3)) return null;
      return { databaseId: r.pick(VALID_IDS) };
    })(),
    baseRefName: bad(P, "baseRefName") ? r.pick(BAD_REFS) : r.pick(VALID_REFS),
    baseRepository: bad(P, "baseRepository")
      ? r.pick<unknown>([null, {}, { databaseId: r.pick(BAD_IDS) }, { databaseId: 1, extra: true }])
      : { databaseId: r.pick(VALID_IDS) },
    baseRef: (() => {
      if (terminal) {
        // A terminal key's baseSha is null and "any returned value is ignored" (§2).
        // Only shape-exact values (or null) are generated, so the exact-field rule and
        // the ignore rule never conflict here.
        return r.pick<unknown>([
          { target: { oid: sha(r) } },
          null,
          { target: null },
          { target: { oid: "not-a-sha" } },
          { target: { oid: sha(r).toUpperCase() } },
        ]);
      }
      if (bad(P, "baseRef"))
        return r.pick<unknown>([
          null,
          { target: null },
          { target: { oid: sha(r).toUpperCase() } },
          { target: { oid: sha(r).slice(2) } },
          {},
          { target: {} },
          { target: { oid: sha(r), extra: 1 } },
          { target: { oid: sha(r) }, name: "main" },
          sha(r),
        ]);
      return { target: { oid: sha(r) } };
    })(),
  };
  if (r.bool(0.05)) {
    const f = r.pick(EXTRA_FIELDS);
    pr[f] = f === "baseRefOid" ? sha(r) : "x";
    note.push(`extra ${f}`);
  }
  if (r.bool(0.04)) {
    const candidates = terminal ? GQL_FIELDS.filter((f) => f !== "baseRef") : [...GQL_FIELDS];
    const f = r.pick(candidates);
    delete pr[f];
    note.push(`missing ${f}`);
  }
  let raw: unknown = { data: { repository: { pullRequest: pr } } };
  if (r.bool(0.04)) {
    raw = r.pick<unknown>([
      { errors: [{ type: "NOT_FOUND", message: "Could not resolve to a PullRequest" }] },
      { data: null },
      { data: { repository: null } },
      { data: { repository: { pullRequest: null } } },
      { data: { repository: { pullRequest: pr } }, errors: [{ message: "partial" }] },
      null,
      [],
      "a string",
      42,
    ]);
    note.push("envelope");
  }
  if (r.bool(0.5)) raw = permuteKeys(raw, r);
  const expectedNumber =
    typeof number === "number" && Number.isInteger(number) && number > 0
      ? r.bool(0.94)
        ? number
        : number + 1
      : r.pick(VALID_NUMBERS);
  if (expectedNumber !== number) note.push("expectedNumber differs");
  return { raw, expectedNumber, note };
}

/** A valid raw answer built from explicit values (for hand-written cases). */
export function rawKey(v: {
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  headSha: string;
  headRef: string;
  headRepoId: number | null;
  baseRef: string;
  baseRepoId: number;
  baseTip: string | null;
}): any {
  return {
    data: {
      repository: {
        pullRequest: {
          number: v.number,
          state: v.state,
          isDraft: v.isDraft,
          headRefOid: v.headSha,
          headRefName: v.headRef,
          headRepository: v.headRepoId === null ? null : { databaseId: v.headRepoId },
          baseRefName: v.baseRef,
          baseRepository: { databaseId: v.baseRepoId },
          baseRef: v.baseTip === null ? null : { target: { oid: v.baseTip } },
        },
      },
    },
  };
}
