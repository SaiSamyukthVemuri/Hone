import { describe, expect, it } from "vitest";
import {
  buildDayPacket,
  DOB_PENDING,
  NOT_RECORDED,
  PACKET_EXCLUSIONS,
  type PacketBlockSource,
  type PacketEntrySource,
  type PacketSessionSource,
} from "@/lib/records/print/day-packet";

const TZ = "America/Toronto";
const session = (over: Partial<PacketSessionSource> = {}): PacketSessionSource => ({
  id: "s1", started_at: "2026-05-11T02:30:00.000Z", ended_at: null, modality: "Electrolysis", session_notes: null,
  performed_by_practitioner_id: "p1", practitioner_id: "p0", aftercare_and_risks_explained_at: null, aftercare_and_risks_explained_by: null, ...over,
});
const block = (over: Partial<PacketBlockSource> = {}): PacketBlockSource => ({
  id: "b1", session_id: "s1", sort_order: 1, block_name: null, primary_area: "Upper lip", side: null, custom_area_detail: null,
  mode: null, apilus_modality: null, energy_level: null, minutes_performed: null, machine_frequency: null, probe_label: null,
  probe_type: null, probe_size: null, probe_lot_number: null, numbing_status: null, numbing_notes: null, tolerance_rating: null,
  reaction_type: null, reaction_notes: null, caution_note: null, caution_for_next_session: null, block_notes: null,
  started_at: null, ended_at: null, created_at: "2026-05-11T02:31:00.000Z", ...over,
});
const entry = (over: Partial<PacketEntrySource> = {}): PacketEntrySource => ({
  id: "e1", session_id: "s1", block_id: "b1", area: null, areas: null, probe_type: null, probe_size: null, mode: null, apilus_modality: null,
  intensity: null, duration_seconds: null, energy_level: null, machine_frequency: null, thermolysis_intensity_percent: null,
  thermolysis_duration_seconds: null, galvanic_ma: null, galvanic_duration_seconds: null, units_of_lye: null, pulse_delay_seconds: null,
  minutes_performed: null, pulse_count: null, hairs_treated: null, observation_chips: null, comments: null, created_at: "2026-05-11T02:32:00.000Z", ...over,
});
const names = new Map([["p1", "Dana Reyes"], ["p0", "Other Person"]]);
const base = { day: "2026-05-10", timezone: TZ, studioName: "Studio", clientName: "Legal Name (Pref)", practitionerNameById: names, laserEntries: [] };

describe("buildDayPacket", () => {
  it("prints times in the studio-local zone: a 22:30 EDT visit is on the selected local day", () => {
    const p = buildDayPacket({ ...base, sessions: [session()], blocks: [], entries: [] });
    expect(p.visits[0].startTime).toBe("10:30 PM");
    expect(p.visits[0].localDate).toBe("2026-05-10");
  });
  it("missing stays missing: no duration, practitioner, service or aftercare becomes a value", () => {
    const p = buildDayPacket({
      ...base,
      sessions: [session({ modality: null, performed_by_practitioner_id: null, practitioner_id: null })],
      blocks: [block({ primary_area: null })],
      entries: [],
    });
    const v = p.visits[0];
    expect(v.service).toBe(NOT_RECORDED);
    expect(v.practitioner).toBe(NOT_RECORDED);
    expect(v.aftercare).toBe(NOT_RECORDED);
    expect(v.areas[0].label).toBe(NOT_RECORDED);
    expect(v.areas[0].duration).toBe(NOT_RECORDED);
    expect(v.areas[0].settings).toEqual([]);
    expect(v.endTime).toBeNull();
  });
  it("a recorded duration prints as minutes", () => {
    const p = buildDayPacket({ ...base, sessions: [session()], blocks: [block({ minutes_performed: 12 })], entries: [] });
    expect(p.visits[0].areas[0].duration).toBe("12 min");
  });
  it("operator is the performer, falling back to the owning practitioner", () => {
    expect(buildDayPacket({ ...base, sessions: [session()], blocks: [], entries: [] }).visits[0].practitioner).toBe("Dana Reyes");
    expect(buildDayPacket({ ...base, sessions: [session({ performed_by_practitioner_id: null })], blocks: [], entries: [] }).visits[0].practitioner).toBe("Other Person");
  });
  it("DOB is the marked pending field and no contact field exists on the packet", () => {
    const p = buildDayPacket({ ...base, sessions: [session()], blocks: [], entries: [] });
    expect(p.dateOfBirth).toBe(DOB_PENDING);
    const json = JSON.stringify(p);
    for (const k of ["phone", "email", "address", "date_of_birth"]) expect(json.toLowerCase()).not.toContain(k);
    expect(PACKET_EXCLUSIONS.join(" ")).toMatch(/phone, email and address/i);
  });
  it("ALLOW-LIST: an extra column on any input row never reaches the output", () => {
    const leak = "SECRET-PRICE-AND-PRIVATE-NOTE";
    const p = buildDayPacket({
      ...base,
      sessions: [{ ...session(), price_paid: leak, private_warning: leak } as PacketSessionSource],
      blocks: [{ ...block(), internal: leak } as PacketBlockSource],
      entries: [{ ...entry({ comments: "ok" }), galvanic_intensity_percent: leak, staff_only: leak } as PacketEntrySource],
    });
    expect(JSON.stringify(p)).not.toContain(leak);
  });
  it("sessions are oldest first; entries attach to their block; a soft-deleted block's entries do not resurface", () => {
    const p = buildDayPacket({
      ...base,
      sessions: [session({ id: "late", started_at: "2026-05-10T20:00:00.000Z" }), session({ id: "early", started_at: "2026-05-10T14:00:00.000Z" })],
      blocks: [block({ id: "b1", session_id: "early" })],
      entries: [
        entry({ id: "in-block", session_id: "early", block_id: "b1", comments: "in block" }),
        entry({ id: "orphan", session_id: "early", block_id: "deleted-block", comments: "orphan" }),
        entry({ id: "legacy", session_id: "early", block_id: null, comments: "legacy" }),
      ],
    });
    expect(p.visits.map((v) => v.id)).toEqual(["early", "late"]);
    expect(p.visits[0].areas[0].entries.flat().map((r) => r.value)).toContain("in block");
    expect(JSON.stringify(p)).not.toContain("orphan");
    expect(p.visits[0].looseEntries.flat().map((r) => r.value)).toEqual(["legacy"]);
  });
  it("structured areas win over the legacy single area, and every area prints", () => {
    const p = buildDayPacket({
      ...base, sessions: [session()], blocks: [block({ primary_area: "Chin" })], entries: [],
      blockAreasById: new Map([["b1", [{ area: "upper_lip", laterality: "left" }, { area: "chin", laterality: "right" }] as never]]),
    });
    expect(p.visits[0].areas[0].label.split(" · ")).toHaveLength(2);
  });
  it("empty day builds an empty packet, not other data", () => {
    expect(buildDayPacket({ ...base, sessions: [], blocks: [], entries: [] }).visits).toEqual([]);
  });
});
