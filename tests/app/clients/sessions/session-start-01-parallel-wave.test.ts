import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// SESSION-START-01 slice 2A — the destination's independent reads run in ONE wave.
//
// MEASURED, not assumed. With perf-timing instrumentation over three runs of the
// same scenarios, the region span `session-chart.domain` moved:
//
//     before  [401, 423, 462] ms      after  [312, 302, 342] ms
//
// The individual reads got SLOWER (payment-eligibility 78-94 -> 96-119) while
// the region got FASTER. That is the signature of real parallelism: the reads
// now contend for connections instead of queueing behind each other, and the
// page waits for the slowest rather than the sum.
//
// WHAT THIS FILE PROVES is the structural precondition for that number — that
// the reads are actually issued together. A timing assertion would be flaky;
// this is the stable half, and the measurement is recorded in the handoff.

const PAGE_PATH = path.resolve(
  __dirname,
  "../../../../app/(app)/clients/[id]/sessions/[sessionId]/page.tsx",
);
const RAW = readFileSync(PAGE_PATH, "utf8");
const SOURCE = RAW.replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

/** The single wave: from `] = await Promise.all([` back to its destructure. */
function waveBlock(): string {
  const end = SOURCE.indexOf("] = await Promise.all([");
  expect(end, "the destination must issue its independent reads in one wave").toBeGreaterThan(-1);
  const start = SOURCE.lastIndexOf("const [", end);
  const close = SOURCE.indexOf("]);", end);
  expect(close).toBeGreaterThan(end);
  return SOURCE.slice(start, close + 3);
}

/**
 * The wave's top-level elements, split on depth-0 commas with string literals
 * respected. Derived from the source so no expectation in this file is a
 * hand-maintained count.
 */
function waveElements(): string[] {
  const wave = waveBlock();
  const open = wave.indexOf("Promise.all([") + "Promise.all([".length;
  const body = wave.slice(open, wave.lastIndexOf("]"));
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (quote) {
      cur += c;
      if (c === "\\") {
        cur += body[i + 1] ?? "";
        i += 1;
      } else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      cur += c;
    } else if ("([{".includes(c)) {
      depth += 1;
      cur += c;
    } else if (")]}".includes(c)) {
      depth -= 1;
      cur += c;
    } else if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.filter((p) => p.trim().length > 0);
}

const THE_EIGHT = [
  "getRecentEntryForClient",
  "getLaserTreatmentCountsForClient",
  "getSessionAudit",
  "getClientTags",
  "buildClinicalNoteSections",
  "getSessionPaymentEligibility",
  "getAuthoritativeSessionPaymentAmount",
  "getAppointmentSettlements",
] as const;

