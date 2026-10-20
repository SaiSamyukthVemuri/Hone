import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { APILUS_3G_PROFILES, APILUS_3G_TEXT_PROFILES } from "../../../lib/machines/apilus-3g";
import { APILUS_3G_NATIVE_FIXTURES, APILUS_3G_TEXT_FIXTURES } from "../../../lib/machines/apilus-3g-fixtures";
import { catalogueIntegrity, MACHINE_CATALOGUE, profileAtVersion } from "../../../lib/machines/catalogue";
import { catalogueForRuntime } from "../../../lib/machines/synthetic-profile";
import { nativeFieldGroups } from "../../../lib/machines/charting";
import { modeFields } from "../../../lib/machines/profile-contract";
import { assembleReadings, firstGroup, draftKey, groupReadiness } from "../../../lib/machines/setting-groups";
import { validateReading } from "../../../lib/machines/validate-reading";
import { planContractPublication } from "../../../lib/machines/contract-publication";
import { recordSetupGroup, recordSetupSubmission, readingsForBlock, type MachineDb, type RecordedReading } from "../../../lib/machines/machine-queries";
import { changesWithin, chronology } from "../../../lib/machines/capture-chronology";
import { initialSaveState, keyForSave, afterOutcome, afterDraftChanged, afterRecordAnother, canEditDraft, canSubmit, outcomeFromRecordResult, REUSED_NOTE } from "../../../lib/machines/save-attempt";
import { SettingDraftFields } from "../../../components/machines/setting-draft-fields";
import { MachinePriorSetup } from "../../../components/machines/machine-prior-setup";
import { MachineRecordedSetups } from "../../../components/machines/machine-recorded-setups";

