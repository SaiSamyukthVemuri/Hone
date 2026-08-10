import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
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
// C2 is read from the EXACT frozen production base with `git show`, never from
// the working tree — the working tree no longer contains the old
// implementation, and copying it back in just to test it would put forbidden
// direct-DML into the runtime source the census guards.
//
// The SHA is pinned so future history cannot silently change what "old app"
// means.

const BASE = "f2d4a5aa6053b34b0198d2806786868499580b18";
const REPO_ROOT = join(__dirname, "..", "..", "..");

function showAtBase(path: string): string {
  return execFileSync("git", ["show", `${BASE}:${path}`], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
}

/** Strip line comments so prose cannot satisfy or defeat an ordering check. */
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l))
    .join("\n");

describe("STATE C2 — the OLD application claimed before it sent", () => {
  it("the pinned base is reachable and is the recorded production SHA", () => {
    // If this throws, the rest of the file proves nothing — so it is asserted
    // first rather than assumed.
    const sha = execFileSync("git", ["rev-parse", `${BASE}^{commit}`], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
    expect(sha).toBe(BASE);
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
      execFileSync("git", ["show", "HEAD:app/(app)/calendar/postcare-auto-send.ts"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      }),
    );
    expect(now).not.toMatch(/\.from\("appointments"\)[\s\S]{0,120}\.update\(/);
    expect(now).toMatch(/claim_postcare_send/);
  });
});
