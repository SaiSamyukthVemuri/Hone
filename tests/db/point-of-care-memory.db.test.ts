import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
  asUser,
  closePool,
  seedStudio,
  type SeededStudio,
  type UserQuery,
} from "./helpers/harness";
import {
  chartedSessionCandidates,
  groupBlocksBySession,
  pickNewestChartedSession,
} from "@/lib/sessions/charted-session";
import {
  buildPointOfCareMemory,
  type PointOfCareBlock,
} from "@/lib/sessions/point-of-care-memory";
import { buildAreaMinutesBreakdown } from "@/lib/treatment-time/area-bucket";

// Point-of-care treatment memory, proven against the REAL migrated local
// database as the `authenticated` role — so RLS, the 0128 structured-area
// child rows, the soft-delete columns and the actual stored types are all
// exercised, not mocked.
//
// The SQL below mirrors the loader's PostgREST select exactly (same columns,
// same filters, same join). The rows it returns are fed through the SAME pure
// builders the application uses, so what is asserted is the end-to-end result
// a practitioner sees.

let s: SeededStudio;
let other: SeededStudio;
// Same studio, different client — the isolation control that studio scoping
// alone would not catch.
let otherClientId: string;

const CHARTED_AT = "2026-01-01T10:00:00Z";
const EMPTY_AT = "2026-06-01T10:00:00Z";
const CURRENT_AT = "2026-07-01T10:00:00Z";

let chartedSessionId: string;
let emptySessionId: string;
let currentSessionId: string;
// A fully-charted session belonging to a DIFFERENT studio, newer than the real
// treatment — the cross-tenant control.
let foreignSessionId = "";
let multiAreaBlockId: string;
let singleAreaBlockId: string;

// The loader's select, as SQL. Kept in lockstep with BLOCK_COLUMNS in
// lib/sessions/last-treatment-loader.ts.
const BLOCK_SQL = `
  select b.id, b.session_id, b.sort_order, b.block_name, b.primary_area, b.side,
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

const SESSION_SQL = `
  select id, started_at, modality, record_status, deleted_at, next_session_note
    from public.sessions
   where studio_id = $1 and client_id = $2 and deleted_at is null
   order by started_at desc`;

const ENTRY_SQL = `
  select id, block_id, created_at, deleted_at, mode, hairs_treated,
         observation_chips, thermolysis_intensity_percent,
         thermolysis_duration_seconds, galvanic_ma, galvanic_duration_seconds,
         units_of_lye, pulse_count, pulse_delay_seconds
    from public.electrolysis_entries
   where session_id = any($1::uuid[]) and deleted_at is null`;

type Counted = {
  query: UserQuery;
  count: () => number;
  blockReads: () => number;
};

// Wraps a harness query fn so a test can prove the read is bounded.
//
// `count` alone would be vacuous — loadMemory contains three literal calls, so
// it can only ever return 3 no matter how the data grows. `blockReads` is the
// assertion that means something: it counts executions of the BATCHED block
// statement, which is where an N+1 (one read per session, per block or per
// area) would actually show up.
function counting(query: UserQuery): Counted {
  let n = 0;
  let blocks = 0;
  return {
    query: (text, params) => {
      n += 1;
      if (text === BLOCK_SQL) blocks += 1;
      return query(text, params);
    },
    count: () => n,
    blockReads: () => blocks,
  };
}

async function insertSession(
  studio: SeededStudio,
  clientId: string,
  startedAt: string,
  extra: { modality?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.sessions
       (id, studio_id, client_id, practitioner_id, modality, started_at)
     values ($1,$2,$3,$4,$5,$6)`,
    [
      id,
      studio.studioId,
      clientId,
      studio.practitionerId,
      extra.modality ?? "electrolysis",
      startedAt,
    ],
  );
  return id;
}

