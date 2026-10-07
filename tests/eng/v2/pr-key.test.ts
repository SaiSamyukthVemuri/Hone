import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { PR_KEY_QUERY, keysEqual, parsePrKey } from "../../../scripts/eng/v2/contract/pr-key.mjs";
import {
  ENVELOPE_CASES,
  keyViolation,
  mulberry32,
  randomMutation,
  singlePointCases,
  type MutationCase,
} from "./support/key-mutations";

// ===========================================================================
// ENG-LOOP V1 05A, gap row 1: coherent PR identity, including the draft flag.
//
// THE INVARIANT UNDER TEST: a raw GraphQL answer becomes a PrSnapshotKey only
// when it satisfies the contract exactly (PR-SNAPSHOT-01 §2; `isDraft` from
// PR-SNAPSHOT-DRAFT-01 §15). Anything else is `malformed`, or `read_failed`
// when GitHub reported an error or no pull request. Validation happens on the
// RAW answer, before any projection: there is no default branch.
//
// Fixtures are real, unedited answers recorded on 2026-10-07 for #800 (OPEN,
// draft), #809 (MERGED), #776 (OPEN on a non-production base) and #623 (CLOSED,
// never merged).
// ===========================================================================

const FIXTURES = path.join(__dirname, "fixtures", "pr-key");
const load = (f: string) => JSON.parse(readFileSync(path.join(FIXTURES, f), "utf8"));
const REAL: Record<string, { file: string; number: number }> = {
  "#800 open draft": { file: "pr-800-open-draft.json", number: 800 },
  "#809 merged": { file: "pr-809-merged.json", number: 809 },
  "#776 open, feature base": { file: "pr-776-open-feature-base.json", number: 776 },
  "#623 closed unmerged": { file: "pr-623-closed-unmerged.json", number: 623 },
};

type Result = { ok: true; key: any } | { ok: false; reason: string; detail?: string };
type Validator = (raw: unknown, opts: { expectedNumber: number }) => Result;

/** Run every spec-derived case against a validator; return the failures. */
function specFailures(validator: Validator): string[] {
  const failures: string[] = [];
  const check = (c: MutationCase, expectedNumber: number) => {
    let r: Result;
    try {
      r = validator(c.raw, { expectedNumber });
    } catch (e) {
      failures.push(`${c.name}: threw ${(e as Error).message}`);
      return;
    }
    if (c.expect.ok) {
      if (!r.ok) failures.push(`${c.name}: expected a key, got ${r.reason} (${r.detail ?? ""})`);
      else {
        const v = keyViolation(c.raw, r.key, expectedNumber);
        if (v) failures.push(`${c.name}: accepted key violates the contract: ${v}`);
      }
    } else if (r.ok) failures.push(`${c.name}: expected ${c.expect.reason}, got a key`);
    else if (r.reason !== c.expect.reason) failures.push(`${c.name}: expected ${c.expect.reason}, got ${r.reason}`);
  };
  for (const [label, { file, number }] of Object.entries(REAL)) {
    for (const c of singlePointCases(label, load(file))) check(c, number);
  }
  for (const c of ENVELOPE_CASES) check(c, 800);
  return failures;
}

/** Seeded random fuzzing: safety properties only, since outcomes are not predictable. */
function fuzzFailures(validator: Validator, iterations: number, seed: number): string[] {
  const rand = mulberry32(seed);
  const entries = Object.values(REAL);
  const failures: string[] = [];
  for (let i = 0; i < iterations; i++) {
    const { file, number } = entries[Math.floor(rand() * entries.length)];
    const raw = randomMutation(load(file), rand);
    let r: Result;
    try {
      r = validator(raw, { expectedNumber: number });
    } catch (e) {
      failures.push(`#${i}: threw ${(e as Error).message}`);
      continue;
    }
    if (!r || typeof r !== "object" || typeof r.ok !== "boolean") {
      failures.push(`#${i}: result is not a closed result`);
    } else if (r.ok) {
      const v = keyViolation(raw, r.key, number);
      if (v) failures.push(`#${i}: accepted an invalid key (${v}): ${JSON.stringify(raw)}`);
    } else if (!["malformed", "read_failed"].includes(r.reason)) {
      failures.push(`#${i}: reason ${r.reason} is outside the closed set`);
    }
  }
  return failures;
}

