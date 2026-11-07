import { describe, expect, it } from "vitest";
import { MACHINE_CATALOGUE } from "@/lib/machines/catalogue";
import { modeFields } from "@/lib/machines/profile-contract";
import { NATIVE_SETTINGS_UNREADABLE, nativeSettingsForBlock, type PacketSetupReadingSource } from "@/lib/records/print/machine-settings";
import { buildDayPacket, type PacketBlockSource, type PacketSessionSource } from "@/lib/records/print/day-packet";
import { loadDayPacket, type PacketQuery, type PacketReader } from "@/lib/records/print/day-loader";

// A real numeric field from today's catalogue, so labels come from the contract, not the test.
const found = (() => {
  for (const p of MACHINE_CATALOGUE) for (const m of p.modes) for (const f of modeFields(m)) {
    if (f.stageKey === null && f.field.decimals >= 1 && f.field.unit !== "none") return { p, m, f: f.field };
  }
  throw new Error("no numeric field in catalogue");
})();

const reading = (over: Partial<PacketSetupReadingSource> = {}): PacketSetupReadingSource => ({
  id: "r1", session_block_id: "b1", capture_id: "c1", machine_profile_id: found.p.profileId, machine_profile_version: found.p.version,
  mode_key: found.m.key, group_key: "g1", channels: [], stage_key: null, field_key: found.f.key, value_numeric: "1.25", value_text: null,
  absence_reason: null, native_unit: found.f.unit, decimals: found.f.decimals, observation_source: "practitioner-entered", revision: 1,
  recorded_at: "2026-05-10T15:00:00.000Z", ...over,
});

const session: PacketSessionSource = {
  id: "s1", started_at: "2026-05-10T15:00:00.000Z", ended_at: null, modality: "Electrolysis", session_notes: null,
  performed_by_practitioner_id: "p1", practitioner_id: "p1", aftercare_and_risks_explained_at: null, aftercare_and_risks_explained_by: null,
} as PacketSessionSource;
const block = (over: Partial<PacketBlockSource> = {}): PacketBlockSource => ({
  id: "b1", session_id: "s1", sort_order: 0, block_name: null, primary_area: "Upper lip", side: null, custom_area_detail: null, mode: "LEGACY-MODE",
  apilus_modality: null, energy_level: "99", minutes_performed: 10, machine_frequency: "STALE-FREQ", probe_label: null, probe_type: null,
  probe_size: null, probe_lot_number: null, numbing_status: null, numbing_notes: null, tolerance_rating: null, reaction_type: null,
  reaction_notes: null, caution_note: null, block_notes: null, started_at: null, ended_at: null, created_at: "2026-05-10T15:00:00.000Z", ...over,
});
const packet = (setupReadings: PacketSetupReadingSource[], blockOver: Partial<PacketBlockSource> = {}) =>
  buildDayPacket({ day: "2026-05-10", timezone: "America/Toronto", studioName: "S", clientName: "C", sessions: [session], blocks: [block(blockOver)], entries: [], laserEntries: [], setupReadings, practitionerNameById: new Map() });
const settingsOf = (p: ReturnType<typeof packet>) => p.visits[0].areas[0].settings;