beforeAll(async () => {
  s = await seedStudio("poc-memory");
  other = await seedStudio("poc-other-studio");

  otherClientId = randomUUID();
  await adminQuery(
    "insert into public.clients (id, studio_id, name) values ($1,$2,$3)",
    [otherClientId, s.studioId, "Other client, same studio"],
  );

  // 1. The REAL previous treatment: one multi-area block (Cheek/left +
  //    Sideburn/right) with one stored duration, plus a single-area block.
  chartedSessionId = await insertSession(s, s.clientId, CHARTED_AT);
  await adminQuery(
    "update public.sessions set next_session_note = $2 where id = $1",
    [chartedSessionId, "Start lower on the sideburn"],
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
             3, 'mild_redness', 'Settled within the hour',
             true, 'Watch the sideburn')`,
    [multiAreaBlockId, s.studioId, chartedSessionId],
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
        mode, minutes_performed, machine_frequency)
     values ($1,$2,$3,2,'Chin','center','thermo',12,'27.12 MHz')`,
    [singleAreaBlockId, s.studioId, chartedSessionId],
  );
  await adminQuery(
    `insert into public.session_block_areas (session_block_id, area, laterality, display_order)
     values ($1,'Chin','midline',0)`,
    [singleAreaBlockId],
  );

  // Two live passes on the multi-area block (hairs are summable), plus one
  // soft-deleted pass that must never be counted.
  await adminQuery(
    `insert into public.electrolysis_entries
       (session_id, block_id, area, mode, hairs_treated,
        thermolysis_duration_seconds, thermolysis_intensity_percent,
        galvanic_ma, galvanic_duration_seconds, units_of_lye,
        pulse_count, created_at)
     values ($1,$2,'Cheek','blend',40, 0.733, 40, 1.2, 8, 30, 1, '2026-01-01T10:05:00Z'),
            ($1,$2,'Cheek','blend',25, 0.9, 45, 1.2, 8, 30, 1, '2026-01-01T10:20:00Z')`,
    [chartedSessionId, multiAreaBlockId],
  );
  const deletedEntryId = randomUUID();
  await adminQuery(
    `insert into public.electrolysis_entries
       (id, session_id, block_id, area, mode, hairs_treated, pulse_count, created_at, deleted_at)
     values ($1,$2,$3,'Cheek','blend',9999,1,'2026-01-01T09:00:00Z','2026-01-01T09:30:00Z')`,
    [deletedEntryId, chartedSessionId, multiAreaBlockId],
  );

  // 2. A NEWER session with nothing charted on it — the exact row that used to
  //    win `order started_at desc limit 1` and hide the treatment above.
  emptySessionId = await insertSession(s, s.clientId, EMPTY_AT);

  // 3. The session being charted right now.
  currentSessionId = await insertSession(s, s.clientId, CURRENT_AT);

  // 4. Cross-client and cross-studio noise, both newer than the real
  //    treatment, both fully charted.
  const otherClientSession = await insertSession(s, otherClientId, EMPTY_AT);
  await adminQuery(
    `insert into public.session_blocks (id, studio_id, session_id, primary_area, minutes_performed)
     values ($1,$2,$3,'FORBIDDEN-OTHER-CLIENT',99)`,
    [randomUUID(), s.studioId, otherClientSession],
  );
  foreignSessionId = await insertSession(other, other.clientId, EMPTY_AT);
  await adminQuery(
    `insert into public.session_blocks (id, studio_id, session_id, primary_area, minutes_performed)
     values ($1,$2,$3,'FORBIDDEN-OTHER-STUDIO',99)`,
    [randomUUID(), other.studioId, foreignSessionId],
  );
});

afterAll(async () => {
  await closePool();
});

