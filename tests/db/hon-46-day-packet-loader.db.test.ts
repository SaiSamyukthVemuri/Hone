import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, asUser, closePool, seedStudio, type SeededStudio } from "./helpers/harness";
import { loadDayPacket, type PacketQuery, type PacketReader } from "@/lib/records/print/day-loader";
import { buildDayPacket } from "@/lib/records/print/day-packet";
import { NATIVE_SETTINGS_UNREADABLE } from "@/lib/records/print/machine-settings";

// HON-46 E-5. The day-packet LOADER against the REAL schema. The unit tests prove
// its filters against a recording fake; this proves the column lists exist, the
// studio / client / day / soft-delete scoping holds on real rows under RLS as the
// signed-in owner, paging completes past one page, and a foreign studio sees nothing.
//
// The reader below translates the loader's PostgREST-style builder into SQL and
// runs it as the signed-in user (role authenticated, RLS on). It proves the SQL
// semantics and RLS; it does NOT exercise PostgREST itself (max_rows, URL length).
// Synthetic ids throughout; no real catalogue profile is activated.
//
// STATUS: written without a stack (no OPS grant yet). It has typechecked but NOT
// been run; expect to adjust seeding once it meets the real schema.

afterAll(() => closePool());

const IDENT = /^[a-z_]+$/;
// PostgREST returns timestamps as strings; node-pg returns Date. Make the rows look like the wire.
const wire = (row: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]));
function sqlReader(userId: string): PacketReader {
  return {
    from(table: string) {
      if (!IDENT.test(table)) throw new Error("bad table");
      let cols = "*";
      const where: string[] = [];
      const params: unknown[] = [];
      let limit = 1000;
      const p = (v: unknown) => (params.push(v), `$${params.length}`);
      const col = (c: string) => {
        if (!IDENT.test(c)) throw new Error("bad column");
        return c;
      };
      const q = {
        select: (c: string) => {
          cols = c.split(",").map((x) => col(x.trim())).join(", ");
          return q;
        },
        eq: (c: string, v: unknown) => (where.push(`${col(c)} = ${p(v)}`), q),
        is: (c: string, v: unknown) => (where.push(v === null ? `${col(c)} is null` : `${col(c)} is ${String(v)}`), q),
        in: (c: string, v: unknown) => (where.push(`${col(c)} = any(${p(v)})`), q),
        gt: (c: string, v: unknown) => (where.push(`${col(c)} > ${p(v)}`), q),
        gte: (c: string, v: unknown) => (where.push(`${col(c)} >= ${p(v)}`), q),
        lt: (c: string, v: unknown) => (where.push(`${col(c)} < ${p(v)}`), q),
        order: () => q,
        range: (_a: number, b: number) => {
          limit = b + 1;
          return q;
        },
        then(ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) {
          const sql = `select ${cols} from public.${table}${where.length ? ` where ${where.join(" and ")}` : ""} order by id asc limit ${limit}`;
          return asUser(userId, (query) => query(sql, params))
            .then((r) => ({ data: r.rows.map(wire), error: null }))
            .catch((e: unknown) => ({ data: null, error: e }))
            .then(ok, bad);
        },
      };
      return q as unknown as PacketQuery;
    },
  } as unknown as PacketReader;
}

const TZ = "America/Toronto";
const DAY = "2026-09-15";
const IN_DAY = "2026-09-15T15:00:00.000Z";
const PREV_LOCAL_DAY = "2026-09-15T03:59:59.000Z"; // 23:59:59 on the 14th, Toronto
const NEXT_LOCAL_DAY = "2026-09-16T04:00:00.000Z"; // 00:00 on the 16th, Toronto

async function sessionAt(s: SeededStudio, startedAt: string, over: { clientId?: string; deleted?: boolean; frequency?: string } = {}) {
  const sessionId = randomUUID();
  const blockId = randomUUID();
  await adminQuery(
    `insert into public.sessions (id, studio_id, client_id, practitioner_id, modality, started_at, deleted_at)
     values ($1,$2,$3,$4,'electrolysis',$5,$6)`,
    [sessionId, s.studioId, over.clientId ?? s.clientId, s.practitionerId, startedAt, over.deleted ? new Date().toISOString() : null],
  );
  await adminQuery(`insert into public.session_blocks (id, studio_id, session_id, machine_frequency) values ($1,$2,$3,$4)`, [blockId, s.studioId, sessionId, over.frequency ?? null]);
  return { sessionId, blockId };
}