describe("machine-native settings (Codex P1 #4500315781)", () => {
  it("a machine-first block prints its native settings under the contract's own label and unit", () => {
    const s = settingsOf(packet([reading()]));
    expect(s.some((r) => r.label === found.f.nativeLabel && r.value.startsWith("1.25"))).toBe(true);
    expect(s[0].label).toBe("Machine settings");
  });
  it("a block with BOTH native readings and legacy columns prints the native ones and none of the legacy", () => {
    const s = settingsOf(packet([reading()]));
    const text = JSON.stringify(s);
    expect(text).not.toContain("STALE-FREQ");
    expect(text).not.toContain("LEGACY-MODE");
    expect(text).not.toContain("99");
  });
  it("a block with no native readings still prints its legacy columns", () => {
    expect(JSON.stringify(settingsOf(packet([])))).toContain("STALE-FREQ");
  });
  it("another block's readings are never attached", () => {
    expect(JSON.stringify(settingsOf(packet([reading({ session_block_id: "other" })])))).toContain("STALE-FREQ");
  });
  it("a changed setting shows both observations, oldest first", () => {
    const s = settingsOf(packet([
      reading({ id: "r2", revision: 2, capture_id: "c2", value_numeric: "2.5", recorded_at: "2026-05-10T15:05:00.000Z" }),
      reading(),
    ]));
    const vals = s.filter((r) => r.label === found.f.nativeLabel).map((r) => r.value.split(" ")[0]);
    expect(vals).toEqual(["1.25", "2.50"]);
    expect(s.filter((r) => r.label === "Machine settings")[0].value).toContain("entry 1 of 2");
  });
  it("an absence prints in words, never as blank or zero", () => {
    const s = settingsOf(packet([reading({ value_numeric: null, absence_reason: "not-legible" })]));
    expect(s.some((r) => r.value.startsWith("Not legible"))).toBe(true);
  });
  it.each([
    ["a profile no longer in the catalogue", { machine_profile_id: "gone:model" }],
    ["a version that is not retained", { machine_profile_version: 9999 }],
    ["a mode the contract does not have", { mode_key: "no-such-mode" }],
    ["a field the contract does not have", { field_key: "no_such_field" }],
    ["a value of an unknown shape", { value_numeric: "NaN" }],
    ["a row with neither value nor a known absence", { value_numeric: null, absence_reason: "weird" }],
  ])("FAILS CLOSED for %s: explicit message, no legacy fallback, no partial settings", (_n, over) => {
    const n = nativeSettingsForBlock([reading(), reading({ id: "r9", field_key: "x", ...over } as Partial<PacketSetupReadingSource>)].slice(over ? 1 : 0));
    expect(n).toEqual({ kind: "unreadable" });
    const s = settingsOf(packet([reading(), reading({ id: "r9", ...over } as Partial<PacketSetupReadingSource>)]));
    expect(s).toEqual([{ label: "Settings", value: NATIVE_SETTINGS_UNREADABLE }]);
    expect(JSON.stringify(s)).not.toContain("STALE-FREQ");
  });
});

describe("probe identity and lot are kept whichever source supplies the settings (Codex P2 #4500489752)", () => {
  const probe = { probe_label: "Probe-X", probe_type: "insulated", probe_size: "002", probe_lot_number: "LOT-77" };
  it("a native block prints its probe and lot after the native settings", () => {
    const s = settingsOf(packet([reading()], probe));
    expect(s).toContainEqual({ label: "Probe", value: "Probe-X insulated 002" });
    expect(s).toContainEqual({ label: "Probe lot", value: "LOT-77" });
    expect(JSON.stringify(s)).not.toContain("STALE-FREQ");
  });
  it("an unreadable native block still prints probe and lot next to the refusal, and no legacy settings", () => {
    const s = settingsOf(packet([reading({ mode_key: "no-such-mode" })], probe));
    expect(s).toEqual([
      { label: "Settings", value: NATIVE_SETTINGS_UNREADABLE },
      { label: "Probe", value: "Probe-X insulated 002" },
      { label: "Probe lot", value: "LOT-77" },
    ]);
  });
  it("a legacy block is unchanged: mode, energy, frequency, then probe and lot", () => {
    expect(settingsOf(packet([], probe)).map((r) => r.label)).toEqual(["Mode", "Energy level", "Frequency", "Probe", "Probe lot"]);
  });
  it("a native block with no probe recorded prints no probe line", () => {
    expect(settingsOf(packet([reading()])).some((r) => r.label.startsWith("Probe"))).toBe(false);
  });
});