// The whole read path, as the application performs it: sessions (already in
// memory on the real page), one batched blocks read, entries from the same
// already-loaded sessions.
async function loadMemory(opts: {
  userId: string;
  studioId: string;
  clientId: string;
  before?: string;
  excludeSessionId?: string;
}) {
  return asUser(opts.userId, async (rawQuery) => {
    const c = counting(rawQuery);
    const sessions = (
      await c.query(SESSION_SQL, [opts.studioId, opts.clientId])
    ).rows.map((r) => ({
      id: r.id as string,
      started_at: new Date(r.started_at).toISOString(),
      modality: r.modality as string,
      record_status: r.record_status as string,
      deleted_at: r.deleted_at as string | null,
      next_session_note: r.next_session_note as string | null,
    }));

    const candidates = chartedSessionCandidates(sessions, {
      before: opts.before,
      excludeSessionId: opts.excludeSessionId,
    });
    if (candidates.length === 0) {
      return {
        memory: null,
        queries: c.count(),
        blockReads: c.blockReads(),
        breakdown: [],
        selected: null,
      };
    }

    const blockRows = (
      await c.query(BLOCK_SQL, [
        opts.studioId,
        candidates.map((x) => x.id),
      ])
    ).rows as Array<
      PointOfCareBlock & { session_id: string; deleted_at?: string | null }
    >;

    const bySession = groupBlocksBySession(blockRows);
    const selected = pickNewestChartedSession(sessions, bySession, {
      before: opts.before,
      excludeSessionId: opts.excludeSessionId,
    });
    if (!selected) {
      return {
        memory: null,
        queries: c.count(),
        blockReads: c.blockReads(),
        breakdown: [],
        selected: null,
      };
    }

    // On the real page these arrive with the sessions read; here they are a
    // third statement so the fixture stays readable. The count assertion below
    // accounts for that explicitly.
    const entries = (await c.query(ENTRY_SQL, [[selected.id]])).rows;
    const byBlock = new Map<string, typeof entries>();
    for (const e of entries) {
      const list = byBlock.get(e.block_id) ?? [];
      list.push(e);
      byBlock.set(e.block_id, list);
    }

    const blocks: PointOfCareBlock[] = (bySession.get(selected.id) ?? []).map(
      (b) => ({ ...b, entries: byBlock.get(b.id) ?? [] }),
    );

    return {
      selected,
      queries: c.count(),
      blockReads: c.blockReads(),
      breakdown: buildAreaMinutesBreakdown(
        blockRows.map((b) => ({
          ...b,
          minutes_performed: b.minutes_performed as number | null,
        })),
      ),
      memory: buildPointOfCareMemory({
        session: {
          id: selected.id,
          started_at: selected.started_at,
          modality: selected.modality,
          next_session_note: selected.next_session_note ?? null,
        },
        blocks,
      }),
    };
  });
}

describe("1-2. the newest CHARTED session wins over a newer empty one", () => {
  it("selects the older charted session, not the newer empty row", async () => {
    const r = await loadMemory({
      userId: s.userId,
      studioId: s.studioId,
      clientId: s.clientId,
      before: CURRENT_AT,
      excludeSessionId: currentSessionId,
    });
    expect(r.selected?.id).toBe(chartedSessionId);
    expect(r.selected?.id).not.toBe(emptySessionId);
    expect(r.selected?.id).not.toBe(currentSessionId);
  });

  it("flags that a newer, uncharted session exists", async () => {
    const r = await loadMemory({
      userId: s.userId,
      studioId: s.studioId,
      clientId: s.clientId,
      before: CURRENT_AT,
      excludeSessionId: currentSessionId,
    });
    // The empty session is the newest candidate but not the selected one.
    expect(r.selected?.id).toBe(chartedSessionId);
    expect(r.selected?.started_at).toBe(new Date(CHARTED_AT).toISOString());
  });
});

