import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// ===========================================================================
// THE VERIFICATION PROVIDER BOUNDARY, GUARDED AT THE SOURCE
// ===========================================================================
//
// WHY THIS FILE EXISTS, STATED PLAINLY: the same defect class escaped this slice
// THREE TIMES, and every time the behavioural tests were green.
//
//   1. The header promised an unconfigured deployment returns `unavailable`;
//      `resolveMobileVerificationProvider` returned the FAKE, which approves a
//      fixed exported code. A verification bypass. (P1)
//   2. `startMobileVerification` documented "an unknown outcome is an outage";
//      `checkMobileVerification` reported unknown outcomes as `not_proved`,
//      telling a person their proof was rejected when nothing evaluated it. (P2)
//   3. After fixing (1), three files still ASSERTED the fake was the default --
//      one of them calling that "the safety property". A maintainer adding the
//      real adapter and following those comments would write
//      `armed ? real : fake` and restore the bypass. (P2)
//
// In all three the stated rule was right and something else disagreed with it.
// Behavioural tests cannot catch that: they execute the code and never read the
// claim. So the claims are asserted here, as source.
//
// This is the same instrument tests/source-guards/sms-provider-guards.test.ts
// applies to the SEND boundary, for the same reason.

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const DIR = "lib/waitlist/mobile-verification";
const MODULE_FILES = [
  `${DIR}/index.ts`,
  `${DIR}/types.ts`,
  `${DIR}/fake-provider.ts`,
  `${DIR}/fail-closed-provider.ts`,
  "lib/waitlist/mobile-verification-server.ts",
  "lib/waitlist/profile-completion-server.ts",
] as const;

/** Comment text only: this guard is about what the files CLAIM. */
function commentsOf(src: string): string {
  const out: string[] = [];
  for (const line of src.split("\n")) {
    const m = line.match(/^\s*(?:\/\/|\*|\/\*\*?)\s?(.*)$/);
    if (m) out.push(m[1]);
  }
  return out.join("\n");
}