/** One reading for a block via the governed commands, on a SYNTHETIC profile (not in the catalogue). */
async function seedReading(s: SeededStudio, blockId: string): Promise<string> {
  const profile = "fixture:hon46-loader";
  await adminQuery(`select public.sync_machine_profile_contract($1,$2,$3,$4,$5,$6::jsonb)`, [
    profile,
    1,
    "galvanic",
    4,
    null,
    JSON.stringify([{ field_key: "current", native_unit: "µA", decimals: 0, quantity: "current", optional: true }]),
  ]);
  const machineId = await asUser(s.userId, async (q) => {
    const r = await q(`select public.register_studio_machine($1,$2,$3,$4,$5) as id`, [s.studioId, profile, 1, `Room ${randomUUID().slice(0, 8)}`, []]);
    return r.rows[0].id as string;
  });
  const route = (
    await adminQuery(
      `select b.session_id, x.client_id from public.session_blocks b join public.sessions x on x.id = b.session_id where b.id = $1`,
      [blockId],
    )
  ).rows[0];
  await asUser(s.userId, (q) =>
    q(`select public.record_treatment_setup_group($1::uuid,$2::uuid,'galvanic',null,$3::smallint[],$4::jsonb,$5::uuid,$6::uuid,'g1')`, [
      blockId,
      machineId,
      [],
      JSON.stringify([{ field_key: "current", value: "5", native_unit: "µA", decimals: 0, observation_source: "practitioner-entered" }]),
      route.session_id,
      route.client_id,
    ]),
  );
  return (await adminQuery(`select id from public.treatment_setup_readings where session_block_id = $1`, [blockId])).rows[0].id as string;
}

const load = (s: SeededStudio, as: SeededStudio = s) =>
  loadDayPacket({
    supabase: sqlReader(as.userId),
    studioId: s.studioId,
    clientId: s.clientId,
    day: DAY,
    timezone: TZ,
    loadBlockAreas: () => Promise.resolve(new Map()),
  });

describe("day packet loader against the real schema", () => {
  it("returns only this client's live sessions that started on the studio-local day; adjacent days, other clients and soft-deleted rows are absent", async () => {
    const s = await seedStudio("hon46ld");
    const otherClient = randomUUID();
    await adminQuery(`insert into public.clients (id, studio_id, name) values ($1,$2,'Other')`, [otherClient, s.studioId]);
    const inDay = await sessionAt(s, IN_DAY);
    await sessionAt(s, PREV_LOCAL_DAY);
    await sessionAt(s, NEXT_LOCAL_DAY);
    await sessionAt(s, IN_DAY, { clientId: otherClient });
    await sessionAt(s, IN_DAY, { deleted: true });
    const r = await load(s);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sessions.map((x) => x.id)).toEqual([inDay.sessionId]);
    expect(r.value.blocks.map((b) => b.id)).toEqual([inDay.blockId]);
  });

  it("another studio's owner loading this studio's client and day gets nothing (RLS), not an error and not rows", async () => {
    const a = await seedStudio("hon46la");
    const b = await seedStudio("hon46lb");
    await sessionAt(a, IN_DAY);
    const r = await load(a, b);
    expect(r.ok && r.value.sessions).toEqual([]);
  });

  it("reads more than one page of blocks to completion (1,050 blocks, page size 1,000)", async () => {
    const s = await seedStudio("hon46lp");
    const { sessionId } = await sessionAt(s, IN_DAY);
    await adminQuery(
      `insert into public.session_blocks (id, studio_id, session_id)
       select gen_random_uuid(), $1, $2 from generate_series(1, 1049)`,
      [s.studioId, sessionId],
    );
    const r = await load(s);
    expect(r.ok && r.value.blocks.length).toBe(1050);
  });

  it("loads machine-native readings for this day's blocks only, and never another studio's", async () => {
    const s = await seedStudio("hon46ln");
    const other = await seedStudio("hon46lo");
    const day = await sessionAt(s, IN_DAY);
    const adjacent = await sessionAt(s, NEXT_LOCAL_DAY);
    const foreign = await sessionAt(other, IN_DAY);
    const dayReading = await seedReading(s, day.blockId);
    await seedReading(s, adjacent.blockId);
    await seedReading(other, foreign.blockId);
    const r = await load(s);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.setupReadings.map((x) => x.id)).toEqual([dayReading]);
    expect(r.value.setupReadings[0].session_block_id).toBe(day.blockId);
  });

  it("a recorded shape the catalogue cannot resolve prints the explicit refusal and none of the block's legacy columns", async () => {
    const s = await seedStudio("hon46lf");
    const { blockId } = await sessionAt(s, IN_DAY, { frequency: "STALE-FREQ" });
    await seedReading(s, blockId);
    const r = await load(s);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const packet = buildDayPacket({ day: DAY, timezone: TZ, studioName: "S", clientName: "C", ...r.value });
    const settings = packet.visits[0].areas[0].settings;
    expect(settings).toEqual([{ label: "Settings", value: NATIVE_SETTINGS_UNREADABLE }]);
    expect(JSON.stringify(settings)).not.toContain("STALE-FREQ");
  });
});
