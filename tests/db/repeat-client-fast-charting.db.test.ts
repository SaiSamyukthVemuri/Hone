import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
  asUser,
  closePool,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";
import {
  buildCopyDrafts,
  draftToCopyInput,
  type CopySourceBlock,
} from "@/lib/sessions/whole-session-copy";
import { normalizeWholeSessionCopy } from "@/lib/sessions/whole-session-copy-normalize";
import { landingBlockId } from "@/lib/sessions/fast-chart-start";

// ===========================================================================
// Repeat-client fast charting, "Start from last session", proven on the REAL
// migrated local DB.
// ===========================================================================
//
// WHAT MAKES THIS DIFFERENT from tests/db/whole-session-copy.db.test.ts: that
// suite proves the RPC against HAND-WRITTEN specs. This one drives the ACTUAL
// payload the fast path sends, the real pure pipeline
//
//     buildCopyDrafts -> draftToCopyInput -> normalizeWholeSessionCopy
//
// over rows read back out of the database, and then commits it. So it proves
// the thing the fast path actually does, not a reconstruction of it. Nothing is
// edited in between, because the fast path offers no edit: that is precisely
// why its payload is a pure function of the source.
//
// The one projection this file reproduces by hand is the server action's SELECT
// (buildSourceProjection below). That is a deliberate, narrow duplication: it is
// the only step that needs a Supabase client, which the DB harness does not
// have. It is annotated so a future column change is an obvious edit here too;
// the end-to-end truth of that step is covered by the browser E2E.
//
// NO MIGRATION accompanies this feature. Every object exercised here is 0157
// applied history.

let a: SeededStudio;
let other: SeededStudio;

beforeAll(async () => {
  a = await seedStudio("fastchart");
  other = await seedStudio("fastchart-other");
});
afterAll(async () => {
  await closePool();
});

// ---- seeding ---------------------------------------------------------------

async function freshClient(studio: SeededStudio): Promise<string> {
  const id = randomUUID();
  await adminQuery("insert into public.clients (id, studio_id, name) values ($1,$2,$3)", [
    id,
    studio.studioId,
    `Fast ${id.slice(0, 8)}`,
  ]);
  return id;
}

