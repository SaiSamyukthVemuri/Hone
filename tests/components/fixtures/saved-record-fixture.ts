// ONE fixture for the saved-record / printout parity proof (HON-46, #896):
// every field a saved treatment area, pass and laser pass carries, and every
// display STATE the saved session view distinguishes. The same rows feed the
// real SessionBlocksView and the printout's document builder.
//
// States covered, by block:
//   B1  current multi-area flat block: structured areas + detail, blend, Apilus
//       modality, EL, frequency, minutes, structured probe + CONFIRMED lot,
//       numbing USED with a note, tolerance 1, an UNMATCHED legacy reaction +
//       response note, caution WITH a note, legacy block notes (print-only);
//       passes: structured blend (pulses > 1 with delay, every galvanic and
//       thermolysis reading, hairs, chips, note); a pass whose stored areas
//       DIFFER from the header and carry an old legacy probe and pulse/
//       intensity pair (edited legacy row); a galvanic pass with the stored
//       default pulse count 1 and a mode OVERRIDE; legacy chips in comments.
//   B2  legacy block (no primary_area, block_name only, legacy probe type/size,
//       UNCONFIRMED lot, numbing NONE with a stray note, reaction "none" beside
//       a real response chip, caution FLAG only): non-flat, full rows with
//       their own area/probe/mode and a pass with no readings at all.
//   B3  placeholder title (nothing named), no entries, a chip-backed reaction
//       with nothing to back it, tolerance 4, side "n/a".
//   B4  single structured area via primary_area + side "bilateral", thermo,
//       one pass whose area EQUALS the header (hidden), tolerance 5.
// Unassigned: two blockless legacy passes. Laser: a pass with text and numeric
// settings and results, and a minimal pass.

const T = (m: number) => `2026-10-01T15:${String(m).padStart(2, "0")}:00Z`;

export const SESSION_ID = "11111111-1111-4111-8111-111111111111";
export const CLIENT_ID = "22222222-2222-4222-8222-222222222222";

export const session = {
  id: SESSION_ID,
  started_at: T(0),
  ended_at: T(50),
  modality: "electrolysis",
  session_notes: null,
  performed_by_practitioner_id: null,
  practitioner_id: null,
  record_status: null,
  finalized_at: null,
  aftercare_and_risks_explained_at: null,
  aftercare_and_risks_explained_by: null,
};

const blockBase = {
  session_id: SESSION_ID,
  block_name: null,
  primary_area: null,
  side: null,
  custom_area_detail: null,
  mode: null,
  apilus_modality: null,
  energy_level: null,
  minutes_performed: null,
  machine_frequency: null,
  probe_label: null,
  probe_type: null,
  probe_size: null,
  probe_lot_number: null,
  probe_lot_confirmed: false,
  numbing_status: null,
  numbing_notes: null,
  tolerance_rating: null,
  reaction_type: null,
  reaction_notes: null,
  caution_note: null,
  caution_for_next_session: false,
  block_notes: null,
  started_at: null,
  ended_at: null,
};

export const blocks = [
  {
    ...blockBase,
    id: "b1",
    sort_order: 0,
    primary_area: "cheeks",
    side: "left",
    custom_area_detail: "along the jaw line",
    mode: "blend",
    apilus_modality: "Picoflash",
    energy_level: 7,
    minutes_performed: 15,
    machine_frequency: "13.56",
    probe_label: "Ballet F3 gold",
    probe_lot_number: " LOT-7 ",
    probe_lot_confirmed: true,
    numbing_status: "used",
    numbing_notes: "Topical, 30 minutes before",
    tolerance_rating: 1,
    reaction_type: "swelling",
    reaction_notes: "Settled within the hour",
    caution_note: "Thin skin at the jaw",
    caution_for_next_session: true,
    block_notes: "Legacy area note kept on paper",
    created_at: T(1),
  },
  {
    ...blockBase,
    id: "b2",
    sort_order: 1,
    block_name: "Main",
    mode: "thermo",
    probe_type: "Insulated",
    probe_size: "F2",
    probe_lot_number: "L9",
    probe_lot_confirmed: false,
    numbing_status: "none",
    numbing_notes: "stray note that must not imply numbing",
    reaction_type: "none",
    caution_for_next_session: true,
    block_notes: "Second legacy note",
    created_at: T(2),
  },
  {
    ...blockBase,
    id: "b3",
    sort_order: 2,
    side: "n/a",
    tolerance_rating: 4,
    reaction_type: "mild_redness",
    created_at: T(3),
  },
  {
    ...blockBase,
    id: "b4",
    sort_order: 3,
    primary_area: "upper lip",
    side: "bilateral",
    mode: "thermo",
    tolerance_rating: 5,
    numbing_status: "bogus",
    created_at: T(4),
  },
];

/** Structured areas per block (session_block_areas). B1 only. */
export const blockAreas: Record<string, Array<{ area: string; laterality: "left" | "right" | "bilateral" | "midline" | "not_applicable" }>> = {
  b1: [
    { area: "cheeks", laterality: "left" },
    { area: "sideburns", laterality: "right" },
  ],
};

