// HON-46 M2 — the content of a one-client, one-day clinical print packet, as
// pure code.
//
// BUILT BY ALLOW-LIST. `buildDayPacket` copies NAMED fields out of its inputs;
// it never spreads a row. A column a query happens to return, or one added to a
// table later, cannot reach the page. The source types below are exactly what
// the loader selects (./day-loader.ts), nothing more.
//
// MISSING STAYS MISSING. A value Hone did not record prints "Not recorded"; the
// builder never infers, defaults or fabricates (HON-46). Duration, practitioner
// and times are therefore always present as a line, with that text when absent.
//
// NEVER IN THE PACKET (and said so on the page, see PACKET_EXCLUSIONS):
//   * phone, email, address (OPS ruling 7 Nov, HON-46 "unrelated admin data");
//   * date of birth: a clearly marked PENDING field until Sabrina's format
//     review decides it (OPS ruling 7 Nov), never silently printed;
//   * private warnings and personal notes (client_personal_notes is never read);
//   * payments, the next-session planning note, photos, intake and consent;
//   * soft-deleted sessions, blocks and entries.

import { localDateString, localTimeString12h } from "@/lib/booking/tz";
import { formatAreaLabel, type BlockArea } from "@/lib/sessions/block-areas";

export const NOT_RECORDED = "Not recorded";
/** Printed in place of a date of birth until Sabrina's format review decides it. */
export const DOB_PENDING = "Pending format review";

/** What the page says is NOT in the packet. Rendered verbatim. */
export const PACKET_EXCLUSIONS: readonly string[] = [
  "Phone, email and address",
  "Date of birth (pending format review)",
  "Private warnings and personal notes about the client",
  "Payment records (prices, charges, payments and balances)",
  "Intake forms, medical history and consent forms",
  "Photos and treatment images",
  "Next-session planning notes",
  "Deleted sessions, settings blocks and entries",
];

// ---- Sources: exactly the columns the loader selects ------------------------

export type PacketSessionSource = {
  id: string;
  started_at: string;
  ended_at: string | null;
  modality: string | null;
  session_notes: string | null;
  performed_by_practitioner_id: string | null;
  practitioner_id: string | null;
  aftercare_and_risks_explained_at: string | null;
  aftercare_and_risks_explained_by: string | null;
};

export type PacketBlockSource = {
  id: string;
  session_id: string;
  sort_order: number | null;
  block_name: string | null;
  primary_area: string | null;
  side: string | null;
  custom_area_detail: string | null;
  mode: string | null;
  apilus_modality: string | null;
  energy_level: string | number | null;
  minutes_performed: number | null;
  machine_frequency: string | null;
  probe_label: string | null;
  probe_type: string | null;
  probe_size: string | null;
  probe_lot_number: string | null;
  numbing_status: string | null;
  numbing_notes: string | null;
  tolerance_rating: number | null;
  reaction_type: string | null;
  reaction_notes: string | null;
  caution_note: string | null;
  caution_for_next_session: boolean | null;
  block_notes: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
};

export type PacketEntrySource = {
  id: string;
  session_id: string;
  block_id: string | null;
  area: string | null;
  areas: string[] | null;
  probe_type: string | null;
  probe_size: string | null;
  mode: string | null;
  apilus_modality: string | null;
  intensity: string | number | null;
  duration_seconds: number | null;
  energy_level: string | number | null;
  machine_frequency: string | null;
  thermolysis_intensity_percent: number | null;
  thermolysis_duration_seconds: number | null;
  galvanic_ma: number | null;
  galvanic_duration_seconds: number | null;
  // NOT galvanic_intensity_percent: a RETIRED reading. The live chart omits it
  // from every clinical display so it cannot be read as a current setting.
  units_of_lye: number | null;
  pulse_delay_seconds: number | null;
  minutes_performed: number | null;
  pulse_count: number | null;
  hairs_treated: number | null;
  observation_chips: string[] | null;
  comments: string | null;
  created_at: string;
};

export type PacketLaserSource = {
  id: string;
  session_id: string;
  zone: string;
  session_number: number | null;
  equipment_params: Record<string, unknown> | null;
  observation_notes: string | null;
  ejection_results: string | null;
  created_at: string;
};

// ---- The packet --------------------------------------------------------------

/** One labelled value, already formatted. Only recorded values are emitted. */
export type Reading = { label: string; value: string };

export type PacketArea = {
  id: string;
  /** Every treated area and laterality, or "Not recorded". */
  label: string;
  /** "12 min", or "Not recorded". Never 0 for a missing value. */
  duration: string;
  /** Studio-local clock times the area itself recorded, when recorded. */
  startedAt: string | null;
  endedAt: string | null;
  settings: Reading[];
  notes: Reading[];
  entries: Reading[][];
};

