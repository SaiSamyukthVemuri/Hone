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

type TestReading = PacketSetupReadingSource & { id: string };
const reading = (over: Partial<TestReading> = {}): TestReading => ({
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
    const n = nativeSettingsForBlock([reading(), reading({ id: "r9", field_key: "x", ...over } as Partial<TestReading>)].slice(over ? 1 : 0));
    expect(n).toEqual({ kind: "unreadable" });
    const s = settingsOf(packet([reading(), reading({ id: "r9", ...over } as Partial<TestReading>)]));
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
  it("the printed settings do not depend on the order the rows arrive in (the RPC orders by field, not time)", () => {
    const t = "2026-05-10T15:00:00.000Z";
    const other = found.p.modes.find((m) => m.key !== found.m.key);
    const rows = [
      reading({ id: "a", group_key: "g1", capture_id: "c1", recorded_at: t }),
      reading({ id: "b", group_key: "g1", capture_id: "c2", revision: 1, recorded_at: t, value_numeric: "9.5" }), // ties on time, group and revision
      reading({ id: "c", group_key: "g1", capture_id: "c3", revision: 2, recorded_at: "2026-05-10T15:05:00.000Z", value_numeric: "3.5" }),
      reading({ id: "d", group_key: "g2", capture_id: "c4", recorded_at: t, ...(other ? { mode_key: other.key } : {}) }),
    ];
    const render = (rs: typeof rows) => JSON.stringify(nativeSettingsForBlock(rs));
    const base = render(rows);
    const perms = [[3, 2, 1, 0], [1, 0, 3, 2], [2, 0, 3, 1], [0, 3, 1, 2]];
    for (const p of perms) expect(render(p.map((i) => rows[i]))).toBe(base);
  });
  it("a native block with no probe recorded prints no probe line", () => {
    expect(settingsOf(packet([reading()])).some((r) => r.label.startsWith("Probe"))).toBe(false);
  });
});

