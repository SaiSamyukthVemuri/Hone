import { describe, expect, it } from "vitest";
import { APILUS_3G_PROFILES } from "../../../lib/machines/apilus-3g";
import { APILUS_3G_NATIVE_FIXTURES } from "../../../lib/machines/apilus-3g-fixtures";
import { catalogueForRuntime } from "../../../lib/machines/synthetic-profile";
import { planContractPublication } from "../../../lib/machines/contract-publication";

const local: NodeJS.ProcessEnv = { NODE_ENV: "test", HONE_SYNTHETIC_MACHINE_PROFILE: "1", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:64821" };
describe("native synthetic fixtures behind the existing gate", () => {
  it("keeps both model contracts separate and exposes only six reviewed modes", () => {
    expect(APILUS_3G_NATIVE_FIXTURES.map((p) => p.modes.map((m) => m.key))).toEqual([
      ["flash", "microflash", "multiplex", "electrolysis"], ["flash", "electrolysis"],
    ]);
    for (const [index, fixture] of APILUS_3G_NATIVE_FIXTURES.entries()) {
      const original = APILUS_3G_PROFILES[index];
      expect(original.availability).toBe("blocked");
      expect(fixture.profileId).toMatch(/^synthetic:native-/);
      for (const mode of fixture.modes) {
        const source = original.modes.find((m) => m.key === mode.key)!;
        expect(mode.fields).toEqual(source.fields);
        expect(mode.stages).toEqual(source.stages);
        expect(mode.fields).not.toBe(source.fields);
        expect(source.availability).toBe("blocked");
      }
      expect(planContractPublication([fixture]).publish).toHaveLength(fixture.modes.length);
    }
  });
  it("offers fixtures only for an explicitly enabled local undeployed runtime", () => {
    const offered = catalogueForRuntime(local);
    for (const fixture of APILUS_3G_NATIVE_FIXTURES) expect(offered).toContain(fixture);
    expect(offered.filter((p) => APILUS_3G_PROFILES.some((real) => real.profileId === p.profileId)).every((p) => p.availability === "blocked")).toBe(true);
  });
  it.each([
    { NODE_ENV: "test" as const }, { ...local, HONE_SYNTHETIC_MACHINE_PROFILE: undefined },
    { ...local, HONE_SYNTHETIC_MACHINE_PROFILE: "true" },
    { ...local, NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co" },
    { ...local, VERCEL: "1" }, { ...local, VERCEL_ENV: "preview" },
    { ...local, AWS_EXECUTION_ENV: "AWS_Lambda_nodejs" }, { ...local, AWS_REGION: "eu-west-1" },
    { ...local, KUBERNETES_SERVICE_HOST: "10.0.0.1" },
  ])("never exposes native fixtures when closed or deployed: %j", (env) => {
    expect(catalogueForRuntime(env).some((p) => p.profileId.startsWith("synthetic:native-"))).toBe(false);
  });
});