const row = (p: typeof APILUS_3G_TEXT_FIXTURES[number], value: string): RecordedReading => ({
  blockId: "block", captureId: "capture", deviceId: "device", profileId: p.profileId,
  profileVersion: 3, modeKey: "blend", groupKey: "g1", channels: [], stageKey: null,
  fieldKey: "program_identifier", value: { kind: "text", value }, nativeUnit: "none",
  decimals: 0, revision: 1, observationSource: "practitioner-entered", recordedAt: "2026-10-19T10:00:00Z",
});
for (const [index, profile] of APILUS_3G_TEXT_FIXTURES.entries()) describe(`${profile.model} faithful text`, () => {
  const mode = profile.modes.find((m) => m.key === "blend")!;
  const validate = (fieldKey: string, value: Parameters<typeof validateReading>[0]["value"]) => validateReading({
    profileId: profile.profileId, version: 3, modeKey: mode.key, fieldKey,
    value, source: "practitioner-entered",
  }, { catalogue: [profile] });
  it("retains v1/v2 unchanged and keeps real v3 blocked while synthetic fields qualify", () => {
    expect(APILUS_3G_PROFILES[index].version).toBe(2);
    expect(APILUS_3G_PROFILES[index].modes.find((m) => m.key === "blend")!.captureHold).toBeTruthy();
    expect(profileAtVersion(APILUS_3G_PROFILES[index].profileId, 2)).toBe(APILUS_3G_PROFILES[index]);
    expect(APILUS_3G_TEXT_PROFILES[index].availability).toBe("blocked");
    expect(catalogueIntegrity([profile])).toEqual([]);
    const plan = planContractPublication([profile]);
    expect(plan.publish.length).toBe(profile.modes.length);
    const published = plan.publish.find((p) => p.p_mode_key === "blend")!;
    expect(published.p_fields).toContainEqual(expect.objectContaining({ field_key: "program_identifier", value_kind: "text", choices: [] }));
    expect(published.p_fields).toContainEqual(expect.objectContaining({ field_key: "starting_current", value_kind: "choice", choices: index === 0 ? ["Glv Hf", "Hf Glv"] : ["Glv hf", "Hf Glv"] }));
    expect(planContractPublication().publish).toEqual([]);
  });
  it.each(["003i", "00", "Hf Glv", " 03i "])("preserves text %j exactly, without dose inference", (value) => {
    expect(validate("program_identifier", { kind: "text", value })).toMatchObject({ ok: true, recorded: { kind: "text", value } });
  });
  it.each(["", "   ", "\t", "a".repeat(501), "a\0b"])("refuses malformed text %j", (value) => {
    expect(validate("program_identifier", { kind: "text", value })).toMatchObject({ ok: false, code: "malformed_value" });
  });
  it("distinguishes exact choice, wrong model spelling, absence, number and text", () => {
    const choices = mode.fields.find((f) => f.key === "starting_current")!.choices!;
    for (const value of choices) expect(validate("starting_current", { kind: "text", value }).ok).toBe(true);
    for (const value of [index === 0 ? "Glv hf" : "Glv Hf", "0", "Glv", "Hf Glv "]) expect(validate("starting_current", { kind: "text", value }).ok).toBe(false);
    expect(validate("program_identifier", { kind: "value", value: 3 }).ok).toBe(false);
    expect(validate("galvanic_current", { kind: "text", value: "0.27" }).ok).toBe(false);
    expect(validate("program_identifier", { kind: "absent", reason: "not-recorded" }).ok).toBe(true);
  });
  it("uses text/select controls and requires starting-current choice with a partial numeric draft", () => {
    const groups = firstGroup();
    const fields = nativeFieldGroups(profile, mode);
    for (const group of fields) for (const f of group.fields) {
      if (!f.valueKind) groups[0].values[draftKey(group.key, f)] = "1";
      if (f.key === "program_identifier") groups[0].values[draftKey(group.key, f)] = "003i";
    }
    expect(groupReadiness(fields, groups[0])).toBe("partial");
    const choice = fields.flatMap((g) => g.fields).find((f) => f.key === "starting_current")!;
    groups[0].values[draftKey("_mode", choice)] = choice.choices![0];
    expect(groupReadiness(fields, groups[0])).toBe("complete");
    expect(assembleReadings(fields, groups[0].values)).toContainEqual(expect.objectContaining({ fieldKey: "program_identifier", value: { kind: "text", value: "003i" } }));
    const html = renderToStaticMarkup(createElement(SettingDraftFields, { profile, mode, groups, groupOrdinal: 1, editDraft: () => {}, onAdvanceOrdinal: () => {}, setValue: () => {}, flipChannel: () => {} }));
    expect(html).toContain('type="text"');
    expect(html).toContain('<select');
    expect(html).toContain('value="003i"');
    expect(html).not.toContain('native-control-pending');
  });
  it.each([" 003i ", "00  3i", "003i\t  03i\n"])("preserves visible whitespace for text %j in history and prior guidance", value => {
    const stored = row(profile, value);
    const revised = { ...stored, revision: 2, captureId: "capture2", value: { kind: "text" as const, value: " 03i " } };
    const history = renderToStaticMarkup(createElement(MachineRecordedSetups, { readings: [stored, revised], catalogue: [profile] }));
    const prior = renderToStaticMarkup(createElement(MachinePriorSetup, { readings: [stored], catalogue: [profile] }));
    const exactSpan = (text: string) => `class="font-medium whitespace-break-spaces [overflow-wrap:anywhere]">${text}</span>`;
    for (const html of [history, prior]) expect(html).toContain(exactSpan(value));
    // The change summary must retain both strings too, not only the saved row.
    expect(history.split(exactSpan(value)).length - 1).toBeGreaterThanOrEqual(2);
    expect(history.split(exactSpan(" 03i ")).length - 1).toBeGreaterThanOrEqual(2);
  });
  it("keeps numeric precision and reasoned-absence rendering unchanged", () => {
    const stored = { ...row(profile, "unused"), fieldKey: "galvanic_current", nativeUnit: "mA" as const, decimals: 2,
      value: { kind: "value" as const, value: 0.27 } };
    for (const Component of [MachineRecordedSetups, MachinePriorSetup]) {
      const html = renderToStaticMarkup(createElement(Component, { readings: [stored], catalogue: [profile] }));
      expect(html).toContain('class="font-medium">0.27</span>');
      expect(html).not.toContain("whitespace-break-spaces");
      const absent = renderToStaticMarkup(createElement(Component, { readings: [{ ...stored, value: { kind: "absent", reason: "not-legible" } }], catalogue: [profile] }));
      expect(absent).toContain('class="font-medium">not legible</span>');
      expect(absent).not.toContain("whitespace-break-spaces");
    }
  });
  it("preserves text across existing write/read adapters and exact-version history display", async () => {
    const stored = row(profile, "003i");
    const rpc = vi.fn(async (name: string) => ({ data: name === "record_treatment_setup_group" ? 1 : [{
      session_block_id: "block", machine_profile_id: profile.profileId, machine_profile_version: 3,
      mode_key: "blend", group_key: "g1", channels: [], stage_key: null, field_key: "program_identifier",
      value_numeric: null, value_text: "003i", absence_reason: null, native_unit: "none", decimals: 0,
      revision: 1, capture_id: "capture", studio_machine_id: "device", observation_source: "practitioner-entered", recorded_at: stored.recordedAt,
    }], error: null }));
    const db: MachineDb = { rpc, from: () => { throw new Error("No unscoped read permitted"); } };
    expect(await recordSetupGroup(db, { blockId: "block", machineId: "device", modeKey: "blend", groupKey: "g1", newGroupRef: null, channels: [], readings: [{ stageKey: null, fieldKey: "program_identifier", value: stored.value, nativeUnit: "none", decimals: 0, observationSource: "practitioner-entered" }], sessionId: "session", clientId: "client" })).toMatchObject({ ok: true });
    expect(rpc).toHaveBeenCalledWith("record_treatment_setup_group", expect.objectContaining({ p_readings: [expect.objectContaining({ value_text: "003i" })] }));
    const read = await readingsForBlock(db, "block", "session");
    expect(read).toMatchObject({ ok: true, value: [stored] });
    const props = { readings: [stored], catalogue: [profile] };
    const history = renderToStaticMarkup(createElement(MachineRecordedSetups, props));
    const prior = renderToStaticMarkup(createElement(MachinePriorSetup, props));
    for (const html of [history, prior]) { expect(html).toContain("003i"); expect(html).toContain("Program"); expect(html).not.toContain("NaN"); }
    expect(changesWithin(chronology([stored, { ...stored, revision: 2, captureId: "capture2", value: { kind: "text", value: "03i" } }]))).toHaveLength(1);
    expect(changesWithin(chronology([stored, { ...stored, revision: 2, captureId: "capture2" }]))).toHaveLength(0);
  });
});

