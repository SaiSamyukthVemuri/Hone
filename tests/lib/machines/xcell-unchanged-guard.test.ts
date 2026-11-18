import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MACHINE_CATALOGUE } from "../../../lib/machines/catalogue";

// HON-8 re-scope (4 Nov 2026): the Junior/Senior work must not change xCell support in any way. This pins the xCell catalogue entry
// to the exact bytes it has on production (7936f5b2a), so any edit to its fields, modes, evidence or availability fails here.
// If an xCell change is ever wanted on purpose, that is a separate decision and this hash is updated in that change, not in HON-8's.
const XCELL_ENTRY_SHA256 = "96702e7aeae76762f4536e71740de5e1c39403c87e7f44b521f060216f518dce";

describe("xCell catalogue entry is unchanged by HON-8", () => {
  const xcell = MACHINE_CATALOGUE.filter((p) => /xcell/i.test(p.profileId));

  it("there is exactly one xCell profile, version 1, as before", () => {
    expect(xcell.map((p) => [p.profileId, p.version, p.availability])).toEqual([["dectro-apilus:xcell", 1, "blocked"]]);
  });

  it("its whole definition is byte-identical to production's", () => {
    expect(createHash("sha256").update(JSON.stringify(xcell[0])).digest("hex")).toBe(XCELL_ENTRY_SHA256);
  });

  it("no Junior or Senior 3G profile reuses an xCell field or evidence id", () => {
    const xcellEvidence = new Set(xcell[0]!.evidence.map((e) => e.id));
    for (const p of MACHINE_CATALOGUE.filter((p) => /apilus:(senior|junior)-3g/.test(p.profileId) && p.version === 3)) {
      for (const e of p.evidence) expect(xcellEvidence.has(e.id), `${p.profileId} cites xCell evidence ${e.id}`).toBe(false);
    }
  });
});
