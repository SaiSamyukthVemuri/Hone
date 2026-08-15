import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// PAY-READ-01 PR D - SOURCE GUARDS.
//
// SECONDARY EVIDENCE ONLY. The behavioural proof lives in
// eligibility-read-fail-closed.test.ts and
// eligibility-read-failure-money-safety.test.ts; nothing here proves runtime
// behaviour. These guards exist to stop the class of regression that a
// behavioural test cannot see: a NEW read added later that quietly forgets to
// capture its error, and drift between the two duplicated copy constants.

const SESSION = readFileSync(
  "lib/billing/session-payment-eligibility.ts",
  "utf8",
);
const FEE = readFileSync("lib/billing/manual-fee-eligibility.ts", "utf8");

const CONST_RE =
  /export const ELIGIBILITY_READ_FAILED_REASON =\s*\n?\s*"([^"]+)";/;

describe("the duplicated copy constant cannot drift", () => {
  it("both helpers declare it and the strings are identical", () => {
    const a = SESSION.match(CONST_RE)?.[1];
    const b = FEE.match(CONST_RE)?.[1];
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).toBe(b);
  });

  it("it is retryable, and asserts no business fact", () => {
    const copy = SESSION.match(CONST_RE)?.[1] ?? "";
    expect(copy).toMatch(/could not be verified/i);
    expect(copy).toMatch(/try again/i);
    // Must not claim absence of anything.
    expect(copy).not.toMatch(/not found|no card|missing|not configured/i);
  });
});

describe("no authoritative read may discard its error", () => {
  // Every Supabase destructure in these two helpers must capture `error`.
  // A new read added without one is precisely the PAY-READ defect class.
  for (const [name, src] of [
    ["session-payment-eligibility", SESSION],
    ["manual-fee-eligibility", FEE],
  ] as const) {
    it(`${name}: every \`const { data\` destructure also captures error`, () => {
      const destructures = src.match(/const \{ data[^}]*\}/g) ?? [];
      expect(destructures.length).toBeGreaterThan(0);
      const offenders = destructures.filter((d) => !d.includes("error"));
      expect(offenders).toEqual([]);
    });
  }
});

describe("both manual-fee history sources keep their errors", () => {
  it("the Promise.all destructures result objects, not bare data", () => {
    // `const [{ data: a }, { data: b }] = await Promise.all(...)` discards TWO
    // errors at once and is invisible to the per-destructure guard above.
    expect(FEE).not.toMatch(/const \[\{ data[^\]]*\] = await Promise\.all/);
    expect(FEE).toMatch(/const \[canonicalRes, legacyRes\] = await Promise\.all/);
  });

  it("a failure on EITHER source raises the read-failure reason", () => {
    expect(FEE).toMatch(/canonicalRes\.error \|\| legacyRes\.error/);
  });
});

describe("mode and tenant predicates survive", () => {
  it("session mode-bearing reads still pin stripe_livemode", () => {
    const count = (SESSION.match(/\.eq\("stripe_livemode", livemode\)/g) ?? [])
      .length;
    expect(count).toBeGreaterThanOrEqual(3);
  });

  it("manual-fee history reads still pin stripe_livemode", () => {
    const count = (FEE.match(/\.eq\("stripe_livemode", livemode\)/g) ?? [])
      .length;
    expect(count).toBeGreaterThanOrEqual(2);
  });
});

describe("the read-failure reason is raised through the dedupe helper", () => {
  it("neither helper pushes the constant directly", () => {
    // Direct pushes would allow the same line to appear several times when
    // several reads fail, which reads as several independent problems. The
    // constant may be pushed EXACTLY ONCE per file - inside pushReadFailure
    // itself - so a count above one means a call site bypassed the dedupe.
    for (const src of [SESSION, FEE]) {
      const pushes = (
        src.match(/reasons\.push\(\s*ELIGIBILITY_READ_FAILED_REASON/g) ?? []
      ).length;
      expect(pushes).toBe(1);
      expect(src).toMatch(/function pushReadFailure\(/);
    }
  });
});
