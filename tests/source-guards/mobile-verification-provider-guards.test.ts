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
  "lib/waitlist/mobile-verification-flow.ts",
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
 * Is a matched banned phrase excused?
 *
 * ONLY BY AN EXPLICIT MARKER ON THE SAME LINE, and deliberately by nothing else.
 *
 * TWO NATURAL-LANGUAGE VERSIONS OF THIS WERE BOTH SATISFIABLE, each defeated by
 * a sentence a reviewer wrote in one line:
 *
 *   v1 searched the whole sentence for a permissive token, so "The fake is the
 *      default when the real adapter was not enabled" was excused by `was`.
 *   v2 required a negator within three words in the same punctuated clause, so
 *      "The real adapter is not configured and fake is the default" was excused
 *      by a negator belonging to a SIBLING clause with no comma between them.
 *
 * Every repair widened the grammar I had to reason about, and the next
 * counterexample was always one conjunction away. English is not a decidable
 * language and this guard should not pretend otherwise.
 *
 * SO THE ALLOWANCE IS NOT INFERRED, IT IS DECLARED. A comment that legitimately
 * records what an earlier revision did marks itself `[historical]`, which this
 * repo already does for exactly this problem -- see the
 * `canonical-facts:ignore-start reason=...` regions in
 * tests/docs/canonical-production-facts.test.ts. An author cannot write the
 * marker by accident, a reviewer sees it in the diff, and no sentence structure
 * can produce one.
 */
const HISTORICAL_MARKER = "[historical]";

