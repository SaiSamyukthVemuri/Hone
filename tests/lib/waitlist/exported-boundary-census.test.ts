import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * THE CENSUS — the limb every previous repair was missing.
 *
 * Five repairs on this branch each fixed one operand at one boundary, and the
 * next review found the next unguarded one. They verified THE FIX; none of them
 * verified THE CLASS. This file enumerates the class mechanically, on every run,
 * from the source itself — so a new comparison-bearing export cannot join the
 * module without joining the census with it.
 *
 * THE RULE IT ENFORCES: an exported function that consumes a clock or a numeric
 * cap must take it as a VALIDATED type. Raw `Date` and raw `number` are how an
 * unreadable operand reaches a comparison and comes back as a confident answer.
 */

const DIR = path.join(process.cwd(), "lib", "waitlist");

/** Member/parameter names that carry an instant or a cap into a comparison. */
const CLOCK_NAMES = /\b(now|at|from|to|importedAt|joinedAt|asOf|since|until)\s*[?]?:/;
const CAP_NAMES = /\b(maxAgeDays|capDays|waitingTimeCapDays|thresholdDays|ageDays)\s*[?]?:/;

/** The validated types a comparison-bearing parameter is allowed to be. */
const VALIDATED = /\b(ValidInstant|ValidStalenessPolicy|DisabledStalenessPolicy|StalenessPolicy)\b/;

type Signature = { readonly file: string; readonly name: string; readonly params: string };

function stripComments(src: string): string {
  // A doc comment naming `now: Date` is prose, not a signature. Matching it was
  // a real false positive in an earlier guard on this branch.
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function sources(): { file: string; code: string }[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".ts"))
    .sort()
    .map((file) => ({ file, code: stripComments(readFileSync(path.join(DIR, file), "utf8")) }));
}

/**
 * Type declarations that CARRY a clock or a cap.
 *
 * Following the name alone was not enough, and finding that out is the point of
 * building this mechanically: `projectCandidates(rows, options: ProjectionOptions)`
 * names no clock in its own parameter list, yet it consumes one. A guard that
 * reads parameter names only would have declared it uninvolved — which is
 * precisely the drift this file exists to refuse.
 */
function evidenceCarryingTypes(all: { file: string; code: string }[]): Map<string, string> {
  const carriers = new Map<string, string>();
  for (const { code } of all) {
    const re = /(?:export )?type ([A-Za-z0-9_]+)\s*=([\s\S]*?)(?=\n(?:export )?(?:type|function|const|interface)\s|\n\/\*|$)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      const [, name, body] = m;
      if (CLOCK_NAMES.test(body!) || CAP_NAMES.test(body!)) carriers.set(name!, body!);
    }
  }
  return carriers;
}

