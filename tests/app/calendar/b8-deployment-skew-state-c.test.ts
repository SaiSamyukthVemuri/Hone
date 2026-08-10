import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// B8 / 0177 — DEPLOYMENT SKEW, STATE C: new database, OLD application.
//
// If 0177 is applied before the new application deploys, the still-running old
// code performs its direct postcare claim UPDATE. That write now hits a revoked
// privilege. The state is safe only if the denial happens BEFORE the provider
// call — otherwise an email would go out that the database could never record.
//
// Two independent facts are required, and this file owns the second:
//
//   C1 — the DB denies it. Proved behaviourally by T34/T35 in
//        tests/db/postcare-write-boundary.db.test.ts: service_role UPDATE of
//        each former postcare column, and a combined update, both raise 42501.
//
//   C2 — HERE. The old code reached that UPDATE before it reached the provider.
//
// C2 reads the EXACT production base, never the working tree — the working
// tree no longer contains the old implementation, and copying it back into
// runtime source just to test it would reintroduce the forbidden direct-DML the
// census guards. The base is carried as a hash-pinned fixture (see below) so
// the proof does not depend on git history being present.

const BASE = "f2d4a5aa6053b34b0198d2806786868499580b18";
const REPO_ROOT = join(__dirname, "..", "..", "..");

// THE OLD SOURCE IS FROZEN AS A FIXTURE, not read from git history at test time.
//
// The first version of this file called `git show <BASE>:...` directly. That
// passed locally and FAILED in CI, because CI checks out shallow and the base
// object simply is not in the runner's object store. A proof that only works on
// a full clone is not a proof.
//
// So the two old files are committed verbatim under tests/fixtures/, pinned by
// sha256. The ordering assertions read the fixture and therefore run
// everywhere. When git history IS available — locally, or any full clone — an
// extra assertion verifies the fixture is byte-identical to what the base
// actually contains, so the fixture cannot silently drift into fiction.
const FIXTURES: Record<string, { file: string; sha256: string }> = {
  "app/(app)/calendar/actions.ts": {
    file: "tests/fixtures/b8-base-f2d4a5aa/calendar-actions.ts.txt",
    sha256: "636ab315b779a172eae35b5f86a90df2286cbff4bdcd526fd552390bf86a7738",
  },
  "app/(app)/calendar/postcare-auto-send.ts": {
    file: "tests/fixtures/b8-base-f2d4a5aa/postcare-auto-send.ts.txt",
    sha256: "359e903e7d50f3a6f2dfe88e474f4eb0af9700cc1e2597e5543c55f581af46c0",
  },
};

function showAtBase(path: string): string {
  const fx = FIXTURES[path];
  const text = readFileSync(join(REPO_ROOT, fx.file), "utf8");
  // The fixture is only evidence if it is the evidence it claims to be.
  expect(createHash("sha256").update(text, "utf8").digest("hex"), `${fx.file} sha256`).toBe(
    fx.sha256,
  );
  return text;
}

/** True only where the base commit is actually present (full clone). */
function baseAvailable(): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", `${BASE}^{commit}`], { cwd: REPO_ROOT });
    return true;
  } catch {
    return false;
  }
}

/** Strip line comments so prose cannot satisfy or defeat an ordering check. */
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l))
    .join("\n");

describe("STATE C2 — the OLD application claimed before it sent", () => {
  it("the frozen fixtures are byte-identical to the real base (full clone only)", () => {
    // Where history exists, prove the fixtures ARE the base. Where it does not
    // (a shallow CI checkout), this cannot run — and the test says so out loud
    // rather than passing silently, because a skipped verification that looks
    // like a pass is exactly the failure mode this suite guards against.
    if (!baseAvailable()) {
      expect(
        process.env.CI ?? "",
        "no base object: only acceptable on a shallow CI checkout",
      ).not.toBe("");
      return;
    }
    for (const [path, fx] of Object.entries(FIXTURES)) {
      const real = execFileSync("git", ["show", `${BASE}:${path}`], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
      });
      expect(createHash("sha256").update(real, "utf8").digest("hex"), path).toBe(fx.sha256);
    }
  });

  it("OLD MANUAL: the direct claim UPDATE precedes sendPostcareToClient", () => {
    const src = codeOnly(showAtBase("app/(app)/calendar/actions.ts"));
    const start = src.indexOf("export async function sendPostcareEmailAction");
    expect(start, "the old action must exist at the base").toBeGreaterThan(-1);
    const body = src.slice(start);

    // The old first-send claim: a direct UPDATE assigning the claim column.
    const claim = body.indexOf("postcare_email_claimed_at:");
    const provider = body.indexOf("sendPostcareToClient(");
    expect(claim, "old manual claim UPDATE not found").toBeGreaterThan(-1);
    expect(provider, "old provider call not found").toBeGreaterThan(-1);
    expect(
      claim,
      "the old claim write must precede the provider call, or 42501 would " +
        "arrive too late to prevent an email",
    ).toBeLessThan(provider);

    // And it really was a direct table write, not a command.
    expect(body.slice(0, provider)).toMatch(/\.from\("appointments"\)[\s\S]{0,120}\.update\(/);
  });

  it("OLD AUTO: the direct claim UPDATE precedes sendPostcareToClient", () => {
    const src = codeOnly(showAtBase("app/(app)/calendar/postcare-auto-send.ts"));
    const claim = src.indexOf("postcare_email_claimed_at:");
    const provider = src.indexOf("await send({");
    expect(claim, "old auto claim UPDATE not found").toBeGreaterThan(-1);
    expect(provider, "old auto provider call not found").toBeGreaterThan(-1);
    expect(claim).toBeLessThan(provider);
    expect(src.slice(0, provider)).toMatch(/\.from\("appointments"\)[\s\S]{0,120}\.update\(/);
  });

  it("the CURRENT tree no longer contains those old direct writers", () => {
    // Non-vacuity in the other direction: this file reads history, so it must
    // not be mistaken for a statement about the shipping code. The census
    // (tests/security/appointment-direct-dml-guard.test.ts) owns that claim;
    // this asserts the contrast so the two cannot silently agree by accident.
    const now = codeOnly(
      readFileSync(join(REPO_ROOT, "app/(app)/calendar/postcare-auto-send.ts"), "utf8"),
    );
    expect(now).not.toMatch(/\.from\("appointments"\)[\s\S]{0,120}\.update\(/);
    expect(now).toMatch(/claim_postcare_send/);
  });
});