// Exercise each confirmed mode's actual field layout, not just Blend's layout.
// Senior OmniBlend/MultiBlend differ in numeric/stage fields; Junior must never
// acquire their starting-current selector through a family-wide shortcut.
for (const [index, profile] of APILUS_3G_TEXT_FIXTURES.entries()) {
  const confirmed = index === 0 ? ["blend", "omniblend", "multiblend"] : ["blend"];
  for (const modeKey of confirmed) it(`${profile.model}/${modeKey}: both choices survive draft assembly and native validation`, () => {
    const mode = profile.modes.find(m => m.key === modeKey)!;
    const fields = nativeFieldGroups(profile, mode);
    const starting = fields.flatMap(g => g.fields).find(f => f.key === "starting_current")!;
    const nativeChoices = index === 0 ? ["Glv Hf", "Hf Glv"] : ["Glv hf", "Hf Glv"];
    const publication = planContractPublication([profile]).publish.find(p => p.p_mode_key === modeKey)!;
    expect(publication.p_fields.find(f => f.field_key === "starting_current")?.choices).toEqual(nativeChoices);
    for (const choice of nativeChoices) {
      const groups = firstGroup();
      for (const group of fields) for (const field of group.fields) {
        groups[0].values[draftKey(group.key, field)] = field.key === "program_identifier"
          ? " 003i " : field.key === "starting_current" ? choice : "1";
      }
      expect(groupReadiness(fields, groups[0])).toBe("complete");
      const readings = assembleReadings(fields, groups[0].values);
      expect(readings.find(r => r.fieldKey === "starting_current")?.value).toEqual({ kind: "text", value: choice });
      expect(readings.find(r => r.fieldKey === "program_identifier")?.value).toEqual({ kind: "text", value: " 003i " });
      for (const reading of readings) {
        expect(validateReading({
          profileId: profile.profileId, version: profile.version, modeKey,
          stageKey: reading.stageKey, fieldKey: reading.fieldKey,
          value: reading.value, source: reading.observationSource,
        }, { catalogue: [profile] }).ok).toBe(true);
      }
    }
    expect(validateReading({ profileId: profile.profileId, version: profile.version,
      modeKey, fieldKey: starting.key, value: { kind: "text", value: index === 0 ? "Glv hf" : "Glv Hf" },
      source: "practitioner-entered",
    }, { catalogue: [profile] })).toMatchObject({ ok: false, code: "malformed_value" });
  });
  for (const modeKey of confirmed) it(`${profile.model}/${modeKey}: an unknown response retains exact text and the same retry identity`, async () => {
    const mode = profile.modes.find(m => m.key === modeKey)!;
    const choices = mode.fields.find(f => f.key === "starting_current")!.choices!;
    // Simulated transport/receipt only: this does not prove database idempotency
    // or mounted reload recovery. Exercise both model-specific choice strings.
    for (const choice of choices) {
      const readings = modeFields(mode).map(({ field, stageKey }) => ({
        stageKey, fieldKey: field.key, nativeUnit: field.unit,
        decimals: field.decimals, observationSource: field.expectedSource,
        value: field.valueKind === "text" ? { kind: "text" as const, value: " 003i " }
          : field.valueKind === "choice" ? { kind: "text" as const, value: choice }
            : { kind: "value" as const, value: 1 },
      }));
      const rpc = vi.fn()
        .mockResolvedValueOnce({ data: null, error: { message: "Failed to fetch" } })
        .mockResolvedValueOnce({ data: { submission_id: "original-submission", groups: 1, readings: readings.length, reused: true }, error: null });
      const db: MachineDb = { rpc, from: () => { throw new Error("No unscoped read permitted"); } };
      const initial = initialSaveState();
      const key = keyForSave(initial, () => "same-native-save");
      const input = { blockId: "block", machineId: "device", modeKey, idempotencyKey: key,
        groups: [{ groupKey: null, newGroupRef: "g1", channels: [], readings }],
        sessionId: "session", clientId: "client" };
      const first = await recordSetupSubmission(db, input);
      expect(first).toMatchObject({ ok: false, unresolved: true });
      const frozen = afterOutcome(initial, key, outcomeFromRecordResult({ ok: false, code: "unknown" }, 1));
      expect(canEditDraft(frozen, false)).toBe(false);
      expect(canSubmit(frozen)).toBe(true);
      expect(afterDraftChanged(frozen)).toEqual(frozen);
      const mint = vi.fn(() => "deliberate-new-save");
      input.idempotencyKey = keyForSave(frozen, mint);
      expect(mint).not.toHaveBeenCalled();
      const beforeRetry = structuredClone(rpc.mock.calls[0][1]);
      const retry = await recordSetupSubmission(db, input);
      expect(rpc).toHaveBeenCalledTimes(2);
      expect(rpc.mock.calls[1][1]).toEqual(beforeRetry);
      expect(beforeRetry.p_groups[0].readings).toContainEqual(expect.objectContaining({ field_key: "program_identifier", value_text: " 003i ", native_unit: "none", decimals: 0 }));
      expect(beforeRetry.p_groups[0].readings).toContainEqual(expect.objectContaining({ field_key: "starting_current", value_text: choice, native_unit: "none", decimals: 0 }));
      expect(retry.ok).toBe(true);
      if (!retry.ok) throw new Error(retry.error);
      expect(retry.value.submissionId).toBe("original-submission");
      const settled = afterOutcome(frozen, key, outcomeFromRecordResult({ ok: true,
        captures: retry.value.groups, written: retry.value.readings, reused: retry.value.reused }, 1));
      expect(settled).toMatchObject({ recorded: true, unresolved: false, key: null, captures: 1, message: REUSED_NOTE });
      // An intentional later capture may retain identical values, with a new key.
      expect(keyForSave(afterRecordAnother(settled), mint)).toBe("deliberate-new-save");
    }
  });
  it(`${profile.model}: only its confirmed modes publish starting-current choices`, () => {
    const published = planContractPublication([profile]).publish;
    expect(published.filter(p => p.p_fields.some(f => f.field_key === "starting_current"))
      .map(p => p.p_mode_key)).toEqual(confirmed);
    expect(APILUS_3G_TEXT_PROFILES[index].availability).toBe("blocked");
    if (index === 1) {
      const held = APILUS_3G_TEXT_PROFILES[index].modes.find(m => m.key === "omniblend")!;
      expect(held.captureHold).toBeTruthy();
      expect(held.fields.some(f => f.key === "starting_current")).toBe(false);
      expect(published.some(p => p.p_mode_key === "omniblend")).toBe(false);
    }
  });
}

