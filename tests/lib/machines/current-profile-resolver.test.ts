import { readdirSync, readFileSync } from "node:fs";
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

describe("and EVERY site uses it, so they cannot diverge again", () => {
  // WITHOUT THIS THE RESOLVER IS OPTIONAL. A negative control proved it: I
  // reverted ONE call site to its own `catalogue.find(...)` and every
  // behavioural test above still passed, because they exercise the resolver
  // rather than its callers. A shared helper that callers may ignore is not a
  // single definition - it is a fourth one waiting to be written.
  //
  // AND A HAND-WRITTEN LIST OF CALLERS IS THE SAME TRAP ONE LEVEL UP. The
  // first spelling of this guard listed five files and swept only those, so
  // the four SERVER-ACTION sites were invisible to it (Codex, #860
  // 4308488012) - including the one that validates a clinical reading against
  // a profile's field contract. The sweep below WALKS THE TREE instead: a new
  // file cannot be absent from a list it is not part of.
  const read = (rel: string) =>
    readFileSync(nodePath.resolve(__dirname, "../../..", rel), "utf8");

  /**
   * The banned CODE FORM, matched against comment-stripped source.
   *
   * `(\w+)` with a back-reference, so renaming the parameter cannot bypass it:
   * `(x) => x.profileId ===` is the same defect as `(p) => p.profileId ===`.
   *
   * AND WHITESPACE IS TOLERATED EVERYWHERE, which a negative control is the
   * reason for. The first spelling demanded `.find((p) =>` with no gap, and
   * all four real call sites are formatted across lines - so reverting one of
   * them to the defect changed nothing and the limb reported NOT CAUGHT. A
   * guard written to one formatting is a guard against nothing.
   *
   * COMMENTS ARE STRIPPED FIRST, and LINE comments before BLOCK comments -
   * `profile-contract.ts` quotes the banned form verbatim in the docblock that
   * explains it, and several call sites name it in prose. A guard that reads
   * raw text is satisfied, or tripped, by an explanation.
   */
  const FIRST_MATCH =
    /\.find\(\s*\((\w+)\)\s*=>\s*\1\.profileId\s*===\s*([^)]*?)\s*,?\s*\)/g;

  const stripComments = (src: string) =>
    src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

  /**
   * Every first-match profile lookup in a file that is NOT pinned to a version.
   *
   * AN EXACT-VERSION LOOKUP IS NOT THIS DEFECT. `catalogue.ts` resolves one
   * published contract with `p.profileId === id && p.version === version`,
   * which names exactly one entry and is the right thing to do. The exemption
   * reads the PREDICATE the regex captured rather than a window of nearby
   * text, because a proximity window exempts by accident - which is how three
   * earlier guards in this lane came to pass over the thing they banned.
   */
  const offenders = (src: string): string[] => {
    const out: string[] = [];
    for (const m of stripComments(src).matchAll(FIRST_MATCH)) {
      if (!/\.version === /.test(m[2]!)) out.push(m[0]!);
    }
    return out;
  };

  /** Every .ts/.tsx under the application tree. */
  const walk = (rel: string): string[] => {
    const abs = nodePath.resolve(__dirname, "../../..", rel);
    const out: string[] = [];
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const next = `${rel}/${e.name}`;
      if (e.isDirectory()) out.push(...walk(next));
      else if (/\.tsx?$/.test(e.name)) out.push(next);
    }
    return out;
  };

  /** The callers that must resolve through it, named so a deletion is visible. */
  const SITES = [
    "components/machines/machine-recorded-setups.tsx",
    "components/machines/machine-prior-setup.tsx",
    // THE SERVER ACTIONS, which the first version of this guard never saw.
    "app/(app)/clients/[id]/sessions/[sessionId]/machine-setup-actions.ts",
    "app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts",
  ];

  it("each resolves through the shared current or exact recorded-version resolver", () => {
    for (const rel of SITES) {
      expect(read(rel), `${rel} does not use the resolver`).toMatch(
        /(?:currentProfile|recordedProfile)\(/,
      );
    }
  });

  it("and none of them resolves a profile by its own find", () => {
    for (const rel of SITES) {
      expect(
        offenders(read(rel)),
        `${rel} resolves a profile with its own find, which takes the FIRST match`,
      ).toEqual([]);
    }
  });

  it("and NOTHING in app, lib or components does, which is what makes the list complete", () => {
    // A FIFTH SITE shows up here as a named file rather than as a mislabelled
    // reading - or a reading validated against the wrong contract - in
    // production.
    const found: string[] = [];
    for (const rel of [...walk("app"), ...walk("lib"), ...walk("components")]) {
      if (offenders(read(rel)).length > 0) found.push(rel);
    }
    expect(found, "a surface resolves a profile id by its own find").toEqual([]);
  });

  it("and the sweep can still SEE the banned form, so an empty result means absence", () => {
    // THE VACUITY CHECK. A sweep that strips comments, walks a tree and
    // exempts version-pinned lookups has four ways to find nothing by
    // accident. This proves it finds the real thing when it is there, and
    // keeps exempting the one lookup that is legitimate.
    expect(
      offenders("const x = list.find((q) => q.profileId === wanted);"),
      "the sweep no longer recognises the defect it exists to ban",
    ).toHaveLength(1);
    expect(
      // THE SPELLING THAT ACTUALLY GOT THROUGH, kept as a case of its own.
      offenders(
        "const x = cat().find(\n  (p) => p.profileId === input.profileId,\n);",
      ),
      "the sweep misses the multi-line form, which is how all four sites are written",
    ).toHaveLength(1);
    expect(
      offenders(
        "const x = list.find((p) => p.profileId === id && p.version === v);",
      ),
      "the sweep now flags an exact-version lookup, which is not this defect",
    ).toEqual([]);
    expect(
      offenders("// const x = list.find((p) => p.profileId === id);"),
      "the sweep reads commented-out code as live",
    ).toEqual([]);
    expect(
      walk("lib").length,
      "the tree walk returned nothing, so the sweep above was vacuous",
    ).toBeGreaterThan(50);
  });
});