describe("loadDayPacket reads the native readings", () => {
  const mk = (tables: Record<string, Array<Record<string, unknown>>>, fail?: string) => {
    const ops: Array<[string, string, ...unknown[]]> = [];
    const rpcCalls: Array<[string, Record<string, string>]> = [];
    const reader: PacketReader = {
      // One block's readings in ONE call (the DB function is a single STABLE statement). RLS is
      // modelled by dropping other studios' rows; the real behaviour is proven in the E-5 DB test.
      rpc(fn, args) {
        rpcCalls.push([fn, args]);
        if (fail === "rpc") return Promise.resolve({ data: null, error: { message: "x" } });
        const rows = (tables.treatment_setup_readings ?? [])
          .filter((r) => r.session_block_id === args.p_block_id && r.studio_id === "st")
          .map(({ studio_id: _s, id: _i, ...rest }) => rest);
        return Promise.resolve({ data: rows, error: null });
      },
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
    return { reader, ops, rpcCalls };
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
  it("reads each of this day's blocks through setup_readings_for_block with the block's own session, and attaches only that block's rows", async () => {
    const { reader, rpcCalls, ops } = mk(tables);
    const r = await run(reader);
    expect(rpcCalls).toEqual([["setup_readings_for_block", { p_block_id: "b1", p_session_id: "s1" }]]);
    expect(r.ok && r.value.setupReadings.map((x) => x.session_block_id)).toEqual(["b1"]);
    expect(r.ok && r.value.setupReadings).toHaveLength(1); // the other studio's and other block's rows never arrive
    // The keyset page loop over the readings table is gone: nothing may query it directly.
    expect(ops.some((o) => o[0] === "treatment_setup_readings")).toBe(false);
  });
  it.each([
    ["an rpc error", "rpc"],
  ])("a failed readings read (%s) fails the whole packet, never an empty settings list", async (_n, f) => {
    const { reader } = mk(tables, f);
    expect(await run(reader)).toEqual({ ok: false, reason: "read_failed" });
  });
  it("a non-array answer, a thrown rpc and a row for a different block each fail the whole packet", async () => {
    const base = mk(tables).reader;
    const bad = (rpc: PacketReader["rpc"]) => run({ ...base, from: base.from, rpc });
    expect(await bad(() => Promise.resolve({ data: { not: "an array" }, error: null }))).toEqual({ ok: false, reason: "read_failed" });
    expect(await bad(() => Promise.resolve({ data: null, error: null }))).toEqual({ ok: false, reason: "read_failed" });
    expect(await bad(() => Promise.reject(new Error("boom")))).toEqual({ ok: false, reason: "read_failed" });
    expect(await bad(() => Promise.resolve({ data: [{ ...reading({ session_block_id: "b-else" }) }], error: null }))).toEqual({ ok: false, reason: "read_failed" });
  });
  it("an empty day makes no readings read", async () => {
    const { reader, ops, rpcCalls } = mk({ ...tables, sessions: [] });
    const r = await run(reader);
    expect(r.ok && r.value.setupReadings).toEqual([]);
    expect(ops.some((o) => o[0] === "treatment_setup_readings")).toBe(false);
    expect(rpcCalls).toEqual([]);
  });
});

// Codex P1 #4500529393. A capture committed WHILE the readings are being read must never
// come back half-read. The store below commits a two-field capture right after the first
// request that touches the readings returns, with one row sorting before the keyset cursor
// and one after - the exact straddle. rpc() answers from the store at the instant of the
// call (one statement, one snapshot); a paged from() read would see the commit mid-loop.
describe("a capture committed during the read is never returned partially", () => {
  const sess = { id: "s1", studio_id: "st", client_id: "cl", deleted_at: null, started_at: "2026-05-10T15:00:00.000Z", ended_at: null, modality: "x", session_notes: null, performed_by_practitioner_id: "p1", practitioner_id: "p1", aftercare_and_risks_explained_at: null, aftercare_and_risks_explained_by: null };
  const row = (id: string, capture: string, field: string) => ({ ...reading({ id, capture_id: capture, field_key: field }), studio_id: "st" });
  const build = () => {
    // 1,000 rows in capture c0 fill a whole page; capture c1 (2 rows) is committed afterwards.
    const store: Array<Record<string, unknown>> = Array.from({ length: 1000 }, (_v, i) => row(`m-${String(i).padStart(4, "0")}`, "c0", `f${i}`));
    const expected: Record<string, number> = { c0: 1000, c1: 2 };
    let committed = false;
    const commit = () => {
      if (committed) return;
      committed = true;
      store.push(row("a-0001", "c1", "current"), row("z-0001", "c1", "duration"));
    };
    const strip = ({ studio_id: _s, id: _i, ...rest }: Record<string, unknown>) => rest;
    const reader: PacketReader = {
      rpc(_fn, args) {
        const snapshot = store.filter((r) => r.session_block_id === args.p_block_id).map(strip);
        commit(); // lands after this statement's snapshot
        return Promise.resolve({ data: snapshot, error: null });
      },
      from(table: string) {
        const calls: Array<[string, unknown, unknown]> = [];
        const q: PacketQuery = {
          select: () => q, eq: (c, v) => (calls.push(["eq", c, v]), q), is: (c, v) => (calls.push(["is", c, v]), q),
          in: (c, v) => (calls.push(["in", c, v]), q), gt: (c, v) => (calls.push(["gt", c, v]), q),
          gte: () => q, lt: () => q, order: () => q, range: () => q,
          then(ok, bad) {
            const base: Record<string, Array<Record<string, unknown>>> = {
              sessions: [sess], practitioners: [{ id: "p1", display_name: "D" }],
              session_blocks: [{ ...block(), studio_id: "st", deleted_at: null }],
            };
            let rows = table === "treatment_setup_readings" ? [...store] : [...(base[table] ?? [])];
            rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
            for (const [op, c, v] of calls) {
              if (op === "eq" || op === "is") rows = rows.filter((r) => r[c as string] === v);
              if (op === "in") rows = rows.filter((r) => (v as string[]).includes(r[c as string] as string));
              if (op === "gt") rows = rows.filter((r) => String(r[c as string]) > String(v));
            }
            const page = rows.slice(0, 1000);
            if (table === "treatment_setup_readings") commit();
            return Promise.resolve({ data: page, error: null }).then(ok, bad);
          },
        };
        return q;
      },
    };
    return { reader, expected };
  };
  it("every capture that is returned is returned whole", async () => {
    const { reader, expected } = build();
    const r = await loadDayPacket({ supabase: reader, studioId: "st", clientId: "cl", day: "2026-05-10", timezone: "America/Toronto", loadBlockAreas: () => Promise.resolve(new Map()) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const counts: Record<string, number> = {};
    for (const x of r.value.setupReadings) counts[x.capture_id ?? ""] = (counts[x.capture_id ?? ""] ?? 0) + 1;
    // Positive control: the filled page really was read, so the loop below is not vacuous.
    expect(counts.c0).toBe(1000);
    for (const [capture, n] of Object.entries(counts)) expect(n).toBe(expected[capture]);
  });
});
