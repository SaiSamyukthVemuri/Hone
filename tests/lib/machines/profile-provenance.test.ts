import { describe, expect, it } from "vitest";

import { APILUS_3G_PROFILES } from "@/lib/machines/apilus-3g";
import { profileProvenance } from "@/lib/machines/profile-provenance";
import type { MachineProfile } from "@/lib/machines/profile-contract";

// DEFAULT-PROFILES item 6. Provenance is derived from the profile and claims
// nothing the profile does not: documentation alone never reads as confirmed.

const SENIOR = APILUS_3G_PROFILES.find((p) => p.profileId === "dectro-apilus:senior-3g")!;
const JUNIOR = APILUS_3G_PROFILES.find((p) => p.profileId === "dectro-apilus:junior-3g")!;

describe("profileProvenance", () => {
  it("a manufacturer-documented profile names its source and is PENDING studio confirmation", () => {
    const p = profileProvenance(SENIOR);
    expect(p.title).toBe("Dectro Senior 3G");
    expect(p.versionLabel).toBe("Profile version 2");
    expect(p.confirmation).toBe("pending");
    expect(p.confirmationLabel).toBe("Pending studio confirmation");
    expect(p.sources.length).toBeGreaterThanOrEqual(3);
    expect(p.sources.join("\n")).toContain("6080-0000349");
    expect(p.sources.join("\n")).toMatch(/Manufacturer manual/);
  });

  it("the audit digest is not shown to the reader", () => {
    for (const profile of [SENIOR, JUNIOR]) {
      expect(profileProvenance(profile).sources.join("\n")).not.toMatch(/SHA256|[0-9a-f]{64}/i);
    }
  });

  it("Junior carries its own document and edition", () => {
    expect(profileProvenance(JUNIOR).title).toBe("Dectro Junior 3G");
    expect(profileProvenance(JUNIOR).sources.join("\n")).toContain("6080-0000345");
  });

  it("only device-confirmed reads as confirmed", () => {
    const confirmed: MachineProfile = { ...SENIOR, verification: "device-confirmed" };
    expect(profileProvenance(confirmed).confirmation).toBe("confirmed");
    for (const v of ["unverified", "pending-evidence"] as const) {
      const p = profileProvenance({ ...SENIOR, verification: v });
      expect(p.confirmation).toBe("not-applicable");
      expect(p.confirmationLabel).toBe("Not manufacturer-verified");
    }
  });

  it("non-manufacturer evidence is not listed as a manufacturer source", () => {
    const p = profileProvenance({
      ...SENIOR,
      evidence: [{ id: "x", kind: "practitioner-report", consultedOn: "2026-10-01", establishes: "a report" }],
    });
    expect(p.sources).toEqual([]);
  });
});
