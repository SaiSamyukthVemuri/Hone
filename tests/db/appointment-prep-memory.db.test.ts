import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
  asUser,
  closePool,
  seedLegacyRecordStatus,
  seedStudio,
  type SeededStudio,
  type UserQuery,
} from "./helpers/harness";
import {
  BLOCK_COLUMNS,
  PREP_SESSION_COLUMNS,
} from "@/lib/sessions/last-treatment-loader";
import {
  chartedSessionCandidates,
  groupBlocksBySession,
  pickNewestChartedSession,
} from "@/lib/sessions/charted-session";
import {
  buildAppointmentPrepMemory,
  type PrepLaserEntry,
} from "@/lib/sessions/appointment-prep-memory";
import type { PointOfCareBlock } from "@/lib/sessions/point-of-care-memory";

// APPOINTMENT PREPARATION MEMORY, proven against the REAL migrated local
// database as the `authenticated` role — so RLS, the 0128 structured-area child
// rows, the soft-delete columns, `record_status`, the 0068 appointment FK and
// the actual stored types are all exercised rather than mocked.
//
// The SQL below mirrors the loader's PostgREST selects. That mirroring is NOT
// left to a comment: `describe("0.")` below asserts, column by column, that
// every identifier in the shipped TypeScript constants appears in its SQL twin.
// The equivalent claim in tests/db/point-of-care-memory.db.test.ts:52 was a
// prose comment, and it had already silently drifted by one column
// (custom_area_detail) before this test was written.

let s: SeededStudio;
let other: SeededStudio;
let otherClientId: string;


// The appointment being prepared.
const APPT_STARTS_AT = "2026-08-06T14:00:00Z";
let appointmentId: string;
let otherAppointmentId: string;

const CHARTED_AT = "2026-01-01T10:00:00Z";
const EMPTY_AT = "2026-06-01T10:00:00Z";
const DELETED_AT = "2026-06-05T10:00:00Z";
const VOID_AT = "2026-06-10T10:00:00Z";
// Strictly before the appointment start — the reachable case where a
// practitioner starts charting a few minutes early.
const LINKED_AT = "2026-08-06T13:55:00Z";
const FUTURE_AT = "2026-09-01T10:00:00Z";

let chartedSessionId: string;
let emptySessionId: string;
let deletedSessionId: string;
let voidSessionId: string;
let linkedSessionId: string;
let futureSessionId: string;
let foreignSessionId = "";
let multiAreaBlockId: string;
let singleAreaBlockId: string;

const MULTILINE_SESSION_NOTES =
  "Client arrived early and was comfortable.\n\nDiscussed spacing the next two visits.\nAgreed to keep the same probe.";
const LONG_REACTION_NOTE = `${"Erythema persisted longer than usual. ".repeat(8)}Resolved by evening.`;

// ---------------------------------------------------------------------------
// The loader's selects, as SQL.
// ---------------------------------------------------------------------------

const BLOCK_SQL = `
  select b.id, b.session_id, b.sort_order, b.block_name, b.primary_area, b.side,
         b.custom_area_detail,
         b.mode, b.apilus_modality, b.energy_level, b.minutes_performed,
         b.machine_frequency, b.probe_label, b.probe_type, b.probe_size,
         b.probe_lot_number, b.probe_lot_confirmed,
         b.numbing_status, b.numbing_notes,
         b.tolerance_rating, b.reaction_type, b.reaction_notes,
         b.caution_for_next_session, b.caution_note,
         coalesce(
           (select json_agg(json_build_object(
                     'area', a.area, 'laterality', a.laterality,
                     'display_order', a.display_order, 'created_at', a.created_at,
                     'id', a.id)
                   order by a.display_order, a.created_at, a.id)
              from public.session_block_areas a
             where a.session_block_id = b.id),
           '[]'::json) as structured_areas
    from public.session_blocks b
   where b.studio_id = $1
     and b.session_id = any($2::uuid[])
     and b.deleted_at is null
   order by b.sort_order asc`;

// The bounded candidate window: studio, client, soft-delete, the strict
// appointment bound, newest-first, limited.
const SESSION_SQL = `
  select s.id, s.started_at, s.modality, s.record_status, s.deleted_at,
         s.appointment_id, s.session_notes, s.next_session_note,
         -- The scalar behind the "Aftercare not marked" reminder. It is read
         -- off the SELECTED SESSION ROW, which is what licenses the chip: a
         -- field null on a row we hold, never an inference from a collection.
         s.aftercare_and_risks_explained_at,
         coalesce(
           (select json_agg(json_build_object(
                     'id', e.id, 'block_id', e.block_id, 'area', e.area,
                     'created_at', e.created_at,
                     'deleted_at', e.deleted_at, 'mode', e.mode,
                     'hairs_treated', e.hairs_treated,
                     'observation_chips', e.observation_chips,
                     'comments', e.comments,
                     'thermolysis_intensity_percent', e.thermolysis_intensity_percent,
                     'thermolysis_duration_seconds', e.thermolysis_duration_seconds,
                     'galvanic_ma', e.galvanic_ma,
                     'galvanic_duration_seconds', e.galvanic_duration_seconds,
                     'units_of_lye', e.units_of_lye,
                     'pulse_count', e.pulse_count,
                     'pulse_delay_seconds', e.pulse_delay_seconds)
                   order by e.created_at)
              from public.electrolysis_entries e where e.session_id = s.id),
           '[]'::json) as electrolysis_entries,
         coalesce(
           (select json_agg(json_build_object(
                     'id', l.id, 'deleted_at', l.deleted_at,
                     'zone', l.zone, 'observation_notes', l.observation_notes))
              from public.laser_entries l where l.session_id = s.id),
           '[]'::json) as laser_entries
    from public.sessions s
   where s.studio_id = $1 and s.client_id = $2 and s.deleted_at is null
     and s.started_at < $3
   order by s.started_at desc
   limit $4`;