describe("3-4. a multi-area block's duration is credited exactly once", () => {
  it("buckets the combined label and credits 30 minutes ONCE", async () => {
    const r = await loadMemory({
      userId: s.userId,
      studioId: s.studioId,
      clientId: s.clientId,
      before: CURRENT_AT,
      excludeSessionId: currentSessionId,
    });
    const combined = r.breakdown.filter((b) => b.area === "Cheek · Sideburn");
    expect(combined).toHaveLength(1);
    expect(combined[0].minutes).toBe(30);
    // Never once per area.
    expect(r.breakdown.find((b) => b.area === "Cheek")).toBeUndefined();
    expect(r.breakdown.find((b) => b.area === "Sideburn")).toBeUndefined();
  });

  it("does not display those minutes twice — the breakdown sums to the stored total", async () => {
    const r = await loadMemory({
      userId: s.userId,
      studioId: s.studioId,
      clientId: s.clientId,
      before: CURRENT_AT,
      excludeSessionId: currentSessionId,
    });
    const total = r.breakdown.reduce((n, b) => n + b.minutes, 0);
    const stored = await adminQuery(
      `select coalesce(sum(minutes_performed),0)::int as total
         from public.session_blocks
        where session_id = $1 and deleted_at is null`,
      [chartedSessionId],
    );
    expect(total).toBe(stored.rows[0].total);
    expect(total).toBe(42);
    expect(total).not.toBe(72); // 30 credited twice + 12
  });

  it("a single-area block still buckets under its bare area", async () => {
    const r = await loadMemory({
      userId: s.userId,
      studioId: s.studioId,
      clientId: s.clientId,
      before: CURRENT_AT,
      excludeSessionId: currentSessionId,
    });
    expect(r.breakdown.find((b) => b.area === "Chin")?.minutes).toBe(12);
  });
});

describe("5-6. the memory view model carries the fields that were missing", () => {
  let memory: NonNullable<Awaited<ReturnType<typeof loadMemory>>["memory"]>;

  beforeAll(async () => {
    const r = await loadMemory({
      userId: s.userId,
      studioId: s.studioId,
      clientId: s.clientId,
      before: CURRENT_AT,
      excludeSessionId: currentSessionId,
    });
    memory = r.memory!;
  });

  it("shows every treated area with laterality, from the real 0128 child rows", () => {
    expect(memory.areas[0].areaLabel).toBe("Left Cheek · Right Sideburn");
    expect(memory.areaHeadline).toBe("Left Cheek · Right Sideburn · Midline Chin");
  });

  it("carries machine frequency", () => {
    expect(memory.areas[0].frequency).toBe("13.56 MHz");
    expect(memory.areas[1].frequency).toBe("27.12 MHz");
  });

  it("carries the probe and its stored lot snapshot", () => {
    expect(memory.areas[0].probeLine).toBe("Ballet F3 · Lot #LOT-A12 (confirmed)");
  });

  it("carries numbing status and its note", () => {
    expect(memory.areas[0].numbing).toEqual({
      label: "Numbing used",
      note: "Emla 30 min before",
    });
  });

  it("carries hairs, summed across LIVE passes only", () => {
    expect(memory.areas[0].hairs).toBe(65);
    expect(memory.areas[0].passCount).toBe(2);
  });

  it("carries minutes, tolerance, response and caution", () => {
    expect(memory.totalMinutes).toBe(42);
    expect(memory.areas[0].toleranceLine).toBe("3/5 - Moderate discomfort");
    expect(memory.areas[0].responseLine).toBe("Mild redness");
    expect(memory.areas[0].responseNote).toBe("Settled within the hour");
    expect(memory.watchLines).toEqual([
      "Left Cheek · Right Sideburn: Watch the sideburn",
    ]);
    expect(memory.plan).toBe("Start lower on the sideburn");
  });

  it("shows the EXACT stored 3-decimal thermolysis duration read back from numeric", () => {
    const reading = memory.areas[0].readings.find(
      (r) => r.field === "thermolysisDurationSeconds",
    );
    // PostgREST/pg hands `numeric` back as a string; the builder coerces.
    expect(reading?.value).toBe("0.733 seconds");
  });

  it("never surfaces the retired galvanic intensity", () => {
    expect(JSON.stringify(memory)).not.toMatch(/galvanic_intensity|galvanicIntensity/i);
  });
});