function exportedSignatures(all: { file: string; code: string }[]): Signature[] {
  const out: Signature[] = [];
  for (const { file, code } of all) {
    const re = /export function ([A-Za-z0-9_]+)\s*(?:<[^>]*>)?\s*\(([\s\S]*?)\)\s*:/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) out.push({ file, name: m[1]!, params: m[2]! });
  }
  // Overload declarations repeat a name; the boundary is the name, not the arity.
  const seen = new Set<string>();
  return out.filter((s) => {
    const k = `${s.file}.${s.name}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * THE CENSUS, with the OWNER that answers for each entry.
 *
 * Building this mechanically immediately found something the re-entry write-up
 * had rounded off. The re-entry said "two constructors". That is true for the
 * operand family the findings were about — instants and staleness caps — but
 * `ScoringPolicy.waitingTimeCapDays` is a third raw numeric cap with its own
 * PRE-EXISTING owner, `validateScoringPolicy`, which `rankWaitlistCandidates`
 * calls and throws on. Restructuring that is out of scope for this repair, so
 * it is DECLARED here rather than quietly excluded: three owners, named, and a
 * fourth cannot appear without failing this file.
 */
const CENSUS: ReadonlyArray<readonly [string, string]> = [
  ["candidate.projectCandidates", "instant + stalenessPolicy"],
  ["confirmation.applyConfirmation", "instant"],
  ["confirmation.classifyPreferenceFreshness", "instant + stalenessPolicy"],
  ["legacy-import.planLegacyWaitlistImport", "instant"],
  ["scoring.daysBetween", "instant"],
  ["scoring.rankWaitlistCandidates", "instant + validateScoringPolicy"],
  ["policy.serializeScoringPolicy", "upstream — serialises a policy, compares nothing"],
  ["confirmation.preferenceIsActionable", "upstream — reads a computed verdict"],
  ["explain.explainCandidate", "upstream — reads an already-ranked result"],
  ["explain.explainRanking", "upstream — reads an already-ranked result"],
  ["scoring.validateScoringPolicy", "self — it IS a validator"],
  ["validated.instant", "self — it IS a constructor"],
  ["validated.optionalInstant", "self — it IS a constructor"],
  ["validated.stalenessPolicy", "self — it IS a constructor"],
  ["validated.toDate", "self — the interop edge; takes an ALREADY validated instant"],
];
const CENSUS_COMPARISON_BEARING = CENSUS.map(([k]) => k);

/**
 * Boundaries that read a COMPUTED number rather than raw evidence.
 *
 * `PreferenceFreshness.ageDays` and `ScoredCandidate.daysWaiting` are OUTPUTS
 * of a validated boundary, not operands entering one. The detector flags them
 * because it matches on member names and cannot tell input from output — so the
 * distinction is drawn here, explicitly, rather than by narrowing the regex
 * until the awkward cases disappear. Narrowing the detector is how a real
 * boundary gets excluded by accident.
 */
const DOWNSTREAM = new Set([
  "policy.serializeScoringPolicy",
  "confirmation.preferenceIsActionable",
  "explain.explainCandidate",
  "explain.explainRanking",
]);

/** Boundaries that legitimately take RAW input: their job is to judge it. */
const OWNERS = new Set([
  "validated.instant",
  "validated.optionalInstant",
  "validated.stalenessPolicy",
  "scoring.validateScoringPolicy",
  "policy.parseScoringPolicy",
]);

const ALL = sources();
const CARRIERS = evidenceCarryingTypes(ALL);

function isComparisonBearing(sig: Signature): boolean {
  // Every export of the evidence module is in scope by definition: it exists
  // only to construct or refuse comparison operands.
  if (sig.file === "validated.ts") return true;
  if (CLOCK_NAMES.test(sig.params) || CAP_NAMES.test(sig.params)) return true;
  for (const carrier of CARRIERS.keys()) {
    if (new RegExp(`\\b${carrier}\\b`).test(sig.params)) return true;
  }
  return false;
}

/**
 * Operands that are RAW on purpose, each with the owner that answers for it.
 *
 * Turning the guard from `any` to `every` immediately surfaced four, and every
 * one is recorded here rather than made to disappear by loosening the detector.
 * Loosening is how a real hole gets exempted by accident; declaring costs a
 * line and makes the next raw operand fail until someone justifies it too.
 */
const DECLARED_RAW: ReadonlyMap<string, string> = new Map([
  // The no-clock arm of the union. `undefined` is the ABSENCE of evidence, not
  // unvalidated evidence — and the arm exists precisely to forbid a finite cap
  // without a clock.
  ["ProjectionOptions.now: undefined", "n/a — the statically-disabled arm"],
  // The untrusted INPUT ROW. This is the value being parsed, not evidence being
  // consumed: parseJoinedAt refuses a non-finite or future date before it can
  // reach a comparison.
  ["LegacyImportRow.joinedAt: unknown", "parseJoinedAt — it is the input under validation"],
  // Validated at the CALL SITE rather than in the type: rankWaitlistCandidates
  // runs `instant(candidate.joinedAt)`, so an unreadable value throws instead of
  // being compared. Fail-closed, but the type does not carry it — recorded as a
  // known limit of this repair's bounded scope, not as a clean result.
  ["ScoringCandidate.joinedAt: Date", "instant() at the rankWaitlistCandidates call site"],
  // The pre-existing third owner, declared in re-entry #1 and out of scope here.
  ["ScoringPolicy.waitingTimeCapDays: number", "validateScoringPolicy (pre-existing)"],
]);

/** Every recognised clock/cap occurrence in a fragment, with its declared type. */
function operands(fragment: string): { name: string; declared: string }[] {
  const found: { name: string; declared: string }[] = [];
  const re = new RegExp(
    `\\b(now|at|from|to|importedAt|joinedAt|asOf|since|until|maxAgeDays|capDays` +
      `|waitingTimeCapDays|thresholdDays|ageDays)\\s*[?]?:\\s*([^,;)}\\n]+)`,
    "g",
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(fragment)) !== null) found.push({ name: m[1]!, declared: m[2]!.trim() });
  return found;
}

/**
 * True when EVERY clock/cap this signature can reach is a validated type.
 *
 * IT USED TO BE `ANY`, AND THAT WAS A FALSE NEGATIVE ON THE VERY CLASS THIS
 * FILE EXISTS TO CATCH. One branded type anywhere in the parameter list vouched
 * for the whole signature, so `f(now: ValidInstant, maxAgeDays: number)` passed
 * — a validated operand standing surety for a raw one sitting right beside it,
 * which is precisely the mixed shape that lets an unreadable value reach a
 * comparison. The guard has to hold for each operand or it holds for none.
 */
function takesValidatedEvidence(sig: Signature): boolean {
  return unvalidatedOperands(sig).length === 0;
}

/** The offending operands, named, so a failure says WHICH one is raw. */
function unvalidatedOperands(sig: Signature): string[] {
  const bad: string[] = [];
  for (const { name, declared } of operands(sig.params)) {
    const entry = `${name}: ${declared}`;
    if (!VALIDATED.test(declared) && !DECLARED_RAW.has(entry)) bad.push(entry);
  }
  for (const [carrier, body] of CARRIERS) {
    if (!new RegExp(`\\b${carrier}\\b`).test(sig.params)) continue;
    for (const { name, declared } of operands(body)) {
      const entry = `${carrier}.${name}: ${declared}`;
      if (!VALIDATED.test(declared) && !DECLARED_RAW.has(entry)) bad.push(entry);
    }
  }
  return bad;
}

const SIGNATURES = exportedSignatures(ALL);
const key = (s: Signature) => `${s.file.replace(/\.ts$/, "")}.${s.name}`;

describe("the exported comparison-bearing surface is enumerated, not remembered", () => {
  it("finds the module's exported functions at all", () => {
    // Anti-vacuity: a regex that matched nothing would make every assertion
    // below pass while proving precisely nothing.
    expect(SIGNATURES.length).toBeGreaterThan(20);
    expect(SIGNATURES.map(key)).toContain("confirmation.classifyPreferenceFreshness");
  });

  it("every comparison-bearing export is in the census", () => {
    // THE DRIFT GUARD. A new export that takes a clock or a cap fails here
    // until someone puts it in the census — which is the moment to ask whether
    // it takes validated evidence.
    const found = SIGNATURES.filter(isComparisonBearing).map(key).sort();
    const known = [...CENSUS_COMPARISON_BEARING].sort();
    expect(found).toEqual(known);
  });

  it("every censused boundary takes VALIDATED evidence, unless it IS an owner", () => {
    const offenders = SIGNATURES.filter(isComparisonBearing)
      .filter((s) => !OWNERS.has(key(s)))
      .filter((s) => !DOWNSTREAM.has(key(s)))
      .filter((s) => !takesValidatedEvidence(s))
      .map((s) => `${key(s)} -> raw: ${unvalidatedOperands(s).join(", ")}`);
    expect(offenders, "a comparison-bearing export must not take a raw Date or number").toEqual([]);
  });

  it("declares every RAW operand and the owner that answers for it", () => {
    // Four exist. None is silently exempt, and a fifth fails the guard above
    // until it is declared here — which is the moment to ask whether it should
    // be validated instead.
    expect([...DECLARED_RAW.keys()].sort()).toEqual([
      "LegacyImportRow.joinedAt: unknown",
      "ProjectionOptions.now: undefined",
      "ScoringCandidate.joinedAt: Date",
      "ScoringPolicy.waitingTimeCapDays: number",
    ]);
    for (const [operand, owner] of DECLARED_RAW) {
      expect(owner, `${operand} must name who answers for it`).not.toBe("");
    }
  });

  it("declares every owner, so a fourth cannot appear unnoticed", () => {
    // The property that failed before was a COUNT: five partial owners meant
    // "is this operand guarded?" had no single answer. Naming them is what
    // makes a new one visible.
    expect([...OWNERS].sort()).toEqual([
      "policy.parseScoringPolicy",
      "scoring.validateScoringPolicy",
      "validated.instant",
      "validated.optionalInstant",
      "validated.stalenessPolicy",
    ]);
    for (const [entry, owner] of CENSUS) {
      expect(owner, `${entry} must name who answers for it`).not.toBe("");
    }
  });

  it("requires EVERY operand to be validated, not merely one of them", () => {
    // The property directly: a mixed signature must be rejected. Asserted on a
    // synthetic fragment so it holds whether or not such a signature exists in
    // the module today — a guard that only works on present-tense code is a
    // guard that stops working the moment someone writes the bad shape.
    const mixed = { file: "synthetic.ts", name: "mixed",
      params: "now: ValidInstant, maxAgeDays: number" };
    expect(takesValidatedEvidence(mixed)).toBe(false);
    expect(unvalidatedOperands(mixed)).toEqual(["maxAgeDays: number"]);

    // And an UNDECLARED raw operand must fail even beside a validated one.
    const sneaky = { file: "synthetic.ts", name: "sneaky",
      params: "now: ValidInstant, until: Date" };
    expect(unvalidatedOperands(sneaky)).toEqual(["until: Date"]);

    const clean = { file: "synthetic.ts", name: "clean",
      params: "now: ValidInstant, policy: StalenessPolicy" };
    expect(takesValidatedEvidence(clean)).toBe(true);
  });

  it("resolves a clock hidden inside an options type, not just a named parameter", () => {
    // The detector must follow the TYPE. projectCandidates names no clock in
    // its own parameter list and consumes one through ProjectionOptions; a
    // name-only guard would have called it uninvolved.
    expect([...CARRIERS.keys()].sort()).toContain("ProjectionOptions");
    expect([...CARRIERS.keys()].sort()).toContain("ScoringContext");
    expect([...CARRIERS.keys()].sort()).toContain("LegacyImportOptions");
    const project = SIGNATURES.find((s) => key(s) === "candidate.projectCandidates");
    expect(project && isComparisonBearing(project)).toBe(true);
    expect(project && takesValidatedEvidence(project)).toBe(true);
  });

  it("the validated module exports exactly its three constructors", () => {
    const owners = SIGNATURES.filter((s) => s.file === "validated.ts").map((s) => s.name).sort();
    expect(owners).toEqual(["instant", "optionalInstant", "stalenessPolicy", "toDate"]);
  });
});
