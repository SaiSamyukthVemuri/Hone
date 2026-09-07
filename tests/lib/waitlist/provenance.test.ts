import { describe, expect, it } from "vitest";
import {
  AVAILABILITY_SOURCES,
  availabilitySourceRequiresPractitioner,
  ENTRY_SOURCES,
  INFERRED_NAME_PROVENANCE,
  JOINED_AT_PROVENANCES,
  joinedAtSupportsDuration,
  parseVocabulary,
  PROPOSED_NAME_PROVENANCES,
  provenanceMatchesSource,
  sourceRequiresCreatingPractitioner,
} from "@/lib/waitlist/provenance";

// WAIT-ADMIT-01 — the rules that keep a weak value from passing as a strong one.

describe("entry source", () => {
  it("names the three routes an entry can arrive by", () => {
    expect(ENTRY_SOURCES).toEqual(["public_booking", "practitioner", "legacy_import"]);
  });

  it("requires a named operator for exactly the operator-originated routes", () => {
    expect(sourceRequiresCreatingPractitioner("public_booking")).toBe(false);
    expect(sourceRequiresCreatingPractitioner("practitioner")).toBe(true);
    expect(sourceRequiresCreatingPractitioner("legacy_import")).toBe(true);
  });
});

describe("only the form may claim 'form'", () => {
  it("accepts the honest pairings", () => {
    expect(provenanceMatchesSource("public_booking", "form")).toBe(true);
    expect(provenanceMatchesSource("practitioner", "operator_supplied")).toBe(true);
    expect(provenanceMatchesSource("legacy_import", "operator_supplied")).toBe(true);
    expect(provenanceMatchesSource("legacy_import", "unknown")).toBe(true);
  });

  // The rejection that matters: an import claiming the form's own timestamp
  // would make a recollection indistinguishable from an observation.
  it("refuses an import or a practitioner entry claiming 'form'", () => {
    expect(provenanceMatchesSource("legacy_import", "form")).toBe(false);
    expect(provenanceMatchesSource("practitioner", "form")).toBe(false);
  });

  it("refuses the public form claiming a weaker provenance", () => {
    expect(provenanceMatchesSource("public_booking", "operator_supplied")).toBe(false);
    expect(provenanceMatchesSource("public_booking", "unknown")).toBe(false);
  });

  it("covers every source x provenance pair exactly once", () => {
    let accepted = 0;
    for (const s of ENTRY_SOURCES) {
      for (const p of JOINED_AT_PROVENANCES) if (provenanceMatchesSource(s, p)) accepted += 1;
    }
    // public_booking x form, plus 2 sources x 2 weaker provenances.
    expect(accepted).toBe(5);
  });
});

describe("duration meaningfulness", () => {
  it("is false only for 'unknown'", () => {
    expect(joinedAtSupportsDuration("form")).toBe(true);
    expect(joinedAtSupportsDuration("operator_supplied")).toBe(true);
    expect(joinedAtSupportsDuration("unknown")).toBe(false);
  });
});

describe("availability source", () => {
  it("keeps the token-authenticated route distinct from the public form", () => {
    expect(AVAILABILITY_SOURCES).toEqual(["public_form", "practitioner", "prospect_link"]);
  });

  it("names a practitioner only for the practitioner-recorded route", () => {
    expect(availabilitySourceRequiresPractitioner("practitioner")).toBe(true);
    expect(availabilitySourceRequiresPractitioner("public_form")).toBe(false);
    expect(availabilitySourceRequiresPractitioner("prospect_link")).toBe(false);
  });
});

describe("proposed name provenance (recorded, not implemented)", () => {
  it("names the one value that marks a name nobody actually knew", () => {
    expect(PROPOSED_NAME_PROVENANCES).toContain(INFERRED_NAME_PROVENANCE);
    expect(INFERRED_NAME_PROVENANCE).toBe("operator_inferred");
  });

  it("distinguishes the case `source` alone cannot: transcribed vs inferred", () => {
    // Both are source='legacy_import'; only this vocabulary separates them.
    expect(PROPOSED_NAME_PROVENANCES).toContain("operator_transcribed");
    expect(PROPOSED_NAME_PROVENANCES).toContain("operator_inferred");
  });
});

describe("vocabulary parsing", () => {
  it("accepts exact members after trim and lowercase", () => {
    expect(parseVocabulary("  LEGACY_IMPORT ", ENTRY_SOURCES)).toBe("legacy_import");
  });

  it("returns null rather than throwing for a value outside the vocabulary", () => {
    for (const raw of ["", "nope", null, undefined, 7, {}, []]) {
      expect(parseVocabulary(raw, ENTRY_SOURCES)).toBeNull();
    }
  });
});
