// ---------------------------------------------------------------------------
// ENG-LOOP V1 05A: spec-derived mutations of a raw PR-key GraphQL answer.
//
// Every single-point case carries its EXPECTED outcome, derived from the
// PrSnapshotKey contract (PR-SNAPSHOT-01 §2, with `isDraft` from
// PR-SNAPSHOT-DRAFT-01 §15) — never from the validator under test. The random
// fuzzer cannot predict an outcome, so it asserts safety properties instead:
// no throw, a closed result shape, and every accepted key matching the raw
// answer and the contract's invariants.
// ---------------------------------------------------------------------------

export type Expect = { ok: true } | { ok: false; reason: "malformed" | "read_failed" };

export interface MutationCase {
  name: string;
  raw: unknown;
  expect: Expect;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const MALFORMED: Expect = { ok: false, reason: "malformed" };
const READ_FAILED: Expect = { ok: false, reason: "read_failed" };
const OK: Expect = { ok: true };

export const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** Deterministic PRNG, so every fuzz failure is reproducible from its seed. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pr = (raw: any) => raw.data.repository.pullRequest;

/** Values of every JSON type, for "this field has the wrong type" cases. */
const WRONG_TYPES: Record<string, Json[]> = {
  posint: [0, -1, 1.5, "800", null, true, [], {}],
  state: ["open", "DRAFT", "", null, 1, [], {}],
  bool: ["true", "false", 1, 0, null, [], {}],
  sha40: [
    "FE62F51F0FD95FC97D2E21EEF71D179E2E701358", // upper case
    "fe62f51f0fd95fc97d2e21eef71d179e2e70135", // 39
    "fe62f51f0fd95fc97d2e21eef71d179e2e7013588", // 41
    "ze62f51f0fd95fc97d2e21eef71d179e2e701358", // non-hex
    "",
    null,
    1,
    [],
  ],
  nonEmptyString: ["", null, 1, true, [], {}],
};

/**
 * Exhaustive single-point mutations of one real fixture, each with the outcome
 * the contract requires.
 */
export function singlePointCases(fixtureName: string, fixture: any): MutationCase[] {
  const cases: MutationCase[] = [];
  const state: string = pr(fixture).state;
  const open = state === "OPEN";
  const add = (name: string, mutate: (raw: any) => void, expect: Expect) => {
    const raw = clone(fixture);
    mutate(raw);
    cases.push({ name: `${fixtureName}: ${name}`, raw, expect });
  };

  // The unmutated fixture is valid.
  add("unmutated", () => {}, OK);

  // Every one of the nine requested fields is required, even when its value may be null.
  for (const f of [
    "number",
    "state",
    "isDraft",
    "headRefOid",
    "headRefName",
    "headRepository",
    "baseRefName",
    "baseRepository",
    "baseRef",
  ]) {
    add(`delete ${f}`, (r) => delete pr(r)[f], MALFORMED);
  }

  for (const v of WRONG_TYPES.posint) add(`number = ${JSON.stringify(v)}`, (r) => (pr(r).number = v), MALFORMED);
  add("number names another PR", (r) => (pr(r).number = pr(r).number + 1), MALFORMED);

  for (const v of WRONG_TYPES.state) add(`state = ${JSON.stringify(v)}`, (r) => (pr(r).state = v), MALFORMED);

  for (const v of WRONG_TYPES.bool) add(`isDraft = ${JSON.stringify(v)}`, (r) => (pr(r).isDraft = v), MALFORMED);
  add("isDraft flipped", (r) => (pr(r).isDraft = !pr(r).isDraft), OK);

  for (const v of WRONG_TYPES.sha40) add(`headRefOid = ${JSON.stringify(v)}`, (r) => (pr(r).headRefOid = v), MALFORMED);

  for (const v of WRONG_TYPES.nonEmptyString) {
    add(`headRefName = ${JSON.stringify(v)}`, (r) => (pr(r).headRefName = v), MALFORMED);
    add(`baseRefName = ${JSON.stringify(v)}`, (r) => (pr(r).baseRefName = v), MALFORMED);
  }
  add("headRefName renamed", (r) => (pr(r).headRefName = "renamed/branch"), OK);

  // headRepository: null only when the PR is not OPEN (a deleted fork after close).
  add("headRepository = null", (r) => (pr(r).headRepository = null), open ? MALFORMED : OK);
  for (const v of [{}, { databaseId: 0 }, { databaseId: "1" }, { databaseId: null }, [], "x"] as Json[]) {
    add(`headRepository = ${JSON.stringify(v)}`, (r) => (pr(r).headRepository = v), MALFORMED);
  }
  add("headRepository extra key", (r) => (pr(r).headRepository.extra = 1), MALFORMED);

  // baseRepository is never null.
  for (const v of [null, {}, { databaseId: -5 }, { databaseId: 1.5 }, []] as Json[]) {
    add(`baseRepository = ${JSON.stringify(v)}`, (r) => (pr(r).baseRepository = v), MALFORMED);
  }

  // baseRef: an OPEN PR needs the live base tip; a terminal PR's base value is ignored.
  for (const v of [
    null,
    {},
    { target: null },
    { target: {} },
    { target: { oid: "6cdd830b" } },
    { target: { oid: "6CDD830B0BCC5E3532016BC612BD0298DB3533FB" } },
    { target: { oid: "6cdd830b0bcc5e3532016bc612bd0298db3533fb", extra: 1 } },
  ] as Json[]) {
    add(`baseRef = ${JSON.stringify(v)}`, (r) => (pr(r).baseRef = v), open ? MALFORMED : OK);
  }

  // Strict shape: an unrequested field anywhere in the answer is not this query's answer.
  add("extra pullRequest field", (r) => (pr(r).title = "x"), MALFORMED);
  add("extra repository field", (r) => (r.data.repository.name = "Hone"), MALFORMED);
  add("extra data field", (r) => (r.data.viewer = {}), MALFORMED);
  add("extra top-level field", (r) => (r.extensions = {}), MALFORMED);

  // Envelope.
  add("errors present", (r) => (r.errors = [{ message: "Something went wrong" }]), READ_FAILED);
  add("empty errors array", (r) => (r.errors = []), MALFORMED);
  add("pullRequest = null (not found)", (r) => (r.data.repository.pullRequest = null), READ_FAILED);
  add("repository = null (no access)", (r) => (r.data.repository = null), READ_FAILED);
  add("delete data", (r) => delete r.data, MALFORMED);
  add("data = null without errors", (r) => (r.data = null), MALFORMED);
  add("delete pullRequest", (r) => delete r.data.repository.pullRequest, MALFORMED);

  return cases;
}

/** Whole-answer cases that are not mutations of a fixture. */
export const ENVELOPE_CASES: MutationCase[] = [
  { name: "raw = null", raw: null, expect: MALFORMED },
  { name: "raw = array", raw: [], expect: MALFORMED },
  { name: "raw = string", raw: "{}", expect: MALFORMED },
  { name: "raw = number", raw: 1, expect: MALFORMED },
  { name: "errors only", raw: { errors: [{ message: "NOT_FOUND" }] }, expect: READ_FAILED },
];

// --- random fuzzing ---------------------------------------------------------

const RANDOM_VALUES: Json[] = [
  null,
  true,
  false,
  0,
  -1,
  1.5,
  2 ** 53,
  "",
  "OPEN",
  "MERGED",
  "x",
  "fe62f51f0fd95fc97d2e21eef71d179e2e701358",
  [],
  [1],
  {},
  { databaseId: 1 },
  { target: { oid: "6cdd830b0bcc5e3532016bc612bd0298db3533fb" } },
];

function paths(x: any, prefix: (string | number)[] = []): (string | number)[][] {
  if (x === null || typeof x !== "object") return [prefix];
  const out: (string | number)[][] = [prefix];
  for (const k of Object.keys(x)) out.push(...paths(x[k], [...prefix, Array.isArray(x) ? Number(k) : k]));
  return out;
}

function setAt(root: any, path: (string | number)[], value: Json, del = false) {
  if (path.length === 0) return value;
  let o = root;
  for (const k of path.slice(0, -1)) o = o[k];
  const last = path[path.length - 1];
  if (del) {
    if (Array.isArray(o)) o.splice(Number(last), 1);
    else delete o[last as string];
  } else o[last as string] = value;
  return root;
}

/** One random multi-point mutation: 1-4 deletes, replacements or additions. */
export function randomMutation(fixture: any, rand: () => number): unknown {
  let raw: any = clone(fixture);
  const ops = 1 + Math.floor(rand() * 4);
  for (let i = 0; i < ops; i++) {
    if (raw === null || typeof raw !== "object") break;
    const ps = paths(raw);
    const p = ps[Math.floor(rand() * ps.length)];
    const op = rand();
    const v = RANDOM_VALUES[Math.floor(rand() * RANDOM_VALUES.length)];
    if (op < 0.35 && p.length > 0) raw = setAt(raw, p, null, true);
    else if (op < 0.85) raw = setAt(raw, p, clone(v));
    else {
      let o = raw;
      for (const k of p) o = o?.[k];
      if (o && typeof o === "object" && !Array.isArray(o)) o[`k${Math.floor(rand() * 1000)}`] = clone(v);
    }
  }
  return raw;
}

const SHA40 = /^[0-9a-f]{40}$/;
const isPosInt = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

/**
 * Independent safety check of one accepted key: its fields satisfy the contract
 * and are exactly the raw answer's values. Returns the violated rule, or null.
 */
export function keyViolation(raw: any, key: any, expectedNumber: number): string | null {
  const keys = ["prNumber", "state", "isDraft", "headSha", "headRef", "headRepoId", "baseRef", "baseRepoId", "baseSha"];
  if (!key || typeof key !== "object") return "key is not an object";
  const got = Object.keys(key).sort();
  if (JSON.stringify(got) !== JSON.stringify([...keys].sort())) return `key fields are ${got.join(",")}`;
  if (!Object.isFrozen(key)) return "key is not frozen";
  const p = raw?.data?.repository?.pullRequest;
  if (!p) return "accepted an answer with no pull request";
  if (key.prNumber !== expectedNumber || key.prNumber !== p.number) return "prNumber does not match";
  if (!["OPEN", "CLOSED", "MERGED"].includes(key.state) || key.state !== p.state) return "state does not match";
  if (typeof key.isDraft !== "boolean" || key.isDraft !== p.isDraft) return "isDraft does not match";
  if (!SHA40.test(key.headSha) || key.headSha !== p.headRefOid) return "headSha does not match";
  if (typeof key.headRef !== "string" || key.headRef.length === 0 || key.headRef !== p.headRefName) return "headRef";
  if (typeof key.baseRef !== "string" || key.baseRef.length === 0 || key.baseRef !== p.baseRefName) return "baseRef";
  if (!isPosInt(key.baseRepoId) || key.baseRepoId !== p.baseRepository?.databaseId) return "baseRepoId";
  if (key.state === "OPEN") {
    if (!isPosInt(key.headRepoId) || key.headRepoId !== p.headRepository?.databaseId) return "headRepoId (open)";
    if (!SHA40.test(key.baseSha) || key.baseSha !== p.baseRef?.target?.oid) return "baseSha (open)";
  } else {
    if (key.baseSha !== null) return "a terminal key must have baseSha null";
    if (p.headRepository === null) {
      if (key.headRepoId !== null) return "headRepoId should be null";
    } else if (!isPosInt(key.headRepoId) || key.headRepoId !== p.headRepository?.databaseId) return "headRepoId";
  }
  return null;
}
