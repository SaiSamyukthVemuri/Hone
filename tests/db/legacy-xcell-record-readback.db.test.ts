import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

import { adminQuery, closePool, seedSession, seedStudio } from "./helpers/harness";

// ===========================================================================
// GOLDEN READ-BACK OF EXISTING xCell Pur (LEGACY) CHARTING RECORDS.
//
// A legacy record carries NO machine identity: no machine id, no catalogue id,
// no model column on session_blocks or electrolysis_entries. These rows are
// written the way production rows are shaped (synthetic values, real columns)
// and read back column for column. The machine-selector change must leave every
// one of these reads unchanged, so this file is committed on the unchanged base
// and has to keep passing afterwards.
//
// Only the LEGACY columns are compared. Any column a later change adds is
// outside the golden, and a separate test asserts it is NULL on these rows.
// ===========================================================================

afterAll(async () => {
  await closePool();
});

const BLOCK_COLS = [
  "mode",
  "apilus_modality",
  "energy_level",
  "minutes_performed",
  "machine_frequency",
  "primary_area",
  "side",
  "custom_area_detail",
  "probe_key",
  "probe_lot_number",
  "probe_lot_confirmed",
  "numbing_status",
  "tolerance_rating",
  "caution_for_next_session",
  "caution_note",
  "block_notes",
] as const;

const ENTRY_COLS = [
  "area",
  "mode",
  "pulse_count",
  "pulse_delay_seconds",
  "hairs_treated",
  "thermolysis_intensity_percent",
  "thermolysis_duration_seconds",
  "galvanic_ma",
  "galvanic_duration_seconds",
  "galvanic_intensity_percent",
  "units_of_lye",
  "observation_chips",
  "comments",
] as const;

type Shape = {
  name: string;
  block: Record<(typeof BLOCK_COLS)[number], unknown>;
  entry: Record<(typeof ENTRY_COLS)[number], unknown>;
};

const NULL_BLOCK = {
  mode: null,
  apilus_modality: null,
  energy_level: null,
  minutes_performed: null,
  machine_frequency: null,
  primary_area: null,
  side: null,
  custom_area_detail: null,
  probe_key: null,
  probe_lot_number: null,
  probe_lot_confirmed: false,
  numbing_status: null,
  tolerance_rating: null,
  caution_for_next_session: false,
  caution_note: null,
  block_notes: null,
};

const NULL_ENTRY = {
  area: "Upper lip",
  mode: null,
  pulse_count: 1,
  pulse_delay_seconds: null,
  hairs_treated: null,
  thermolysis_intensity_percent: null,
  thermolysis_duration_seconds: null,
  galvanic_ma: null,
  galvanic_duration_seconds: null,
  galvanic_intensity_percent: null,
  units_of_lye: null,
  observation_chips: [],
  comments: null,
};

const SHAPES: Shape[] = [
  {
    name: "thermolysis",
    block: {
      ...NULL_BLOCK,
      mode: "thermolysis",
      machine_frequency: "13.56 MHz",
      minutes_performed: 12,
      primary_area: "Upper lip",
      side: "center",
    },
    entry: {
      ...NULL_ENTRY,
      mode: "thermolysis",
      pulse_delay_seconds: "0.5",
      thermolysis_intensity_percent: 40,
      thermolysis_duration_seconds: "0.7",
      hairs_treated: 31,
    },
  },
  {
    name: "galvanic",
    block: { ...NULL_BLOCK, mode: "galvanic", primary_area: "Chin", side: "left" },
    entry: {
      ...NULL_ENTRY,
      area: "Chin",
      mode: "galvanic",
      units_of_lye: "2.5",
      galvanic_duration_seconds: 90,
      galvanic_ma: "0.8",
    },
  },
  {
    name: "blend",
    block: {
      ...NULL_BLOCK,
      mode: "blend",
      apilus_modality: "blend",
      energy_level: "3",
      primary_area: "Jaw",
      side: "right",
      probe_key: "synthetic-probe",
      probe_lot_number: "LOT-SYN-1",
      probe_lot_confirmed: true,
      numbing_status: "topical",
      tolerance_rating: 4,
      caution_for_next_session: true,
      caution_note: "synthetic caution",
    },
    entry: {
      ...NULL_ENTRY,
      area: "Jaw",
      mode: "blend",
      pulse_delay_seconds: "1",
      thermolysis_intensity_percent: 25,
      thermolysis_duration_seconds: "0.3",
      units_of_lye: "1.5",
      galvanic_duration_seconds: 60,
      galvanic_ma: "0.4",
      observation_chips: ["erythema"],
      comments: "synthetic note",
    },
  },
  {
    name: "oldest row with a retired galvanic intensity and no chips",
    block: { ...NULL_BLOCK, mode: "galvanic", primary_area: "Neck" },
    entry: {
      ...NULL_ENTRY,
      area: "Neck",
      mode: "galvanic",
      units_of_lye: "1",
      galvanic_intensity_percent: 30,
      comments: "synthetic legacy note",
    },
  },
];

describe("existing xCell Pur (legacy) charting records read back unchanged", () => {
  for (const shape of SHAPES) {
    it(`${shape.name}: block and entry columns round-trip, and no setup readings exist`, async () => {
      const studio = await seedStudio("legacy-readback");
      const { sessionId } = await seedSession(studio);
      const blockId = randomUUID();
      const bcols = Object.keys(shape.block);
      await adminQuery(
        `insert into public.session_blocks (id, studio_id, session_id, sort_order, ${bcols.join(", ")})
         values ($1, $2, $3, 50, ${bcols.map((_, i) => `$${i + 4}`).join(", ")})`,
        [blockId, studio.studioId, sessionId, ...Object.values(shape.block)],
      );
      const ecols = Object.keys(shape.entry);
      await adminQuery(
        `insert into public.electrolysis_entries (session_id, block_id, ${ecols.join(", ")})
         values ($1, $2, ${ecols
           .map((c, i) => `$${i + 3}${c === "observation_chips" ? "::jsonb" : ""}`)
           .join(", ")})`,
        [
          sessionId,
          blockId,
          ...Object.values(shape.entry).map((v, i) =>
            ecols[i] === "observation_chips" ? JSON.stringify(v) : v,
          ),
        ],
      );

      const b = await adminQuery(
        `select ${BLOCK_COLS.join(", ")} from public.session_blocks where id = $1`,
        [blockId],
      );
      const e = await adminQuery(
        `select ${ENTRY_COLS.join(", ")} from public.electrolysis_entries where block_id = $1`,
        [blockId],
      );
      const norm = (row: Record<string, unknown>) =>
        Object.fromEntries(
          Object.entries(row).map(([k, v]) => [k, v == null ? v : typeof v === "object" ? v : String(v)]),
        );
      const want = (row: Record<string, unknown>) => norm(row);
      expect(norm(b.rows[0])).toEqual(want(shape.block));
      expect(e.rows).toHaveLength(1);
      expect(norm(e.rows[0])).toEqual(want(shape.entry));

      const readings = await adminQuery(
        `select count(*)::int as n from public.treatment_setup_readings where session_block_id = $1`,
        [blockId],
      );
      expect(readings.rows[0].n).toBe(0);
    });
  }
});