type Counted = {
  query: UserQuery;
  count: () => number;
  sessionReads: () => number;
  blockReads: () => number;
};

// Wraps a harness query fn so a test can prove the read is bounded.
//
// A bare statement count is VACUOUS here — loadLastChartedTreatmentForClient
// contains two literal calls, so it can only ever return 2 no matter how the
// data grows. `sessionReads` and `blockReads` are the assertions that mean
// something: they count executions of the two batched statements, which is
// where an N+1 (one read per session, per block or per area) would show up.
function counting(query: UserQuery): Counted {
  let n = 0;
  let sessions = 0;
  let blocks = 0;
  return {
    query: (text, params) => {
      n += 1;
      if (text === SESSION_SQL) sessions += 1;
      if (text === BLOCK_SQL) blocks += 1;
      return query(text, params);
    },
    count: () => n,
    sessionReads: () => sessions,
    blockReads: () => blocks,
  };
}

async function insertSession(
  studio: SeededStudio,
  clientId: string,
  startedAt: string,
  extra: { modality?: string; appointmentId?: string | null } = {},
): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.sessions
       (id, studio_id, client_id, practitioner_id, modality, started_at, appointment_id)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [
      id,
      studio.studioId,
      clientId,
      studio.practitionerId,
      extra.modality ?? "electrolysis",
      startedAt,
      extra.appointmentId ?? null,
    ],
  );
  return id;
}