export type PacketLaserPass = { id: string; readings: Reading[] };

export type PacketVisit = {
  id: string;
  /** Studio-local, e.g. "9:30 AM". */
  startTime: string;
  endTime: string | null;
  /** Studio-local YYYY-MM-DD of the visit start (always the selected day). */
  localDate: string;
  service: string;
  /** The performing practitioner, or "Not recorded". One operator; see HON-59. */
  practitioner: string;
  sessionNotes: string | null;
  aftercare: string;
  areas: PacketArea[];
  /** Entries not attached to any block (older charting). */
  looseEntries: Reading[][];
  laserPasses: PacketLaserPass[];
};

export type DayPacket = {
  day: string;
  clientName: string;
  dateOfBirth: typeof DOB_PENDING;
  studioName: string;
  timezone: string;
  visits: PacketVisit[];
};

function present(v: unknown): v is string | number {
  return (typeof v === "string" && v.trim().length > 0) || (typeof v === "number" && Number.isFinite(v));
}

/** Allow-listed label/value pairs: a label is emitted only when its value exists. */
function readings(pairs: Array<[string, unknown]>): Reading[] {
  const out: Reading[] = [];
  for (const [label, value] of pairs) if (present(value)) out.push({ label, value: String(value).trim() });
  return out;
}

function seconds(v: number | null): string | null {
  return v === null || !Number.isFinite(v) ? null : `${v} s`;
}

function clock(iso: string | null, timezone: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : localTimeString12h(d, timezone);
}

function entryReadings(e: PacketEntrySource): Reading[] {
  const areas = e.areas && e.areas.length > 0 ? e.areas.join(", ") : e.area;
  return readings([
    ["Area", areas],
    ["Mode", e.mode],
    ["Modality", e.apilus_modality],
    ["Energy level", e.energy_level],
    ["Intensity", e.intensity],
    ["Frequency", e.machine_frequency],
    ["Probe", [e.probe_type, e.probe_size].filter(present).join(" ")],
    ["Duration", seconds(e.duration_seconds)],
    ["Minutes", e.minutes_performed],
    ["Thermolysis intensity", e.thermolysis_intensity_percent === null ? null : `${e.thermolysis_intensity_percent}%`],
    ["Thermolysis duration", seconds(e.thermolysis_duration_seconds)],
    ["Galvanic mA", e.galvanic_ma],
    ["Galvanic duration", seconds(e.galvanic_duration_seconds)],
    ["Units of lye", e.units_of_lye],
    ["Pulse delay", seconds(e.pulse_delay_seconds)],
    ["Pulse count", e.pulse_count],
    ["Hairs treated", e.hairs_treated],
    ["Observations", e.observation_chips && e.observation_chips.length > 0 ? e.observation_chips.join(", ") : null],
    ["Comments", e.comments],
  ]);
}

function laserReadings(l: PacketLaserSource): Reading[] {
  const params = l.equipment_params ?? {};
  const settings = Object.entries(params)
    .filter(([, v]) => present(v))
    .map(([k, v]) => `${k.replace(/_/g, " ")} ${String(v)}`);
  return readings([
    ["Zone", l.zone],
    ["Pass", l.session_number],
    ["Settings", settings.length > 0 ? settings.join(" · ") : null],
    ["Observations", l.observation_notes],
    ["Results", l.ejection_results],
  ]);
}

function areaLabel(b: PacketBlockSource, areas: ReadonlyArray<BlockArea> | undefined): string {
  // Structured child rows win (migration 0128); otherwise the legacy single area.
  const structured = areas && areas.length > 0 ? areas.map(formatAreaLabel).join(" · ") : null;
  const legacy = present(b.primary_area) ? [b.primary_area, b.side].filter(present).join(" ") : null;
  const detail = present(b.custom_area_detail) ? b.custom_area_detail : null;
  const base = structured ?? legacy ?? (present(b.block_name) ? b.block_name : null);
  if (base === null) return NOT_RECORDED;
  return detail ? `${base} (${detail})` : base;
}