/** Code with comments removed: for the guards that are about what RUNS. */
function codeOf(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

/**
 * Comment prose as SENTENCES with whitespace flattened.
 *
 * A line-by-line scan is not good enough and this lane has proved it twice: a
 * banned phrase survives by falling across a line break, and a negation that
 * makes the phrase legal sits on the line above it. Both are invisible to a
 * per-line regex.
 */
function claimSentences(src: string): string[] {
  return commentsOf(src)
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

describe("the resolver's default is fail-closed, in code", () => {
  const SRC = read(`${DIR}/index.ts`);

  it("resolveMobileVerificationProvider returns the fail-closed provider", () => {
    const body = SRC.slice(SRC.indexOf("export function resolveMobileVerificationProvider"));
    const upToBrace = body.slice(0, body.indexOf("\n}"));
    expect(upToBrace, "the default resolver must not return the fake").not.toMatch(
      /return\s+fake\b/,
    );
    expect(upToBrace).toMatch(/return\s+failClosed\b/);
  });

  it("the fake is never the fallback of a conditional in the resolver", () => {
    // Catches the specific edit the third finding warned about: an armed/unarmed
    // ternary whose unarmed branch is the fake.
    const body = SRC.slice(SRC.indexOf("export function resolveMobileVerificationProvider"));
    const upToBrace = body.slice(0, body.indexOf("\n}"));
    expect(upToBrace, "`armed ? real : fake` recreates the bypass").not.toMatch(
      /\?[\s\S]*:\s*fake\b/,
    );
    expect(upToBrace).not.toMatch(/\|\|\s*fake\b/);
    expect(upToBrace).not.toMatch(/\?\?\s*fake\b/);
  });

  it("the fake is only ever handed out by the explicitly named accessor", () => {
    const returnsFake = [...SRC.matchAll(/return\s+fake\b/g)];
    expect(returnsFake).toHaveLength(1);
    const before = SRC.slice(0, returnsFake[0].index ?? 0);
    expect(
      before.slice(-260),
      "the one `return fake` must be inside fakeMobileVerificationProvider",
    ).toMatch(/export function fakeMobileVerificationProvider/);
  });
});

describe("no file in this boundary CLAIMS the fake is the default", () => {
  // The third finding, made unrepeatable.
  const BANNED: ReadonlyArray<readonly [RegExp, string]> = [
    [/fake is the default/i, "asserts the fake is the default"],
    [/\bit is the default\b/i, "asserts the fake is the default ('it is the default')"],
    [/default(?:s)?\s+(?:is|to)\s+the\s+fake/i, "says the default is/defaults to the fake"],
    [/fake[- ]by[- ]default/i, "says fake-by-default"],
  ];

  for (const rel of MODULE_FILES) {
    it(`${rel.split("/").pop()} makes no stale fake-default claim`, () => {
      const sentences = claimSentences(read(rel));
      for (const [re, why] of BANNED) {
        // A claim about a PAST revision is legal and useful, so a sentence that
        // also says it was wrong, or names the earlier revision, is allowed
        // through. Judged per SENTENCE, because the negation routinely sits on a
        // different LINE from the phrase it negates.
        const offending = sentences
          .filter((x) => re.test(x))
          .filter(
            (x) =>
              !/\b(not|never|no longer|none|earlier|previous|was|were|revision|defect|bypass|opposite|collapses?)\b/i.test(
                x,
              ),
          );
        expect(offending, `${rel} ${why}: ${offending.join(" / ")}`).toEqual([]);
      }
    });
  }
});

describe("the documented outage rule is the rule both paths follow", () => {
  const SRC = read("lib/waitlist/mobile-verification-server.ts");

  it("neither entry point ends in a catch-all that reports not_proved", () => {
    // The second finding. `not_proved` is a statement about the person's code and
    // only an explicit rejection earns it.
    // COMMENT-STRIPPED. This module's comments deliberately quote the defective
    // expression to record what went wrong, and a guard that a comment can
    // satisfy -- or trip -- is not a guard. That mistake was made twice in this
    // lane already.
    expect(
      codeOf(SRC),
      "a catch-all `!== approved` misreports unknown outcomes",
    ).not.toMatch(/!==\s*"approved"[\s\S]{0,80}not_proved/);
  });

  it("both switches map an unknown outcome to unavailable", () => {
    // THREE switches have a default branch, not two: `start`, `check`, and the
    // one over the RPC's returned code. A first version of this assertion pinned
    // the count at 2 and went red on correct code -- the third branch is right
    // and wanted. What matters is not how many there are but that EVERY ONE of
    // them fails to an outage, so that is what is asserted.
    const defaults = [...codeOf(SRC).matchAll(/default:[\s\S]{0,260}?return\s*\{[^}]*\}/g)].map(
      (m) => m[0],
    );
    expect(defaults.length, "every switch on a provider or command result needs a default").toBeGreaterThanOrEqual(3);
    for (const d of defaults) {
      expect(d, `a default branch does not fail to an outage: ${d.slice(-90)}`).toMatch(
        /code:\s*"unavailable"/,
      );
    }
  });
});

describe("the fake's approving code cannot reach the promotion path", () => {
  it("the server module never references the fake or its code", () => {
    const SRC = read("lib/waitlist/mobile-verification-server.ts");
    expect(SRC).not.toMatch(/FAKE_VERIFICATION_CODE/);
    expect(SRC).not.toMatch(/FakeMobileVerificationProvider/);
  });

  it("the fail-closed provider can return no approval at all", () => {
    const SRC = read(`${DIR}/fail-closed-provider.ts`);
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
    expect(code).not.toMatch(/"approved"/);
    expect(code).not.toMatch(/"started"/);
    expect([...code.matchAll(/return\s+"unavailable"/g)]).toHaveLength(2);
  });
});
