import { describe, expect, it, vi } from "vitest";
import { planContractPublication, publishContracts } from "../../../lib/machines/contract-publication";
import { validateReading } from "../../../lib/machines/validate-reading";
import { publicationFixture } from "../../fixtures/machine-publication";

describe("deployment contract publication selection", () => {
  it("derives exact RPC content from the reviewed field, stage and mode facts", () => {
    const p = publicationFixture();
    p.channels = { count: 2, nativeLabel: "Synthetic channel", associationRequired: false, supportsDistinctSettingGroups: true, verification: "device-confirmed", evidence: ["fixture"] };
    p.modes[0].requiresInstalledOption = "synthetic-option";
    p.modes[0].stages = [{ key: "stage", nativeLabel: "Synthetic stage", fields: [{ ...p.modes[0].fields[0], key: "staged", unit: "mA", decimals: 2, optional: true }] }];
    expect(planContractPublication([p])).toEqual({ skipped: [], publish: [{
      p_machine_profile_id: p.profileId, p_machine_profile_version: 1, p_mode_key: "galvanic",
      p_channels_max: 2, p_requires_installed_option: "synthetic-option", p_fields: [
        { stage_key: "", field_key: "current", native_unit: "µA", decimals: 1, quantity: "current", optional: false },
        { stage_key: "stage", field_key: "staged", native_unit: "mA", decimals: 2, quantity: "current", optional: true },
      ],
    }] });
  });

  it.each(["blocked", "legacy-only"] as const)("never publishes a %s profile", (availability) => {
    const p = publicationFixture(); p.availability = availability;
    const plan = planContractPublication([p]);
    expect(plan.publish).toEqual([]);
    expect(plan.skipped[0].reasons.join(" ")).toContain(`profile is ${availability}`);
  });

  it("selects per mode without promoting a blocked sibling", () => {
    const p = publicationFixture();
    p.modes.push({ ...structuredClone(p.modes[0]), key: "pending", availability: "blocked", verification: "pending-evidence" });
    const plan = planContractPublication([p]);
    expect(plan.publish.map((m) => m.p_mode_key)).toEqual(["galvanic"]);
    expect(plan.skipped[0].mode).toBe("pending");
    expect(p.modes[1].availability).toBe("blocked");
  });

  it.each([false, true])("skips the entire mode for a pending field, optional=%s", (optional) => {
    const p = publicationFixture();
    p.modes[0].fields.push({ ...p.modes[0].fields[0], key: "pending", optional, verification: "pending-evidence" });
    const plan = planContractPublication([p]);
    expect(plan.publish).toEqual([]);
    expect(plan.skipped[0].reasons.join(" ")).toContain("pending-evidence");
  });

  it.each(["unit", "decimals", "label", "editability"] as const)("skips an optional field with unverified %s rather than dropping it", (aspect) => {
    const p = publicationFixture(); p.modes[0].fields[0].optional = true; p.modes[0].fields[0].unverified = [aspect];
    expect(planContractPublication([p]).publish).toEqual([]);
  });

  it("honours open questions even on optional staged fields", () => {
    const p = publicationFixture();
    p.modes[0].stages = [{ key: "stage", nativeLabel: "Synthetic stage", fields: [{ ...p.modes[0].fields[0], optional: true }] }];
    p.openQuestions = [{ id: "pending", question: "Unverified?", resolvedBy: "Fixture only", blocks: ["stage.current"] }];
    expect(planContractPublication([p]).publish).toEqual([]);
  });

  it("refuses association-required publication until the database carries that fact", () => {
    const p = publicationFixture();
    p.channels = { count: 2, nativeLabel: "Synthetic channel", associationRequired: true, supportsDistinctSettingGroups: true, verification: "device-confirmed", evidence: ["fixture"] };
    const plan = planContractPublication([p]);
    expect(plan.publish).toEqual([]);
    expect(plan.skipped[0].reasons.join(" ")).toContain("cannot enforce required channel association");
  });

  it("does not republish a historical version or accept duplicate identities", () => {
    const old = publicationFixture(); const current = { ...structuredClone(old), version: 2 };
    expect(planContractPublication([old, current]).publish.map((p) => p.p_machine_profile_version)).toEqual([2]);
    expect(planContractPublication([old, structuredClone(old)]).publish).toEqual([]);
  });

  it.each([NaN, Infinity, -Infinity, 0, 1.5, 65])("refuses malformed channel count %s before JSON can turn it into null", (count) => {
    const p = publicationFixture();
    p.channels = { count, nativeLabel: "Synthetic channel", associationRequired: false, supportsDistinctSettingGroups: true, verification: "device-confirmed", evidence: ["fixture"] };
    const plan = planContractPublication([p]);
    expect(plan.publish).toEqual([]);
    expect(plan.skipped[0].reasons.join(" ")).toContain("channel count cannot be represented");
  });

  it("blocks malformed precision and unknown evidence", () => {
    const p = publicationFixture(); p.modes[0].fields[0].decimals = Infinity;
    expect(planContractPublication([p]).publish).toEqual([]);
    p.modes[0].fields[0].decimals = 1; p.modes[0].fields[0].evidence = ["missing"];
    expect(planContractPublication([p]).publish).toEqual([]);
  });

  it("does not present an unverified frequency as a verified contract", () => {
    const p = publicationFixture(); p.frequency = { kind: "unverified", note: "Fixture question" };
    expect(planContractPublication([p]).publish).toEqual([]);
  });

  it("keeps both required Apilus models separate and blocked with no invented Junior modes", () => {
    const plan = planContractPublication();
    expect(plan.publish).toEqual([]);
    const senior = plan.skipped.filter((s) => s.profileId === "dectro-apilus:senior-3g");
    const junior = plan.skipped.filter((s) => s.profileId === "dectro-apilus:junior-3g");
    expect(senior.map((s) => s.mode)).toEqual(["multiplex"]);
    expect(junior.map((s) => s.mode)).toEqual([null]);
    expect(senior[0].reasons.join(" ")).toContain("pending-evidence");
    expect(junior[0].reasons.join(" ")).toContain("no verified modes");
  });
});

