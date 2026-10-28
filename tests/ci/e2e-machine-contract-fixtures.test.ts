import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import {
  SYNTHETIC_DEMO_PROFILE,
  SYNTHETIC_SINGLE_PROBE,
} from "@/lib/machines/synthetic-profile";

// ===========================================================================
// MPX-03 — EVERY e2e CONTRACT FIXTURE MUST MATCH THE CATALOGUE
//
// A published machine contract is IMMUTABLE per (profile, version, mode).
// Several e2e specs publish the same identities through
// `sync_machine_profile_contract`, so they are not independent fixtures at
// all: on a shard that carries two of them, the first publish wins and the
// second is refused with "already published with different fields".
//
// IT HAS HAPPENED TWICE, both times over the same single flag.
//   - Round 11 added `optional: true` to `energy_shown` and had to sweep
//     THREE multineedle fixtures by hand (Codex, #860 4299434251).
//   - Round 12 added a second publisher of the single-probe contract and did
//     not sweep the first, so CI shard 2 at c0991e0d went red in the FIXTURE
//     of `machine-switch-discards-draft` - 151 passed, that one failing
//     before its first assertion.
//
// A LOCAL SINGLE-SPEC RUN CANNOT SEE THIS. Each spec passes alone, because
// alone it is the first publisher. That is exactly why the check belongs
// here, in a test that needs no database and no browser.
//
// The rule is tied to the CATALOGUE rather than to the other fixtures: a
// fixture stands in for the product, so "they agree with each other" is not
// enough - two fixtures could agree on a machine stricter than the real one,
// which is the defect round 11 was fixing.
// ===========================================================================

const E2E_DIR = path.resolve(__dirname, "../../e2e");

/** field_key -> the optional-ness the catalogue declares for it. */
function catalogueOptionality(): Map<string, Set<boolean>> {
  const m = new Map<string, Set<boolean>>();
  for (const profile of [SYNTHETIC_DEMO_PROFILE, SYNTHETIC_SINGLE_PROBE]) {
    for (const mode of profile.modes) {
      for (const field of mode.fields) {
        const seen = m.get(field.key) ?? new Set<boolean>();
        seen.add(field.optional === true);
        m.set(field.key, seen);
      }
    }
  }
  return m;
}

type FixtureField = { file: string; fieldKey: string; optional: boolean };

/**
 * Every `{ field_key: ... }` object literal in the e2e specs, with whether it
 * declares `optional: true`.
 *
 * Deliberately brace-bounded rather than line-based: round 11's entries are
 * multi-line objects and a line-based scan would have read `optional` from a
 * NEIGHBOURING field, which is a way for this guard to be confidently wrong.
 */
function fixtureFields(): FixtureField[] {
  const out: FixtureField[] = [];
  for (const name of readdirSync(E2E_DIR)) {
    if (!name.endsWith(".spec.ts")) continue;
    const src = readFileSync(path.join(E2E_DIR, name), "utf8");
    if (!src.includes("sync_machine_profile_contract")) continue;
    for (const m of src.matchAll(/\{[^{}]*?field_key:\s*"([^"]+)"[^{}]*?\}/gs)) {
      out.push({
        file: name,
        fieldKey: m[1]!,
        optional: /optional:\s*true/.test(m[0]),
      });
    }
  }
  return out;
}

describe("e2e machine contract fixtures agree with the catalogue", () => {
  const catalogue = catalogueOptionality();
  const fields = fixtureFields();

  it("the scan found fixtures at all", () => {
    // NON-VACUITY. Every assertion below iterates this list; an empty one
    // would make the whole file pass while checking nothing — the failure
    // mode that has already cost this PR one withdrawn proof.
    expect(fields.length, "no e2e contract fixture fields were found").toBeGreaterThan(5);
    expect(
      new Set(fields.map((f) => f.file)).size,
      "fixtures were found in only one spec, so no cross-spec rule is being tested",
    ).toBeGreaterThan(1);
    expect(catalogue.size).toBeGreaterThan(0);
  });

  it("no fixture publishes a field as REQUIRED that the catalogue calls optional", () => {
    const wrong = fields
      .filter((f) => {
        const declared = catalogue.get(f.fieldKey);
        // Unambiguous keys only: a key the catalogue uses both ways cannot be
        // judged without knowing which mode the fixture is publishing.
        if (!declared || declared.size !== 1) return false;
        return [...declared][0] === true && !f.optional;
      })
      .map((f) => `${f.file}: ${f.fieldKey}`);
    expect(
      wrong,
      "these fixtures omit `optional: true`, so the publish defaults the field to REQUIRED — the fixture then stands in for a stricter machine than the product, and collides with any other spec publishing the same contract identity",
    ).toEqual([]);
  });

  it("and no fixture publishes a field as optional that the catalogue requires", () => {
    const wrong = fields
      .filter((f) => {
        const declared = catalogue.get(f.fieldKey);
        if (!declared || declared.size !== 1) return false;
        return [...declared][0] === false && f.optional;
      })
      .map((f) => `${f.file}: ${f.fieldKey}`);
    expect(
      wrong,
      "these fixtures declare a required field optional, so a capture missing it would be accepted here and refused by the product",
    ).toEqual([]);
  });

  it("every field_key published by two specs is published the SAME way", () => {
    // The immutability rule directly: whatever the catalogue says, two specs
    // that disagree with each other cannot both run on one database.
    const byKey = new Map<string, Map<boolean, string[]>>();
    for (const f of fields) {
      const m = byKey.get(f.fieldKey) ?? new Map<boolean, string[]>();
      m.set(f.optional, [...(m.get(f.optional) ?? []), f.file]);
      byKey.set(f.fieldKey, m);
    }
    const split = [...byKey.entries()]
      .filter(([, m]) => m.size > 1)
      .map(
        ([key, m]) =>
          `${key}: ${[...m.entries()]
            .map(([opt, files]) => `optional=${opt} in ${[...new Set(files)].join(", ")}`)
            .join(" vs ")}`,
      );
    expect(
      split,
      "a published contract is immutable per (profile, version, mode), so whichever of these specs runs second on a shared stack is refused in its FIXTURE, before its first assertion",
    ).toEqual([]);
  });
});