async function seedSession(
  studio: SeededStudio,
  clientId: string,
  startedAt: string,
): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.sessions (id, studio_id, client_id, practitioner_id, modality, record_status, started_at)
     values ($1,$2,$3,$4,'electrolysis','draft',$5)`,
    [id, studio.studioId, clientId, studio.practitionerId, startedAt],
  );
  return id;
}

type SeedArea = {
  area: string;
  laterality: string;
  mode: string;
  energy: number | null;
  frequency: string;
  probeKey: string | null;
};

// A previous visit whose blocks carry BOTH reusable setup and a full set of
// TODAY'S-FACTS values (minutes, hairs, chips, tolerance, reaction, notes,
// caution, numbing). Everything in the second group must stay behind.
async function seedPreviousVisit(
  studio: SeededStudio,
  sessionId: string,
  areas: readonly SeedArea[],
): Promise<string[]> {
  const blockIds: string[] = [];
  for (let i = 0; i < areas.length; i++) {
    const s = areas[i];
    const blockId = randomUUID();
    await adminQuery(
      `insert into public.session_blocks (
         id, studio_id, session_id, sort_order, primary_area, side, mode, energy_level,
         machine_frequency, probe_key, probe_brand, probe_material, probe_piece_type,
         probe_shank, probe_size_value, probe_length, probe_label,
         minutes_performed, tolerance_rating, reaction_type, reaction_notes,
         caution_for_next_session, caution_note, numbing_status, numbing_notes,
         probe_lot_number, probe_lot_confirmed, block_name, block_notes)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Sterex','Gold','Two-piece','F','3','Short',
               'Sterex · Gold · Two-piece · F3 Short',
               17, 4, 'mild_redness', 'was pink afterwards',
               true, 'go gentler next time', 'used', 'numbing notes from last time',
               'LOT-PREV-9', true, 'legacy name', 'legacy notes')`,
      [
        blockId,
        studio.studioId,
        sessionId,
        i + 1,
        s.area,
        s.laterality,
        s.mode,
        s.energy,
        s.frequency,
        s.probeKey,
      ],
    );
    await adminQuery(
      `insert into public.session_block_areas (id, studio_id, session_block_id, area, laterality, display_order)
       values ($1,$2,$3,$4,$5,0)`,
      [randomUUID(), studio.studioId, blockId, s.area, s.laterality],
    );
    await adminQuery(
      `insert into public.electrolysis_entries (
         id, session_id, block_id, area, areas, mode, energy_level, machine_frequency,
         thermolysis_intensity_percent, thermolysis_duration_seconds, pulse_count,
         minutes_performed, hairs_treated, comments, observation_chips)
       values ($1,$2,$3,$4,array[$4]::text[],$5,$6,$7,42,3,1,
               17, 63, 'she tolerated it well today', '["Coarse hair","Mild redness"]'::jsonb)`,
      [randomUUID(), sessionId, blockId, s.area, s.mode, s.energy, s.frequency],
    );
    blockIds.push(blockId);
  }
  return blockIds;
}

// ---- the real fast-path payload -------------------------------------------

// Mirrors getWholeSessionCopySourceAction's SELECT + row->CopySourceBlock
// mapping. THIS IS THE ONLY HAND-WRITTEN STEP; everything downstream is the
// production code path. Keep the column list in sync with the server action.
async function buildSourceProjection(sourceSessionId: string): Promise<CopySourceBlock[]> {
  const blocks = await adminQuery(
    `select id, sort_order, mode, apilus_modality, energy_level, machine_frequency,
            probe_key, probe_brand, probe_material, probe_piece_type, probe_shank,
            probe_size_value, probe_length, probe_label, primary_area, side, custom_area_detail
       from public.session_blocks
      where session_id = $1 and deleted_at is null
      order by sort_order asc`,
    [sourceSessionId],
  );
  const out: CopySourceBlock[] = [];
  for (const b of blocks.rows) {
    const areas = await adminQuery(
      `select area, laterality from public.session_block_areas
        where session_block_id = $1 order by display_order asc`,
      [b.id],
    );
    const entries = await adminQuery(
      `select created_at, deleted_at, mode, thermolysis_intensity_percent,
              thermolysis_duration_seconds, galvanic_ma, galvanic_duration_seconds,
              units_of_lye, pulse_count, pulse_delay_seconds
         from public.electrolysis_entries
        where block_id = $1 and deleted_at is null
        order by created_at asc, id asc limit 1`,
      [b.id],
    );
    const fe = entries.rows[0] ?? null;
    out.push({
      blockId: b.id,
      primary_area: b.primary_area,
      side: b.side,
      custom_area_detail: b.custom_area_detail,
      block: {
        mode: b.mode,
        apilus_modality: b.apilus_modality,
        energy_level: b.energy_level,
        machine_frequency: b.machine_frequency,
        probe_key: b.probe_key,
      },
      probe: {
        probe_brand: b.probe_brand,
        probe_material: b.probe_material,
        probe_piece_type: b.probe_piece_type,
        probe_shank: b.probe_shank,
        probe_size_value: b.probe_size_value,
        probe_length: b.probe_length,
        probe_label: b.probe_label,
      },
      firstEntry: fe
        ? {
            created_at: new Date(fe.created_at).toISOString(),
            deleted_at: fe.deleted_at,
            mode: fe.mode,
            thermolysis_intensity_percent: fe.thermolysis_intensity_percent,
            thermolysis_duration_seconds:
              fe.thermolysis_duration_seconds == null
                ? null
                : Number(fe.thermolysis_duration_seconds),
            galvanic_ma: fe.galvanic_ma == null ? null : Number(fe.galvanic_ma),
            galvanic_duration_seconds: fe.galvanic_duration_seconds,
            units_of_lye: fe.units_of_lye == null ? null : Number(fe.units_of_lye),
            pulse_count: fe.pulse_count,
            pulse_delay_seconds:
              fe.pulse_delay_seconds == null ? null : Number(fe.pulse_delay_seconds),
          }
        : null,
      areas: areas.rows.map((r) => ({ area: r.area, laterality: r.laterality })),
    });
  }
  return out;
}

// The exact JSON the fast path sends. No editing step exists on this route, so
// this is a pure function of the source rows.
async function fastPathSpecs(sourceSessionId: string): Promise<unknown[]> {
  const drafts = buildCopyDrafts(await buildSourceProjection(sourceSessionId));
  const normalized = normalizeWholeSessionCopy(drafts.map(draftToCopyInput));
  if (!normalized.ok) throw new Error(`fast-path payload rejected: ${normalized.error}`);
  return normalized.specs;
}

async function fingerprintOf(sessionId: string): Promise<string> {
  const r = await adminQuery("select public._whole_session_copy_fingerprint($1) as fp", [
    sessionId,
  ]);
  return r.rows[0].fp as string;
}

async function callCopy(opts: {
  studio?: SeededStudio;
  target: string;
  specs: unknown;
  key: string;
  fp: string;
  sourceId: string;
}) {
  const studio = opts.studio ?? a;
  const r = await adminQuery(
    "select public.copy_session_setup($1,$2,$3,$4::jsonb,$5,$6,$7) as result",
    [
      studio.studioId,
      opts.target,
      studio.practitionerId,
      JSON.stringify(opts.specs),
      opts.key,
      opts.fp,
      opts.sourceId,
    ],
  );
  return r.rows[0].result as {
    created_block_ids: string[];
    copied_block_count: number;
    idempotent_replay: boolean;
  };
}

const AREA_CHIN: SeedArea = {
  area: "Chin",
  laterality: "left",
  mode: "blend",
  energy: 10,
  frequency: "13.56 MHz",
  probeKey: "sterex-gold-two-piece-f3-short",
};
const AREA_LIP: SeedArea = {
  area: "Upper lip",
  laterality: "bilateral",
  mode: "thermo",
  energy: 22,
  frequency: "27.12 MHz",
  probeKey: null,
};

// One repeat client: a previous visit with `areas`, and today's empty draft.
async function seedRepeatClient(areas: readonly SeedArea[], studio: SeededStudio = a) {
  const clientId = await freshClient(studio);
  const previous = await seedSession(studio, clientId, "2026-01-01T10:00:00Z");
  const sourceBlockIds = await seedPreviousVisit(studio, previous, areas);
  const today = await seedSession(studio, clientId, "2026-06-01T10:00:00Z");
  return { clientId, previous, today, sourceBlockIds, fp: await fingerprintOf(previous) };
}

async function todaysBlocks(sessionId: string) {
  const r = await adminQuery(
    `select id, sort_order, primary_area, side, mode, energy_level, machine_frequency,
            probe_key, probe_label, minutes_performed, tolerance_rating, reaction_type,
            reaction_notes, caution_for_next_session, caution_note, numbing_status,
            numbing_notes, probe_lot_number, probe_lot_confirmed, block_name, block_notes
       from public.session_blocks
      where session_id = $1 and deleted_at is null order by sort_order asc`,
    [sessionId],
  );
  return r.rows;
}

async function todaysEntries(sessionId: string) {
  const r = await adminQuery(
    `select block_id, area, areas, mode, energy_level, machine_frequency,
            thermolysis_intensity_percent, thermolysis_duration_seconds, pulse_count,
            minutes_performed, hairs_treated, comments, observation_chips
       from public.electrolysis_entries
      where session_id = $1 and deleted_at is null order by created_at asc`,
    [sessionId],
  );
  return r.rows;
}

// ===========================================================================

describe("(3) the fast path's REAL payload copies the reusable setup", () => {
  it("reproduces area, laterality, mode, energy, machine frequency and probe", async () => {
    const s = await seedRepeatClient([AREA_CHIN]);
    await callCopy({
      target: s.today,
      specs: await fastPathSpecs(s.previous),
      key: randomUUID(),
      fp: s.fp,
      sourceId: s.previous,
    });

    const [block] = await todaysBlocks(s.today);
    expect(block.primary_area).toBe("Chin");
    expect(block.side).toBe("left");
    expect(block.mode).toBe("blend");
    expect(Number(block.energy_level)).toBe(10); // numeric column -> string from pg
    expect(block.machine_frequency).toBe("13.56 MHz");
    expect(block.probe_key).toBe("sterex-gold-two-piece-f3-short");
    expect(block.probe_label).toBe("Sterex · Gold · Two-piece · F3 Short");

    const areas = await adminQuery(
      `select area, laterality from public.session_block_areas where session_block_id = $1`,
      [block.id],
    );
    expect(areas.rows).toEqual([{ area: "Chin", laterality: "left" }]);

    const [entry] = await todaysEntries(s.today);
    expect(entry.mode).toBe("blend");
    expect(entry.thermolysis_intensity_percent).toBe(42);
    expect(Number(entry.thermolysis_duration_seconds)).toBe(3);
  });
});

describe("(4-9) TODAY'S FACTS are never manufactured from the previous visit", () => {
  it("every outcome column starts blank on the copied block and entry", async () => {
    const s = await seedRepeatClient([AREA_CHIN]);
    await callCopy({
      target: s.today,
      specs: await fastPathSpecs(s.previous),
      key: randomUUID(),
      fp: s.fp,
      sourceId: s.previous,
    });

    const [block] = await todaysBlocks(s.today);
    expect(block.minutes_performed).toBeNull(); // (4) minutes performed
    expect(block.tolerance_rating).toBeNull(); // (7) tolerance
    expect(block.reaction_type).toBeNull(); // (6) reaction
    expect(block.reaction_notes).toBeNull();
    expect(block.caution_for_next_session).toBe(false); // block caution
    expect(block.caution_note).toBeNull();
    expect(block.numbing_status).toBeNull();
    expect(block.numbing_notes).toBeNull();
    expect(block.block_name).toBeNull(); // (9) no narrative carried over
    expect(block.block_notes).toBeNull();

    const [entry] = await todaysEntries(s.today);
    expect(entry.minutes_performed).toBeNull(); // (4)
    expect(entry.hairs_treated).toBeNull(); // (5) hairs treated
    expect(entry.comments).toBeNull(); // (9) today's notes
    expect(entry.observation_chips ?? []).toEqual([]); // (8) observation chips

    // The previous visit DID record all of them, so these nulls prove the copy
    // dropped them, not that the source was empty.
    const prevBlock = await adminQuery(
      `select minutes_performed, tolerance_rating, reaction_type from public.session_blocks where session_id = $1`,
      [s.previous],
    );
    expect(prevBlock.rows[0].minutes_performed).toBe(17);
    expect(prevBlock.rows[0].tolerance_rating).toBe(4);
    expect(prevBlock.rows[0].reaction_type).toBe("mild_redness");
    const prevEntry = await adminQuery(
      `select hairs_treated, comments, observation_chips from public.electrolysis_entries where session_id = $1`,
      [s.previous],
    );
    expect(prevEntry.rows[0].hairs_treated).toBe(63);
    expect(prevEntry.rows[0].comments).toBe("she tolerated it well today");
    expect(prevEntry.rows[0].observation_chips).toEqual(["Coarse hair", "Mild redness"]);
  });

  it("the probe LOT is not carried forward, and is never marked confirmed", async () => {
    // A copy is a transcription, not a check of the physical package. The
    // whole-session route does not read the lot at all.
    const s = await seedRepeatClient([AREA_CHIN]);
    await callCopy({
      target: s.today,
      specs: await fastPathSpecs(s.previous),
      key: randomUUID(),
      fp: s.fp,
      sourceId: s.previous,
    });
    const [block] = await todaysBlocks(s.today);
    expect(block.probe_lot_number).toBeNull();
    expect(block.probe_lot_confirmed).toBe(false);
  });
});

describe("(12) several prior areas are all brought forward, in order", () => {
  it("copies every area with its own distinct settings, preserving source order", async () => {
    const s = await seedRepeatClient([AREA_CHIN, AREA_LIP]);
    const res = await callCopy({
      target: s.today,
      specs: await fastPathSpecs(s.previous),
      key: randomUUID(),
      fp: s.fp,
      sourceId: s.previous,
    });
    expect(res.copied_block_count).toBe(2);

    const blocks = await todaysBlocks(s.today);
    expect(blocks.map((b) => b.primary_area)).toEqual(["Chin", "Upper lip"]);
    expect(blocks.map((b) => b.sort_order)).toEqual([1, 2]);

    // DISTINCT settings per area survive, the second area is not a copy of the first.
    expect(blocks[0].mode).toBe("blend");
    expect(Number(blocks[0].energy_level)).toBe(10);
    expect(blocks[0].machine_frequency).toBe("13.56 MHz");
    expect(blocks[0].probe_key).toBe("sterex-gold-two-piece-f3-short");
    expect(blocks[1].mode).toBe("thermo");
    expect(Number(blocks[1].energy_level)).toBe(22);
    expect(blocks[1].machine_frequency).toBe("27.12 MHz");
    expect(blocks[1].probe_key).toBeNull();

    // ...and today's facts are blank on BOTH.
    for (const b of blocks) expect(b.minutes_performed).toBeNull();
    const entries = await todaysEntries(s.today);
    expect(entries).toHaveLength(2);
    for (const e of entries) {
      expect(e.hairs_treated).toBeNull();
      expect(e.comments).toBeNull();
    }
  });

  it("SAME settings across several areas copy independently (no dedup, no collapse)", async () => {
    const twin: SeedArea = { ...AREA_CHIN, area: "Right cheek", laterality: "right" };
    const s = await seedRepeatClient([AREA_CHIN, twin]);
    const res = await callCopy({
      target: s.today,
      specs: await fastPathSpecs(s.previous),
      key: randomUUID(),
      fp: s.fp,
      sourceId: s.previous,
    });
    expect(res.copied_block_count).toBe(2);
    const blocks = await todaysBlocks(s.today);
    expect(blocks.map((b) => `${b.primary_area}|${b.side}`)).toEqual([
      "Chin|left",
      "Right cheek|right",
    ]);
    expect(blocks[0].id).not.toBe(blocks[1].id);
  });

  it("(19) the landing area is created_block_ids[0], the FIRST area, sort_order 1", async () => {
    // This is the invariant the fast path's routing depends on: the id it sends
    // the practitioner to must be the area she expects to start with.
    const s = await seedRepeatClient([AREA_CHIN, AREA_LIP]);
    const res = await callCopy({
      target: s.today,
      specs: await fastPathSpecs(s.previous),
      key: randomUUID(),
      fp: s.fp,
      sourceId: s.previous,
    });
    const landing = landingBlockId(res.created_block_ids);
    const blocks = await todaysBlocks(s.today);
    expect(landing).toBe(blocks[0].id);
    expect(blocks[0].sort_order).toBe(1);
    expect(blocks[0].primary_area).toBe("Chin");
  });
});

describe("(11) a double submit cannot duplicate the copied setup", () => {
  it("the SAME source-derived key replays: identical ids, no new rows, one ledger row", async () => {
    // The fast path derives its key from (source session, source fingerprint),
    // and its payload from the same pair, so a retry after a lost response
    // re-derives a byte-identical request.
    const s = await seedRepeatClient([AREA_CHIN, AREA_LIP]);
    const key = randomUUID();
    const specs = await fastPathSpecs(s.previous);

    const first = await callCopy({
      target: s.today,
      specs,
      key,
      fp: s.fp,
      sourceId: s.previous,
    });
    const specsAgain = await fastPathSpecs(s.previous);
    expect(JSON.stringify(specsAgain)).toBe(JSON.stringify(specs)); // pure function of the source
    const second = await callCopy({
      target: s.today,
      specs: specsAgain,
      key,
      fp: s.fp,
      sourceId: s.previous,
    });

    expect(second.idempotent_replay).toBe(true);
    expect(second.created_block_ids).toEqual(first.created_block_ids);
    expect(landingBlockId(second.created_block_ids)).toBe(
      landingBlockId(first.created_block_ids),
    );
    expect((await todaysBlocks(s.today))).toHaveLength(2);
    expect((await todaysEntries(s.today))).toHaveLength(2);

    const ledger = await adminQuery(
      `select count(*)::int as n from public.session_copy_operations where target_session_id = $1`,
      [s.today],
    );
    expect(ledger.rows[0].n).toBe(1);
  });

  it("a DIFFERENT key after a successful copy is refused (HN003) and creates nothing", async () => {
    // The worst case if key reuse ever failed: the target-row lock + emptiness
    // recheck still make duplication impossible.
    const s = await seedRepeatClient([AREA_CHIN]);
    const specs = await fastPathSpecs(s.previous);
    await callCopy({ target: s.today, specs, key: randomUUID(), fp: s.fp, sourceId: s.previous });
    await expect(
      callCopy({ target: s.today, specs, key: randomUUID(), fp: s.fp, sourceId: s.previous }),
    ).rejects.toMatchObject({ code: "HN003" });
    expect(await todaysBlocks(s.today)).toHaveLength(1);
  });
});

describe("(10) a stale source fails closed", () => {
  it("a fingerprint from BEFORE a source edit is rejected (HN005), creating nothing", async () => {
    const s = await seedRepeatClient([AREA_CHIN]);
    const specs = await fastPathSpecs(s.previous);

    // The previous visit's reusable setup changes after the fast path read it.
    await adminQuery(
      `update public.session_blocks set energy_level = energy_level + 5 where session_id = $1`,
      [s.previous],
    );
    expect(await fingerprintOf(s.previous)).not.toBe(s.fp);

    await expect(
      callCopy({ target: s.today, specs, key: randomUUID(), fp: s.fp, sourceId: s.previous }),
    ).rejects.toMatchObject({ code: "HN005" });
    expect(await todaysBlocks(s.today)).toHaveLength(0);
    expect(await todaysEntries(s.today)).toHaveLength(0);
  });

  it("recovery is a fresh read: the NEW fingerprint commits the NEW setup", async () => {
    const s = await seedRepeatClient([AREA_CHIN]);
    await adminQuery(
      `update public.session_blocks set energy_level = 33 where session_id = $1`,
      [s.previous],
    );
    const freshFp = await fingerprintOf(s.previous);
    await callCopy({
      target: s.today,
      specs: await fastPathSpecs(s.previous),
      key: randomUUID(),
      fp: freshFp,
      sourceId: s.previous,
    });
    const [block] = await todaysBlocks(s.today);
    expect(Number(block.energy_level)).toBe(33); // the CURRENT setup, never the stale one
  });
});

describe("(14) a cross-studio session can never become the copy source", () => {
  it("the resolver refuses another studio's session even when it is named explicitly", async () => {
    const mine = await seedRepeatClient([AREA_CHIN]);
    const theirs = await seedRepeatClient([AREA_LIP], other);

    // The canonical resolver, scoped to my studio, never sees their session.
    const resolved = await adminQuery(
      "select public._whole_session_copy_source_id($1,$2) as id",
      [a.studioId, mine.today],
    );
    expect(resolved.rows[0].id).toBe(mine.previous);
    expect(resolved.rows[0].id).not.toBe(theirs.previous);

    // Naming their session as the expected source is rejected, the RPC
    // re-derives the canonical source and refuses the mismatch.
    await expect(
      callCopy({
        target: mine.today,
        specs: await fastPathSpecs(theirs.previous),
        key: randomUUID(),
        fp: await fingerprintOf(theirs.previous),
        sourceId: theirs.previous,
      }),
    ).rejects.toMatchObject({ code: "HN005" });
    expect(await todaysBlocks(mine.today)).toHaveLength(0);
  });

  it("a target in another studio is not found for my studio id (HN002)", async () => {
    const theirs = await seedRepeatClient([AREA_LIP], other);
    await expect(
      callCopy({
        target: theirs.today,
        specs: await fastPathSpecs(theirs.previous),
        key: randomUUID(),
        fp: theirs.fp,
        sourceId: theirs.previous,
      }),
    ).rejects.toMatchObject({ code: "HN002" });
    expect(await todaysBlocks(theirs.today)).toHaveLength(0);
  });
});

describe("(15) the prior session is never mutated, Treatment Memory stays historical truth", () => {
  it("a successful copy leaves the source's fingerprint, rows and outcomes byte-identical", async () => {
    const s = await seedRepeatClient([AREA_CHIN, AREA_LIP]);

    const before = await adminQuery(
      `select id, sort_order, primary_area, side, mode, energy_level, machine_frequency,
              probe_key, minutes_performed, tolerance_rating, reaction_type, reaction_notes,
              caution_for_next_session, caution_note, numbing_status, numbing_notes,
              probe_lot_number, probe_lot_confirmed, block_name, block_notes, updated_at
         from public.session_blocks where session_id = $1 order by sort_order`,
      [s.previous],
    );
    const beforeEntries = await adminQuery(
      `select id, block_id, minutes_performed, hairs_treated, comments, observation_chips,
              thermolysis_intensity_percent, deleted_at
         from public.electrolysis_entries where session_id = $1 order by created_at`,
      [s.previous],
    );

    await callCopy({
      target: s.today,
      specs: await fastPathSpecs(s.previous),
      key: randomUUID(),
      fp: s.fp,
      sourceId: s.previous,
    });

    const after = await adminQuery(
      `select id, sort_order, primary_area, side, mode, energy_level, machine_frequency,
              probe_key, minutes_performed, tolerance_rating, reaction_type, reaction_notes,
              caution_for_next_session, caution_note, numbing_status, numbing_notes,
              probe_lot_number, probe_lot_confirmed, block_name, block_notes, updated_at
         from public.session_blocks where session_id = $1 order by sort_order`,
      [s.previous],
    );
    const afterEntries = await adminQuery(
      `select id, block_id, minutes_performed, hairs_treated, comments, observation_chips,
              thermolysis_intensity_percent, deleted_at
         from public.electrolysis_entries where session_id = $1 order by created_at`,
      [s.previous],
    );

    expect(after.rows).toEqual(before.rows);
    expect(afterEntries.rows).toEqual(beforeEntries.rows);
    expect(await fingerprintOf(s.previous)).toBe(s.fp);

    // The copy's rows are genuinely NEW, no source row was re-parented.
    const copiedIds = (await todaysBlocks(s.today)).map((b) => b.id);
    for (const id of copiedIds) expect(s.sourceBlockIds).not.toContain(id);
  });

  it("a REJECTED copy also leaves the source untouched", async () => {
    const s = await seedRepeatClient([AREA_CHIN]);
    const specs = await fastPathSpecs(s.previous);
    await expect(
      callCopy({
        target: s.today,
        specs,
        key: randomUUID(),
        fp: "0".repeat(64),
        sourceId: s.previous,
      }),
    ).rejects.toMatchObject({ code: "HN005" });
    expect(await fingerprintOf(s.previous)).toBe(s.fp);
    const prev = await adminQuery(
      `select count(*)::int as n from public.session_blocks where session_id = $1 and deleted_at is null`,
      [s.previous],
    );
    expect(prev.rows[0].n).toBe(1);
  });
});

describe("(13) an already-charted session is never destructively replaced", () => {
  it("a target that already has an area refuses the copy (HN003) and keeps its own rows", async () => {
    const s = await seedRepeatClient([AREA_CHIN]);
    // Today's chart already has work on it.
    const existing = randomUUID();
    await adminQuery(
      `insert into public.session_blocks (id, studio_id, session_id, sort_order, primary_area, side, mode, minutes_performed)
       values ($1,$2,$3,1,'Neck','right','thermo',9)`,
      [existing, a.studioId, s.today],
    );

    await expect(
      callCopy({
        target: s.today,
        specs: await fastPathSpecs(s.previous),
        key: randomUUID(),
        fp: s.fp,
        sourceId: s.previous,
      }),
    ).rejects.toMatchObject({ code: "HN003" });

    const blocks = await todaysBlocks(s.today);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].id).toBe(existing);
    expect(blocks[0].primary_area).toBe("Neck");
    expect(blocks[0].minutes_performed).toBe(9); // her own work is intact
  });

  it("the descriptor reports the chart ineligible, so the panel is not offered at all", async () => {
    const s = await seedRepeatClient([AREA_CHIN]);
    await adminQuery(
      `insert into public.session_blocks (id, studio_id, session_id, sort_order, primary_area, mode)
       values ($1,$2,$3,1,'Neck','thermo')`,
      [randomUUID(), a.studioId, s.today],
    );
    const r = await asUser(a.userId, (q) =>
      q("select public.whole_session_copy_source_descriptor($1,$2) as d", [a.studioId, s.today]),
    );
    expect(r.rows[0].d).toMatchObject({ eligible: false, reason: "not_empty" });
  });
});
