import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// G1 (REVIEW-PROCESS-GAPS-20261028): the pending-release receipt was only
// checked after a merge, so a missing or malformed docs/production/
// pending-releases/<pr>.json cost an extra head, run and review (#1202, #1204,
// #1205, #1207, #1209). This asks the same question while the PR is open, in
// the existing unit lane, with no new job and no workflow change.
//
// It runs only inside a pull_request run (Actions writes the event payload to
// GITHUB_EVENT_PATH for every step). Locally and on push it is a no-op for the
// live case; the pure rule below is proved by its own cases either way.
//
// Scope: presence and shape, and that `migrations` names exactly the migration
// paths the PR changes. `runtime` is NOT judged here; that needs the A3 classifier
// and stays with tests/docs/canonical-production-facts.test.ts after the merge.

const ROOT = path.resolve(__dirname, "../..");
const RECORD_ONLY = /^docs\/production\//;
const MIGRATION = /^supabase\/migrations\//;
const KEYS = new Set(["pr", "runtime", "migrations", "release_receipt"]);

export type Verdict = { ok: true } | { ok: false; reason: string };

/** A PR whose every changed file is under docs/production/ is record-only: no receipt. */
export function isRecordOnly(changed: string[]): boolean {
  return changed.length > 0 && changed.every((f) => RECORD_ONLY.test(f));
}

/** `text` is the receipt's content at the PR head, or null when the file is absent. */
export function checkPrReceipt(pr: number, changed: string[], text: string | null): Verdict {
  if (isRecordOnly(changed)) return { ok: true };
  const file = `docs/production/pending-releases/${pr}.json`;
  if (text === null) {
    return { ok: false, reason: `${file} is missing: a PR that is not record-only must carry its release receipt` };
  }
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { ok: false, reason: `${file} is not valid JSON` };
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return { ok: false, reason: `${file} is not a JSON object` };
  const o = v as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !KEYS.has(k));
  if (extra.length) return { ok: false, reason: `${file} has unknown key(s) ${JSON.stringify(extra)}` };
  if (o.pr !== pr) return { ok: false, reason: `${file} says pr ${JSON.stringify(o.pr)}, expected ${pr}` };
  if (typeof o.runtime !== "boolean") return { ok: false, reason: `${file}: runtime must be true or false` };
  if (!Array.isArray(o.migrations) || !o.migrations.every((m) => typeof m === "string")) {
    return { ok: false, reason: `${file}: migrations must be an array of paths` };
  }
  if (o.release_receipt !== `01-ops/${pr}-release-receipt.json`) {
    return { ok: false, reason: `${file}: release_receipt must be 01-ops/${pr}-release-receipt.json` };
  }
  const declared = [...(o.migrations as string[])].sort();
  const actual = changed.filter((f) => MIGRATION.test(f)).sort();
  if (JSON.stringify(declared) !== JSON.stringify(actual)) {
    return {
      ok: false,
      reason: `${file}: migrations ${JSON.stringify(declared)} must equal the migration paths this PR changes ${JSON.stringify(actual)}`,
    };
  }
  return { ok: true };
}

const good = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ pr: 7, runtime: true, migrations: [], release_receipt: "01-ops/7-release-receipt.json", ...over });
const APP = ["app/page.tsx"];

describe("G1: PR-time pending-release receipt", () => {
  it("record-only PRs need no receipt", () => {
    expect(checkPrReceipt(7, ["docs/production/current-state.md"], null)).toEqual({ ok: true });
    expect(checkPrReceipt(7, ["docs/production/pending-releases/3.json"], null)).toEqual({ ok: true });
  });

  it("a well-formed receipt passes, with and without migrations", () => {
    expect(checkPrReceipt(7, APP, good())).toEqual({ ok: true });
    const m = "supabase/migrations/0300_x.sql";
    expect(checkPrReceipt(7, [...APP, m], good({ migrations: [m] }))).toEqual({ ok: true });
  });

  // Negative controls: each of these must fail, or the check proves nothing.
  it("N1: a non-record PR with no receipt fails", () => {
    const v = checkPrReceipt(7, APP, null);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toMatch(/pending-releases\/7\.json is missing/);
  });

  it("N1b: docs outside docs/production/ is not record-only", () => {
    expect(checkPrReceipt(7, ["docs/09_DATABASE_AND_RLS.md"], null).ok).toBe(false);
    expect(checkPrReceipt(7, ["docs/production/a.md", "README.md"], null).ok).toBe(false);
  });

  it.each([
    ["not JSON", "{"],
    ["an array", "[]"],
    ["a wrong pr", good({ pr: 8 })],
    ["a string pr", good({ pr: "7" })],
    ["a non-boolean runtime", good({ runtime: "true" })],
    ["a missing runtime", JSON.stringify({ pr: 7, migrations: [], release_receipt: "01-ops/7-release-receipt.json" })],
    ["non-array migrations", good({ migrations: "none" })],
    ["a wrong release_receipt", good({ release_receipt: "01-ops/8-release-receipt.json" })],
    ["an unknown key", good({ extra: 1 })],
    ["a merge key (late receipts are post-merge only)", good({ merge: "a".repeat(40) })],
  ])("N2: %s fails", (_n, text) => {
    expect(checkPrReceipt(7, APP, text).ok).toBe(false);
  });

  it("N3: migrations that disagree with the diff fail, both ways", () => {
    const m = "supabase/migrations/0300_x.sql";
    expect(checkPrReceipt(7, [...APP, m], good()).ok).toBe(false); // undeclared
    expect(checkPrReceipt(7, APP, good({ migrations: [m] })).ok).toBe(false); // phantom
  });

  it("the live PR carries its receipt (pull_request runs only)", () => {
    const eventPath = process.env.GITHUB_EVENT_PATH;
    if (process.env.GITHUB_EVENT_NAME !== "pull_request" || !eventPath || !existsSync(eventPath)) return;
    const pr = (JSON.parse(readFileSync(eventPath, "utf8")) as {
      pull_request: { number: number; base: { sha: string }; head: { sha: string } };
    }).pull_request;
    const git = (...a: string[]) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 });
    // Same basis as ci.yml's "Collect changed files": merge base to PR head, no rename folding.
    const mb = git("merge-base", pr.base.sha, pr.head.sha).trim();
    const changed = git("diff", "--name-only", "--no-renames", mb, pr.head.sha).split("\n").filter(Boolean);
    let text: string | null = null;
    try {
      text = git("show", `${pr.head.sha}:docs/production/pending-releases/${pr.number}.json`);
    } catch {
      text = null;
    }
    const v = checkPrReceipt(pr.number, changed, text);
    expect(v.ok ? "ok" : v.reason).toBe("ok");
  });
});
