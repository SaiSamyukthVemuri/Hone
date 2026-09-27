import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
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

/**
 * DERIVED FROM THE DIRECTORY, NEVER ENUMERATED BY HAND.
 *
 * A fixed list would not inspect the file B2b-2 adds -- the real adapter, the
 * single most relevant boundary file there will ever be -- unless its author also
 * remembered to edit this test. It would then be free to claim the fake is the
 * default while this suite stayed green.
 */
const PROVIDER_DIR_FILES = readdirSync(path.join(ROOT, DIR))
  .filter((f) => f.endsWith(".ts"))
  .sort()
  .map((f) => `${DIR}/${f}`);

const MODULE_FILES: readonly string[] = [
  ...PROVIDER_DIR_FILES,
  "lib/waitlist/mobile-verification-server.ts",
  "lib/waitlist/profile-completion-server.ts",
];

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

/**
 * Is a matched banned phrase excused as a HISTORICAL record rather than a claim?
 *
 * A FIRST VERSION SEARCHED THE WHOLE SENTENCE for any of `not`, `was`, `none`...
 * and was satisfiable by the exact class it exists to stop: "The fake is the
 * default when the real adapter was not enabled" is a present-tense claim, and it
 * was discarded because `was` and `not` appeared elsewhere in it. Mixed
 * historical/current sentences are ordinary in these comments.
 *
 * So the excuse must ATTACH TO THE CLAUSE. Either the phrase is directly negated
 * within the words immediately before it, or the sentence carries an explicit
 * past-revision marker -- not a bare common word that happens to be present.
 */
function excused(sentence: string, re: RegExp): boolean {
  const m = sentence.match(re);
  if (!m || m.index === undefined) return false;
  // DIRECTLY negated, in the SAME CLAUSE and within three words: "is NOT the
  // default", "was NEVER the default". The window stops at a clause boundary,
  // because "the adapter was never armed, the fake is the default" is a
  // present-tense claim whose negation belongs to a different clause entirely --
  // a wider window excused exactly that sentence.
  const clause = sentence.slice(0, m.index).split(/[,;:—-]/).pop() ?? "";
  if (/\b(not|never|no longer)\b(?:\s+\S+){0,2}\s*$/i.test(clause)) return true;
  // Or the sentence explicitly records a past revision of this code.
  const HISTORY = [
    /\ban earlier revision\b/i,
    /\bthe previous revision\b/i,
    /\bits first revision\b/i,
    /\bthis module's first revision\b/i,
    /\bused to be\b/i,
    /\bwas the defect\b/i,
    /\bwas a verification bypass\b/i,
  ];
  return HISTORY.some((h) => h.test(sentence));
}

describe("no file in this boundary CLAIMS the fake is the default", () => {
  // The third finding, made unrepeatable.

  it("the hand-written list covers every file in the provider directory", () => {
    for (const f of PROVIDER_DIR_FILES) {
      expect(MODULE_FILES, `${f} is not scanned`).toContain(f);
    }
    expect(PROVIDER_DIR_FILES.length, "the provider directory looks empty").toBeGreaterThanOrEqual(
      4,
    );
  });

  it("NEGATIVE CONTROL: the allowance cannot excuse a present-tense claim", () => {
    const BANNED_CLAIM = /fake is the default/i;
    // The reviewer's own counterexample, plus the shapes around it.
    for (const stale of [
      "The fake is the default when the real adapter was not enabled.",
      "The fake is the default; none of this was changed.",
      "Because the adapter was never armed, the fake is the default.",
    ]) {
      expect(excused(stale, BANNED_CLAIM), `wrongly excused: ${stale}`).toBe(false);
    }
    // And a genuine historical record is still allowed. Judged with the SAME
    // banned pattern, because an example whose regex swallows the negator proves
    // nothing about the adjacency rule -- a first version of this control did
    // exactly that and went red on its own fixtures.
    for (const historical of [
      "An earlier revision said the fake is the default, and that was the defect.",
      "In its first revision the fake is the default, which was a verification bypass.",
      "It is not the fake is the default any more.",
    ]) {
      expect(excused(historical, BANNED_CLAIM), `wrongly flagged: ${historical}`).toBe(true);
    }
    // A negated claim does not match the banned pattern at all, so it never
    // reaches the allowance.
    expect(BANNED_CLAIM.test("The fake is not the default.")).toBe(false);
  });
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
        const offending = sentences.filter((x) => re.test(x)).filter((x) => !excused(x, re));
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