const entryBase = {
  session_id: SESSION_ID,
  block_id: null as string | null,
  area: "chin",
  areas: null as string[] | null,
  probe_type: null,
  probe_size: null,
  mode: null as string | null,
  apilus_modality: null,
  intensity: null,
  duration_seconds: null,
  energy_level: null,
  machine_frequency: null,
  thermolysis_intensity_percent: null,
  thermolysis_duration_seconds: null,
  galvanic_ma: null,
  galvanic_duration_seconds: null,
  units_of_lye: null,
  pulse_delay_seconds: null,
  minutes_performed: null,
  pulse_count: null,
  hairs_treated: null,
  observation_chips: [] as string[],
  comments: null as string | null,
};

export const entries = [
  // B1: structured blend pass, every reading.
  {
    ...entryBase,
    id: "e1",
    block_id: "b1",
    area: "cheeks",
    areas: ["cheeks"],
    mode: "blend",
    units_of_lye: 12.5,
    galvanic_duration_seconds: 6,
    galvanic_ma: 0.3,
    thermolysis_duration_seconds: 0.15,
    thermolysis_intensity_percent: 22,
    pulse_count: 3,
    pulse_delay_seconds: 1.5,
    hairs_treated: 40,
    observation_chips: ["Coarse hair", "Client tolerated well"],
    comments: "Good release.",
    created_at: T(5),
  },
  // B1: an edited legacy row: areas DIFFER from the header, an old entry probe
  // and the stale legacy pair beside structured readings.
  {
    ...entryBase,
    id: "e2",
    block_id: "b1",
    area: "chin",
    areas: ["chin", "jaw"],
    probe_type: "OLD-PROBE-TYPE",
    probe_size: "OLD-F5",
    mode: "blend",
    intensity: 77,
    duration_seconds: 9,
    thermolysis_intensity_percent: 33,
    thermolysis_duration_seconds: 2,
    created_at: T(6),
  },
  // B1: galvanic pass with the stored default pulse count 1, mode override,
  // and pre-0108 chips kept in comments.
  {
    ...entryBase,
    id: "e3",
    block_id: "b1",
    area: "cheeks",
    areas: ["cheeks"],
    mode: "galv",
    galvanic_ma: 0.4,
    pulse_count: 1,
    pulse_delay_seconds: 0.5,
    comments: "Coarse hair, Client tolerated well\nNarrative after the chips.",
    created_at: T(7),
  },
  // B2 (legacy, non-flat): full rows with their own area/probe/mode.
  {
    ...entryBase,
    id: "e4",
    block_id: "b2",
    area: "neck",
    probe_type: "Insulated",
    probe_size: "F2",
    mode: "thermo",
    apilus_modality: "Meloflash",
    intensity: 40,
    duration_seconds: 3,
    energy_level: 5,
    machine_frequency: "27",
    minutes_performed: 10,
    pulse_count: 2,
    pulse_delay_seconds: 0.25,
    hairs_treated: 15,
    observation_chips: ["Mild redness"],
    created_at: T(8),
  },
  {
    ...entryBase,
    id: "e5",
    block_id: "b2",
    area: "neck",
    created_at: T(9),
  },
  // B4: one pass whose area EQUALS the header area (hidden in the flat view).
  {
    ...entryBase,
    id: "e6",
    block_id: "b4",
    area: "upper lip",
    mode: "thermo",
    thermolysis_intensity_percent: 18,
    pulse_count: 1,
    created_at: T(10),
  },
  // Unassigned (blockless) legacy passes.
  {
    ...entryBase,
    id: "o1",
    area: "brows",
    areas: ["brows", "forehead"],
    mode: "blend",
    intensity: 30,
    duration_seconds: 4,
    pulse_count: 4,
    pulse_delay_seconds: 0.75,
    hairs_treated: 8,
    comments: "Unassigned legacy narrative",
    created_at: T(11),
  },
  {
    ...entryBase,
    id: "o2",
    area: "nose",
    created_at: T(12),
  },
];

export const laserEntries = [
  {
    id: "l1",
    session_id: SESSION_ID,
    zone: "Underarm",
    session_number: 3,
    equipment_params: { fluence: "18 J/cm2", pulse_width: "3 ms", spot_size: "12 mm", fluence_j_cm2: 18, cooling: "contact" },
    observation_notes: "Even response",
    ejection_results: "Good ejection",
    created_at: T(13),
  },
  {
    id: "l2",
    session_id: SESSION_ID,
    zone: "Bikini",
    session_number: null,
    equipment_params: null,
    observation_notes: null,
    ejection_results: null,
    created_at: T(14),
  },
];

/** The rows as the SAVED SESSION VIEW receives them (SessionBlocksView props). */
export function viewProps() {
  return {
    sessionId: SESSION_ID,
    clientId: CLIENT_ID,
    blocks: blocks.map((b) => ({
      ...b,
      structured_areas: (blockAreas[b.id] ?? []).map((a, i) => ({
        id: `${b.id}-a${i}`,
        session_block_id: b.id,
        studio_id: "s",
        display_order: i,
        created_at: b.created_at,
        ...a,
      })),
      electrolysis_entries: entries.filter((e) => e.block_id === b.id),
    })) as never[],
    orphanEntries: entries.filter((e) => e.block_id === null) as never[],
  };
}

/** The rows as the PRINTOUT's document builder receives them. */
export function exportInput() {
  return {
    sessions: [session],
    blocks: blocks as never[],
    blockAreasById: new Map(Object.entries(blockAreas)),
    entries: entries as never[],
    laserEntries: laserEntries as never[],
    notes: [],
    practitionerNameById: new Map<string, string>(),
  };
}