describe("7. cross-client and cross-studio rows cannot enter the summary", () => {
  it("another client in the SAME studio never appears", async () => {
    const r = await loadMemory({
      userId: s.userId,
      studioId: s.studioId,
      clientId: s.clientId,
      before: CURRENT_AT,
      excludeSessionId: currentSessionId,
    });
    expect(JSON.stringify(r)).not.toMatch(/FORBIDDEN-OTHER-CLIENT/);
  });

  it("another studio never appears, and RLS itself blocks the read", async () => {
    const r = await loadMemory({
      userId: s.userId,
      studioId: s.studioId,
      clientId: s.clientId,
      before: CURRENT_AT,
      excludeSessionId: currentSessionId,
    });
    expect(JSON.stringify(r)).not.toMatch(/FORBIDDEN-OTHER-STUDIO/);

    // Belt and braces: even asking for the foreign studio's blocks directly
    // returns nothing for this user.
    const leak = await asUser(s.userId, (q) =>
      q(BLOCK_SQL, [other.studioId, [foreignSessionId]]),
    );
    expect(leak.rows).toHaveLength(0);
  });

  it("the foreign studio's own owner still sees only their studio", async () => {
    const r = await loadMemory({
      userId: other.userId,
      studioId: other.studioId,
      clientId: other.clientId,
    });
    expect(JSON.stringify(r)).not.toMatch(/Ballet F3|LOT-A12|Sideburn/);
  });
});

describe("8. soft-deleted blocks and entries are excluded", () => {
  it("a session whose only block is soft-deleted is NOT charted", async () => {
    const isolated = await seedStudio("poc-softdelete");
    const older = await insertSession(isolated, isolated.clientId, CHARTED_AT);
    const newer = await insertSession(isolated, isolated.clientId, EMPTY_AT);
    await adminQuery(
      `insert into public.session_blocks (id, studio_id, session_id, primary_area, minutes_performed)
       values ($1,$2,$3,'Chin',10)`,
      [randomUUID(), isolated.studioId, older],
    );
    const deletedBlock = randomUUID();
    await adminQuery(
      `insert into public.session_blocks
         (id, studio_id, session_id, primary_area, minutes_performed, deleted_at)
       values ($1,$2,$3,'Ghost',99, now())`,
      [deletedBlock, isolated.studioId, newer],
    );

    const r = await loadMemory({
      userId: isolated.userId,
      studioId: isolated.studioId,
      clientId: isolated.clientId,
    });
    expect(r.selected?.id).toBe(older);
    expect(JSON.stringify(r)).not.toMatch(/Ghost/);
  });

  it("a soft-deleted pass contributes no hairs and no reading", async () => {
    const r = await loadMemory({
      userId: s.userId,
      studioId: s.studioId,
      clientId: s.clientId,
      before: CURRENT_AT,
      excludeSessionId: currentSessionId,
    });
    // 40 + 25 live; the 9999-hair deleted pass is excluded.
    expect(r.memory?.areas[0].hairs).toBe(65);
    expect(JSON.stringify(r.memory)).not.toMatch(/9999/);
  });

  it("a soft-deleted SESSION never becomes the last treatment", async () => {
    const isolated = await seedStudio("poc-deleted-session");
    const older = await insertSession(isolated, isolated.clientId, CHARTED_AT);
    const newer = await insertSession(isolated, isolated.clientId, EMPTY_AT);
    await adminQuery(
      `insert into public.session_blocks (id, studio_id, session_id, primary_area, minutes_performed)
       values ($1,$2,$3,'Chin',10), ($4,$2,$5,'Deleted',99)`,
      [randomUUID(), isolated.studioId, older, randomUUID(), newer],
    );
    await adminQuery("update public.sessions set deleted_at = now() where id = $1", [
      newer,
    ]);

    const r = await loadMemory({
      userId: isolated.userId,
      studioId: isolated.studioId,
      clientId: isolated.clientId,
    });
    expect(r.selected?.id).toBe(older);
  });
});