function excused(line: string): boolean {
  return line.includes(HISTORICAL_MARKER);
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

  it("NEGATIVE CONTROL: no sentence structure can excuse a present-tense claim", () => {
    // Every counterexample a review produced against the two natural-language
    // versions, plus the shapes around them. None carries the marker, so none is
    // excused -- and no future conjunction can change that.
    for (const stale of [
      "The fake is the default when the real adapter was not enabled.",
      "The real adapter is not configured and fake is the default",
      "An earlier revision used failClosed, but the fake is the default",
      "The fake is the default; none of this was changed.",
      "Because the adapter was never armed, the fake is the default.",
      "It used to be fail-closed, however the fake is the default now.",
    ]) {
      expect(excused(stale), `wrongly excused: ${stale}`).toBe(false);
    }
    // And a declared historical record is allowed, by the marker and only by it.
    expect(excused("[historical] an earlier revision had the fake is the default")).toBe(true);
    expect(
      excused("an earlier revision had the fake is the default"),
      "prose alone must not excuse",
    ).toBe(false);
  });
  const BANNED: ReadonlyArray<readonly [RegExp, string]> = [
    [/fake is the default/i, "asserts the fake is the default"],
    [/\bit is the default\b/i, "asserts the fake is the default ('it is the default')"],
    [/default(?:s)?\s+(?:is|to)\s+the\s+fake/i, "says the default is/defaults to the fake"],
    [/fake[- ]by[- ]default/i, "says fake-by-default"],
  ];

  for (const rel of MODULE_FILES) {
    it(`${rel.split("/").pop()} makes no stale fake-default claim`, () => {
      // PER LINE, because the marker is per line. Whitespace is flattened first
      // within each comment line so a phrase cannot hide behind wrapping; a claim
      // deliberately split across two lines is caught by the sentence pass below.
      const lines = commentsOf(read(rel)).split("\n").map((l) => l.replace(/\s+/g, " ").trim());
      const sentences = claimSentences(read(rel));
      for (const [re, why] of BANNED) {
        const offending = [
          ...lines.filter((x) => re.test(x) && !excused(x)),
          // A wrapped claim: present in the joined sentence but in no single line,
          // so it cannot carry a marker and is simply illegal.
          ...sentences.filter((x) => re.test(x) && !lines.some((l) => re.test(l))),
        ];
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

// ===========================================================================
// WAIT B2b-2 — THE REAL ADAPTER AND THE AUTHORIZED FLOW
// ===========================================================================
//
// B2b-1's guards asserted the SHAPE of a boundary with no real adapter in it.
// These assert the properties that only matter once one exists: that the live
// path is unreachable without the flag, that the adapter cannot log a secret, and
// that the single promoting command still has a single caller.

const ADAPTER = `${DIR}/twilio-verify-provider.ts`;
const FLOW = "lib/waitlist/mobile-verification-flow.ts";

describe("the live path is reachable only through the flag", () => {
  const SRC = read(`${DIR}/index.ts`);

  it("the resolver's armed branch is guarded by liveMobileVerificationArmed", () => {
    const body = SRC.slice(SRC.indexOf("export function resolveMobileVerificationProvider"));
    const upToBrace = body.slice(0, body.indexOf("\n}"));
    // The unarmed return must come FIRST and be unconditional, so no edit can
    // reorder the branches into an armed-by-default resolver without failing here.
    const guard = upToBrace.indexOf("liveMobileVerificationArmed");
    const failClosedReturn = upToBrace.indexOf("return failClosed");
    const realReturn = upToBrace.indexOf("return twilioVerify");
    expect(guard, "the armed branch is not gated by the arming predicate").toBeGreaterThan(-1);
    expect(failClosedReturn).toBeGreaterThan(guard);
    expect(realReturn, "the real adapter is returned before the fail-closed guard").toBeGreaterThan(
      failClosedReturn,
    );
  });

  it("all four configuration inputs are required by the ONE shared predicate", () => {
    // READ FROM ./arming.ts, WHICH IS WHERE IT LIVES NOW. It was defined in
    // index.ts, which the adapter cannot import (index imports the adapter), and
    // that circularity is exactly why the flag ended up with a single enforcement
    // point. One definition below both of them removes the choice.
    const ARMING = read(`${DIR}/arming.ts`);
    const body = ARMING.slice(ARMING.indexOf("export function liveMobileVerificationArmed"));
    const upToBrace = body.slice(0, body.indexOf("\n}"));
    for (const needle of [
      "REAL_PROVIDER_FLAG",
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "VERIFY_SERVICE_SID",
    ]) {
      expect(upToBrace, `${needle} is not required to arm`).toContain(needle);
    }
    // `&&` throughout: one `||` here would make any single input sufficient.
    expect(upToBrace).not.toMatch(/\|\|/);
    // AND THERE IS ONLY ONE DEFINITION. A second would be two predicates that can
    // drift, which is the shape of the bypass this file now guards against.
    const definers: string[] = [];
    for (const f of PROVIDER_DIR_FILES) {
      if (/export function liveMobileVerificationArmed/.test(read(f))) definers.push(f);
    }
    expect(definers).toEqual([`${DIR}/arming.ts`]);
  });

  it("THE ADAPTER RE-CHECKS THE PREDICATE ITSELF, on every call", () => {
    // P1 at b6cecbb0. The resolver's gate was the only enforcement point AND the
    // adapter class is exported, so `new TwilioVerifyProvider()` sent a real SMS
    // with the flag unset -- in any deployment that already sends SMS, which is
    // every production one. A held instance also survived a disarm, making the
    // documented rollback wrong.
    const CODE = codeOf(read(ADAPTER));
    expect(CODE, "the adapter does not consult the arming predicate").toContain(
      "liveMobileVerificationArmed",
    );
    // Inside readConfig, which every operation calls before doing anything.
    const cfg = CODE.slice(CODE.indexOf("function readConfig"));
    const body = cfg.slice(0, cfg.indexOf("\n}"));
    expect(body, "readConfig does not gate on the flag").toMatch(
      /if\s*\(\s*!liveMobileVerificationArmed\(\)\s*\)\s*return null/,
    );
    // FIRST in the body: before any env value is read, so no ordering change can
    // leave a path that touches configuration without consulting the flag.
    expect(body.indexOf("liveMobileVerificationArmed")).toBeLessThan(
      body.indexOf("process.env"),
    );
  });

  it("nothing but the resolver decides which provider to use", () => {
    // A second `new TwilioVerifyProvider()` anywhere would be a live path that
    // skips the resolver's gate.
    //
    // COMMENT-STRIPPED, AND THAT IS NOT A DETAIL. This boundary documents its own
    // past bypasses by QUOTING THEM, so the exact expression a guard here looks for
    // is also the expression the comments contain. Matching raw source made this
    // fail on arming.ts, whose header quotes `new TwilioVerifyProvider().start(...)`
    // while explaining why that must not work. Third time in this boundary that a
    // guard matched prose instead of code -- so every matcher in this file runs over
    // codeOf(), and a new one that does not is a bug waiting to happen.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
      for (const entry of readdirSync(path.join(ROOT, dir))) {
        if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
        const rel = `${dir}/${entry}`;
        if (statSync(path.join(ROOT, rel)).isDirectory()) {
          walk(rel);
          continue;
        }
        if (!/\.tsx?$/.test(entry)) continue;
        if (rel === `${DIR}/index.ts` || rel === ADAPTER) continue;
        if (/new TwilioVerifyProvider\s*\(/.test(codeOf(read(rel)))) offenders.push(rel);
      }
    };
    for (const top of ["app", "components", "lib"]) walk(top);
    expect(offenders, "a live provider is constructed outside the resolver").toEqual([]);
  });
});

describe("the rollback the code documents is the rollback that works", () => {
  // P1 at 442ca286. An earlier revision said reading the flag per call made the
  // rollback a flag change with no redeploy. On Vercel it does not: unsetting a
  // hosted variable leaves `process.env` untouched in the deployment already
  // serving traffic, so an armed deployment keeps sending until it is redeployed.
  // This repository had already written the correct model down for live payments
  // ("unset STRIPE_ALLOW_LIVE_MODE + redeploy").
  //
  // GUARDED AS A PRESENCE, NOT AS AN ABSENCE. This file's own HISTORICAL_MARKER
  // machinery exists because banning an English claim is undecidable and every
  // repair widened the grammar. So rather than trying to ban "no redeploy" in all
  // its phrasings, this asserts the TRUE statement is present where an operator
  // would look for it. Deleting the paragraph fails the test; rewording it does not.
  it("the arming module states that rollback requires a redeploy", () => {
    const ARMING = commentsOf(read(`${DIR}/arming.ts`)).replace(/\s+/g, " ");
    expect(ARMING, "the redeploy requirement is not stated").toMatch(/redeploy/i);
    expect(ARMING, "the hosting model that causes it is not named").toMatch(/Vercel/i);
  });

  it("no file in the boundary claims a rollback needs no redeploy", () => {
    // ONE narrow phrase, per line, excusable only by the explicit marker -- the
    // same contract the fake-default claims use. Not an attempt to parse English:
    // just the exact sentence shape that was wrong, so reintroducing it verbatim is
    // caught while an honest rewording is free.
    for (const rel of MODULE_FILES) {
      const lines = commentsOf(read(rel))
        .split("\n")
        .map((l) => l.replace(/\s+/g, " ").trim());
      const offending = lines.filter(
        (l) => /(needs?|requires?|without)\s+no\s+redeploy|no\s+redeploy\s+(is\s+)?(needed|required)/i.test(l) && !excused(l),
      );
      expect(offending, `${rel} claims a rollback needs no redeploy: ${offending.join(" / ")}`).toEqual(
        [],
      );
    }
  });
});

describe("the adapter cannot leak what it holds", () => {
  const SRC = read(ADAPTER);
  const CODE = codeOf(SRC);

  it("emits NO logs at all", () => {
    // It holds an Auth Token, a full phone number, a one-time code and a raw
    // provider payload in local scope. There is no log statement to audit, so
    // none can drift into carrying one of them.
    expect(CODE).not.toMatch(/console\./);
    expect(CODE).not.toMatch(/\blogger\b/);
    expect(CODE).not.toMatch(/captureException|Sentry/);
  });

  it("reads the Auth Token in exactly one place and never interpolates it into a message", () => {
    // ONE ENV READ. A second would be a second place to get the credential from.
    expect([...CODE.matchAll(/TWILIO_AUTH_TOKEN/g)]).toHaveLength(1);
    // AND EXACTLY ONE USE OF THE VALUE: the Basic credential. Counting `authToken`
    // occurrences was the first version of this and it was a bad assertion -- the
    // name legitimately appears in the Config type, the read, the null check and
    // the return, so the count said "5" about correct code. What matters is not how
    // many times it is NAMED but that it is INTERPOLATED exactly once, into the
    // Authorization header and nowhere else.
    const interpolations = [...CODE.matchAll(/\$\{[^}]*authToken[^}]*\}/g)];
    expect(interpolations, "the token is interpolated somewhere unexpected").toHaveLength(1);
    const around = CODE.slice(
      Math.max(0, (interpolations[0].index ?? 0) - 120),
      (interpolations[0].index ?? 0) + 60,
    );
    expect(around, "the token's one interpolation is not the Basic header").toContain("Basic");
    expect(CODE).not.toMatch(/(Error|message|throw)[^\n]*authToken/);
  });

  it("never stringifies a provider response", () => {
    expect(CODE).not.toMatch(/JSON\.stringify\s*\(\s*(json|res|body)/);
    expect(CODE).not.toMatch(/String\s*\(\s*(json|res\.json)/);
  });

  it("every request is bounded by a timeout", () => {
    expect(CODE).toContain("AbortController");
    expect(CODE).toMatch(/setTimeout\(\s*\(\)\s*=>\s*controller\.abort\(\)/);
    expect(CODE).toMatch(/signal:\s*controller\.signal/);
    expect(CODE).toContain("clearTimeout");
  });

  it("reads its configuration per call, not at module load", () => {
    // A module-load read would freeze an unarmed process into needing a restart
    // to disarm, which would make the documented rollback wrong.
    expect(CODE).not.toMatch(/^const\s+\w+\s*=\s*process\.env/m);
    expect(CODE).toMatch(/function readConfig/);
  });
});

describe("the adapter's approval is the only approval", () => {
  const CODE = codeOf(read(ADAPTER));

  it("`approved` is returned from exactly one place, in check", () => {
    const approvals = [...CODE.matchAll(/return\s+"approved"/g)];
    expect(approvals).toHaveLength(1);
    const checkAt = CODE.indexOf("async check(");
    expect(approvals[0].index, "an approval is returned outside check()").toBeGreaterThan(checkAt);
  });

  it("start has no path to an approval at all", () => {
    const start = CODE.slice(CODE.indexOf("async start("), CODE.indexOf("async check("));
    expect(start).not.toContain('"approved"');
  });

  it("an unrecognised provider status is never a rejection", () => {
    // `rejected` is a statement about the person's code. A default branch that
    // said it would tell someone their proof was wrong when nothing judged it.
    const defaults = [...CODE.matchAll(/default:[\s\S]{0,120}?return\s+"(\w+)"/g)].map(
      (m) => m[1],
    );
    expect(defaults.length).toBeGreaterThanOrEqual(1);
    for (const d of defaults) expect(d).toBe("unavailable");
  });
});

describe("the two operations keep separate code sets", () => {
  const CODE = codeOf(read(ADAPTER));

  it("no single shared rate-limit set exists", () => {
    // P2 at b72d393d. One shared `RATE_LIMIT_CODES` put 60202 -- max CHECK attempts,
    // which is terminal -- into `rate_limited` on the check path, which both gave
    // false retry advice AND re-exposed a distinction ./types.ts coarsens on purpose.
    // Reunifying the sets is the single edit that would bring it back.
    expect(CODE, "a shared set invites the 60202 defect back").not.toMatch(
      /const RATE_LIMIT_CODES\b/,
    );
    expect(CODE).toMatch(/const START_RATE_LIMIT_CODES\b/);
    expect(CODE).toMatch(/const CHECK_RATE_LIMIT_CODES\b/);
  });

  it("the check path consults its TERMINAL codes before its window codes", () => {
    // Order is the property: a terminal verification must never be reported as a
    // retryable limit, whichever set a future code is added to.
    const check = CODE.slice(CODE.indexOf("async check("));
    const rejectAt = check.indexOf("CHECK_REJECTION_CODES");
    const limitAt = check.indexOf("CHECK_RATE_LIMIT_CODES");
    expect(rejectAt, "the check path does not consult terminal codes").toBeGreaterThan(-1);
    expect(limitAt).toBeGreaterThan(-1);
    expect(rejectAt, "window codes are consulted before terminal ones").toBeLessThan(limitAt);
  });

  it("THE CODE TABLE OUTRANKS EVERY STATUS-CLASS BRANCH, in both operations", () => {
    // P2 at 7e5f78e1, AND THE REASON THE ASSERTION ABOVE WAS NOT ENOUGH. That one
    // compares the two sibling branches to each other, and both sat inside the
    // `>= 400` arm -- below `if (res.status === 429) return "rate_limited"`. Twilio
    // sends 60202 WITH a 429, so the generic branch answered first and the guard was
    // satisfied while the defect was live. Comparing siblings proves nothing about a
    // branch that shadows them both, so this compares against the status branches.
    for (const [op, first] of [
      ["async start(", "START_RATE_LIMIT_CODES"],
      ["async check(", "CHECK_REJECTION_CODES"],
    ] as const) {
      const start = CODE.indexOf(op);
      const end = CODE.indexOf("\n  }", start);
      const body = CODE.slice(start, end === -1 ? undefined : end);
      const codeAt = body.indexOf(first);
      expect(codeAt, `${op} does not consult ${first}`).toBeGreaterThan(-1);
      // Every status-class branch AFTER the 2xx and 404 handling must come later.
      for (const branch of [
        /res\.status === 429/,
        /res\.status === 401/,
        /res\.status >= 500/,
        /res\.status >= 400/,
      ]) {
        const m = body.match(branch);
        if (!m || m.index === undefined) continue;
        expect(
          codeAt,
          `${op}: ${branch} is tested before the error-code table, so it shadows it`,
        ).toBeLessThan(m.index);
      }
    }
  });

  it("no code appears in both a rejection set and a rate-limit set", () => {
    // Overlap would make the outcome depend on branch order rather than on meaning.
    const setOf = (name: string): number[] => {
      const at = CODE.indexOf(`const ${name}`);
      if (at === -1) return [];
      const body = CODE.slice(at, CODE.indexOf("]", at));
      return [...body.matchAll(/\b(\d{5})\b/g)].map((m) => Number(m[1]));
    };
    const reject = new Set(setOf("CHECK_REJECTION_CODES"));
    for (const c of setOf("CHECK_RATE_LIMIT_CODES")) {
      expect(reject.has(c), `${c} is in both check sets`).toBe(false);
    }
    expect(reject.size, "the terminal set is empty, so the ordering proves nothing").toBeGreaterThan(0);
  });
});

describe("the promoting command still has exactly one caller", () => {
  it("mark_waitlist_mobile_verified has exactly ONE call site, not one file", () => {
    // 0203's own column comment says the ordering -- provider first, write only on
    // approval -- is an APPLICATION contract and not a database guarantee. A
    // second call site is therefore a second place that contract can be broken,
    // and it would not fail any behavioural test.
    //
    // COUNTED PER CALL SITE, BECAUSE THE FIRST VERSION COUNTED FILES AND A
    // MUTATION WALKED STRAIGHT THROUGH IT. It asserted the set of files naming the
    // command equalled one path, so a SECOND invocation added INSIDE
    // mobile-verification-server.ts -- the likeliest place for one, since it is the
    // module that legitimately holds the first -- kept the set at one file and the
    // guard stayed green. The claim was "exactly one caller"; the enforcement was
    // "exactly one file". Only the mutation told them apart.
    let callSites = 0;
    const offenders: string[] = [];
    const walk = (dir: string) => {
      const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
      for (const entry of readdirSync(path.join(ROOT, dir))) {
        if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
        const rel = `${dir}/${entry}`;
        if (statSync(path.join(ROOT, rel)).isDirectory()) {
          walk(rel);
          continue;
        }
        if (!/\.tsx?$/.test(entry)) continue;
        // A COMMENT MENTION IS NOT A CALL SITE, and the first version of this
        // guard did not distinguish them -- it reported three files, two of which
        // only DISCUSS the command (this boundary documents it heavily, on purpose).
        // What must stay singular is the number of places that INVOKE it.
        const hits = [
          ...codeOf(read(rel)).matchAll(/rpc\(\s*["']mark_waitlist_mobile_verified["']/g),
        ];
        if (hits.length === 0) continue;
        callSites += hits.length;
        offenders.push(rel);
      }
    };
    for (const top of ["app", "components", "lib"]) walk(top);
    expect(offenders).toEqual(["lib/waitlist/mobile-verification-server.ts"]);
    expect(callSites, "the promoting command is invoked more than once").toBe(1);
  });
});

describe("the canonical limiter-order policy describes the order that ships", () => {
  // P2 at 322da8a4. MOBILE_VERIFICATION_LIMITS' header said "the entry dimension is
  // checked first" -- borrowed from PROOF_REQUEST_LIMITS, true of the original
  // single-call design, and false from the moment the gates were split. It is the
  // CANONICAL POLICY TEXT a future refactor reads, so it pointed at the vulnerable
  // ordering.
  //
  // A MUTATION FOUND THIS GAP, NOT A REVIEW: I corrected the prose and added no guard,
  // so reverting it stayed green. Two of the eight findings on this branch were stale
  // prose; prose that encodes a security ordering needs a guard like anything else.
  //
  // SCOPED TO THIS BLOCK ONLY. PROOF_REQUEST_LIMITS below legitimately checks its
  // invitation dimension first -- it has no pre-authorization stage -- so a
  // whole-file assertion would be wrong about correct code.
  const POLICY = read("lib/waitlist/delivery/policy.ts");
  const BLOCK = (() => {
    const at = POLICY.indexOf("WAIT B2b-2 — possession-proof attempt budgets");
    expect(at, "the B2b-2 budget block is gone").toBeGreaterThan(-1);
    return POLICY.slice(at, POLICY.indexOf("export const PROOF_REQUEST_LIMITS"));
  })();

  it("states the pre-resolution IP gate FIRST, then resolution, then the entry gate", () => {
    const flat = BLOCK.replace(/\s+/g, " ");
    const ip = flat.search(/PRE-RESOLUTION IP GATE/i);
    const resolution = flat.search(/authorization resolution/i);
    const entry = flat.search(/POST-RESOLUTION ENTRY GATE/i);
    for (const [n, i] of [["IP gate", ip], ["resolution", resolution], ["entry gate", entry]] as const) {
      expect(i, `the policy does not name the ${n}`).toBeGreaterThan(-1);
    }
    expect(ip, "the policy puts resolution before the IP gate").toBeLessThan(resolution);
    expect(resolution, "the policy puts the entry gate before resolution").toBeLessThan(entry);
  });

  it("does NOT claim the entry dimension is checked first", () => {
    const offending = BLOCK.split("\n")
      .map((l) => l.replace(/\s+/g, " ").trim())
      .filter((l) => /entry dimension is checked first|entry (?:gate|dimension)[^.]{0,30}\bfirst\b/i.test(l) && !excused(l));
    expect(
      offending,
      `the canonical policy claims the entry dimension is checked first: ${offending.join(" / ")}`,
    ).toEqual([]);
  });

  it("records the three properties the ordering depends on", () => {
    const flat = BLOCK.replace(/\s+/g, " ");
    expect(flat, "one-IP-charge-per-request is not stated").toMatch(/ONE REQUEST SPENDS ONE IP BUDGET/i);
    expect(flat, "server-resolved keying is not stated").toMatch(/SERVER-RESOLVED/i);
    expect(flat, "fail-open is not stated").toMatch(/fail-open/i);
    expect(flat, "the not-authorization caveat is not stated").toMatch(/NOT AUTHORIZATION/i);
  });
});

describe("the adapter states its precedence invariant ONCE, and correctly", () => {
  const COMMENTS = commentsOf(read(ADAPTER)).replace(/\s+/g, " ");

  it("says the error code outranks the status class", () => {
    // P2 at ef5a9278: this file stated the invariant twice, in opposite directions.
    // The stale half described the pre-fix implementation and would have led a
    // maintainer to restore the 429/60202 shadowing bug.
    expect(COMMENTS, "the correct precedence is not stated").toMatch(
      /recognized error code outranks the generic HTTP status class|error code outranks/i,
    );
  });

  it("does NOT still say the status class decides first", () => {
    // The exact stale sentence shape, per line, excusable only by the marker -- the
    // same contract the other prose guards in this file use.
    const lines = commentsOf(read(ADAPTER))
      .split("\n")
      .map((l) => l.replace(/\s+/g, " ").trim());
    // NARROW ON PURPOSE, AND THE FIRST VERSION WAS NOT. It also matched
    // "status class first" anywhere, which caught the line that EXPLAINS why the
    // code must win ("keying on the status class first makes the outcome depend on
    // which one Twilio chose") -- prose that rejects the bad approach, not prose
    // that asserts it. That is the undecidability this file already documents, so
    // this matches only the ASSERTIVE sentence shape, and a deliberate quotation of
    // it carries [historical] like every other recorded defect here.
    const offending = lines.filter(
      (l) => /(?:every branch|branches?)[^.]{0,40}decides? first on the HTTP status/i.test(l) && !excused(l),
    );
    expect(
      offending,
      `the adapter still claims the status class decides first: ${offending.join(" / ")}`,
    ).toEqual([]);
  });
});

describe("the authorized flow keeps its seam open and its surface narrow", () => {
  const SRC = read(FLOW);
  const CODE = codeOf(SRC);

  it("ships NO default resolver, so a surface must name its authorization", () => {
    // Which capability resolves a verification context is owner decision D1. A
    // plausible-looking default would put an identity decision in place that
    // nobody chose -- the same shape as B2b-1's first resolver, which looked inert
    // and was not.
    expect(CODE).not.toMatch(/resolve\s*:\s*VerificationContextResolver\s*=/);
    expect(CODE).not.toMatch(/resolve\s*=\s*\w/);
  });

  it("accepts no phone number from a caller, at any entry point", () => {
    // The property that stops this being a waitlist-membership oracle.
    expect(CODE).not.toMatch(/e164/);
    const signatures = [...CODE.matchAll(/export async function \w+\(([\s\S]*?)\)\s*:/g)].map(
      (m) => m[1],
    );
    expect(signatures.length).toBe(2);
    for (const sig of signatures) {
      expect(sig, `a flow entry point accepts a phone: ${sig}`).not.toMatch(/phone/i);
      expect(sig).not.toMatch(/destination/i);
    }
  });

  it("emits no logs of its own", () => {
    expect(CODE).not.toMatch(/console\./);
  });

  it("the unresolved-context refusal has exactly one site, and is not_proved", () => {
    // ONE site so the decision has one place to land. `not_proved` because a
    // resolver that runs and returns null has decided the authorization proves
    // nothing, and because it is the value a provider refusal already yields -- so a
    // caller cannot tell the two apart. It was `unavailable`, which leaked
    // authorization validity (P2 at ef5a9278).
    // ONE DECLARATION, AND ONE USE -- IN THE FUNNEL. This asserted "at least three
    // occurrences" as a proxy for "used on both operations", and the funnel made that
    // proxy WRONG by centralising it to two: the declaration and the single use.
    // Counting was never the property. Being declared once and reachable only through
    // afterResolution() is.
    expect([...CODE.matchAll(/const UNRESOLVED_CONTEXT_REFUSAL/g)]).toHaveLength(1);
    const funnelAt = CODE.indexOf("function afterResolution");
    expect(funnelAt).toBeGreaterThan(-1);
    const funnel = CODE.slice(funnelAt, CODE.indexOf("\n}", funnelAt));
    expect(funnel, "the funnel does not use the constant").toContain("UNRESOLVED_CONTEXT_REFUSAL");
    // And nowhere else constructs a refusal from it directly.
    const uses = [...CODE.matchAll(/code:\s*UNRESOLVED_CONTEXT_REFUSAL/g)];
    expect(uses, "the coarse refusal is constructed outside the funnel").toHaveLength(1);
    expect(CODE).toMatch(/UNRESOLVED_CONTEXT_REFUSAL:\s*VerificationRefusal\s*=\s*"not_proved"/);
    expect(
      CODE,
      "an unresolved context must not report an outage; that distinguishes it from a refusal",
    ).not.toMatch(/UNRESOLVED_CONTEXT_REFUSAL[^\n]*=\s*"unavailable"/);
  });

  it("EVERY return at or after resolution goes through the ONE funnel", () => {
    // THE GENERAL RULE, GUARDED STRUCTURALLY. The previous guard searched for a
    // literal `code: "rate_limited"` after `await resolve(` -- true of the code it was
    // written against, and BLIND to an outcome arriving indirectly from a lower layer,
    // which is exactly how the provider-passthrough leak escaped it. Searching for
    // one spelling of one bad value cannot express "no detailed outcome may surface".
    //
    // So this asserts the shape instead: after resolution the flow may return NOTHING
    // but `afterResolution(...)`. A future negative outcome added to StartOutcome or
    // CheckOutcome is then coarsened without anyone editing the flow, because there is
    // no other way for a post-resolution path to construct a FlowOutcome.
    for (const fn of [
      "export async function runStartMobileVerification",
      "export async function runCheckMobileVerification",
    ]) {
      const at = CODE.indexOf(fn);
      expect(at, `${fn} is missing`).toBeGreaterThan(-1);
      const body = CODE.slice(at, CODE.indexOf("\n}", at));
      const resolveAt = body.indexOf("await resolve(");
      expect(resolveAt, `${fn} never resolves`).toBeGreaterThan(-1);
      const after = body.slice(resolveAt);
      const returns = [...after.matchAll(/return\s+[^;]+;/g)].map((m) =>
        m[0].replace(/\s+/g, " "),
      );
      expect(returns.length, `${fn} returns nothing after resolution`).toBeGreaterThan(0);
      for (const r of returns) {
        expect(
          r,
          `${fn} returns something other than the funnel after resolution: ${r}`,
        ).toMatch(/^return afterResolution\(/);
      }
    }
  });

  it("the funnel can only produce success or the coarse refusal", () => {
    const at = CODE.indexOf("function afterResolution");
    expect(at, "the funnel is gone").toBeGreaterThan(-1);
    const body = CODE.slice(at, CODE.indexOf("\n}", at));
    expect(body).toMatch(/\{\s*ok:\s*true\s*\}/);
    expect(body).toMatch(/code:\s*UNRESOLVED_CONTEXT_REFUSAL/);
    // No detailed code may be spelled inside it either.
    for (const leak of ["rate_limited", "unavailable", "no_destination"]) {
      expect(body, `the funnel can emit ${leak}`).not.toContain(leak);
    }
  });

  it("the flow never reads a lower-layer refusal code", () => {
    // `outcome.code` was read once, and that single expression was the whole
    // provider-passthrough leak. Nothing at this boundary needs it.
    expect(CODE, "the flow reads a lower-layer code").not.toMatch(/outcome\.code/);
  });

  it("a POST-RESOLUTION denial never reports rate_limited", () => {
    // P2 at 8110c1fc. `rate_limited` is safe from the PRE-authorization IP gate,
    // which answers identically for a valid and an invalid capability. It is not safe
    // from anything reachable only after a context resolves: a distinct outcome there
    // is a statement that the capability was good, and the shipped budgets made it
    // readable in four requests from one IP.
    //
    // ASSERTED BY POSITION, not by counting: every `rate_limited` in this module must
    // appear BEFORE the first `await resolve(` of its function, and every return after
    // that point must use the coarsened constant.
    for (const fn of [
      "export async function runStartMobileVerification",
      "export async function runCheckMobileVerification",
    ]) {
      const at = CODE.indexOf(fn);
      expect(at, `${fn} is missing`).toBeGreaterThan(-1);
      const body = CODE.slice(at, CODE.indexOf("\n}", at));
      const resolveAt = body.indexOf("await resolve(");
      expect(resolveAt, `${fn} never resolves`).toBeGreaterThan(-1);
      const after = body.slice(resolveAt);
      expect(
        after,
        `${fn} reports rate_limited after authorization, which reveals capability validity`,
      ).not.toMatch(/code:\s*"rate_limited"/);
      // And the pre-auth gate still reports it, so the value has not left the
      // vocabulary altogether.
      expect(body.slice(0, resolveAt)).toMatch(/code:\s*"rate_limited"/);
    }
  });

  it("the per-entry gate is still consulted in both operations", () => {
    // The counterweight: coarsening the refusal must not have been achieved by
    // deleting the gate.
    expect([...CODE.matchAll(/limitMobileVerificationEntry\(/g)]).toHaveLength(2);
    expect([...CODE.matchAll(/limitMobileVerificationIp\(/g)]).toHaveLength(2);
  });

  it("never calls the promoting RPC itself", () => {
    expect(CODE).not.toContain("mark_waitlist_mobile_verified");
    expect(CODE).not.toContain("createAdminClient");
  });
});