describe("publication transport receipts", () => {
  it("delegates first publication and idempotent replay to the same immutable RPC", async () => {
    const plan = planContractPublication([publicationFixture()]);
    const rpc = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    expect((await publishContracts(plan, rpc))[0].inserted).toBe(1);
    expect((await publishContracts(plan, rpc))[0].inserted).toBe(0);
    expect(rpc.mock.calls).toEqual([[plan.publish[0]], [plan.publish[0]]]);
  });
  it("never calls the writer for a skipped mode", async () => {
    const p = publicationFixture(); p.modes[0].verification = "pending-evidence";
    const rpc = vi.fn(); await publishContracts(planContractPublication([p]), rpc);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("propagates changed-contract refusal without retrying or continuing", async () => {
    const plan = planContractPublication([publicationFixture(), publicationFixture("synthetic:second")]);
    const rpc = vi.fn().mockRejectedValue(new Error("Publish a NEW version"));
    await expect(publishContracts(plan, rpc)).rejects.toThrow("NEW version");
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it.each([null, "1", -1, NaN, Infinity, 2])("rejects malformed receipt %s", async (value) => {
    await expect(publishContracts(planContractPublication([publicationFixture()]), async () => value as number)).rejects.toThrow("Invalid publication receipt");
  });
});

describe("non-finite readings are malformed, never clinical observations", () => {
  it.each([NaN, Infinity, -Infinity])("refuses %s at application validation", (value) => {
    const p = publicationFixture();
    const result = validateReading({ profileId: p.profileId, version: 1, modeKey: "galvanic", fieldKey: "current", value: { kind: "value", value }, source: "practitioner-entered" }, { catalogue: [p] });
    expect(result).toMatchObject({ ok: false, code: "malformed_value" });
  });
  it.each([0, 120.5])("preserves finite %s without rounding", (value) => {
    const p = publicationFixture();
    expect(validateReading({ profileId: p.profileId, version: 1, modeKey: "galvanic", fieldKey: "current", value: { kind: "value", value }, source: "practitioner-entered" }, { catalogue: [p] })).toMatchObject({ ok: true, recorded: { kind: "value", value } });
  });
});