it("all six synthetic identities are absent when gate-closed or deployed, with real profiles unchanged", () => {
  const baseline = structuredClone(MACHINE_CATALOGUE);
  for (const env of [ { NODE_ENV: "test" }, { NODE_ENV: "test", HONE_SYNTHETIC_MACHINE_PROFILE: "1", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:64821", VERCEL: "1" } ] as NodeJS.ProcessEnv[]) {
    expect(catalogueForRuntime(env)).toEqual(baseline);
    expect(catalogueForRuntime(env).some((p) => p.profileId.startsWith("synthetic:"))).toBe(false);
  }
  expect(MACHINE_CATALOGUE.filter((p) => p.availability === "active")).toEqual([]);
});

it("existing deployment adapter carries text/choice metadata without changing numeric payloads", async () => {
  const { publishMachineContract } = await import("../../../lib/machines/machine-queries");
  const rpc = vi.fn(async () => ({ data: 2, error: null }));
  const db: MachineDb = { rpc, from: () => { throw new Error("No direct contract table writes"); } };
  await publishMachineContract(db, { profileId: "synthetic:test", profileVersion: 3, modeKey: "blend", channelsMax: null, requiresInstalledOption: null,
    fields: [{ fieldKey: "start", nativeUnit: "none", decimals: 0, quantity: "configuration", valueKind: "choice", choices: ["Glv Hf", "Hf Glv"] },
      { fieldKey: "numeric", nativeUnit: "s", decimals: 2, quantity: "duration" }],
  });
  expect(rpc).toHaveBeenCalledWith("sync_machine_profile_contract", expect.objectContaining({ p_fields: [
    expect.objectContaining({ value_kind: "choice", choices: ["Glv Hf", "Hf Glv"] }),
    { stage_key: "", field_key: "numeric", native_unit: "s", decimals: 2, quantity: "duration", optional: false },
  ] }));
});

it.each(["missing choices", "duplicate choices", "blank choice", "numeric unit", "numeric precision"])("refuses malformed native metadata: %s", (mutation) => {
  const p = structuredClone(APILUS_3G_TEXT_FIXTURES[0]);
  const f = p.modes.find((m) => m.key === "blend")!.fields.find((field) => field.valueKind === "choice")!;
  if (mutation === "missing choices") delete f.choices;
  if (mutation === "duplicate choices") f.choices = ["Glv Hf", "Glv Hf"];
  if (mutation === "blank choice") f.choices = [" "];
  if (mutation === "numeric unit") f.unit = "s";
  if (mutation === "numeric precision") f.decimals = 2;
  expect(catalogueIntegrity([p]).some((v) => v.problem.includes("malformed text/choice metadata"))).toBe(true);
  expect(planContractPublication([p]).publish).toEqual([]);
});


// Reads arrive in SQL/chronology key order, not in the device's field order.
// Resolve display order from the retained exact-version contract only.
for (const profile of APILUS_3G_TEXT_FIXTURES) {
  for (const mode of profile.modes.filter(m => m.fields.some(f => f.valueKind === "choice"))) {
    it(`${profile.model}/${mode.key}: history and prior preserve retained contract order`, () => {
      const recorded = modeFields(mode).map(({ field, stageKey }, index): RecordedReading => ({
        ...row(profile, "unused"), modeKey: mode.key, stageKey, fieldKey: field.key,
        nativeUnit: field.unit, decimals: field.decimals,
        value: field.valueKind === "text" ? { kind: "text", value: " 003i " }
          : field.valueKind === "choice" ? { kind: "text", value: field.choices![0] }
            : { kind: "value", value: index + 1 },
      }));
      const incoming = [...recorded].reverse();
      const before = structuredClone(incoming);
      const newer = { ...profile, version: profile.version + 1, modes: profile.modes.map(m => ({
        ...m, fields: [...m.fields].reverse(), stages: [...m.stages].reverse(),
      })) };
      for (const Component of [MachineRecordedSetups, MachinePriorSetup]) {
        const html = renderToStaticMarkup(createElement(Component, { readings: incoming, catalogue: [newer, profile] }));
        const positions = recorded.map(r => html.indexOf(`>${r.value.kind === "text" ? r.value.value : r.value.kind === "value" ? r.value.value.toFixed(r.decimals) : ""}</span>`));
        expect(positions.every(p => p >= 0)).toBe(true);
        expect(positions).toEqual([...positions].sort((a, b) => a - b));
      }
      expect(incoming).toEqual(before);
    });
  }
}
it("Senior MultiPlex: history and prior preserve retained contract order of warming before MicroFlash", () => {
  const profile = APILUS_3G_NATIVE_FIXTURES[0];
  const mode = profile.modes.find(m => m.key === "multiplex")!;
  const recorded = modeFields(mode).map(({ field, stageKey }, index): RecordedReading => ({
    ...row(profile, "unused"), profileVersion: profile.version, modeKey: mode.key,
    stageKey, fieldKey: field.key, nativeUnit: field.unit, decimals: field.decimals,
    value: { kind: "value", value: index + 1 },
  }));
  for (const Component of [MachineRecordedSetups, MachinePriorSetup]) {
    const html = renderToStaticMarkup(createElement(Component, { readings: [...recorded].reverse(), catalogue: [profile] }));
    expect(html.indexOf("Warming H.F.")).toBeGreaterThanOrEqual(0);
    expect(html.indexOf("MicroFlash pulse")).toBeGreaterThan(html.indexOf("Warming H.F."));
  }
});
