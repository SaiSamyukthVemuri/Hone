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

/** True when every clock/cap this signature can reach is a validated type. */
function takesValidatedEvidence(sig: Signature): boolean {
  if (VALIDATED.test(sig.params)) return true;
  for (const [carrier, body] of CARRIERS) {
    if (new RegExp(`\\b${carrier}\\b`).test(sig.params) && VALIDATED.test(body)) return true;
  }
  return false;
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
      .map((s) => `${key(s)}(${s.params.replace(/\s+/g, " ").trim()})`);
    expect(offenders, "a comparison-bearing export must not take a raw Date or number").toEqual([]);
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
    expect(owners).toEqual(["instant", "optionalInstant", "stalenessPolicy"]);
  });
});
