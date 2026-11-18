import { describe, expect, it } from "vitest";
import { MACHINE_CATALOGUE } from "@/lib/machines/catalogue";
import { planContractPublication } from "@/lib/machines/contract-publication";
import { activeModes } from "@/lib/machines/profile-contract";

// The DATABASE now refuses a saved machine identity whose (profile, version, mode) is not in machine_profile_mode_contract (the forward
// migration for the 0301 mode-key finding). That contract is PUBLISHED FROM the application catalogue (scripts/publish-machine-contracts.mjs
// -> planContractPublication), so the two share one source. This test fails when the app would OFFER a mode that the publication plan would
// not publish: such a mode would pass checkDeviceChoice and then be refused by the database after the migration. The reverse (published
// but not offered) is harmless: the app is the stricter side.
describe("every mode the app offers is a mode the database contract would hold", () => {
  const plan = planContractPublication(MACHINE_CATALOGUE);
  const published = new Set(plan.publish.map((p) => `${p.p_machine_profile_id}|${p.p_machine_profile_version}|${p.p_mode_key}`));
  const offered = MACHINE_CATALOGUE.flatMap((p) =>
    activeModes(p).map((m) => ({ key: `${p.profileId}|${p.version}|${m.key}`, option: m.requiresInstalledOption ?? null })),
  );

  it("the catalogue offers at least one mode (the comparison is not vacuous)", () => {
    expect(offered.length).toBeGreaterThan(0);
  });

  it("each offered (profile, version, mode) is in the publication plan", () => {
    const missing = offered.filter((o) => !published.has(o.key)).map((o) => o.key);
    expect(missing, `offered by the app but not publishable to machine_profile_mode_contract: ${missing.join(", ")}`).toEqual([]);
  });

  it("an option-gated mode publishes the same required option the app checks", () => {
    for (const o of offered) {
      const row = plan.publish.find((p) => `${p.p_machine_profile_id}|${p.p_machine_profile_version}|${p.p_mode_key}` === o.key);
      if (row) expect(row.p_requires_installed_option, o.key).toBe(o.option);
    }
  });
});