export function buildDayPacket(input: {
  day: string;
  timezone: string;
  studioName: string;
  /** Already resolved by the caller (legal name with preferred in parentheses). */
  clientName: string;
  sessions: ReadonlyArray<PacketSessionSource>;
  blocks: ReadonlyArray<PacketBlockSource>;
  blockAreasById?: ReadonlyMap<string, ReadonlyArray<BlockArea>>;
  entries: ReadonlyArray<PacketEntrySource>;
  laserEntries: ReadonlyArray<PacketLaserSource>;
  practitionerNameById: ReadonlyMap<string, string>;
}): DayPacket {
  const tz = input.timezone;
  const name = (id: string | null) => (id ? (input.practitionerNameById.get(id) ?? null) : null);
  const byCreated = <T extends { created_at: string }>(a: T, b: T) => a.created_at.localeCompare(b.created_at);

  const blockIds = new Set(input.blocks.map((b) => b.id));
  const entriesByBlock = new Map<string, PacketEntrySource[]>();
  const looseBySession = new Map<string, PacketEntrySource[]>();
  for (const e of input.entries) {
    if (e.block_id === null || e.block_id === undefined || e.block_id === "") {
      looseBySession.set(e.session_id, [...(looseBySession.get(e.session_id) ?? []), e]);
    } else if (blockIds.has(e.block_id)) {
      entriesByBlock.set(e.block_id, [...(entriesByBlock.get(e.block_id) ?? []), e]);
    }
    // An entry of a block that was filtered out (soft-deleted) is OMITTED, as
    // the session loader omits it; it must never resurface as a legacy entry.
  }
  const blocksBySession = new Map<string, PacketBlockSource[]>();
  for (const b of input.blocks) blocksBySession.set(b.session_id, [...(blocksBySession.get(b.session_id) ?? []), b]);
  const laserBySession = new Map<string, PacketLaserSource[]>();
  for (const l of input.laserEntries) laserBySession.set(l.session_id, [...(laserBySession.get(l.session_id) ?? []), l]);

  const visits: PacketVisit[] = [...input.sessions]
    .sort((a, b) => a.started_at.localeCompare(b.started_at) || (a.id < b.id ? -1 : 1))
    .map((s) => {
      const started = new Date(s.started_at);
      const aftercareAt = s.aftercare_and_risks_explained_at;
      const aftercareBy = aftercareAt ? name(s.aftercare_and_risks_explained_by) : null;
      return {
        id: s.id,
        startTime: clock(s.started_at, tz) ?? NOT_RECORDED,
        endTime: clock(s.ended_at, tz),
        localDate: localDateString(started, tz),
        service: present(s.modality) ? s.modality.trim() : NOT_RECORDED,
        practitioner: name(s.performed_by_practitioner_id ?? s.practitioner_id) ?? NOT_RECORDED,
        sessionNotes: present(s.session_notes) ? s.session_notes.trim() : null,
        aftercare: aftercareAt
          ? `Risks explained and aftercare provided${clock(aftercareAt, tz) ? ` (${clock(aftercareAt, tz)})` : ""}${aftercareBy ? ` by ${aftercareBy}` : ""}`
          : NOT_RECORDED,
        areas: [...(blocksBySession.get(s.id) ?? [])]
          .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.created_at.localeCompare(b.created_at))
          .map((b) => ({
            id: b.id,
            label: areaLabel(b, input.blockAreasById?.get(b.id)),
            duration: b.minutes_performed === null || !Number.isFinite(b.minutes_performed) ? NOT_RECORDED : `${b.minutes_performed} min`,
            startedAt: clock(b.started_at, tz),
            endedAt: clock(b.ended_at, tz),
            settings: readings([
              ["Mode", b.mode],
              ["Modality", b.apilus_modality],
              ["Energy level", b.energy_level],
              ["Frequency", b.machine_frequency],
              ["Probe", [b.probe_label, b.probe_type, b.probe_size].filter(present).join(" ")],
              ["Probe lot", b.probe_lot_number],
            ]),
            notes: readings([
              ["Numbing", [b.numbing_status, b.numbing_notes].filter(present).join(": ")],
              ["Tolerance", b.tolerance_rating],
              ["Reaction", [b.reaction_type, b.reaction_notes].filter(present).join(": ")],
              ["Caution", b.caution_note],
              ["Area notes", b.block_notes],
            ]),
            entries: [...(entriesByBlock.get(b.id) ?? [])].sort(byCreated).map(entryReadings),
          })),
        looseEntries: [...(looseBySession.get(s.id) ?? [])].sort(byCreated).map(entryReadings),
        laserPasses: [...(laserBySession.get(s.id) ?? [])]
          .sort(byCreated)
          .map((l) => ({ id: l.id, readings: laserReadings(l) })),
      };
    });

  return {
    day: input.day,
    clientName: input.clientName,
    dateOfBirth: DOB_PENDING,
    studioName: input.studioName,
    timezone: tz,
    visits,
  };
}
