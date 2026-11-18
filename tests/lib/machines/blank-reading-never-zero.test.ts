import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { MACHINE_CATALOGUE } from "@/lib/machines/catalogue";
import { nativeFieldGroups, priorSetupView } from "@/lib/machines/charting";
import type { FieldGroup, RecordedSetup } from "@/lib/machines/charting";
import type { MachineProfile } from "@/lib/machines/profile-contract";
import type { StudioDevice } from "@/lib/machines/selection";
import { assembleReadings, draftKey, parse } from "@/lib/machines/setting-groups";
import type { MachineDb } from "@/lib/machines/machine-queries";
import {
  latestRecordedSetup,
  readingsForBlock,
  recordSetupGroup,
} from "@/lib/machines/machine-queries";

// A BLANK OPTIONAL READING IS NEVER A ZERO.
//
// A practitioner who leaves a numeric field blank has told us nothing about it.
// A stored 0 would say "the machine showed 0", which is a different and
// clinical claim, and a stored row is immutable. This pins the rule at every
// step a blank passes through, for every model in the catalogue, so a model or
// field added later is covered without a new test:
//
//   1. parse + assembleReadings (form text -> submitted readings): no reading;
//   2. validateSubmittedReadings: only what it is given, a real 0 stays 0;
//   3. the write payload: a value is sent as its own text, nothing is invented;
//   4. recall (readingsForBlock, latestRecordedSetup, priorSetupView): a row
//      with no number reads back as absent and is shown as "not recorded";
//   5. the source: no coercion of draft text to a number outside `parse`, and
//      the two `Number(data ?? 0)` calls in machine-queries.ts are counts.
//
// Synthetic values and ids only. Nothing here corresponds to a real machine.

const runtimeCatalogue = vi.hoisted(() => ({ value: [] as MachineProfile[] }));
vi.mock("@/lib/machines/synthetic-profile", async (orig) => ({
  ...(await orig<typeof import("@/lib/machines/synthetic-profile")>()),
  catalogueForRuntime: () => runtimeCatalogue.value,
}));
const { validateSubmittedReadings } = await import("@/lib/machines/validate-submitted-readings");

/** Every field of every mode of every profile, as the capture screen describes it. */
function allGroups(): Array<{ profile: MachineProfile; modeKey: string; group: FieldGroup }> {
  const out: Array<{ profile: MachineProfile; modeKey: string; group: FieldGroup }> = [];
  for (const profile of MACHINE_CATALOGUE) {
    for (const mode of profile.modes) {
      for (const group of nativeFieldGroups(profile, mode)) out.push({ profile, modeKey: mode.key, group });
    }
  }
  return out;
}
const NUMERIC = allGroups().flatMap(({ profile, modeKey, group }) =>
  group.fields.filter((f) => f.valueKind !== "text" && f.valueKind !== "choice").map((f) => ({ profile, modeKey, group, f })),
);

describe("the catalogue is non-trivial, so the loops below are not vacuous", () => {
  it("covers many numeric fields, optional and required", () => {
    expect(NUMERIC.length).toBeGreaterThan(20);
    expect(NUMERIC.some(({ f }) => f.optional)).toBe(true);
    expect(NUMERIC.some(({ f }) => !f.optional)).toBe(true);
  });
});

describe("1. form text becomes a reading only when a number was typed", () => {
  it("parse: blank, whitespace and non-numbers are null; zero is a value", () => {
    for (const raw of ["", " ", "   ", "\t", "\n"]) expect(parse(raw)).toBeNull();
    for (const raw of ["abc", "NaN", "Infinity", "-Infinity", "1,2", "0x"]) expect(parse(raw)).toBeNull();
    expect(parse("0")).toEqual({ kind: "value", value: 0 });
    expect(parse("0.0")).toEqual({ kind: "value", value: 0 });
    expect(parse(" 0 ")).toEqual({ kind: "value", value: 0 });
    expect(parse("0.043")).toEqual({ kind: "value", value: 0.043 });
  });

  it("EVERY numeric field in the catalogue: a blank draft submits nothing, and a typed 0 submits exactly 0", () => {
    for (const { group, f } of NUMERIC) {
      for (const blank of ["", "  ", "\t"]) {
        const out = assembleReadings([group], { [draftKey(group.key, f)]: blank });
        expect(out, `${group.label}/${f.key} turned a blank into a reading`).toEqual([]);
      }
      const missing = assembleReadings([group], {});
      expect(missing, `${group.label}/${f.key} invented a reading for an untouched field`).toEqual([]);
      const zero = assembleReadings([group], { [draftKey(group.key, f)]: "0" });
      expect(zero).toEqual([
        { stageKey: f.stageKey, fieldKey: f.key, value: { kind: "value", value: 0 }, observationSource: f.expectedSource },
      ]);
    }
  });

  it("a blank next to a filled field leaves only the filled one", () => {
    const { group } = NUMERIC.find(({ group }) => group.fields.filter((x) => x.valueKind !== "text").length >= 2)!;
    const [a, b] = group.fields.filter((x) => x.valueKind !== "text" && x.valueKind !== "choice");
    const out = assembleReadings([group], { [draftKey(group.key, a!)]: "", [draftKey(group.key, b!)]: "1" });
    expect(out.map((r) => r.fieldKey)).toEqual([b!.key]);
  });
});