describe("PrSnapshotKey: real answers", () => {
  it("parses the open draft #800, with the live base tip as baseSha", () => {
    const r = parsePrKey(load("pr-800-open-draft.json"), { expectedNumber: 800 });
    expect(r).toEqual({
      ok: true,
      key: {
        prNumber: 800,
        state: "OPEN",
        isDraft: true,
        headSha: "fe62f51f0fd95fc97d2e21eef71d179e2e701358",
        headRef: "docs/arch-01-eng-loop-v2",
        headRepoId: 1240764106,
        baseRef: "claude/build-hone-saas-hOex7",
        baseRepoId: 1240764106,
        baseSha: "6cdd830b0bcc5e3532016bc612bd0298db3533fb",
      },
    });
    expect(Object.isFrozen(r.key)).toBe(true);
  });

  it("gives a merged PR a null baseSha: a terminal PR has no live merge target", () => {
    const r = parsePrKey(load("pr-809-merged.json"), { expectedNumber: 809 });
    expect(r.ok).toBe(true);
    expect(r.key.state).toBe("MERGED");
    expect(r.key.baseSha).toBeNull();
  });

  it("parses a closed, never-merged PR as terminal", () => {
    const r = parsePrKey(load("pr-623-closed-unmerged.json"), { expectedNumber: 623 });
    expect(r.ok).toBe(true);
    expect(r.key.state).toBe("CLOSED");
    expect(r.key.baseSha).toBeNull();
  });

  it("parses a PR on a non-production base: wrong_base is the consumer's rule, not a parse failure", () => {
    const r = parsePrKey(load("pr-776-open-feature-base.json"), { expectedNumber: 776 });
    expect(r.ok).toBe(true);
    expect(r.key.baseRef).toBe("feat/ux02-slice2-settings-sectionlabel");
  });

  it("asks GitHub for exactly the nine key fields, in one request", () => {
    for (const f of [
      "number",
      "state",
      "isDraft",
      "headRefOid",
      "headRefName",
      "headRepository{databaseId}",
      "baseRefName",
      "baseRepository{databaseId}",
      "baseRef{target{oid}}",
    ]) {
      expect(PR_KEY_QUERY.replace(/\s+/g, "")).toContain(f);
    }
  });
});

describe("PrSnapshotKey: the contract, mutation by mutation", () => {
  it("every spec-derived single-point mutation gets exactly the required outcome", () => {
    expect(specFailures(parsePrKey)).toEqual([]);
  });

  it("seeded fuzzing never yields an invalid key, an exception or an open-set reason", () => {
    expect(fuzzFailures(parsePrKey, 3000, 20261007)).toEqual([]);
  });
});

describe("PrSnapshotKey: equality is structural over all nine fields", () => {
  const base = () => parsePrKey(load("pr-800-open-draft.json"), { expectedNumber: 800 }).key;

  it("equal answers give equal keys", () => {
    expect(keysEqual(base(), base())).toBe(true);
  });

  it("a draft toggle alone is a key change", () => {
    const raw = load("pr-800-open-draft.json");
    raw.data.repository.pullRequest.isDraft = false;
    expect(keysEqual(base(), parsePrKey(raw, { expectedNumber: 800 }).key)).toBe(false);
  });

  it("a base-tip advance alone is a key change", () => {
    const raw = load("pr-800-open-draft.json");
    raw.data.repository.pullRequest.baseRef.target.oid = "0".repeat(40);
    expect(keysEqual(base(), parsePrKey(raw, { expectedNumber: 800 }).key)).toBe(false);
  });

  it("null equals only null", () => {
    const merged = parsePrKey(load("pr-809-merged.json"), { expectedNumber: 809 }).key;
    expect(keysEqual(merged, { ...merged })).toBe(true);
    expect(keysEqual(merged, { ...merged, baseSha: "0".repeat(40) })).toBe(false);
  });
});

describe("the harness has teeth: an unsafe validator is detected", () => {
  // The coercing projection CP-005a uses today (`Boolean(pr.draft)`, `?? null`)
  // applied to this answer. It is exactly the failure mode the contract forbids:
  // a missing or mistyped field silently becomes a plausible value.
  const coercing: Validator = (raw: any) => {
    const p = raw?.data?.repository?.pullRequest ?? {};
    return {
      ok: true,
      key: Object.freeze({
        prNumber: p.number ?? null,
        state: p.state ?? null,
        isDraft: Boolean(p.isDraft),
        headSha: p.headRefOid ?? null,
        headRef: p.headRefName ?? null,
        headRepoId: p.headRepository?.databaseId ?? null,
        baseRef: p.baseRefName ?? null,
        baseRepoId: p.baseRepository?.databaseId ?? null,
        baseSha: p.state === "OPEN" ? (p.baseRef?.target?.oid ?? null) : null,
      }),
    };
  };

  it("the spec cases reject the coercing mutant", () => {
    expect(specFailures(coercing).length).toBeGreaterThan(50);
  });

  it("the fuzzer rejects the coercing mutant", () => {
    expect(fuzzFailures(coercing, 3000, 20261007).length).toBeGreaterThan(100);
  });

  it("a mutant that only forgets the draft flag is caught", () => {
    const forgetsDraft: Validator = (raw, opts) => {
      const r = parsePrKey(raw, opts);
      return r.ok ? { ok: true, key: Object.freeze({ ...r.key, isDraft: false }) } : r;
    };
    expect(specFailures(forgetsDraft).some((f) => f.includes("isDraft"))).toBe(true);
  });
});