describe("SESSION-START-01 2A: the eight independent reads are issued together", () => {
  it("every one of them is inside the wave", () => {
    const wave = waveBlock();
    for (const read of THE_EIGHT) {
      expect(wave, `${read} must be in the wave, not serial`).toContain(read);
    }
  });

  it("NEGATIVE CONTROL: none of them is also awaited outside the wave", () => {
    // The failure this catches: a read left behind as `const x = await read(...)`
    // while the wave still names it. The page would look parallel and still
    // pay the serial cost — and every assertion above would pass.
    const wave = waveBlock();
    const outside = SOURCE.replace(wave, "");
    for (const read of THE_EIGHT) {
      expect(
        outside,
        `${read} is still awaited outside the wave — the wave is decorative`,
      ).not.toMatch(new RegExp(`await\\s+(?:timed\\([^)]*\\)\\s*=>\\s*)?${read}\\(`));
    }
  });

  it("NEGATIVE CONTROL: the ARRAY contains no await, which would serialise it", () => {
    // `Promise.all([await a(), await b()])` type-checks, runs serially, and
    // would satisfy "all eight are in the wave". This is the assertion that
    // separates a real wave from that shape.
    //
    // Scoped to the array CONTENTS, not the whole block: the block necessarily
    // opens with `= await Promise.all([`, and an earlier revision of this test
    // matched that and failed itself.
    const wave = waveBlock();
    const open = wave.indexOf("Promise.all([");
    const contents = wave.slice(open + "Promise.all([".length);
    expect(
      contents,
      "an await inside the array evaluates before the array is built, so the reads serialise",
    ).not.toMatch(/await\s/);
  });

  it("each read keeps its own span, so a regression stays attributable", () => {
    const wave = waveBlock();
    // ALL EIGHT, not the six that are unconditional.
    //
    // This list held six while the wave held eight, so the two CONDITIONAL
    // reads — laser-only treatment counts, linked-appointment-only settlements
    // — ran inside the advertised wave with no span of their own. The source
    // comment claimed "each read keeps its own timed() span" and this guard was
    // supposed to hold it to that; enumerating a subset made the guard agree
    // with the comment while both were wrong, and the measured "slowest
    // individual read" evidence covered 6 of 8.
    //
    // A conditional read is exactly the kind that regresses unnoticed, because
    // it is absent from the common path a reader checks.
    for (const span of [
      "session-chart.recent-entry",
      "session-chart.treatment-counts",
      "session-chart.audit",
      "session-chart.tags",
      "session-chart.clinical-notes",
      "session-chart.payment-eligibility",
      "session-chart.payment-amount",
      "session-chart.settlements",
    ]) {
      expect(wave).toContain(span);
    }
  });

  it("NEGATIVE CONTROL: EVERY element of the wave carries a span, per element", () => {
    // COUNTING SPANS IS NOT THE SAME CLAIM AS "EVERY READ HAS ONE", and the
    // first version of this control got that wrong: it asserted the number of
    // distinct spans was 8. A ninth element added with no timed() leaves the
    // span count at 8, so that control passed on exactly the regression it was
    // written to catch — the same subset-vs-all mistake as the six-entry list
    // above, one level up.
    //
    // So the expectation is derived from the wave itself and checked PER
    // ELEMENT. Nothing here is hand-maintained: add a read and this fails until
    // it carries its own span, whatever the total happens to be.
    const elements = waveElements();
    expect(elements.length, "the wave must still have elements to check").toBeGreaterThan(0);

    const untimed = elements
      .map((e, i) => ({ i, e: e.trim() }))
      .filter(({ e }) => !/timed\(\s*"[^"]+"/.test(e));
    expect(
      untimed.map(({ i, e }) => `#${i}: ${e.slice(0, 60)}`),
      "every element of the wave must carry its own timed() span",
    ).toEqual([]);

    const spans = elements.flatMap((e) => [...e.matchAll(/timed\(\s*"([^"]+)"/g)].map((m) => m[1]));
    expect(
      new Set(spans).size,
      `one DISTINCT span per element — saw ${spans.join(", ")}`,
    ).toBe(elements.length);
  });
});

describe("SESSION-START-01 2A: what the wave must NOT have changed", () => {
  it("the critical reads still block — the chart cannot render without them", () => {
    // client + session are awaited BEFORE the wave, because every member of the
    // wave takes one of their outputs. Folding them in would be a correctness
    // bug, not an optimisation.
    const core = SOURCE.indexOf('timed("session-chart.core"');
    const wave = SOURCE.indexOf("] = await Promise.all([");
    expect(core).toBeGreaterThan(-1);
    expect(core, "core must resolve before the wave that depends on it").toBeLessThan(wave);
  });

  it("identity is untouched and still resolved before any domain read", () => {
    const identity = SOURCE.indexOf('timed("session-chart.identity"');
    const core = SOURCE.indexOf('timed("session-chart.core"');
    expect(identity).toBeGreaterThan(-1);
    expect(identity).toBeLessThan(core);
  });

  it("no Suspense boundary was introduced on this route", () => {
    // Deliberate: this route's own actions call revalidatePath 39 times, and a
    // route Suspense boundary plus revalidatePath of that route is the recorded
    // "Suspense bricks pending-gated controls" defect. Parallelising is safe;
    // streaming here is not, and is not part of this slice.
    expect(SOURCE).not.toContain("Suspense");
  });

  it("the derivations still run after the reads they consume", () => {
    const wave = SOURCE.indexOf("] = await Promise.all([");
    for (const derived of [
      "const lastEntryNotFromThisSession",
      "const sessionPaymentAmount",
      "const liveSettlement",
    ]) {
      const at = SOURCE.indexOf(derived);
      expect(at, `${derived} must exist`).toBeGreaterThan(-1);
      expect(at, `${derived} must be derived after the wave resolves`).toBeGreaterThan(wave);
    }
  });
});