describe("2. validateSubmittedReadings sees only what it is given", () => {
  const first = MACHINE_CATALOGUE.find((p) => p.availability === "active" && p.modes.some((m) => m.availability === "active"))!;
  const mode = first.modes.find((m) => m.availability === "active")!;
  const groups = nativeFieldGroups(first, mode);
  const field = groups.flatMap((g) => g.fields).find((f) => f.valueKind !== "text" && f.valueKind !== "choice")!;
  const device: StudioDevice = {
    deviceId: "dev-1", studioId: "studio-1", profileId: first.profileId, profileVersion: first.version,
    displayName: "Synthetic", installedOptions: [], retiredAt: null,
  };
  const run = (readings: Parameters<typeof validateSubmittedReadings>[3]) => {
    runtimeCatalogue.value = [first];
    return validateSubmittedReadings(device, first, mode.key, readings, []);
  };

  it("anti-vacuity: the profile resolves and a real value is stored as that value", () => {
    const out = run([{ stageKey: field.stageKey, fieldKey: field.key, value: { kind: "value", value: 1 }, observationSource: field.expectedSource }]);
    expect("rows" in out && out.rows.map((r) => r.value)).toEqual([{ kind: "value", value: 1 }]);
  });
  it("no reading submitted means no row stored", () => {
    const out = run([]);
    expect("rows" in out && out.rows).toEqual([]);
  });
  it("a real zero stays a zero, never dropped and never turned into an absence", () => {
    const out = run([{ stageKey: field.stageKey, fieldKey: field.key, value: { kind: "value", value: 0 }, observationSource: field.expectedSource }]);
    if ("error" in out) return; // a contract whose range refuses 0 refuses it loudly; it must not store anything else
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]!.value).toEqual({ kind: "value", value: 0 });
  });
});

describe("3. the write payload sends a value as its own text and invents nothing", () => {
  const sent: Array<Record<string, unknown>> = [];
  const db = {
    rpc: async (_fn: string, args: Record<string, unknown>) => {
      sent.push(args);
      return { data: 3, error: null as never };
    },
  } as unknown as MachineDb;
  const base = { blockId: "b", machineId: "m", modeKey: "k", groupKey: null, newGroupRef: "r", channels: [], sessionId: "s", clientId: "c" };
  const row = (value: ReturnType<typeof parse> | { kind: "absent"; reason: "not-recorded" }) => ({
    stageKey: null, fieldKey: "f", value: value!, nativeUnit: "s", decimals: 3, observationSource: "practitioner-entered" as const,
  });
  it("0 is sent as '0', 0.043 as '0.043', and neither gains or loses a digit", async () => {
    sent.length = 0;
    await recordSetupGroup(db, { ...base, readings: [row({ kind: "value", value: 0 }), row({ kind: "value", value: 0.043 })] });
    const payload = sent[0]!.p_readings as Array<Record<string, unknown>>;
    expect(payload.map((p) => p.value)).toEqual(["0", "0.043"]);
    expect(payload.every((p) => !("absence_reason" in p))).toBe(true);
  });
  it("an absence is sent as an absence reason with NO value", async () => {
    sent.length = 0;
    await recordSetupGroup(db, { ...base, readings: [row({ kind: "absent", reason: "not-recorded" })] });
    const p = (sent[0]!.p_readings as Array<Record<string, unknown>>)[0]!;
    expect(p).toMatchObject({ absence_reason: "not-recorded" });
    expect("value" in p).toBe(false);
  });
  it("an empty submission sends an empty list, not a placeholder", async () => {
    sent.length = 0;
    await recordSetupGroup(db, { ...base, readings: [] });
    expect(sent[0]!.p_readings).toEqual([]);
  });
});