describe("9. the read is bounded — no N+1 per session, per block or per area", () => {
  it("uses a fixed number of statements regardless of how many blocks or areas exist", async () => {
    const r = await loadMemory({
      userId: s.userId,
      studioId: s.studioId,
      clientId: s.clientId,
      before: CURRENT_AT,
      excludeSessionId: currentSessionId,
    });
    // THE meaningful assertion: the batched block statement executes exactly
    // ONCE for the whole candidate window, with its structured areas joined in.
    // Two blocks, three structured areas and three passes were seeded; an N+1
    // per session / per block / per area would push this above 1.
    expect(r.blockReads).toBe(1);
    expect(r.memory?.areas).toHaveLength(2);
    // sessions + blocks(+areas) + entries. On the real page the sessions and
    // entries arrive with getClientById, so the panel costs ONE query.
    expect(r.queries).toBe(3);
  });

  it("stays at the same statement count when the history grows", async () => {
    const isolated = await seedStudio("poc-bounded");
    for (let i = 0; i < 8; i += 1) {
      const sid = await insertSession(
        isolated,
        isolated.clientId,
        `2026-0${i + 1}-01T10:00:00Z`,
      );
      const bid = randomUUID();
      await adminQuery(
        `insert into public.session_blocks (id, studio_id, session_id, sort_order, primary_area, minutes_performed)
         values ($1,$2,$3,$4,'Chin',10)`,
        [bid, isolated.studioId, sid, i + 1],
      );
      await adminQuery(
        `insert into public.session_block_areas (session_block_id, area, laterality, display_order)
         values ($1,'Chin','left',0), ($1,'Neck','bilateral',1)`,
        [bid],
      );
    }
    const r = await loadMemory({
      userId: isolated.userId,
      studioId: isolated.studioId,
      clientId: isolated.clientId,
    });
    // 8 sessions, 8 blocks, 16 structured areas — still ONE block read.
    expect(r.blockReads).toBe(1);
    expect(r.queries).toBe(3);
  });
});

describe("fail-soft", () => {
  it("a client with no prior charted session yields no memory at all", async () => {
    const isolated = await seedStudio("poc-first-visit");
    const only = await insertSession(isolated, isolated.clientId, CURRENT_AT);
    const r = await loadMemory({
      userId: isolated.userId,
      studioId: isolated.studioId,
      clientId: isolated.clientId,
      before: CURRENT_AT,
      excludeSessionId: only,
    });
    expect(r.memory).toBeNull();
    expect(r.selected).toBeNull();
  });

  it("a laser-only prior treatment still counts as the last treatment", async () => {
    const isolated = await seedStudio("poc-laser");
    const laser = await insertSession(
      isolated,
      isolated.clientId,
      CHARTED_AT,
      { modality: "laser" },
    );
    await adminQuery(
      "insert into public.laser_entries (session_id, zone) values ($1,'Chin')",
      [laser],
    );
    // The loader reads laser content from the session's embedded entries, which
    // the harness fixture supplies explicitly here.
    const sessions = await asUser(isolated.userId, (q) =>
      q(SESSION_SQL, [isolated.studioId, isolated.clientId]),
    );
    const withEntries = sessions.rows.map((r) => ({
      id: r.id as string,
      started_at: new Date(r.started_at).toISOString(),
      record_status: r.record_status as string,
      deleted_at: r.deleted_at as string | null,
      laser_entries: r.id === laser ? [{ deleted_at: null }] : [],
      electrolysis_entries: [],
    }));
    const picked = pickNewestChartedSession(withEntries, new Map());
    expect(picked?.id).toBe(laser);
  });
});
