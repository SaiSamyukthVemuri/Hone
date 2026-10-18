import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { describe, expect, it } from "vitest";

import {
  activeProfiles,
  currentProfile,
  type MachineProfile,
} from "@/lib/machines/profile-contract";

// ===========================================================================
// ONE DEFINITION OF "THE CURRENT VERSION" (Codex, #860 4307914917)
// ===========================================================================
//
// THE DEFECT. Three display surfaces each resolved a profile with
// `catalogue.find((p) => p.profileId === id)`, which takes the FIRST entry
// with that id. With two versions in the catalogue that can be v1 while v2 is
// current - and all three then compared the reading's version against the
// wrong one:
//
//     const historical = entry.profileVersion !== profile.version;
//
// So a reading recorded under the CURRENT version is flagged historical and
// renders raw field keys instead of labels, or a genuinely superseded one is
// treated as current and shown labels that no longer apply. Order-dependent,
// so it would have surfaced the day a second version was added - not before.
//
// THE RULE ALREADY EXISTED inside `activeProfiles` and was welded to an
// availability filter. These surfaces need the current version WHATEVER its
// availability, because labelling a reading recorded on a since-withdrawn
// model is exactly their job. Two filters, one rule, one place.
//
// ORDER IS VARIED DELIBERATELY in these cases. A resolver that happened to
// work because the fixture listed v2 first would be the same latent defect
// wearing a passing test.
// ===========================================================================

const profile = (
  profileId: string,
  version: number,
  availability: MachineProfile["availability"],
): MachineProfile =>
  ({
    profileId,
    version,
    family: "Fixture",
    manufacturer: "Fixture",
    model: `${profileId}@${version}`,
    availability,
    availabilityReason: "fixture",
    verification: "manufacturer-documented",
    frequency: { kind: "unverified", note: "fixture" },
    modes: [],
    evidence: [],
    openQuestions: [],
  }) as unknown as MachineProfile;

describe("currentProfile resolves the HIGHEST version", () => {
  it("picks v2 when v1 is listed FIRST", () => {
    // The defect's exact shape: `find` would return v1 here.
    const out = currentProfile(
      [profile("p", 1, "active"), profile("p", 2, "active")],
      "p",
    );
    expect(out?.version, "the first match was returned, not the current one").toBe(2);
  });

  it("and picks v2 when v2 is listed first, so order cannot flatter it", () => {
    const out = currentProfile(
      [profile("p", 2, "active"), profile("p", 1, "active")],
      "p",
    );
    expect(out?.version).toBe(2);
  });

  it("resolves a BLOCKED profile too, which is the whole reason it is separate", () => {
    // A display surface must label a reading recorded on a model that has
    // since been withdrawn. Filtering by availability here would make the
    // record unreadable the moment a model is blocked.
    const out = currentProfile(
      [profile("p", 1, "blocked"), profile("p", 2, "blocked")],
      "p",
    );
    expect(out?.version).toBe(2);
    expect(out?.availability).toBe("blocked");
  });

  it("resolves a LEGACY-ONLY profile too", () => {
    const out = currentProfile([profile("p", 3, "legacy-only")], "p");
    expect(out?.version).toBe(3);
  });

  it("returns undefined for an id it does not hold", () => {
    expect(currentProfile([profile("p", 1, "active")], "other")).toBeUndefined();
  });

  it("keeps profiles apart", () => {
    const out = currentProfile(
      [profile("a", 5, "active"), profile("b", 2, "active")],
      "b",
    );
    expect(out?.version).toBe(2);
  });
});

describe("activeProfiles still means current AND active", () => {
  it("offers the current version when it is active", () => {
    const out = activeProfiles([
      profile("p", 1, "active"),
      profile("p", 2, "active"),
    ]);
    expect(out.map((p) => p.version)).toEqual([2]);
  });

  it("offers NOTHING when the current version is blocked, even if v1 was active", () => {
    // THE PROPERTY THAT MUST NOT REGRESS while the rule is shared: a model
    // withdrawn at v2 is withdrawn, and falling back to an active v1 would
    // offer a contract the manufacturer's own documentation no longer
    // supports.
    const out = activeProfiles([
      profile("p", 1, "active"),
      profile("p", 2, "blocked"),
    ]);
    expect(
      out,
      "a blocked current version fell back to an active older one",
    ).toEqual([]);
  });
});

describe("and ALL THREE sites use it, so they cannot diverge again", () => {
  // WITHOUT THIS THE RESOLVER IS OPTIONAL. A negative control proved it: I
  // reverted ONE call site to its own `catalogue.find(...)` and every
  // behavioural test above still passed, because they exercise the resolver
  // rather than its callers. A shared helper that callers may ignore is not a
  // single definition - it is a fourth one waiting to be written.
  const read = (rel: string) =>
    readFileSync(nodePath.resolve(__dirname, "../../..", rel), "utf8");

  const SITES = [
    "components/machines/machine-recorded-setups.tsx",
    "components/machines/machine-prior-setup.tsx",
  ];

  it("each resolves through currentProfile", () => {
    for (const rel of SITES) {
      expect(read(rel), `${rel} does not use the resolver`).toMatch(
        /currentProfile\(catalogue, /,
      );
    }
  });

  it("and none of them resolves a profile by its own find", () => {
    // THE CODE FORM, not the word: these files legitimately use `.find` for
    // other things, and the comments discuss the defect by name. What is
    // banned is resolving a PROFILE ID this way.
    for (const rel of SITES) {
      expect(
        read(rel),
        `${rel} resolves a profile with its own find, which takes the FIRST match`,
      ).not.toMatch(/\.find\(\(p\) => p\.profileId ===/);
    }
  });

  it("and the three call sites are the only ones, so this list is complete", () => {
    // A FOURTH SITE shows up here as an unpinned file rather than as a
    // mislabelled reading in production.
    const sweep = [
      ...SITES,
      "components/machines/machine-first-setup-panel.tsx",
      "components/machines/machine-reading-entry.tsx",
      "lib/machines/charting.ts",
    ].filter((rel) => /\.find\(\(p\) => p\.profileId ===/.test(read(rel)));
    expect(sweep, "a surface resolves a profile id by its own find").toEqual([]);
  });
});