describe("4. recall: a row with no number is absent, and shown as 'not recorded'", () => {
  const dbRow = (over: Record<string, unknown>) => ({
    session_block_id: "b", machine_profile_id: "p", machine_profile_version: 1, mode_key: "k", group_key: "g1", channels: null,
    stage_key: null, field_key: "f", value_text: null, value_numeric: null, absence_reason: null, native_unit: "s", decimals: 3,
    revision: 1, capture_id: null, studio_machine_id: "m", observation_source: "practitioner-entered", recorded_at: "2031-01-01T00:00:00Z", ...over,
  });
  const dbOf = (rows: unknown[]) => ({ rpc: async () => ({ data: rows, error: null as never }) }) as unknown as MachineDb;

  it("readingsForBlock: numeric strings keep their digits, zero is zero, null is absent", async () => {
    const out = await readingsForBlock(dbOf([
      dbRow({ field_key: "a", value_numeric: "0.043" }),
      dbRow({ field_key: "z", value_numeric: "0" }),
      dbRow({ field_key: "zero_number", value_numeric: 0 }),
      dbRow({ field_key: "n", value_numeric: null, absence_reason: null }),
      dbRow({ field_key: "na", value_numeric: null, absence_reason: "not-applicable" }),
    ]) as never, "block", "session");
    if (!out.ok) throw new Error("read failed");
    const by = Object.fromEntries(out.value.map((r) => [r.fieldKey, r.value]));
    expect(by.a).toEqual({ kind: "value", value: 0.043 });
    expect(by.z).toEqual({ kind: "value", value: 0 });
    expect(by.zero_number).toEqual({ kind: "value", value: 0 });
    expect(by.n).toEqual({ kind: "absent", reason: "not-recorded" });
    expect(by.na).toEqual({ kind: "absent", reason: "not-applicable" });
  });

  it("latestRecordedSetup: an absent row is never read back as a value, and a field with no row has no reading", async () => {
    const out = await latestRecordedSetup(dbOf([dbRow({ field_key: "present", value_numeric: "1.5" }), dbRow({ field_key: "blank", value_numeric: null })]), "studio", "client", "session");
    if (!out.ok) throw new Error("read failed");
    expect(out.value.map((r) => r.fieldKey)).toEqual(["present", "blank"]);
    expect(out.value.find((r) => r.fieldKey === "blank")!.value.kind).toBe("absent");
    expect(out.value.find((r) => r.fieldKey === "never-saved")).toBeUndefined();
  });

  it("priorSetupView: an absent reading shows 'not recorded', a zero shows 0, and a finer value keeps its own digits", () => {
    const profile = MACHINE_CATALOGUE.find((p) => p.modes.some((m) => nativeFieldGroups(p, m).some((g) => g.fields.some((f) => f.valueKind !== "text"))))!;
    const mode = profile.modes.find((m) => nativeFieldGroups(profile, m).some((g) => g.fields.length > 0))!;
    const f = nativeFieldGroups(profile, mode).flatMap((g) => g.fields).find((x) => x.valueKind !== "text" && x.valueKind !== "choice")!;
    const setup = (value: RecordedSetup["groups"][number]["readings"][string]): RecordedSetup => ({
      profileId: profile.profileId, profileVersion: profile.version, modeKey: mode.key, recordedAt: "2031-01-01T00:00:00Z", sessionId: "s",
      groups: [{ groupId: "g", channels: [], readings: { [f.key]: value } }],
    });
    const show = (v: Parameters<typeof setup>[0]) => {
      const view = priorSetupView(setup(v));
      if ("unavailable" in view) throw new Error(view.unavailable);
      return view.groups[0]!.rows[0]!.display;
    };
    expect(show({ kind: "absent", reason: "not-recorded" })).toBe("not recorded");
    expect(show({ kind: "absent", reason: "not-recorded" })).not.toMatch(/^0/);
    expect(show({ kind: "value", value: 0 })).toBe((0).toFixed(f.decimals));
    expect(show({ kind: "value", value: 0.043 })).toContain("0.043");
  });
});

describe("5. the source: no number coercion of a blank, and the two `?? 0` calls are counts", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  it("Number(...) is applied to a draft string only inside parse, after the blank check", () => {
    const src = read("lib/machines/setting-groups.ts");
    const body = src.slice(src.indexOf("export function parse"), src.indexOf("export function draftKey"));
    expect(body.indexOf('trimmed === ""')).toBeGreaterThan(-1);
    expect(body.indexOf('trimmed === ""')).toBeLessThan(body.indexOf("Number(trimmed)"));
    expect(src.replace(body, "")).not.toMatch(/Number\(\s*(raw|draft|value|trimmed)/);
  });
  it("no machine component coerces typed text with Number() or unary plus", () => {
    for (const f of ["machine-setting-draft.tsx", "setting-draft-fields.tsx", "machine-first-setup-panel.tsx", "machine-reading-entry.tsx"]) {
      expect(read(`components/machines/${f}`), f).not.toMatch(/Number\(\s*(e\.target\.value|event\.target\.value|value|raw|draft)/);
    }
  });
  it("machine-queries.ts: every `Number(x ?? 0)` wraps an RPC's returned COUNT, never a reading value", () => {
    const src = read("lib/machines/machine-queries.ts");
    const hits = [...src.matchAll(/Number\(([^)]*\?\? 0)\)/g)].map((m) => m[1]);
    // The save and publish commands return how many rows they wrote; the other two are summary counts.
    expect(hits).toEqual(["data ?? 0", "row?.groups ?? 0", "row?.readings ?? 0", "data ?? 0"]);
    const around = (needle: string) => src.slice(src.lastIndexOf("rpc(", src.indexOf(needle)), src.indexOf(needle));
    expect(around("return { ok: true, value: Number(data ?? 0) };")).toMatch(/record_treatment_setup_group|sync_machine_profile_contract/);
    // a reading's own value comes from value_numeric and has no default
    expect(src).toMatch(/r\.value_numeric != null\s*\?\s*\{ kind: "value", value: Number\(r\.value_numeric\) \}/);
    expect(src).not.toMatch(/value_numeric \?\? 0|Number\(r\.value_numeric \?\? /);
  });
});