describe("loadDayPacket reads the native readings", () => {
  const mk = (tables: Record<string, Array<Record<string, unknown>>>, fail?: string) => {
    const ops: Array<[string, string, ...unknown[]]> = [];
    const reader: PacketReader = {
      from(table: string) {
        const calls: Array<[string, unknown, unknown]> = [];
        const q: PacketQuery = {
          select: (c) => (ops.push([table, "select", c]), q),
          eq: (c, v) => (calls.push(["eq", c, v]), ops.push([table, "eq", c, v]), q),
          is: (c, v) => (calls.push(["is", c, v]), q), in: (c, v) => (calls.push(["in", c, v]), q), gt: (c, v) => (calls.push(["gt", c, v]), q),
          gte: (c, v) => (calls.push(["gte", c, v]), q), lt: (c, v) => (calls.push(["lt", c, v]), q), order: () => q, range: () => q,
          then(ok, bad) {
            if (fail === table) return Promise.resolve({ data: null, error: { message: "x" } }).then(ok, bad);
            let rows = [...(tables[table] ?? [])].sort((a, b) => String(a.id).localeCompare(String(b.id)));
            for (const [op, c, v] of calls) {
              if (op === "eq" || op === "is") rows = rows.filter((r) => r[c as string] === v);
              if (op === "in") rows = rows.filter((r) => (v as string[]).includes(r[c as string] as string));
              if (op === "gt") rows = rows.filter((r) => String(r[c as string]) > String(v));
              if (op === "gte") rows = rows.filter((r) => String(r[c as string]) >= String(v));
              if (op === "lt") rows = rows.filter((r) => String(r[c as string]) < String(v));
            }
            return Promise.resolve({ data: rows, error: null }).then(ok, bad);
          },
        };
        return q;
      },
    };
    return { reader, ops };
  };
  const sess = { id: "s1", studio_id: "st", client_id: "cl", deleted_at: null, started_at: "2026-05-10T15:00:00.000Z", ended_at: null, modality: "x", session_notes: null, performed_by_practitioner_id: "p1", practitioner_id: "p1", aftercare_and_risks_explained_at: null, aftercare_and_risks_explained_by: null };
  const run = (reader: PacketReader) => loadDayPacket({ supabase: reader, studioId: "st", clientId: "cl", day: "2026-05-10", timezone: "America/Toronto", loadBlockAreas: () => Promise.resolve(new Map()) });
  const tables = {
    sessions: [sess], practitioners: [{ id: "p1", display_name: "D" }],
    session_blocks: [{ ...block(), studio_id: "st", deleted_at: null }],
    treatment_setup_readings: [
      { ...reading(), studio_id: "st" },
      { ...reading({ id: "r-foreign", session_block_id: "b1" }), studio_id: "other-studio" },
      { ...reading({ id: "r-otherblock", session_block_id: "b-else" }), studio_id: "st" },
    ],
  };
  it("loads only this studio's readings for this day's blocks, with named columns", async () => {
    const { reader, ops } = mk(tables);
    const r = await run(reader);
    expect(r.ok && r.value.setupReadings.map((x) => x.id)).toEqual(["r1"]);
    expect(ops).toContainEqual(["treatment_setup_readings", "eq", "studio_id", "st"]);
    expect(ops.find((o) => o[0] === "treatment_setup_readings" && o[1] === "select")![2]).not.toContain("*");
  });
  it("a failed readings read fails the whole packet, never an empty settings list", async () => {
    const { reader } = mk(tables, "treatment_setup_readings");
    expect(await run(reader)).toEqual({ ok: false, reason: "read_failed" });
  });
  it("an empty day makes no readings read", async () => {
    const { reader, ops } = mk({ ...tables, sessions: [] });
    const r = await run(reader);
    expect(r.ok && r.value.setupReadings).toEqual([]);
    expect(ops.some((o) => o[0] === "treatment_setup_readings")).toBe(false);
  });
});