async function insertAppointment(
  studio: SeededStudio,
  clientId: string,
  startsAt: string,
): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.appointments
       (id, studio_id, client_id, practitioner_id, starts_at, ends_at,
        duration_minutes, status)
     values ($1,$2,$3,$4,$5,$5::timestamptz + interval '60 minutes',60,'confirmed')`,
    [id, studio.studioId, clientId, studio.practitionerId, startsAt],
  );
  return id;
}

beforeAll(async () => {
  s = await seedStudio("prep-memory");
  other = await seedStudio("prep-other-studio");

  otherClientId = randomUUID();
  await adminQuery(
    "insert into public.clients (id, studio_id, name) values ($1,$2,$3)",
    [otherClientId, s.studioId, "Other client, same studio"],
  );

  appointmentId = await insertAppointment(s, s.clientId, APPT_STARTS_AT);
  otherAppointmentId = await insertAppointment(
    s,
    s.clientId,
    "2026-08-20T14:00:00Z",
  );

  // 1. THE REAL PREVIOUS TREATMENT: multi-area block (Cheek/left +
  //    Sideburn/right) plus a single-area block, full setup, full outcomes,
  //    multiline narrative.
  chartedSessionId = await insertSession(s, s.clientId, CHARTED_AT);
  await adminQuery(
    `update public.sessions
        set session_notes = $2, next_session_note = $3
      where id = $1`,
    [
      chartedSessionId,
      MULTILINE_SESSION_NOTES,
      "Start lower on the sideburn",
    ],
  );

  multiAreaBlockId = randomUUID();
  await adminQuery(
    `insert into public.session_blocks
       (id, studio_id, session_id, sort_order, block_name,
        primary_area, side, mode, apilus_modality, energy_level,
        minutes_performed, machine_frequency,
        probe_label, probe_lot_number, probe_lot_confirmed,
        numbing_status, numbing_notes,
        tolerance_rating, reaction_type, reaction_notes,
        caution_for_next_session, caution_note)
     values ($1,$2,$3,1,'Main',
             'Cheek', null, 'blend', 'Picoblend', 14,
             30, '13.56 MHz',
             'Ballet F3', 'LOT-A12', true,
             'used', 'Emla 30 min before',
             3, 'mild_redness', $4,
             true, 'Watch the sideburn — it reacted last time')`,
    [multiAreaBlockId, s.studioId, chartedSessionId, LONG_REACTION_NOTE],
  );
  await adminQuery(
    `insert into public.session_block_areas (session_block_id, area, laterality, display_order)
     values ($1,'Cheek','left',0), ($1,'Sideburn','right',1)`,
    [multiAreaBlockId],
  );

  singleAreaBlockId = randomUUID();
  await adminQuery(
    `insert into public.session_blocks
       (id, studio_id, session_id, sort_order, primary_area, side,
        mode, energy_level, minutes_performed, machine_frequency, probe_label)
     values ($1,$2,$3,2,'Chin','center','thermo',9,12,'27.12 MHz','Ballet F2')`,
    [singleAreaBlockId, s.studioId, chartedSessionId],
  );
  await adminQuery(
    `insert into public.session_block_areas (session_block_id, area, laterality, display_order)
     values ($1,'Chin','midline',0)`,
    [singleAreaBlockId],
  );

  // Two live passes with their own Additional notes, plus one soft-deleted
  // pass that must contribute nothing at all.
  await adminQuery(
    `insert into public.electrolysis_entries
       (session_id, block_id, area, mode, hairs_treated,
        thermolysis_duration_seconds, thermolysis_intensity_percent,
        galvanic_ma, galvanic_duration_seconds, units_of_lye,
        pulse_count, comments, created_at)
     values ($1,$2,'Cheek','blend',40, 0.733, 40, 1.2, 8, 30, 1,
             'First pass was slow going near the jawline.', '2026-01-01T10:05:00Z'),
            ($1,$2,'Cheek','blend',25, 0.9, 45, 1.2, 8, 30, 1,
             'Second pass:\nmuch faster once the area warmed up.', '2026-01-01T10:20:00Z')`,
    [chartedSessionId, multiAreaBlockId],
  );
  await adminQuery(
    `insert into public.electrolysis_entries
       (id, session_id, block_id, area, mode, hairs_treated, pulse_count,
        comments, created_at, deleted_at)
     values ($1,$2,$3,'Cheek','blend',9999,1,'FORBIDDEN-DELETED-PASS',
             '2026-01-01T09:00:00Z','2026-01-01T09:30:00Z')`,
    [randomUUID(), chartedSessionId, multiAreaBlockId],
  );

  // 2. A NEWER session with nothing charted on it — the exact row that used to
  //    win `order started_at desc limit 1` and hide the treatment above.
  emptySessionId = await insertSession(s, s.clientId, EMPTY_AT);

  // 3. A NEWER, fully-charted, but soft-DELETED session.
  deletedSessionId = await insertSession(s, s.clientId, DELETED_AT);
  await adminQuery(
    `insert into public.session_blocks (id, studio_id, session_id, primary_area, minutes_performed)
     values ($1,$2,$3,'FORBIDDEN-DELETED-SESSION',99)`,
    [randomUUID(), s.studioId, deletedSessionId],
  );
  await adminQuery("update public.sessions set deleted_at = now() where id = $1", [
    deletedSessionId,
  ]);

  // 4. A NEWER, fully-charted, VOID session. Constructing this state requires
  //    the sanctioned harness escape hatch — 0159 permanently blocks the
  //    transition for every role, which is itself the proof there is no bypass.
  voidSessionId = await insertSession(s, s.clientId, VOID_AT);
  await adminQuery(
    `insert into public.session_blocks (id, studio_id, session_id, primary_area, minutes_performed)
     values ($1,$2,$3,'FORBIDDEN-VOID-SESSION',99)`,
    [randomUUID(), s.studioId, voidSessionId],
  );
  await seedLegacyRecordStatus(voidSessionId, "void");

  // 5. THIS appointment's own linked session — charted, and started BEFORE the
  //    appointment's clock time, so only the appointment_id excludes it.
  linkedSessionId = await insertSession(s, s.clientId, LINKED_AT, {
    appointmentId,
  });
  await adminQuery(
    `insert into public.session_blocks (id, studio_id, session_id, primary_area, minutes_performed)
     values ($1,$2,$3,'FORBIDDEN-LINKED-CURRENT',99)`,
    [randomUUID(), s.studioId, linkedSessionId],
  );

  // 6. A charted session AFTER the appointment starts.
  futureSessionId = await insertSession(s, s.clientId, FUTURE_AT);
  await adminQuery(
    `insert into public.session_blocks (id, studio_id, session_id, primary_area, minutes_performed)
     values ($1,$2,$3,'FORBIDDEN-FUTURE',99)`,
    [randomUUID(), s.studioId, futureSessionId],
  );

  // 7. Cross-client and cross-studio noise, both newer, both fully charted.
  const otherClientSession = await insertSession(s, otherClientId, EMPTY_AT);
  await adminQuery(
    `insert into public.session_blocks (id, studio_id, session_id, primary_area, minutes_performed)
     values ($1,$2,$3,'FORBIDDEN-OTHER-CLIENT',99)`,
    [randomUUID(), s.studioId, otherClientSession],
  );
  foreignSessionId = await insertSession(other, other.clientId, EMPTY_AT);
  await adminQuery(
    `insert into public.session_blocks
       (id, studio_id, session_id, primary_area, minutes_performed, caution_note)
     values ($1,$2,$3,'FORBIDDEN-OTHER-STUDIO',99,'FORBIDDEN-OTHER-STUDIO-NOTE')`,
    [randomUUID(), other.studioId, foreignSessionId],
  );
});

afterAll(async () => {
  await closePool();
});

// The whole read path, exactly as loadLastChartedTreatmentForClient performs
// it: ONE bounded candidate read, then ONE batched block read.
async function loadPrep(opts: {
  userId: string;
  studioId: string;
  clientId: string;
  before?: string;
  excludeAppointmentId?: string;
  limit?: number;
}) {
  return asUser(opts.userId, async (rawQuery) => {
    const c = counting(rawQuery);
    const rows = (
      await c.query(SESSION_SQL, [
        opts.studioId,
        opts.clientId,
        opts.before ?? APPT_STARTS_AT,
        opts.limit ?? 25,
      ])
    ).rows.map((r) => ({
      id: r.id as string,
      started_at: new Date(r.started_at).toISOString(),
      modality: r.modality as string,
      record_status: r.record_status as string,
      deleted_at: r.deleted_at as string | null,
      appointment_id: r.appointment_id as string | null,
      session_notes: r.session_notes as string | null,
      next_session_note: r.next_session_note as string | null,
      electrolysis_entries: r.electrolysis_entries as Array<
        Record<string, unknown> & { block_id?: string | null; deleted_at: string | null }
      >,
      laser_entries: r.laser_entries as PrepLaserEntry[],
    }));

    const candidates = chartedSessionCandidates(rows, {
      before: opts.before ?? APPT_STARTS_AT,
      excludeAppointmentId: opts.excludeAppointmentId,
      limit: opts.limit ?? 25,
    });
    const empty = {
      memory: null,
      selected: null,
      queries: c.count(),
      sessionReads: c.sessionReads(),
      blockReads: c.blockReads(),
      candidates,
    };
    if (candidates.length === 0) return empty;

    const blockRows = (
      await c.query(BLOCK_SQL, [opts.studioId, candidates.map((x) => x.id)])
    ).rows as Array<
      PointOfCareBlock & { session_id: string; deleted_at?: string | null }
    >;
    const bySession = groupBlocksBySession(blockRows);
    const selected = pickNewestChartedSession(candidates, bySession);
    if (!selected) {
      return { ...empty, queries: c.count(), blockReads: c.blockReads() };
    }

    const entriesByBlock = new Map<string, Array<Record<string, unknown>>>();
    for (const e of selected.electrolysis_entries ?? []) {
      if (e.deleted_at != null) continue;
      const blockId = e.block_id;
      if (!blockId) continue;
      const bucket = entriesByBlock.get(blockId) ?? [];
      bucket.push(e);
      entriesByBlock.set(blockId, bucket);
    }
    const blocks: PointOfCareBlock[] = (bySession.get(selected.id) ?? []).map(
      (b) => ({
        ...b,
        structured_areas: (b.structured_areas ?? []) as PointOfCareBlock["structured_areas"],
        entries: (entriesByBlock.get(b.id) ??
          []) as unknown as PointOfCareBlock["entries"],
      }),
    );

    return {
      selected,
      candidates,
      queries: c.count(),
      sessionReads: c.sessionReads(),
      blockReads: c.blockReads(),
      memory: buildAppointmentPrepMemory({
        session: {
          id: selected.id,
          started_at: selected.started_at,
          modality: selected.modality,
          session_notes: selected.session_notes,
          next_session_note: selected.next_session_note,
        },
        blocks,
        laserEntries: selected.laser_entries,
        electrolysisEntries: selected.electrolysis_entries,
        supersededByEmptySession: candidates[0]?.id !== selected.id,
        hasLiveElectrolysisEntries: (selected.electrolysis_entries ?? []).some(
          (e) => e.deleted_at == null,
        ),
      }),
    };
  });
}

const forStudioA = () =>
  loadPrep({
    userId: s.userId,
    studioId: s.studioId,
    clientId: s.clientId,
    excludeAppointmentId: appointmentId,
  });

// ---------------------------------------------------------------------------

describe("0. the SQL mirrors the shipped selects, column for column", () => {
  // Without this, adding a column to the TypeScript constant leaves this suite
  // testing the OLD shape — green, and blind to the change.
  const identifiers = (select: string) =>
    select
      .replace(/[\w]+:/g, "")
      .split(/[(),]/)
      .map((t) => t.trim())
      .filter((t) => /^[a-z_][a-z0-9_]*$/.test(t));

  it("every column of BLOCK_COLUMNS appears in BLOCK_SQL", () => {
    const missing = identifiers(BLOCK_COLUMNS).filter(
      (col) => !new RegExp(`\\b${col}\\b`).test(BLOCK_SQL),
    );
    expect(missing).toEqual([]);
  });

  it("every column of PREP_SESSION_COLUMNS appears in SESSION_SQL", () => {
    const missing = identifiers(PREP_SESSION_COLUMNS).filter(
      (col) => !new RegExp(`\\b${col}\\b`).test(SESSION_SQL),
    );
    expect(missing).toEqual([]);
  });

  it("the retired galvanic input is in neither select", () => {
    expect(PREP_SESSION_COLUMNS).not.toContain("galvanic_intensity_percent");
    expect(SESSION_SQL).not.toContain("galvanic_intensity_percent");
    expect(BLOCK_COLUMNS).not.toContain("galvanic_intensity_percent");
  });
});

describe("1. positive controls — every excluded fixture genuinely EXISTS", () => {
  it("the empty, deleted, void, linked and future rows are all really there", async () => {
    const r = await adminQuery(
      `select id, record_status, deleted_at, appointment_id, started_at
         from public.sessions where id = any($1::uuid[]) order by started_at`,
      [
        [
          chartedSessionId,
          emptySessionId,
          deletedSessionId,
          voidSessionId,
          linkedSessionId,
          futureSessionId,
        ],
      ],
    );
    expect(r.rows).toHaveLength(6);
    const byId = Object.fromEntries(r.rows.map((x) => [x.id, x]));
    expect(byId[deletedSessionId].deleted_at).not.toBeNull();
    expect(byId[voidSessionId].record_status).toBe("void");
    expect(byId[linkedSessionId].appointment_id).toBe(appointmentId);
    expect(new Date(byId[futureSessionId].started_at).toISOString()).toBe(
      new Date(FUTURE_AT).toISOString(),
    );
    // And each excluded one really is NEWER than the treatment we expect.
    for (const id of [emptySessionId, deletedSessionId, voidSessionId, linkedSessionId]) {
      expect(
        new Date(byId[id].started_at).getTime(),
      ).toBeGreaterThan(new Date(CHARTED_AT).getTime());
    }
  });

  it("the decoy blocks that must never surface really exist", async () => {
    const r = await adminQuery(
      `select primary_area from public.session_blocks
        where primary_area like 'FORBIDDEN-%' order by primary_area`,
    );
    const areas = r.rows.map((x) => x.primary_area);
    for (const marker of [
      "FORBIDDEN-DELETED-SESSION",
      "FORBIDDEN-VOID-SESSION",
      "FORBIDDEN-LINKED-CURRENT",
      "FORBIDDEN-FUTURE",
      "FORBIDDEN-OTHER-CLIENT",
      "FORBIDDEN-OTHER-STUDIO",
    ]) {
      expect(areas).toContain(marker);
    }
  });
});

describe("2. selection — the newest CHARTED treatment before this appointment", () => {
  it("selects the older charted treatment over every newer decoy", async () => {
    const r = await forStudioA();
    expect(r.selected?.id).toBe(chartedSessionId);
    for (const excluded of [
      emptySessionId,
      deletedSessionId,
      voidSessionId,
      linkedSessionId,
      futureSessionId,
    ]) {
      expect(r.selected?.id).not.toBe(excluded);
    }
  });

  it("no excluded record leaks into the rendered model", async () => {
    const r = await forStudioA();
    // THE assertion that matters: nothing excluded reaches what is rendered.
    expect(JSON.stringify(r.memory)).not.toMatch(/FORBIDDEN-/);
  });

  it("no excluded SESSION even enters the candidate window", async () => {
    const r = await forStudioA();
    const ids = r.candidates.map((c) => c.id);
    for (const excluded of [
      deletedSessionId,
      voidSessionId,
      linkedSessionId,
      futureSessionId,
    ]) {
      expect(ids).not.toContain(excluded);
    }
    // The empty row IS a candidate — it is rejected on CONTENT, one layer
    // later. That distinction is the whole point of the two-half selector, so
    // it is asserted rather than glossed over.
    expect(ids).toContain(emptySessionId);
    expect(ids).toContain(chartedSessionId);
  });

  it("a soft-deleted pass crosses the wire but never reaches the model", async () => {
    // Soft-deleted entries are filtered in JS, not in SQL — the same contract
    // every other read path in the product uses. Proving BOTH halves means the
    // 'not rendered' assertion above cannot pass merely because the row was
    // never fetched.
    const r = await forStudioA();
    const fetched = r.candidates.find((c) => c.id === chartedSessionId);
    expect(
      JSON.stringify(fetched?.electrolysis_entries ?? []),
    ).toMatch(/FORBIDDEN-DELETED-PASS/);
    expect(JSON.stringify(r.memory)).not.toMatch(/FORBIDDEN-DELETED-PASS/);
    expect(r.memory?.areas[0].outcome.notes).toEqual([
      "First pass was slow going near the jawline.",
      "Second pass:\nmuch faster once the area warmed up.",
    ]);
  });

  it("reports that a newer session exists with nothing charted on it", async () => {
    const r = await forStudioA();
    expect(r.memory?.supersededByEmptySession).toBe(true);
  });

  it("WITHOUT the appointment exclusion, the current linked session would win — the control", async () => {
    const r = await loadPrep({
      userId: s.userId,
      studioId: s.studioId,
      clientId: s.clientId,
      // excludeAppointmentId deliberately omitted.
    });
    expect(r.selected?.id).toBe(linkedSessionId);
    // Which is exactly why the page passes it.
    const guarded = await forStudioA();
    expect(guarded.selected?.id).toBe(chartedSessionId);
  });

  it("a session linked to a DIFFERENT appointment is still eligible", async () => {
    const iso = await seedStudio("prep-other-appt");
    const appt = await insertAppointment(iso, iso.clientId, APPT_STARTS_AT);
    const otherAppt = await insertAppointment(iso, iso.clientId, "2026-08-04T10:00:00Z");
    const older = await insertSession(iso, iso.clientId, CHARTED_AT);
    const linkedElsewhere = await insertSession(iso, iso.clientId, EMPTY_AT, {
      appointmentId: otherAppt,
    });
    await adminQuery(
      `insert into public.session_blocks (id, studio_id, session_id, primary_area, minutes_performed)
       values ($1,$2,$3,'Chin',10), ($4,$2,$5,'Neck',20)`,
      [randomUUID(), iso.studioId, older, randomUUID(), linkedElsewhere],
    );
    const r = await loadPrep({
      userId: iso.userId,
      studioId: iso.studioId,
      clientId: iso.clientId,
      excludeAppointmentId: appt,
    });
    expect(r.selected?.id).toBe(linkedElsewhere);
  });

  it("a first-visit client yields no prior treatment at all", async () => {
    const iso = await seedStudio("prep-first-visit");
    const appt = await insertAppointment(iso, iso.clientId, APPT_STARTS_AT);
    await insertSession(iso, iso.clientId, LINKED_AT, { appointmentId: appt });
    const r = await loadPrep({
      userId: iso.userId,
      studioId: iso.studioId,
      clientId: iso.clientId,
      excludeAppointmentId: appt,
    });
    expect(r.memory).toBeNull();
    expect(r.selected).toBeNull();
  });

  it("a laser-only prior treatment is selected and is truthfully described", async () => {
    const iso = await seedStudio("prep-laser");
    const appt = await insertAppointment(iso, iso.clientId, APPT_STARTS_AT);
    const laser = await insertSession(iso, iso.clientId, CHARTED_AT, {
      modality: "laser",
    });
    await adminQuery(
      `update public.sessions set session_notes = $2, next_session_note = $3 where id = $1`,
      [laser, "Full-face laser pass.", "Reduce fluence next time"],
    );
    await adminQuery(
      `insert into public.laser_entries (session_id, zone, observation_notes)
       values ($1,'Chin','Zone cleared well.\nNo adverse response.')`,
      [laser],
    );
    // A newer empty row, so the fixture also proves the selector.
    await insertSession(iso, iso.clientId, EMPTY_AT);

    const r = await loadPrep({
      userId: iso.userId,
      studioId: iso.studioId,
      clientId: iso.clientId,
      excludeAppointmentId: appt,
    });
    expect(r.selected?.id).toBe(laser);
    expect(r.memory?.areas).toEqual([]);
    expect(r.memory?.blocklessNote).toContain("charted as laser passes");
    expect(r.memory?.blocklessNote).not.toMatch(/not recorded/i);
    // The notes stay visible for a blockless treatment.
    expect(r.memory?.notes.general[0].text).toBe("Full-face laser pass.");
    expect(r.memory?.notes.forNextVisit?.text).toBe("Reduce fluence next time");
    const laserNote = r.memory?.notes.additional.find(
      (n) => n.source === "laser_observation_notes",
    );
    expect(laserNote?.text).toBe("Zone cleared well.\nNo adverse response.");
    expect(laserNote?.areaLabel).toBe("Chin");
  });

  it("a legacy entry-only prior treatment is selected and truthfully described", async () => {
    const iso = await seedStudio("prep-legacy");
    const appt = await insertAppointment(iso, iso.clientId, APPT_STARTS_AT);
    const legacy = await insertSession(iso, iso.clientId, CHARTED_AT);
    await adminQuery(
      `update public.sessions set session_notes = $2 where id = $1`,
      [legacy, "Charted before settings blocks existed."],
    );
    await adminQuery(
      `insert into public.electrolysis_entries (session_id, area, mode, hairs_treated, comments, created_at)
       values ($1,'Chin','thermo',12,'Legacy pass, no settings block.','2026-01-01T10:05:00Z')`,
      [legacy],
    );
    await insertSession(iso, iso.clientId, EMPTY_AT);

    const r = await loadPrep({
      userId: iso.userId,
      studioId: iso.studioId,
      clientId: iso.clientId,
      excludeAppointmentId: appt,
    });
    expect(r.selected?.id).toBe(legacy);
    expect(r.memory?.blocklessNote).toContain("legacy treatment entries");
    expect(r.memory?.blocklessNote).not.toMatch(
      /Area not recorded|Setup not recorded/i,
    );
    // REGRESSION (adversarial review, P1): this fixture seeded a comment from
    // the start, and the test asserted only the blockless copy — so it passed
    // green while the note was unreachable. A blockless pass's narrative has NO
    // other channel to the card.
    expect(r.memory?.notes.hasAny).toBe(true);
    expect(r.memory?.notes.general[0].text).toBe(
      "Charted before settings blocks existed.",
    );
    const orphan = r.memory?.notes.additional.find(
      (n) => n.source === "entry_comments",
    );
    expect(orphan?.text).toBe("Legacy pass, no settings block.");
    expect(orphan?.areaLabel).toBe("Chin");
  });

  it("a session whose only block is soft-deleted is NOT charted", async () => {
    const iso = await seedStudio("prep-softdelete");
    const appt = await insertAppointment(iso, iso.clientId, APPT_STARTS_AT);
    const older = await insertSession(iso, iso.clientId, CHARTED_AT);
    const newer = await insertSession(iso, iso.clientId, EMPTY_AT);
    await adminQuery(
      `insert into public.session_blocks (id, studio_id, session_id, primary_area, minutes_performed)
       values ($1,$2,$3,'Chin',10)`,
      [randomUUID(), iso.studioId, older],
    );
    await adminQuery(
      `insert into public.session_blocks
         (id, studio_id, session_id, primary_area, minutes_performed, deleted_at)
       values ($1,$2,$3,'FORBIDDEN-GHOST-BLOCK',99, now())`,
      [randomUUID(), iso.studioId, newer],
    );
    const r = await loadPrep({
      userId: iso.userId,
      studioId: iso.studioId,
      clientId: iso.clientId,
      excludeAppointmentId: appt,
    });
    expect(r.selected?.id).toBe(older);
    expect(JSON.stringify(r)).not.toMatch(/FORBIDDEN-GHOST-BLOCK/);
  });
});

describe("3. complete areas and settings, read back from the real columns", () => {
  it("shows every treated area with laterality, from the real 0128 child rows", async () => {
    const m = (await forStudioA()).memory!;
    expect(m.areas[0].areaLabel).toBe("Left Cheek · Right Sideburn");
    expect(m.areas[0].areaParts).toEqual(["Left Cheek", "Right Sideburn"]);
    expect(m.areas[1].areaParts).toEqual(["Midline Chin"]);
    expect(m.areaHeadline).toBe("Left Cheek · Right Sideburn · Midline Chin");
  });

  it("keeps each block's settings to its own block", async () => {
    const m = (await forStudioA()).memory!;
    expect(m.areas[0].setup.frequency).toBe("13.56 MHz");
    expect(m.areas[1].setup.frequency).toBe("27.12 MHz");
    expect(m.areas[0].setup.probeLine).toBe("Ballet F3 · Lot #LOT-A12 (confirmed)");
    expect(m.areas[1].setup.probeLine).toBe("Ballet F2");
    expect(m.areas[0].setup.modeLabel).toBe("Blend");
    expect(m.areas[1].setup.modeLabel).toBe("Thermolysis");
  });

  it("shows the EXACT stored 3-decimal thermolysis duration read back from numeric", async () => {
    const m = (await forStudioA()).memory!;
    const reading = m.areas[0].setup.readings.find(
      (r) => r.field === "thermolysisDurationSeconds",
    );
    expect(reading?.value).toBe("0.733 seconds");
  });

  it("mode-gates the readings against the STORED mode", async () => {
    const m = (await forStudioA()).memory!;
    const blend = m.areas[0].setup.readings.map((r) => r.field);
    const thermo = m.areas[1].setup.readings.map((r) => r.field);
    // NON-VACUITY FIRST. `not.toContain` on an empty array passes for the wrong
    // reason, so assert the gate actually produced readings before asserting
    // what it withheld.
    expect(blend.length).toBeGreaterThan(0);
    expect(thermo.length).toBeGreaterThan(0);
    // Blend sees both halves...
    expect(blend).toContain("galvanicMa");
    expect(blend).toContain("thermolysisDurationSeconds");
    // ...the thermolysis block sees only its own, from the same stored rows.
    expect(thermo).toContain("energyLevel");
    expect(thermo).not.toContain("galvanicMa");
    expect(thermo).not.toContain("galvanicDurationSeconds");
    expect(thermo).not.toContain("unitsOfLye");
  });

  it("carries the complete outcome set, with hairs summed across LIVE passes only", async () => {
    const m = (await forStudioA()).memory!;
    const o = m.areas[0].outcome;
    expect(o.minutes).toBe(30);
    expect(o.hairs).toBe(65);
    expect(m.areas[0].passCount).toBe(2);
    expect(o.numbing).toEqual({
      label: "Numbing used",
      note: "Emla 30 min before",
    });
    expect(o.toleranceLine).toBe("3/5 - Moderate discomfort");
    expect(o.responseLine).toBe("Mild redness");
    expect(o.cautionFlag).toBe(true);
    expect(m.totalMinutes).toBe(42);
    expect(m.totalHairs).toBe(65);
    // The soft-deleted pass contributed nothing.
    expect(JSON.stringify(m)).not.toMatch(/9999|FORBIDDEN-DELETED-PASS/);
  });

  it("minutes are never fabricated for a block that recorded none", async () => {
    const iso = await seedStudio("prep-no-minutes");
    const appt = await insertAppointment(iso, iso.clientId, APPT_STARTS_AT);
    const sess = await insertSession(iso, iso.clientId, CHARTED_AT);
    await adminQuery(
      `insert into public.session_blocks (id, studio_id, session_id, primary_area, mode)
       values ($1,$2,$3,'Chin','thermo')`,
      [randomUUID(), iso.studioId, sess],
    );
    const r = await loadPrep({
      userId: iso.userId,
      studioId: iso.studioId,
      clientId: iso.clientId,
      excludeAppointmentId: appt,
    });
    expect(r.memory?.areas[0].outcome.minutes).toBeNull();
    expect(r.memory?.areas[0].outcome.hairs).toBeNull();
    expect(r.memory?.totalMinutes).toBeNull();
  });

  it("never surfaces the retired galvanic intensity", async () => {
    const m = (await forStudioA()).memory!;
    expect(JSON.stringify(m)).not.toMatch(/galvanic_intensity|galvanicIntensity/i);
  });
});

describe("4. the full narrative comes back whole", () => {
  it("session notes keep every line break", async () => {
    const m = (await forStudioA()).memory!;
    expect(m.notes.general).toHaveLength(1);
    expect(m.notes.general[0].text).toBe(MULTILINE_SESSION_NOTES);
    expect(m.notes.general[0].text.split("\n")).toHaveLength(4);
  });

  it("the next-visit note is its own item", async () => {
    const m = (await forStudioA()).memory!;
    expect(m.notes.forNextVisit?.text).toBe("Start lower on the sideburn");
    expect(m.notes.general.map((g) => g.text)).not.toContain(
      "Start lower on the sideburn",
    );
  });

  it("a reaction note LONGER than 140 characters survives in full", async () => {
    // The compact summary silently drops these; this surface must not.
    const m = (await forStudioA()).memory!;
    expect(LONG_REACTION_NOTE.length).toBeGreaterThan(140);
    expect(m.notes.responses[0].text).toBe(LONG_REACTION_NOTE);
    expect(m.notes.responses[0].text).not.toContain("…");
  });

  it("the caution is grouped to its own area", async () => {
    const m = (await forStudioA()).memory!;
    expect(m.notes.cautions).toHaveLength(1);
    expect(m.notes.cautions[0].areaLabel).toBe("Left Cheek · Right Sideburn");
    expect(m.notes.cautions[0].text).toBe(
      "Watch the sideburn — it reacted last time",
    );
  });

  it("entry Additional notes come back grouped under the right area, oldest first", async () => {
    const m = (await forStudioA()).memory!;
    const comments = m.notes.additional.filter(
      (n) => n.source === "entry_comments",
    );
    expect(comments.map((n) => n.text)).toEqual([
      "First pass was slow going near the jawline.",
      "Second pass:\nmuch faster once the area warmed up.",
    ]);
    expect(comments.every((n) => n.areaKey === multiAreaBlockId)).toBe(true);
    // The deleted pass's note is not among them.
    expect(comments.map((n) => n.text).join()).not.toContain("FORBIDDEN");
  });

  it("no piece of narrative is emitted twice", async () => {
    const m = (await forStudioA()).memory!;
    const all = [
      ...m.notes.general,
      ...(m.notes.forNextVisit ? [m.notes.forNextVisit] : []),
      ...m.notes.cautions,
      ...m.notes.responses,
      ...m.notes.additional,
    ];
    expect(new Set(all.map((n) => n.key)).size).toBe(all.length);
    const identities = all.map(
      (n) => `${n.source}|${"areaKey" in n ? n.areaKey : ""}|${n.text}`,
    );
    expect(new Set(identities).size).toBe(identities.length);
  });

  it("a treatment with no narrative at all reports hasAny false", async () => {
    const iso = await seedStudio("prep-no-notes");
    const appt = await insertAppointment(iso, iso.clientId, APPT_STARTS_AT);
    const sess = await insertSession(iso, iso.clientId, CHARTED_AT);
    await adminQuery(
      `insert into public.session_blocks (id, studio_id, session_id, primary_area, minutes_performed)
       values ($1,$2,$3,'Chin',10)`,
      [randomUUID(), iso.studioId, sess],
    );
    const r = await loadPrep({
      userId: iso.userId,
      studioId: iso.studioId,
      clientId: iso.clientId,
      excludeAppointmentId: appt,
    });
    expect(r.memory?.notes.hasAny).toBe(false);
  });
});

describe("5. tenant isolation is enforced by RLS, not by the query", () => {
  it("another client in the SAME studio never appears", async () => {
    const r = await forStudioA();
    expect(JSON.stringify(r)).not.toMatch(/FORBIDDEN-OTHER-CLIENT/);
  });

  it("another studio never appears, and RLS itself blocks the read", async () => {
    const r = await forStudioA();
    expect(JSON.stringify(r)).not.toMatch(/FORBIDDEN-OTHER-STUDIO/);

    // Belt and braces: asking for the foreign studio's rows directly returns
    // nothing for this user, at BOTH statements.
    const leakBlocks = await asUser(s.userId, (q) =>
      q(BLOCK_SQL, [other.studioId, [foreignSessionId]]),
    );
    expect(leakBlocks.rows).toHaveLength(0);
    const leakSessions = await asUser(s.userId, (q) =>
      q(SESSION_SQL, [other.studioId, other.clientId, FUTURE_AT, 25]),
    );
    expect(leakSessions.rows).toHaveLength(0);
  });

  it("the foreign studio's own owner sees only their studio", async () => {
    const r = await loadPrep({
      userId: other.userId,
      studioId: other.studioId,
      clientId: other.clientId,
      before: FUTURE_AT,
    });
    expect(JSON.stringify(r)).not.toMatch(
      /Ballet F3|LOT-A12|Sideburn|Emla|slow going/,
    );
  });

  it("the appointment fixture itself is studio-scoped", async () => {
    const rows = await asUser(other.userId, (q) =>
      q("select id from public.appointments where id = $1", [appointmentId]),
    );
    expect(rows.rows).toHaveLength(0);
  });
});

describe("6. the read is bounded — no N+1 per session, per block, per area or per pass", () => {
  it("exactly one candidate read and one batched block read", async () => {
    const r = await forStudioA();
    expect(r.sessionReads).toBe(1);
    expect(r.blockReads).toBe(1);
    expect(r.queries).toBe(2);
    // Two blocks, three structured areas, three passes were seeded.
    expect(r.memory?.areas).toHaveLength(2);
  });

  it("stays at the same statement count as the history grows", async () => {
    const iso = await seedStudio("prep-bounded");
    const appt = await insertAppointment(iso, iso.clientId, APPT_STARTS_AT);
    for (let i = 0; i < 8; i += 1) {
      const sid = await insertSession(
        iso,
        iso.clientId,
        `2026-0${i + 1}-01T10:00:00Z`,
      );
      const bid = randomUUID();
      await adminQuery(
        `insert into public.session_blocks (id, studio_id, session_id, sort_order, primary_area, minutes_performed)
         values ($1,$2,$3,$4,'Chin',10)`,
        [bid, iso.studioId, sid, i + 1],
      );
      await adminQuery(
        `insert into public.session_block_areas (session_block_id, area, laterality, display_order)
         values ($1,'Chin','left',0), ($1,'Neck','bilateral',1)`,
        [bid],
      );
      await adminQuery(
        `insert into public.electrolysis_entries
           (session_id, block_id, area, mode, hairs_treated, comments, created_at)
         values ($1,$2,'Chin','thermo',5,'note','2026-0${i + 1}-01T10:05:00Z')`,
        [sid, bid],
      );
    }
    const r = await loadPrep({
      userId: iso.userId,
      studioId: iso.studioId,
      clientId: iso.clientId,
      excludeAppointmentId: appt,
    });
    // 8 sessions, 8 blocks, 16 structured areas, 8 passes — still 1 + 1.
    expect(r.sessionReads).toBe(1);
    expect(r.blockReads).toBe(1);
    expect(r.queries).toBe(2);
  });

  it("the candidate window is capped even when the history is long", async () => {
    const iso = await seedStudio("prep-window");
    for (let i = 0; i < 30; i += 1) {
      await insertSession(
        iso,
        iso.clientId,
        new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString(),
      );
    }
    const r = await loadPrep({
      userId: iso.userId,
      studioId: iso.studioId,
      clientId: iso.clientId,
    });
    expect(r.candidates.length).toBeLessThanOrEqual(25);
  });

  it("a future-heavy history does not push the real treatment out of the window", async () => {
    // The SQL bound is load-bearing: without `started_at < $3` these 30 future
    // sessions would fill the LIMIT and the real treatment would vanish.
    const iso = await seedStudio("prep-future-heavy");
    const appt = await insertAppointment(iso, iso.clientId, APPT_STARTS_AT);
    const real = await insertSession(iso, iso.clientId, CHARTED_AT);
    await adminQuery(
      `insert into public.session_blocks (id, studio_id, session_id, primary_area, minutes_performed)
       values ($1,$2,$3,'Chin',10)`,
      [randomUUID(), iso.studioId, real],
    );
    for (let i = 0; i < 30; i += 1) {
      const sid = await insertSession(
        iso,
        iso.clientId,
        new Date(Date.UTC(2026, 8, 1) + i * 86_400_000).toISOString(),
      );
      await adminQuery(
        `insert into public.session_blocks (id, studio_id, session_id, primary_area, minutes_performed)
         values ($1,$2,$3,'FORBIDDEN-FUTURE-FILL',1)`,
        [randomUUID(), iso.studioId, sid],
      );
    }
    const r = await loadPrep({
      userId: iso.userId,
      studioId: iso.studioId,
      clientId: iso.clientId,
      excludeAppointmentId: appt,
    });
    expect(r.selected?.id).toBe(real);
    expect(JSON.stringify(r.memory)).not.toMatch(/FORBIDDEN-FUTURE-FILL/);
  });
});

describe("7. the appointment surfaces this page owns are untouched", () => {
  it("the linked-session lookup still finds this appointment's own session", async () => {
    const rows = await asUser(s.userId, (q) =>
      q(
        `select id, started_at, modality from public.sessions
          where studio_id = $1 and client_id = $2 and appointment_id = $3
            and deleted_at is null
          order by started_at desc limit 1`,
        [s.studioId, s.clientId, appointmentId],
      ),
    );
    expect(rows.rows[0].id).toBe(linkedSessionId);
    // And it is precisely the row the prep memory refuses to show.
    const prep = await forStudioA();
    expect(prep.selected?.id).not.toBe(rows.rows[0].id);
  });

  it("a second appointment for the same client keeps its own boundary", async () => {
    const r = await loadPrep({
      userId: s.userId,
      studioId: s.studioId,
      clientId: s.clientId,
      before: "2026-08-20T14:00:00Z",
      excludeAppointmentId: otherAppointmentId,
    });
    // From the LATER appointment's point of view, the linked session of the
    // earlier appointment is legitimate history.
    expect(r.selected?.id).toBe(linkedSessionId);
  });
});
